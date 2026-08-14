import type {AssetRegistry, ProvisionResponse, WalletResponse} from '@paltalabs/shared';
import {Asset, type Keypair} from '@stellar/stellar-sdk';
import {and, eq, type InferSelectModel} from 'drizzle-orm';
import type {NodePgDatabase} from 'drizzle-orm/node-postgres';
import type * as schema from '../../db/schema.js';
import {intents, merchants} from '../../db/schema.js';
import {AppError} from '../../lib/errors.js';
import {StellarAccountNotFoundError, type StellarGateway} from '../../lib/stellar-gateway.js';
import {buildProvisioningTx} from '../sponsor/provisioning.js';
import {txHashHex} from '../sponsor/stellar.js';
import type {PrivyUserResolver} from './privy-user.js';

export type MerchantRecord = InferSelectModel<typeof merchants>;
export type IntentRecord = InferSelectModel<typeof intents>;

/**
 * Persistence boundary for the wallet module — deliberately narrower than
 * raw Drizzle access so `service.ts` can be unit-tested with an in-memory
 * fake instead of a live Postgres (`service.test.ts`). `createDrizzleWalletRepo`
 * is the only implementation that touches the database.
 */
export interface WalletRepo {
  /** Insert-if-missing; returns the (possibly pre-existing) row either way. */
  upsertMerchant(input: {privyDid: string; privyWalletId: string; stellarAddress: string}): Promise<MerchantRecord>;
  getMerchant(privyDid: string): Promise<MerchantRecord | undefined>;
  markProvisioned(privyDid: string): Promise<void>;
  findPendingProvisionIntent(privyDid: string): Promise<IntentRecord | undefined>;
  createProvisionIntent(input: {privyDid: string; xdr: string; hashHex: string}): Promise<IntentRecord>;
}

/** Production `WalletRepo` backed by Drizzle over the real `merchants`/`intents` tables. */
export function createDrizzleWalletRepo(db: NodePgDatabase<typeof schema>): WalletRepo {
  return {
    async upsertMerchant({privyDid, privyWalletId, stellarAddress}) {
      await db
        .insert(merchants)
        .values({privyDid, privyWalletId, stellarAddress})
        .onConflictDoNothing({target: merchants.privyDid});
      const [row] = await db.select().from(merchants).where(eq(merchants.privyDid, privyDid));
      if (!row) throw new Error(`merchant upsert did not produce a row for privyDid=${privyDid}`);
      return row;
    },

    async getMerchant(privyDid) {
      const [row] = await db.select().from(merchants).where(eq(merchants.privyDid, privyDid));
      return row;
    },

    async markProvisioned(privyDid) {
      await db.update(merchants).set({provisionedAt: new Date()}).where(eq(merchants.privyDid, privyDid));
    },

    async findPendingProvisionIntent(privyDid) {
      const [row] = await db
        .select()
        .from(intents)
        .where(and(eq(intents.privyDid, privyDid), eq(intents.kind, 'provision'), eq(intents.status, 'pending')))
        .limit(1);
      return row;
    },

    async createProvisionIntent({privyDid, xdr, hashHex}) {
      const [row] = await db.insert(intents).values({privyDid, kind: 'provision', xdr, hashHex}).returning();
      if (!row) throw new Error(`intent insert did not return a row for privyDid=${privyDid}`);
      return row;
    }
  };
}

export interface WalletServiceDeps {
  repo: WalletRepo;
  stellarGateway: StellarGateway;
  privyUser: PrivyUserResolver;
  /** Sponsor keypair, parsed once at startup (never per-request) — signs provisioning txs as the tx source. */
  sponsor: Keypair;
  registry: AssetRegistry;
  networkPassphrase: string;
}

export interface WalletService {
  provision(privyDid: string): Promise<ProvisionResponse>;
  getWallet(privyDid: string): Promise<WalletResponse>;
}

/** Reports whether `publicKey` already exists on-chain by probing `loadAccount`. */
async function accountExists(gateway: StellarGateway, publicKey: string): Promise<boolean> {
  try {
    await gateway.loadAccount(publicKey);
    return true;
  } catch {
    return false;
  }
}

