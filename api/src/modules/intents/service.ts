import type {CompleteIntentResponse} from '@paltalabs/shared';
import {Transaction, TransactionBuilder} from '@stellar/stellar-sdk';
import type {FeeBumpTransaction} from '@stellar/stellar-sdk';
import {and, eq, type InferSelectModel} from 'drizzle-orm';
import type {NodePgDatabase} from 'drizzle-orm/node-postgres';
import type * as schema from '../../db/schema.js';
import {activity, intents, merchants} from '../../db/schema.js';
import {AppError} from '../../lib/errors.js';
import {attachRawSignature, txHashHex} from '../sponsor/stellar.js';
import {StaleSequenceError, SubmissionFailedError} from '../sponsor/submit.js';

export type IntentRecord = InferSelectModel<typeof intents>;
export type MerchantRecord = InferSelectModel<typeof merchants>;

/** The intent kinds this module can complete — mirrors `intents.kind`'s widened `$type` union (`db/schema.ts`). */
export type IntentKind = IntentRecord['kind'];

/**
 * Activity-row `type` values a signing-flow completion can write. Narrower
 * than `activity.type`'s full widened union (`db/schema.ts`) — `'receive'`
 * and `'on_ramp'` are written by other producers (the indexer, a future
 * on-ramp module), never by an `IntentSubmitter`.
 */
export type IntentActivityType = 'provision' | 'send' | 'off_ramp' | 'vault_deposit' | 'vault_withdraw';

/**
 * An activity row this module writes — on a confirmed submission (`status:
 * 'confirmed'`, real `txHash`) or a failed one (`status: 'failed'`, `txHash:
 * null` — nothing confirmed on-chain to point at). `externalRef` is always
 * the completing intent's id: `recordActivity` uses it to find and UPDATE a
 * pre-existing `'pending'` row (written by the intent's creator, e.g.
 * `payments/service.ts`) in place instead of inserting a second row — see
 * `recordActivity`'s doc comment.
 */
export interface ActivityInput {
  stellarAddress: string;
  type: IntentActivityType;
  status: 'confirmed' | 'failed';
  source: 'api';
  txHash: string | null;
  externalRef: string;
}

/**
 * One intent kind's submission strategy — the boundary `complete()` routes
 * through instead of a hardcoded kind branch, so adding a new intent kind
 * (payout, vault deposit/withdraw) means registering a new `IntentSubmitter`
 * in `IntentsServiceDeps.submitters`, not editing `complete()` itself.
 *
 * `buildSubmission` MUST be deterministic for a given signed inner tx --
 * `complete()` hashes its output BEFORE calling `submit` (closes the
 * crash-window gap `updateActivityTxHash` exists for) and that hash must
 * equal the eventually-submitted tx's own network hash. `wrapFeeBump`
 * (`createPaymentSubmitter`'s `buildSubmission`) is verified deterministic
 * for exactly this reason — see `docs/modules/api-sponsor.md`'s Gotchas.
 */
export interface IntentSubmitter {
  /** Activity row `type` this kind reconciles to on completion/failure. */
  activityType: IntentActivityType;
  buildSubmission(inner: Transaction): Transaction | FeeBumpTransaction;
  /** Submit the BUILT tx (the same instance `buildSubmission` returned — never rebuilt). Throws `StaleSequenceError`/`SubmissionFailedError` (`../sponsor/submit.js`) on failure. */
  submit(built: Transaction | FeeBumpTransaction, ctx: {intent: IntentRecord; merchant: MerchantRecord}): Promise<{txHash: string}>;
}

/**
 * Persistence boundary for the intents module — deliberately narrower than
 * raw Drizzle access so `service.ts` can be unit-tested with an in-memory
 * fake instead of a live Postgres (`service.test.ts`), mirroring
 * `wallet/service.ts`'s `WalletRepo` pattern. Queries the same
 * `merchants`/`intents` tables `WalletRepo` does (plus `activity`) directly
 * — deliberately not routed through `wallet`'s repo, to keep the two
 * sibling modules decoupled.
 */
