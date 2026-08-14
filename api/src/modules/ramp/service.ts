import type {
  AssetRegistry,
  KycLaunchResponse,
  OnboardingStartRequest,
  PayinExecuteRequest,
  PayinOrderResponse,
  PayinOrderStateResponse,
  PayinQuoteRequest,
  PayoutExecuteRequest,
  PayoutIntentResponse,
  PayoutQuoteRequest,
  PixDetailsRequest,
  RampOnboardingStatus,
  RampQuoteResponse
} from '@paltalabs/shared';
import {Asset, BASE_FEE, Memo, Operation, TransactionBuilder} from '@stellar/stellar-sdk';
import {and, eq, type InferSelectModel} from 'drizzle-orm';
import type {NodePgDatabase} from 'drizzle-orm/node-postgres';
import {randomUUID} from 'node:crypto';
import type {StellarGateway} from '../../lib/stellar-gateway.js';
import type * as schema from '../../db/schema.js';
import {activity, intents, merchants, rampCustomers} from '../../db/schema.js';
import {AppError} from '../../lib/errors.js';
import {txHashHex} from '../sponsor/stellar.js';
import {RampProviderError, type RampProvider} from './provider.js';

export type MerchantRecord = InferSelectModel<typeof merchants>;
export type RampCustomerRecord = InferSelectModel<typeof rampCustomers>;
/**
 * Deliberately re-derived here (not imported from `../intents/service.js`)
 * rather than imported — mirrors `payments/service.ts`'s own local
 * `IntentRecord` alias: every intent-producing module defines its own view
 * of the `intents` table instead of depending on `intents/service.ts`,
 * keeping these sibling modules decoupled (`docs/modules/api-intents.md`'s
 * Gotchas).
 */
export type IntentRecord = InferSelectModel<typeof intents>;

/** The provider token stamped on every `ramp_customers` row this module writes. */
const RAMP_PROVIDER = 'etherfuse';

/** `activity.externalRef`'s order-tagging convention, shared with the ownership lookup below. */
const ORDER_EXTERNAL_REF_PREFIX = 'order:';

/**
 * Persistence boundary for the ramp module — deliberately narrower than raw
 * Drizzle access so `service.ts` can be unit-tested with an in-memory fake
 * instead of a live Postgres (`service.test.ts`), mirroring
 * `vault/service.ts`'s `VaultRepo` shape. `setWalletId`/`setBankAccountId`
 * are separate single-column setters (not one generic `update`) because
 * `completeSetup`'s resumability logic calls each independently, exactly when
 * its corresponding provider step just completed.
 */