/**
 * Registry membership key for exact (code, issuer) matching — see the
 * SECURITY note at its call site in `getWallet` for why code alone is not
 * enough.
 */
function registryKey(code: string, issuer: string): string {
  return `${code}:${issuer}`;
}

/**
 * The wallet module's business logic: sponsored provisioning intents (idempotent)
 * and live balance reads, decoupled from Postgres/Horizon/Privy via `deps`.
 */
export function createWalletService(deps: WalletServiceDeps): WalletService {
  const {repo, stellarGateway, privyUser, sponsor, registry, networkPassphrase} = deps;

  return {
    async provision(privyDid: string): Promise<ProvisionResponse> {
      const wallet = await privyUser.resolveStellarWallet(privyDid);
      await repo.upsertMerchant({
        privyDid,
        privyWalletId: wallet.walletId,
        stellarAddress: wallet.address
      });

      if (await accountExists(stellarGateway, wallet.address)) {
        await repo.markProvisioned(privyDid);
        return {provisioned: true, stellarAddress: wallet.address};
      }

      const pending = await repo.findPendingProvisionIntent(privyDid);
      if (pending) {
        return {intentId: pending.id, xdr: pending.xdr, hashHex: pending.hashHex};
      }

      const [assetConfig] = registry.list();
      if (!assetConfig) throw new Error('asset registry is empty — cannot build a provisioning tx');

      const sponsorAccount = await stellarGateway.loadAccount(sponsor.publicKey());
      const tx = buildProvisioningTx({
        sponsorAccount,
        merchantPublicKey: wallet.address,
        asset: new Asset(assetConfig.code, assetConfig.issuer),
        networkPassphrase
      });
      // Sponsor is the tx source — sign it now server-side so the stored
      // intent only needs the merchant's (Privy rawSign) signature to submit.
      tx.sign(sponsor);
      const hashHex = txHashHex(tx);
      const xdr = tx.toXDR();

      const created = await repo.createProvisionIntent({privyDid, xdr, hashHex});
      return {intentId: created.id, xdr: created.xdr, hashHex: created.hashHex};
    },

    async getWallet(privyDid: string): Promise<WalletResponse> {
      const merchant = await repo.getMerchant(privyDid);
      if (!merchant) {
        throw new AppError('merchant_not_found', 'call POST /wallet/provision first', 404);
      }

      const registryKeys = new Set(registry.list().map((a) => registryKey(a.code, a.issuer)));
      let balances: WalletResponse['balances'] = [];
      try {
        const account = await stellarGateway.loadAccount(merchant.stellarAddress);
        balances = account.balances
          // SECURITY: match on (assetCode, assetIssuer) TOGETHER, never code
          // alone. The merchant fully controls their own signing key and can
          // add a trustline to ANY issuer at any time outside this backend
          // (e.g. a phishing "airdrop" trustline using the real USDC code
          // but a foreign issuer) — Horizon reports that balance too, and
          // code-only matching would display it as indistinguishable from
          // the genuine registry asset. Only balances whose exact (code,
          // issuer) pair is in `registryKeys` are ever reported.
          .filter(
            (b): b is {assetCode: string; assetIssuer: string; balance: string} =>
              !!b.assetCode && !!b.assetIssuer && registryKeys.has(registryKey(b.assetCode, b.assetIssuer))
          )
          .map((b) => ({assetCode: b.assetCode, assetIssuer: b.assetIssuer, balance: b.balance}));
      } catch (err) {
        // Only "account doesn't exist yet" (intent pending/unsubmitted)
        // collapses to an empty balances list. Any other failure (Horizon
        // outage, network error, etc.) must NOT masquerade as an empty
        // wallet — rethrow so it surfaces as a 500, not a false "no funds".
        if (!(err instanceof StellarAccountNotFoundError)) throw err;
        balances = [];
      }

      return {
        stellarAddress: merchant.stellarAddress,
        provisioned: merchant.provisionedAt !== null,
        balances
      };
    }
  };
}
