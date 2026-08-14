import type {
  AssetRegistry,
  VaultDepositRequest,
  VaultIntentResponse,
  VaultPositionResponse,
  VaultWithdrawRequest
} from '@paltalabs/shared';
import {eq, type InferSelectModel} from 'drizzle-orm';
import type {NodePgDatabase} from 'drizzle-orm/node-postgres';
import type * as schema from '../../db/schema.js';
import {activity, intents, merchants} from '../../db/schema.js';
import type {VaultConfig} from '../../config/vaults.js';
import {AppError} from '../../lib/errors.js';
import {SorobanSimulationError} from '../../lib/soroban-gateway.js';
import type {VaultProvider} from './provider.js';

export type MerchantRecord = InferSelectModel<typeof merchants>;
export type IntentRecord = InferSelectModel<typeof intents>;

/**
 * A fixed, sanitized token for a simulation failure's `AppError.details.detail`
 * — deliberately NOT `SorobanSimulationError.detail` (the provider's raw RPC
 * diagnostic string), per that error class's own doc comment
 * (`../../lib/soroban-gateway.ts`): simulation diagnostics are a server-log
 * concern only and must never reach an HTTP client. Mirrors
 * `sponsor/submit.ts`'s `SubmissionFailedError.reason` sanitization
 * convention, just with one fixed value instead of several classified ones —
 * this module has no need to distinguish simulation-failure subtypes for a
 * client.
 */
const SIMULATION_FAILURE_DETAIL = 'vault_simulation_failed';

/**
 * Persistence boundary for the vault module — deliberately narrower than raw
 * Drizzle access so `service.ts` can be unit-tested with an in-memory fake
 * instead of a live Postgres (`service.test.ts`), mirroring
 * `payments/service.ts`'s `PaymentsRepo` shape exactly. Queries
 * `merchants`/`intents`/`activity` directly — deliberately not routed
 * through `wallet`'s or `payments`'s repo, keeping these sibling modules
 * decoupled (same rationale as `payments`, see `docs/modules/api-intents.md`'s
 * Gotchas).
 */
export interface VaultRepo {
  getMerchant(privyDid: string): Promise<MerchantRecord | undefined>;
  createIntent(input: {privyDid: string; kind: 'vault_deposit' | 'vault_withdraw'; xdr: string; hashHex: string}): Promise<IntentRecord>;
  /**
   * `counterparty` carries the vault contract address — the value a feed
   * renders for a deposit/withdraw row — computed by the SERVICE (from
   * `VaultServiceDeps.vault.address`) and passed through here, exactly the
   * way `PaymentsRepo.recordPendingActivity`'s `PendingPaymentActivity`
   * carries the payment destination as `counterparty` (`payments/service.ts:23-30`)
   * rather than the repo inventing it. Not derivable inside
   * `createDrizzleVaultRepo` itself, which only receives `db`.
   */
  recordPendingActivity(input: {
    stellarAddress: string;
    externalRef: string;
    type: 'vault_deposit' | 'vault_withdraw';
    direction: 'in' | 'out';
    amount: string | null;
    assetCode: string;
    assetIssuer: string;
    counterparty: string;
  }): Promise<void>;
}

/** Production `VaultRepo` backed by Drizzle over the real `merchants`/`intents`/`activity` tables. */
export function createDrizzleVaultRepo(db: NodePgDatabase<typeof schema>): VaultRepo {
  return {
    async getMerchant(privyDid) {
      const [row] = await db.select().from(merchants).where(eq(merchants.privyDid, privyDid));
      return row;
    },

    async createIntent({privyDid, kind, xdr, hashHex}) {
      const [row] = await db.insert(intents).values({privyDid, kind, xdr, hashHex}).returning();
      if (!row) throw new Error(`intent insert did not return a row for privyDid=${privyDid}`);
      return row;
    },

    async recordPendingActivity(input) {
      await db.insert(activity).values({
        stellarAddress: input.stellarAddress,
        type: input.type,
        direction: input.direction,
        amount: input.amount,
        assetCode: input.assetCode,
        assetIssuer: input.assetIssuer,
        counterparty: input.counterparty,
        status: 'pending',
        txHash: null,
        source: 'api',
        externalRef: input.externalRef
      });
    }
  };
}

export interface VaultServiceDeps {
  repo: VaultRepo;
  provider: VaultProvider;
  registry: AssetRegistry;
  vault: VaultConfig;
}