export interface IntentsRepo {
  /**
   * Scoped to (id, privyDid) in a single query, so an intent that exists
   * but belongs to someone else is indistinguishable from a nonexistent
   * one — callers must respond 404, never 403 (see `service.ts`'s
   * `complete`). Plain read, no status filter and no side effect — use
   * `claimIntent` for the atomic pending -> submitting transition.
   */
  getOwnedIntent(id: string, privyDid: string): Promise<IntentRecord | undefined>;
  /**
   * Atomically claims a pending intent for submission: a compare-and-swap
   * `'pending' -> 'submitting'` transition (`UPDATE ... WHERE id = $id AND
   * privy_did = $privyDid AND status = 'pending' RETURNING *` in the Drizzle
   * impl). Returns the claimed row on success; returns `undefined` if the
   * intent wasn't in `'pending'` status at the moment of the update (already
   * claimed/submitted/failed, or a concurrent caller won the race first) —
   * see `service.ts`'s `complete` for how callers must re-check status on a
   * failed claim, and `docs/modules/api-intents.md`'s Gotchas for the full
   * TOCTOU rationale.
   */
  claimIntent(id: string, privyDid: string): Promise<IntentRecord | undefined>;
  getMerchant(privyDid: string): Promise<MerchantRecord | undefined>;
  markSubmitted(id: string, resultTxHash: string): Promise<void>;
  markFailed(id: string, error: string): Promise<void>;
  markMerchantProvisioned(privyDid: string): Promise<void>;
  /**
   * Upsert-by-`externalRef` semantics: if an activity row already exists
   * with `externalRef === input.externalRef` (written at intent-creation
   * time by the intent's producer, e.g. a pending 'send' row from
   * `payments/service.ts`), UPDATE that row's `status`/`txHash` in place
   * rather than inserting a new one — avoids a permanent pending+confirmed
   * (or pending+failed) double row for the same payment. No matching row
   * (e.g. `wallet/service.ts`'s `provision()` never writes a pending
   * activity row) falls back to a plain INSERT, unchanged from this
   * method's pre-`externalRef` behavior.
   */
  recordActivity(input: ActivityInput): Promise<void>;
  /**
   * Writes the exact tx hash that is ABOUT to be submitted onto the pending
   * activity row (matched on `externalRef` AND `stellarAddress` -- the same
   * ownership pairing `recordActivity` is keyed on) BEFORE the
   * `IntentSubmitter`'s `submit` is ever called. Closes a crash window: if
   * the process dies after Horizon accepts the submission but before `markSubmitted`/
   * `recordActivity` run (two separate, non-transactional `await`s), the
   * row would otherwise be stuck at `status: 'pending'`, `txHash: null`
   * forever -- the indexer's dedupe-by-`(txHash, stellarAddress, type)`
   * can never match a `NULL` txHash, so it would insert a second,
   * `source: 'indexer'` row once it saw the payment confirm on-chain
   * instead of reconciling this one. With the hash pre-written, that same
   * crash leaves a row the indexer CAN match by txHash, flipping it to
   * `'confirmed'` with no duplicate. A no-op for `'provision'`-kind intents
   * (`wallet/service.ts`'s `provision()` never writes a pending activity
   * row, so there is nothing to match) and safe to call unconditionally.
   */
  updateActivityTxHash(externalRef: string, stellarAddress: string, txHash: string): Promise<void>;
}