export interface RampRepo {
  getMerchant(privyDid: string): Promise<MerchantRecord | undefined>;
  getRampCustomer(privyDid: string): Promise<RampCustomerRecord | undefined>;
  /**
   * Conflict-tolerant: a second concurrent call for the same `privyDid` (two
   * simultaneous `startOnboarding` requests that both saw no existing row)
   * must NOT throw a raw unique-violation — it silently no-ops, letting the
   * caller re-read via `getRampCustomer` to discover which insert actually
   * won. See `startOnboarding`'s doc comment for the full race-handling
   * contract.
   */
  insertRampCustomer(input: {privyDid: string; customerId: string}): Promise<void>;
  setWalletId(privyDid: string, walletId: string): Promise<void>;
  setBankAccountId(privyDid: string, bankAccountId: string): Promise<void>;
  /**
   * Writes the pending `on_ramp` activity row for a just-created order —
   * mirrors `PaymentsRepo.recordPendingActivity` (`../payments/service.ts`)
   * and `VaultRepo.recordPendingActivity`'s shape (`../vault/service.ts`),
   * but with no `counterparty`: a PIX payin's BRL sender has no on-chain
   * identity this module tracks, so the inserted row's `counterparty` column
   * is always `null`.
   */
  recordPendingActivity(input: {
    stellarAddress: string;
    externalRef: string;
    type: 'on_ramp';
    direction: 'in';
    amount: string;
    assetCode: string;
    assetIssuer: string;
  }): Promise<void>;
  /**
   * The ONLY ownership mechanism for an order: Etherfuse's own
   * `order.customerId` is the PARTNER organization's id, not the merchant's
   * (a side effect of `claimOwnership`,
   * `docs/evidence/etherfuse-sandbox-findings.md` Conclusions §10), so
   * ownership is resolved against our own activity row instead.
   */
  findActivityByExternalRef(stellarAddress: string, externalRef: string): Promise<{id: string} | undefined>;
  /**
   * Creates a pending `'payout'`-kind signing intent for an anchor-mode
   * off-ramp withdrawal — mirrors `payments/service.ts`'s
   * `createPaymentIntent`, just with `kind: 'payout'` and a two-field
   * `metadata`: `orderId` (the Etherfuse anchor-mode submitter,
   * `./submitter.ts`, needs NO provider round-trip at completion time — it
   * resolved everything it needs at intent-creation time, see that module's
   * doc comment — so `orderId` isn't consumed by the submitter itself; it's
   * recorded so a future reconciliation pass, Task 6's poller, can
   * trace this intent back to the anchor order it pays) and
   * `activityExternalRef` — the GENERIC, kind-agnostic contract
   * `intents/service.ts`'s `complete()` reads (see `db/schema.ts`'s
   * `intents.metadata` doc comment): set to the SAME `'order:<orderId>'` key
   * `recordPendingPayoutActivity`'s `externalRef` uses below, so `complete()`
   * knows this intent's pending activity row is owned by an external
   * reconciler (the anchor order's fiat leg hasn't settled at submission
   * time) and only keeps its `txHash` current instead of confirming it.
   */
  createPayoutIntent(input: {
    privyDid: string;
    xdr: string;
    hashHex: string;
    metadata: {orderId: string; activityExternalRef: string};
  }): Promise<IntentRecord>;
  /**
   * Writes the pending `off_ramp` activity row for a just-created payout —
   * mirrors `recordPendingActivity` above, but `counterparty` is the anchor
   * account the merchant is about to pay (`OfframpAnchorDetails.withdrawAnchorAccount`),
   * not a caller-supplied value. `externalRef` uses the SAME `'order:<id>'`
   * convention `recordPendingActivity`/`findActivityByExternalRef` use for
   * payin — NOT the completing intent's own id — so a future order-based
   * reconciliation pass (Task 6's poller, which only knows the Etherfuse
   * order id, not this intent's id) can find this row the same way it finds
   * a payin's. The SAME value is also stamped onto the created intent's
   * `metadata.activityExternalRef` (see `createPayoutIntent` above) so
   * `intents/service.ts`'s `complete()` recognizes this row as
   * reconciler-owned and keeps it `'pending'` through submission instead of
   * confirming it — see that method's doc comment and
   * `docs/modules/api-intents.md`'s Gotchas for the full contract.
   */
  recordPendingPayoutActivity(input: {
    stellarAddress: string;
    externalRef: string;
    amount: string;
    assetCode: string;
    assetIssuer: string;
    counterparty: string;
  }): Promise<void>;
}