export interface VaultService {
  /**
   * Build and store a pending `vault_deposit` intent: an unsigned deposit
   * invocation (merchant is the source) plus a pending activity row. Same
   * signing-flow contract as `payments/service.ts`'s `createPayment` — the
   * sponsor signs nothing here; the merchant must co-sign via Privy
   * `rawSign` and submit through `POST /intents/:id/complete`.
   */
  deposit(privyDid: string, request: VaultDepositRequest): Promise<VaultIntentResponse>;
  /**
   * Build and store a pending `vault_withdraw` intent. The pending activity
   * row's `amount` is `null` — the underlying-asset amount the merchant
   * actually receives isn't known until the withdrawal executes on-chain
   * (the share→asset conversion rate is applied at that point, not at
   * intent-build time).
   */
  withdraw(privyDid: string, request: VaultWithdrawRequest): Promise<VaultIntentResponse>;
  /** The caller's current vault position, decorated with the vault's registry asset code/issuer. */
  position(privyDid: string): Promise<VaultPositionResponse>;
}

/**
 * The vault module's business logic: validated deposit/withdraw requests in,
 * pending signing-flow intents out (plus a read-only position lookup).
 * Decoupled from Postgres/Soroban via `deps`, mirroring
 * `payments/service.ts`'s `createPaymentsService` shape.
 */
export function createVaultService(deps: VaultServiceDeps): VaultService {
  const {repo, provider, registry, vault} = deps;
  // The vault's single underlying asset — resolved once, not per-call. A
  // misconfigured `vault.assetCode` (not in `registry`) fails fast here at
  // service-construction time rather than surfacing lazily on a merchant's
  // first request; `config/vaults.ts:25` already enforces the same
  // invariant at import time, so this is a defense-in-depth check on the
  // injected deps, not a new failure mode.
  const asset = registry.get(vault.assetCode);

  async function requireMerchant(privyDid: string): Promise<MerchantRecord> {
    const merchant = await repo.getMerchant(privyDid);
    if (!merchant) {
      throw new AppError('merchant_not_found', 'call POST /wallet/provision first', 404);
    }
    return merchant;
  }

  /**
   * Runs a `VaultProvider` call and maps a `SorobanSimulationError` to the
   * fixed, sanitized 502 `AppError` — shared by `deposit`/`withdraw`
   * (`buildDepositTx`/`buildWithdrawTx`) AND `position` (`getPosition`,
   * which simulates via `soroban.simulateRead` internally, `defindex.ts:95-119`,
   * same failure mode as building a tx).
   */
  async function runProviderCall<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof SorobanSimulationError) {
        throw new AppError('simulation_failed', 'transaction simulation failed', 502, {detail: SIMULATION_FAILURE_DETAIL});
      }
      throw err;
    }
  }

  return {
    async deposit(privyDid, request) {
      const merchant = await requireMerchant(privyDid);
      const built = await runProviderCall(() => provider.buildDepositTx(merchant.stellarAddress, request.amount));

      const created = await repo.createIntent({privyDid, kind: 'vault_deposit', xdr: built.xdr, hashHex: built.hashHex});
      // Pending activity row, tagged with this intent's id so
      // `intents/service.ts`'s completion flow updates it in place instead
      // of inserting a second row (mirrors `payments/service.ts`'s
      // `PendingPaymentActivity` convention). `counterparty` is the vault
      // contract address — the value a feed renders for a deposit.
      await repo.recordPendingActivity({
        stellarAddress: merchant.stellarAddress,
        externalRef: created.id,
        type: 'vault_deposit',
        direction: 'out',
        amount: request.amount,
        assetCode: asset.code,
        assetIssuer: asset.issuer,
        counterparty: vault.address
      });

      return {intentId: created.id, xdr: created.xdr, hashHex: created.hashHex};
    },

    async withdraw(privyDid, request) {
      const merchant = await requireMerchant(privyDid);
      const built = await runProviderCall(() => provider.buildWithdrawTx(merchant.stellarAddress, request.shares));

      const created = await repo.createIntent({privyDid, kind: 'vault_withdraw', xdr: built.xdr, hashHex: built.hashHex});
      await repo.recordPendingActivity({
        stellarAddress: merchant.stellarAddress,
        externalRef: created.id,
        type: 'vault_withdraw',
        direction: 'in',
        // Not known until the withdrawal executes on-chain — see
        // `VaultService.withdraw`'s doc comment.
        amount: null,
        assetCode: asset.code,
        assetIssuer: asset.issuer,
        counterparty: vault.address
      });

      return {intentId: created.id, xdr: created.xdr, hashHex: created.hashHex};
    },

    async position(privyDid) {
      const merchant = await requireMerchant(privyDid);
      const position = await runProviderCall(() => provider.getPosition(merchant.stellarAddress));
      return {
        shares: position.shares,
        underlyingBalance: position.underlyingBalance,
        assetCode: asset.code,
        assetIssuer: asset.issuer
      };
    }
  };
}