/** Production `IntentsRepo` backed by Drizzle over the real `intents`/`merchants`/`activity` tables. */
export function createDrizzleIntentsRepo(db: NodePgDatabase<typeof schema>): IntentsRepo {
  return {
    async getOwnedIntent(id, privyDid) {
      const [row] = await db
        .select()
        .from(intents)
        .where(and(eq(intents.id, id), eq(intents.privyDid, privyDid)));
      return row;
    },

    async claimIntent(id, privyDid) {
      const [row] = await db
        .update(intents)
        .set({status: 'submitting', updatedAt: new Date()})
        .where(and(eq(intents.id, id), eq(intents.privyDid, privyDid), eq(intents.status, 'pending')))
        .returning();
      return row;
    },

    async getMerchant(privyDid) {
      const [row] = await db.select().from(merchants).where(eq(merchants.privyDid, privyDid));
      return row;
    },

    async markSubmitted(id, resultTxHash) {
      await db.update(intents).set({status: 'submitted', resultTxHash, updatedAt: new Date()}).where(eq(intents.id, id));
    },

    async markFailed(id, error) {
      await db.update(intents).set({status: 'failed', error, updatedAt: new Date()}).where(eq(intents.id, id));
    },

    async markMerchantProvisioned(privyDid) {
      await db.update(merchants).set({provisionedAt: new Date()}).where(eq(merchants.privyDid, privyDid));
    },

    async recordActivity(input) {
      const [existing] = await db.select().from(activity).where(eq(activity.externalRef, input.externalRef));
      if (existing) {
        await db.update(activity).set({status: input.status, txHash: input.txHash}).where(eq(activity.id, existing.id));
        return;
      }
      await db.insert(activity).values(input);
    },

    async updateActivityTxHash(externalRef, stellarAddress, txHash) {
      await db
        .update(activity)
        .set({txHash})
        .where(and(eq(activity.externalRef, externalRef), eq(activity.stellarAddress, stellarAddress)));
    }
  };
}

export interface IntentsServiceDeps {
  repo: IntentsRepo;
  networkPassphrase: string;
  /**
   * Kind-keyed submission strategies (`../sponsor/submit.js`'s
   * `createProvisionSubmitter`/`createPaymentSubmitter` today; a future
   * payout/vault module fills in the rest). `Partial` because not every
   * `IntentKind` has a registered submitter yet — `complete()` treats a
   * missing entry for a claimed intent's kind as an integrity bug (a plain
   * `Error`, not a client-facing `AppError`), since an intent should never
   * exist for a kind this deployment can't submit.
   */
  submitters: Partial<Record<IntentKind, IntentSubmitter>>;
}

export interface IntentsService {
  /**
   * Complete a pending signing-flow intent: attach the merchant's raw
   * signature, submit via the kind's registered `IntentSubmitter`, and
   * update the intent/merchant/activity records accordingly.
   */
  complete(privyDid: string, intentId: string, signature: string): Promise<CompleteIntentResponse>;
}

/**
 * Builds the 409 `AppError` for a non-`'pending'` intent — shared between
 * `complete`'s fast-path status check and its post-claim-failure fallback
 * (see `complete`'s doc comment for why both exist). Callers must only
 * invoke this for an intent already known to be non-`'pending'`.
 */
function nonPendingStatusError(intent: IntentRecord): AppError {
  if (intent.status === 'failed') {
    return new AppError('intent_failed', 'intent already failed and cannot be retried; request a new intent', 409, {
      reason: intent.error
    });
  }
  // 'submitted' or 'submitting' — both mean "someone already has this
  // intent moving; do not resubmit". `resultTxHash` is only non-null once
  // 'submitted', but including it either way is harmless (null while
  // 'submitting').
  return new AppError('intent_already_submitted', 'intent has already been submitted', 409, {
    resultTxHash: intent.resultTxHash
  });
}

/**
 * The generic signing-flow completion service: attaches a merchant's raw
 * Privy signature to a pending intent's transaction, submits it via the
 * claimed intent's registered `IntentSubmitter` (`deps.submitters`), and
 * updates persistence accordingly.
 */