/** Production `RampRepo` backed by Drizzle over the real `merchants`/`ramp_customers`/`activity` tables. */
export function createDrizzleRampRepo(db: NodePgDatabase<typeof schema>): RampRepo {
  return {
    async getMerchant(privyDid) {
      const [row] = await db.select().from(merchants).where(eq(merchants.privyDid, privyDid));
      return row;
    },

    async getRampCustomer(privyDid) {
      const [row] = await db.select().from(rampCustomers).where(eq(rampCustomers.privyDid, privyDid));
      return row;
    },

    async insertRampCustomer({privyDid, customerId}) {
      // ON CONFLICT DO NOTHING on the privy_did PK: under a genuine race
      // between two concurrent startOnboarding() calls for the same merchant,
      // the loser's insert would otherwise surface as a raw Postgres
      // unique-violation (a generic 500), contradicting this module's
      // advertised idempotency. See `startOnboarding`'s doc comment.
      //
      // `provider` is written explicitly rather than relying on the
      // column's default — this insert is the source of truth for which
      // provider wrote the row, independent of whatever the schema default
      // happens to be.
      await db
        .insert(rampCustomers)
        .values({privyDid, provider: RAMP_PROVIDER, customerId})
        .onConflictDoNothing({target: rampCustomers.privyDid});
    },

    async setWalletId(privyDid, walletId) {
      await db.update(rampCustomers).set({blockchainWalletId: walletId, updatedAt: new Date()}).where(eq(rampCustomers.privyDid, privyDid));
    },

    async setBankAccountId(privyDid, bankAccountId) {
      await db.update(rampCustomers).set({bankAccountId, updatedAt: new Date()}).where(eq(rampCustomers.privyDid, privyDid));
    },

    async recordPendingActivity(input) {
      await db.insert(activity).values({
        stellarAddress: input.stellarAddress,
        type: input.type,
        direction: input.direction,
        amount: input.amount,
        assetCode: input.assetCode,
        assetIssuer: input.assetIssuer,
        counterparty: null,
        status: 'pending',
        txHash: null,
        source: 'api',
        externalRef: input.externalRef
      });
    },

    async findActivityByExternalRef(stellarAddress, externalRef) {
      const [row] = await db
        .select({id: activity.id})
        .from(activity)
        .where(and(eq(activity.stellarAddress, stellarAddress), eq(activity.externalRef, externalRef)));
      return row;
    },

    async createPayoutIntent({privyDid, xdr, hashHex, metadata}) {
      const [row] = await db.insert(intents).values({privyDid, kind: 'payout', xdr, hashHex, metadata}).returning();
      if (!row) throw new Error(`payout intent insert did not return a row for privyDid=${privyDid}`);
      return row;
    },

    async recordPendingPayoutActivity(input) {
      await db.insert(activity).values({
        stellarAddress: input.stellarAddress,
        type: 'off_ramp',
        direction: 'out',
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

export interface RampServiceDeps {
  repo: RampRepo;
  provider: RampProvider;
  /**
   * Server-derived post-KYC return URL (`${env.CORS_ORIGIN}/ramp/kyc-return`,
   * built in `app.ts`) — the client never supplies a redirect, so the hosted
   * launch has no open-redirect surface.
   */
  kycReturnUrl: string;
  /** Resolves `assetIssuer` for the pending payin activity rows. */
  registry: AssetRegistry;
  /**
   * The asset Etherfuse settles in on the active network — the CODE half of
   * `NetworkConfig.etherfuse.assetId`. Must resolve in `registry`, and must
   * be the same asset `etherfuse.ts` quotes against, or activity rows would
   * record a different asset than the provider actually moves.
   */
  assetCode: string;
  /**
   * The active Stellar network. Gates the sandbox-only deposit simulator:
   * `simulatePayin` 404s on anything but `'testnet'`. Structurally the same
   * union as `StellarNetwork` (`api/src/config/networks.ts`), declared here
   * so this module owns its own dependency shape.
   */
  networkName: 'testnet' | 'mainnet';
  /**
   * Stellar account access for `createPayout`'s anchor-mode payment build —
   * this module's first use of `StellarGateway` (payin needed none: Etherfuse
   * builds its own deposit instructions, but anchor-mode payout hands back
   * only an account + memo, and building the actual payment tx is THIS
   * module's job, mirroring `payments/service.ts`'s `createPayment`). Only
   * `loadAccount` is used — submission goes through `./submitter.ts`'s
   * `createPayoutSubmitter`, not this service.
   */
  gateway: StellarGateway;
  /** Passphrase for `createPayout`'s locally-built anchor payment transaction — must match `gateway`'s network. */
  networkPassphrase: string;
}

export interface RampService {
  /**
   * The derived onboarding ladder: `not_started` (no `ramp_customers` row),
   * `verifying` (row exists, live KYC not yet `approved`), `incomplete`
   * (approved but bank account and/or wallet still unregistered), `ready`
   * (both registered). Only the middle two cost a live provider call.
   */
  onboardingStatus(privyDid: string): Promise<RampOnboardingStatus>;
  /**
   * Creates the merchant's Etherfuse organization (idempotent: an existing
   * row skips creation) and returns fresh hosted-KYC launch parameters.
   */
  startOnboarding(privyDid: string, request: OnboardingStartRequest): Promise<KycLaunchResponse>;
  /** Fresh launch parameters for re-entry (a denied or abandoned KYC run) — 404 until onboarding has been started. */
  kycLaunch(privyDid: string, request: OnboardingStartRequest): Promise<KycLaunchResponse>;
  /**
   * Registers the merchant's BRL/PIX bank account and Stellar wallet, gated
   * on KYC being `approved`. Resumable per field: each step only runs when
   * its id is still unset.
   */
  completeSetup(privyDid: string, request: PixDetailsRequest): Promise<RampOnboardingStatus>;
  /** Quotes a BRL→token on-ramp. Requires onboarding `ready` — 409 `ramp_not_onboarded` otherwise. */
  payinQuote(privyDid: string, request: PayinQuoteRequest): Promise<RampQuoteResponse>;
  /**
   * Executes a previously-quoted payin as an Etherfuse order, then writes a
   * pending `on_ramp` activity row tagged `externalRef: 'order:<orderId>'`
   * (the row a later reconciliation pass — and every ownership check below —
   * matches on). `request.amountCents` is the CLIENT's echo of the quote's
   * own `receiverAmountCents` (`PayinExecuteRequestSchema`,
   * `@paltalabs/shared`) — this service never re-derives it via a provider
   * read-back (Etherfuse's `POST /ramp/order` response carries no
   * settlement amount at all, `provider.ts`'s `OnrampOrderState`). Etherfuse
   * validates the actual token delivery against the quote on its own side,
   * so a client that lies here only mislabels its own activity row, never
   * what actually settles — the same trust envelope the payout flow's
   * `{quoteId, amountCents}` design relies on. Requires onboarding `ready`.
   */
  createPayin(privyDid: string, request: PayinExecuteRequest): Promise<PayinOrderResponse>;
  /** Polls one of the caller's OWN orders; 404 `order_not_found` for anything else. */
  getPayinState(privyDid: string, orderId: string): Promise<PayinOrderStateResponse>;
  /** Testnet-only sandbox deposit simulator; 404 `not_found` on mainnet. */
  simulatePayin(privyDid: string, orderId: string): Promise<void>;
  /** Quotes a token→BRL anchor-mode off-ramp. Requires onboarding `ready` — 409 `ramp_not_onboarded` otherwise. */
  payoutQuote(privyDid: string, request: PayoutQuoteRequest): Promise<RampQuoteResponse>;
  /**
   * Executes a previously-quoted payout as a signing-flow intent:
   * `provider.createAnchorOfframpOrder` returns the anchor account + 32-byte
   * hash memo to pay (`OfframpAnchorDetails`) — unlike payin, Etherfuse's
   * anchor mode never hands back an unsigned transaction, just the
   * destination + memo, so THIS method builds the payment tx itself
   * (merchant-sourced, unsigned — the merchant must co-sign via Privy
   * `rawSign`, same contract as `payments/service.ts`'s `createPayment`).
   *
   * `request.amountCents` is the CLIENT's echo of the payout quote's own
   * sender-side amount (`PayoutExecuteRequestSchema`, `@paltalabs/shared`) —
   * this service never re-derives it via a provider read-back, mirroring
   * `createPayin`'s `request.amountCents` trust envelope exactly (see that
   * method's doc comment). The payout side's backstop is even stronger:
   * Etherfuse auto-refunds any anchor payment that doesn't match the order
   * server-side (`docs/evidence/etherfuse-sandbox-findings.md`'s
   * `## Anchor order`/`## Anchor payment & completion`), so a lying client
   * only gets its own payment refunded.
   *
   * The anchor order's memo MUST decode to exactly 32 bytes (live-verified
   * against the sandbox) — if it doesn't, this fails closed with a 502
   * `ramp_provider_error` (`reason: 'order_rejected'`) rather than building
   * and returning a payment with a memo Etherfuse can never match, which
   * would just get auto-refunded after burning a signing round-trip.
   *
   * Stores the created intent's `metadata.orderId` (NOT `quoteId` — this
   * submitter needs no provider round-trip at completion time, since anchor
   * mode already resolved everything it needs at intent-creation time, so
   * `orderId` is recorded purely for a future reconciliation pass, not
   * consumed by `./submitter.ts`) and writes a
   * pending `off_ramp` activity row tagged `externalRef: 'order:<orderId>'`
   * — see `RampRepo.recordPendingPayoutActivity`'s doc comment for why that
   * key (not the intent's own id) is used. Requires onboarding `ready`.
   */
  createPayout(privyDid: string, request: PayoutExecuteRequest): Promise<PayoutIntentResponse>;
}

/** `ready` requires both registration ids; otherwise `incomplete`. Callers with no row at all handle `not_started` separately. */
function statusForFields(blockchainWalletId: string | null, bankAccountId: string | null): 'incomplete' | 'ready' {
  return blockchainWalletId && bankAccountId ? 'ready' : 'incomplete';
}

/**
 * This module's client-facing amounts are integer cents; Etherfuse's are
 * decimal strings. Converts one to the other — also the shape
 * `RampRepo.recordPendingActivity`'s `amount` expects (mirrors
 * `activity.amount`'s text column, `../../db/schema.ts`) — e.g.
 * `centsToDecimal(1949) === '19.49'`, `centsToDecimal(5) === '0.05'`.
 * Exported (unlike this module's other private helpers) solely so it can be
 * unit-tested directly; not part of `RampService`'s public interface.
 */
export function centsToDecimal(cents: number): string {
  if (!Number.isInteger(cents) || cents < 0) {
    throw new Error(`centsToDecimal expects a non-negative integer number of cents, got ${cents}`);
  }
  const whole = Math.floor(cents / 100);
  const fraction = (cents % 100).toString().padStart(2, '0');
  return `${whole}.${fraction}`;
}

/**
 * The ramp module's business logic: Etherfuse onboarding (organization
 * creation, hosted-KYC launch, resumable bank-account + wallet registration)
 * and the BRL/PIX payin quote→order→poll flow. Decoupled from
 * Postgres/Etherfuse via `deps`, mirroring
 * `payments/service.ts`/`vault/service.ts`'s `createXxxService` shape.
 */
export function createRampService(deps: RampServiceDeps): RampService {
  const {repo, provider, kycReturnUrl, registry, assetCode, networkName, gateway, networkPassphrase} = deps;
  // The single settlement asset BOTH ramp directions use — resolved once,
  // not per-call, mirroring vault/service.ts's `asset` (fails fast here at
  // service-construction time on a misconfigured registry rather than
  // lazily on a merchant's first payin/payout). `createPayout` reuses this
  // SAME resolved asset for its Stellar payment op — see RampServiceDeps.assetCode's
  // doc comment ("must be the same asset etherfuse.ts sends as `token`").
  const payinAsset = registry.get(assetCode);

  async function requireMerchant(privyDid: string): Promise<MerchantRecord> {
    const merchant = await repo.getMerchant(privyDid);
    if (!merchant) {
      throw new AppError('merchant_not_found', 'call POST /wallet/provision first', 404);
    }
    return merchant;
  }

  /** The `ramp_customers` row, or 404 `ramp_not_started` — onboarding must have been started first. */
  async function requireRampCustomer(privyDid: string): Promise<RampCustomerRecord> {
    const row = await repo.getRampCustomer(privyDid);
    if (!row) {
      throw new AppError('ramp_not_started', 'call POST /ramp/onboarding/start first', 404);
    }
    return row;
  }

  /**
   * The payin methods all require the onboarding `ready` gate (a
   * `ramp_customers` row with both `blockchainWalletId` and `bankAccountId`
   * set — the same definition `statusForFields` uses, inlined here rather
   * than calling it so the null checks narrow the returned ids to non-null)
   * before touching the provider; otherwise 409 `ramp_not_onboarded`.
   */
  async function requireReadyRampCustomer(
    privyDid: string
  ): Promise<{customerId: string; blockchainWalletId: string; bankAccountId: string}> {
    const row = await repo.getRampCustomer(privyDid);
    if (!row || !row.blockchainWalletId || !row.bankAccountId) {
      throw new AppError('ramp_not_onboarded', 'complete POST /ramp/onboarding first', 409);
    }
    return {customerId: row.customerId, blockchainWalletId: row.blockchainWalletId, bankAccountId: row.bankAccountId};
  }

  /**
   * Runs a `RampProvider` call and maps a `RampProviderError` to a 502
   * `AppError` carrying the provider's sanitized `reason` token — mirrors
   * `vault/service.ts`'s `runProviderCall`, just forwarding `reason` instead
   * of a fixed detail string (this module's provider errors are already
   * client-safe short tokens, unlike Soroban's raw simulation diagnostics).
   */
  async function runProviderCall<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof RampProviderError) {
        // `cause` carries the provider's own error text for the SERVER LOG
        // only (the global error handler logs it at warn) — it never enters
        // the client envelope, which stays limited to the sanitized `reason`.
        throw Object.assign(new AppError('ramp_provider_error', 'ramp provider request failed', 502, {reason: err.reason}), {
          cause: err
        });
      }
      throw err;
    }
  }

  /** The hosted-KYC launch envelope: provider-signed parameters plus our own server-derived return URL. */
  function launchResponse(customerId: string, request: OnboardingStartRequest): KycLaunchResponse {
    const launch = provider.buildKycLaunch(customerId, {email: request.email, displayName: request.displayName});
    return {launch: {...launch, returnUrl: kycReturnUrl}};
  }

  /**
   * Resolves an order the CALLER owns, or 404 `order_not_found`. Ownership
   * lives entirely in our own `activity` row (`externalRef: 'order:<id>'`) —
   * Etherfuse's order payload cannot answer "whose order is this?" (its
   * `customerId` is the partner org's).
   */
  async function requireOwnedOrder(privyDid: string, orderId: string): Promise<void> {
    const merchant = await requireMerchant(privyDid);
    const row = await repo.findActivityByExternalRef(merchant.stellarAddress, `${ORDER_EXTERNAL_REF_PREFIX}${orderId}`);
    if (!row) {
      throw new AppError('order_not_found', 'no ramp order with that id for this merchant', 404);
    }
  }

  return {
    async onboardingStatus(privyDid) {
      const row = await repo.getRampCustomer(privyDid);
      if (!row) return {status: 'not_started'};
      // Both ids set means KYC was necessarily approved earlier (it gates
      // registration) — so a `ready` merchant costs no provider round-trip on
      // what is the most frequently polled endpoint in the module.
      if (row.blockchainWalletId && row.bankAccountId) return {status: 'ready'};

      const kycStatus = await runProviderCall(() => provider.getKycStatus(row.customerId));
      if (kycStatus !== 'approved') return {status: 'verifying'};
      return {status: statusForFields(row.blockchainWalletId, row.bankAccountId)};
    },

    async startOnboarding(privyDid, request) {
      const merchant = await requireMerchant(privyDid);
      if (!merchant.provisionedAt) {
        throw new AppError(
          'merchant_not_provisioned',
          'complete wallet provisioning before onboarding to the ramp provider',
          409
        );
      }

      const existing = await repo.getRampCustomer(privyDid);
      if (existing) return launchResponse(existing.customerId, request);

      // Concurrency: two simultaneous startOnboarding() calls for the same
      // privyDid can both reach this point (both saw no row) and both create
      // an Etherfuse organization. `repo.insertRampCustomer` is
      // conflict-tolerant (ON CONFLICT DO NOTHING on the privy_did PK), so
      // only the first insert persists — we re-read the row right after
      // inserting to discover which one won, and build the launch against ITS
      // customerId. The loser's own just-created organization is simply
      // abandoned (never persisted or referenced again) — avoiding that
      // duplicate entirely would need cross-request locking (e.g. a DB
      // advisory lock keyed by privyDid), which is out of scope here. This is
      // an accepted trade-off: a harmless orphaned organization is far better
      // than a raw Postgres unique-violation surfacing as a generic 500.
      const customerId = randomUUID();
      await runProviderCall(() =>
        provider.createOrganization({customerId, displayName: request.displayName, email: request.email})
      );
      await repo.insertRampCustomer({privyDid, customerId});
      const winner = await repo.getRampCustomer(privyDid);
      if (!winner) throw new Error(`ramp_customers row missing immediately after insert for privyDid=${privyDid}`);

      return launchResponse(winner.customerId, request);
    },

    async kycLaunch(privyDid, request) {
      const row = await requireRampCustomer(privyDid);
      return launchResponse(row.customerId, request);
    },

    async completeSetup(privyDid, request) {
      const row = await requireRampCustomer(privyDid);

      const kycStatus = await runProviderCall(() => provider.getKycStatus(row.customerId));
      if (kycStatus !== 'approved') {
        // Etherfuse rejects both registrations before approval anyway; this
        // gate turns that into a typed 409 instead of an opaque 502.
        throw new AppError('kyc_not_approved', 'identity verification is not approved yet', 409);
      }

      let bankAccountId = row.bankAccountId;
      let walletId = row.blockchainWalletId;

      // Resumable: each step only runs if its id is still unset, and its
      // result is persisted before the next step starts — so a retry after a
      // mid-flight provider failure resumes at the first missing piece
      // instead of re-running a completed step (Etherfuse allows only ONE BRL
      // bank account per organization, so re-running that one would hard-fail).
      if (!bankAccountId) {
        const registered = await runProviderCall(() =>
          provider.registerBankAccount(row.customerId, {
            // Server-generated idempotency key, never client-supplied.
            transactionId: randomUUID(),
            firstName: request.firstName,
            lastName: request.lastName,
            cpf: request.cpf,
            pixKey: request.pixKey,
            pixKeyType: request.pixKeyType
          })
        );
        bankAccountId = registered.bankAccountId;
        await repo.setBankAccountId(privyDid, bankAccountId);
      }

      if (!walletId) {
        const merchant = await requireMerchant(privyDid);
        const registered = await runProviderCall(() => provider.registerWallet(row.customerId, merchant.stellarAddress));
        walletId = registered.walletId;
        await repo.setWalletId(privyDid, walletId);
      }

      return {status: statusForFields(walletId, bankAccountId)};
    },

    async payinQuote(privyDid, request) {
      const {customerId} = await requireReadyRampCustomer(privyDid);
      const merchant = await requireMerchant(privyDid);
      const quote = await runProviderCall(() =>
        provider.createOnrampQuote({
          customerId,
          walletAddress: merchant.stellarAddress,
          amountBrl: centsToDecimal(request.amountBrlCents)
        })
      );
      return {
        quoteId: quote.quoteId,
        expiresAt: quote.expiresAt,
        senderAmountCents: quote.senderAmountCents,
        receiverAmountCents: quote.receiverAmountCents,
        flatFeeCents: quote.flatFeeCents,
        commercialQuotation: quote.commercialQuotation
      };
    },

    async createPayin(privyDid, request) {
      const {blockchainWalletId, bankAccountId} = await requireReadyRampCustomer(privyDid);
      const merchant = await requireMerchant(privyDid);

      // Order ids are generated here, never client-supplied — the same
      // convention as the quote/transaction ids, and what makes
      // `externalRef` a trustworthy ownership key below.
      const orderId = randomUUID();
      const order = await runProviderCall(() =>
        provider.createOnrampOrder({orderId, quoteId: request.quoteId, bankAccountId, cryptoWalletId: blockchainWalletId})
      );

      // Pending activity row, tagged with this order's id so the ownership
      // checks (`getPayinState`/`simulatePayin`) and a later reconciliation
      // pass can both match on `externalRef` — mirrors `payments/service.ts`'s
      // intent-id tagging convention. No `intents` row is created: a payin
      // has nothing for the merchant to sign. `request.amountCents` (the
      // client's echo of its own quote) is the amount recorded — the
      // provider's create response carries none to derive it from instead.
      await repo.recordPendingActivity({
        stellarAddress: merchant.stellarAddress,
        externalRef: `${ORDER_EXTERNAL_REF_PREFIX}${orderId}`,
        type: 'on_ramp',
        direction: 'in',
        amount: centsToDecimal(request.amountCents),
        assetCode: payinAsset.code,
        assetIssuer: payinAsset.issuer
      });

      return {
        orderId: order.orderId,
        // Etherfuse's create response carries no status — `created` is its
        // own implicit initial order state (`provider.ts`'s `OnrampOrderState`).
        status: 'created',
        deposit: order.deposit,
        receiverAmountCents: request.amountCents
      };
    },

    async getPayinState(privyDid, orderId) {
      await requireOwnedOrder(privyDid, orderId);
      const state = await runProviderCall(() => provider.getOrder(orderId));
      return {orderId: state.orderId, status: state.status, txHash: state.txHash};
    },

    async simulatePayin(privyDid, orderId) {
      // The deposit simulator only exists in Etherfuse's sandbox. On mainnet
      // the endpoint must be indistinguishable from one that was never
      // routed — hence a plain 404 checked BEFORE any lookup, not a 403.
      if (networkName !== 'testnet') {
        throw new AppError('not_found', 'not found', 404);
      }
      await requireOwnedOrder(privyDid, orderId);
      await runProviderCall(() => provider.simulateFiatReceived(orderId));
    },

    async payoutQuote(privyDid, request) {
      const {customerId} = await requireReadyRampCustomer(privyDid);
      const merchant = await requireMerchant(privyDid);
      const quote = await runProviderCall(() =>
        provider.createOfframpQuote({
          customerId,
          walletAddress: merchant.stellarAddress,
          amountToken: centsToDecimal(request.amountCents)
        })
      );
      return {
        quoteId: quote.quoteId,
        expiresAt: quote.expiresAt,
        senderAmountCents: quote.senderAmountCents,
        receiverAmountCents: quote.receiverAmountCents,
        flatFeeCents: quote.flatFeeCents,
        commercialQuotation: quote.commercialQuotation
      };
    },

    async createPayout(privyDid, request) {
      const {blockchainWalletId, bankAccountId} = await requireReadyRampCustomer(privyDid);
      const merchant = await requireMerchant(privyDid);

      // Order ids are generated here, never client-supplied — same
      // convention as createPayin's orderId.
      const orderId = randomUUID();
      const details = await runProviderCall(() =>
        provider.createAnchorOfframpOrder({orderId, quoteId: request.quoteId, bankAccountId, cryptoWalletId: blockchainWalletId})
      );

      // withdrawMemoBase64 MUST decode to exactly 32 bytes (Memo.hash's
      // fixed size; live-verified against the sandbox,
      // docs/evidence/etherfuse-sandbox-findings.md "## Anchor order"). A
      // mismatched memo would just get the payment auto-refunded by
      // Etherfuse ("## Anchor payment & completion") after burning a whole
      // signing round-trip — failing closed here, before the merchant is
      // ever asked to sign anything, is strictly cheaper.
      const memoBytes = Buffer.from(details.withdrawMemoBase64, 'base64');
      if (memoBytes.length !== 32) {
        throw new AppError('ramp_provider_error', 'anchor order memo did not decode to 32 bytes', 502, {
          reason: 'order_rejected'
        });
      }

      // Etherfuse's anchor-mode order returns no unsigned transaction (unlike
      // payin's deposit instructions) — just the destination + memo, so this
      // method builds the payment itself: merchant-sourced (live sequence
      // number from Horizon), deliberately UNSIGNED, same contract as
      // payments/service.ts's createPayment.
      const account = await gateway.loadAccount(merchant.stellarAddress);
      const amount = centsToDecimal(request.amountCents);
      const asset = new Asset(payinAsset.code, payinAsset.issuer);
      const tx = new TransactionBuilder(account, {fee: BASE_FEE, networkPassphrase})
        .addOperation(Operation.payment({destination: details.withdrawAnchorAccount, asset, amount}))
        .addMemo(Memo.hash(memoBytes.toString('hex')))
        .setTimeout(300)
        .build();

      const hashHex = txHashHex(tx);
      const xdr = tx.toXDR();

      // The LOCAL orderId (never the provider-echoed `details.orderId` —
      // nothing guarantees Etherfuse echoes back exactly what was sent, and
      // createPayin's equivalent externalRef is keyed the same way, off its
      // own locally-generated orderId, not the provider's echo). The SAME
      // key is used for both the intent's metadata (read by
      // intents/service.ts's generic activityExternalRef contract) and the
      // pending activity row's own externalRef — computed once so the two
      // can never drift from each other.
      const activityExternalRef = `${ORDER_EXTERNAL_REF_PREFIX}${orderId}`;

      const created = await repo.createPayoutIntent({
        privyDid,
        xdr,
        hashHex,
        metadata: {orderId, activityExternalRef}
      });

      // amount/counterparty come from what the merchant is about to sign
      // (ground truth), not blindly re-derived elsewhere. externalRef uses
      // the order-based key (not created.id) — see
      // RampRepo.recordPendingPayoutActivity's doc comment.
      await repo.recordPendingPayoutActivity({
        stellarAddress: merchant.stellarAddress,
        externalRef: activityExternalRef,
        amount,
        assetCode: payinAsset.code,
        assetIssuer: payinAsset.issuer,
        counterparty: details.withdrawAnchorAccount
      });

      return {intentId: created.id, xdr: created.xdr, hashHex: created.hashHex};
    }
  };
}