export function createIntentsService(deps: IntentsServiceDeps): IntentsService {
  const {repo, networkPassphrase, submitters} = deps;

  return {
    async complete(privyDid, intentId, signature) {
      // Ownership check baked into the query itself: a wrong-owner intent
      // and a nonexistent one both resolve to `undefined` here, so both
      // produce the SAME 404 — never revealing that an intent exists for
      // another caller.
      const intent = await repo.getOwnedIntent(intentId, privyDid);
      if (!intent) {
        throw new AppError('intent_not_found', 'intent not found', 404);
      }

      // Fast-path exit for the common case (already done, no need to parse
      // XDR/verify a signature/touch the gateway at all). This check alone
      // is NOT the correctness boundary against concurrent completions of
      // the SAME intent — see the atomic claim below for that.
      if (intent.status !== 'pending') {
        throw nonPendingStatusError(intent);
      }

      const merchant = await repo.getMerchant(privyDid);
      if (!merchant) {
        // Integrity invariant: intents.privyDid has a NOT NULL FK to
        // merchants.privyDid (see db/schema.ts), so a well-formed intent
        // always has a merchant row. Not a client-facing error.
        throw new Error(`intent ${intent.id} references a merchant that does not exist: ${privyDid}`);
      }

      const parsed = TransactionBuilder.fromXDR(intent.xdr, networkPassphrase);
      // Stored intents are always inner (non-fee-bump) transactions — see
      // wallet/service.ts's provision() building/storing a plain
      // Transaction. fromXDR's return type is a union only because
      // arbitrary XDR could in principle be either.
      if (!(parsed instanceof Transaction)) {
        throw new Error(`intent ${intent.id}'s stored XDR is a FeeBumpTransaction, expected a Transaction`);
      }
      const tx = parsed;

      try {
        attachRawSignature(tx, merchant.stellarAddress, signature);
      } catch {
        // Invalid signature: the intent STAYS pending so the client can
        // retry with a correct signature — no repo mutation here. This
        // happens BEFORE the atomic claim below on purpose: signature
        // verification has no side effects and doesn't touch the gateway,
        // so there's nothing to "protect" here with a claim, and claiming
        // first would leave the intent stuck in 'submitting' forever (the
        // claim only ever moves 'pending' -> 'submitting', never back).
        throw new AppError('invalid_signature', 'signature does not verify against the intent transaction', 400);
      }

      // Atomic claim — the actual TOCTOU correctness boundary. Two
      // concurrent `complete` calls for the SAME intent can both reach this
      // point having both observed 'pending' above; this compare-and-swap
      // (`UPDATE ... WHERE status = 'pending'` in the Drizzle impl) is a
      // single atomic statement at the database, so only one of them
      // actually transitions the row and gets it back. The loser's claim
      // resolves to `undefined` and must re-check the row's now-current
      // status to respond correctly — it never reaches the gateway, so
      // activity rows can't double-write and the intent can't be
      // double-submitted.
      const claimed = await repo.claimIntent(intent.id, privyDid);
      if (!claimed) {
        const current = await repo.getOwnedIntent(intent.id, privyDid);
        // Unreachable in practice (nothing deletes intents once created),
        // but fail closed with the same 404 rather than crash if it ever
        // happens.
        if (!current) throw new AppError('intent_not_found', 'intent not found', 404);
        throw nonPendingStatusError(current);
      }

      // Route by kind to this intent's submission strategy. A missing entry
      // means an intent exists for a kind this deployment never registered
      // a submitter for -- an integrity bug (the intent-producing module and
      // app.ts's submitters map have drifted), not a client-facing error,
      // so this is a plain Error (-> generic 500), same treatment as the
      // "merchant does not exist" integrity check above.
      const submitter = submitters[claimed.kind];
      if (!submitter) {
        throw new Error(`no IntentSubmitter registered for intent kind "${claimed.kind}" (intent ${claimed.id})`);
      }

      // Build the EXACT tx about to be submitted and compute its hash
      // BEFORE calling the gateway, writing it onto any pre-existing
      // pending activity row now. `buildSubmission` is required to be
      // deterministic (see `IntentSubmitter`'s doc comment) -- e.g.
      // `createPaymentSubmitter`'s `wrapFeeBump` verified byte-identical
      // across repeated calls with the same inputs (same feeSource/baseFee/
      // already-signed inner tx; a tx's hash excludes its OWN signatures) --
      // so `submit` below receiving this exact `built` instance (never
      // rebuilt) always yields the same hash we precompute here.
      // `.replace(/^0x/, '')`: txHashHex 0x-prefixes for Privy's rawSign,
      // but activity.txHash must match Horizon's own (unprefixed) hash
      // format -- the same format `result.txHash`/the indexer's
      // `HorizonPaymentRecord.transactionHash` use -- or the indexer's
      // dedupe-by-txHash match would never fire.
      const built = submitter.buildSubmission(tx);
      const precomputedTxHash = txHashHex(built).replace(/^0x/, '');

      // GENERIC, KIND-AGNOSTIC CONTRACT (not a payout special-case baked into
      // this function): an intent whose metadata carries `activityExternalRef`
      // declares that its pending activity row was NOT tagged with this
      // intent's own id (`externalRef: claimed.id`, every other kind's
      // convention) but with a DIFFERENT external key instead -- for
      // `'payout'` today, `'order:<orderId>'`, the same key `createPayin`'s
      // `on_ramp` row and `requireOwnedOrder` use (`ramp/service.ts`). This
      // const MUST be resolved BEFORE the pre-submission write immediately
      // below, and that write MUST key on it too (not just the post-submit
      // writes further down) -- getting this wrong silently drops the
      // crash-window protection that write exists for: if it stayed hardcoded
      // to `claimed.id` for a reconciler-keyed row, that id never matches the
      // row's real `externalRef`, so a crash between Horizon accepting the
      // submission and the post-submit write below would leave the row
      // `txHash: null` forever -- the indexer's Horizon poller
      // (`indexer/poller.ts`) then can't cross-type-dedupe the eventual
      // matching payment against it (see that poller's Gotchas) and inserts
      // a duplicate `'send'` row instead. When `activityExternalRef` is
      // absent (every kind besides `'payout'` today), `?? claimed.id` makes
      // every write below byte-for-byte what it always was.
      const activityExternalRef = claimed.metadata?.activityExternalRef;
      await repo.updateActivityTxHash(activityExternalRef ?? claimed.id, merchant.stellarAddress, precomputedTxHash);

      let result;
      try {
        result = await submitter.submit(built, {intent: claimed, merchant});
      } catch (err) {
        if (err instanceof StaleSequenceError) {
          await repo.markFailed(claimed.id, 'stale_sequence');
          await repo.recordActivity({
            stellarAddress: merchant.stellarAddress,
            type: submitter.activityType,
            status: 'failed',
            source: 'api',
            txHash: null,
            externalRef: activityExternalRef ?? claimed.id
          });
          throw new AppError('intent_expired', 'the intent is stale; request a new one', 409);
        }
        if (err instanceof SubmissionFailedError) {
          await repo.markFailed(claimed.id, err.reason);
          await repo.recordActivity({
            stellarAddress: merchant.stellarAddress,
            type: submitter.activityType,
            status: 'failed',
            source: 'api',
            txHash: null,
            externalRef: activityExternalRef ?? claimed.id
          });
          throw new AppError('submission_failed', 'transaction submission failed', 502, {reason: err.reason});
        }
        throw err;
      }

      await repo.markSubmitted(claimed.id, result.txHash);
      if (activityExternalRef) {
        // This flow deliberately does NOT confirm a reconciler-keyed row
        // itself -- it only makes sure the row's txHash is current, same as
        // the pre-submission write above. The row does NOT stay pending
        // forever: `indexer/poller.ts`'s Horizon-payments poller confirms
        // the ON-CHAIN leg itself, the moment it next sees this exact
        // (txHash, stellarAddress) pair as an outgoing payment -- the SAME
        // mechanism that confirms every other pending activity row this
        // codebase writes (`RAMP_OWNER_TYPE`'s cross-type dedupe check,
        // `indexer/poller.ts`). What a FUTURE order-status reconciler (not
        // built yet) actually owns is the FIAT-side exception path: a row
        // still pending because Etherfuse refunded/canceled the order before
        // any matching payment ever landed on-chain -- see
        // `docs/modules/api-ramp.md`'s payout Gotchas.
        await repo.updateActivityTxHash(activityExternalRef, merchant.stellarAddress, result.txHash);
      } else {
        await repo.recordActivity({
          stellarAddress: merchant.stellarAddress,
          type: submitter.activityType,
          status: 'confirmed',
          source: 'api',
          txHash: result.txHash,
          externalRef: claimed.id
        });
      }
      if (claimed.kind === 'provision') {
        await repo.markMerchantProvisioned(privyDid);
      }

      return {txHash: result.txHash};
    }
  };
}
