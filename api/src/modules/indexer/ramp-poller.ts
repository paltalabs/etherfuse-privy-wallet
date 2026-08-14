import {and, eq, like, or} from 'drizzle-orm';
import type {NodePgDatabase} from 'drizzle-orm/node-postgres';
import type * as schema from '../../db/schema.js';
import {activity} from '../../db/schema.js';
import {RampProviderError, type RampProvider} from '../ramp/provider.js';

/** `activity.externalRef`'s order-tagging convention — `ramp/service.ts`'s `createPayin`/`createPayout` both write `` `order:${orderId}` `` (`ramp/service.ts:604`, `:725`). */
const ORDER_EXTERNAL_REF_PREFIX = 'order:';

/** Terminal-success order statuses (`provider.ts`'s `RampOrderStatus`) — confirm the activity row. */
const TERMINAL_SUCCESS = new Set(['completed', 'finalized']);
/** Terminal-failure order statuses — fail the activity row. */
const TERMINAL_FAILURE = new Set(['failed', 'refunded', 'canceled']);

/** Stellar's own fixed-point precision (stroops) — see `formatStellarAmount`'s doc comment. */
const STELLAR_DECIMALS = 7;

/**
 * Truncates (floors, never rounds) a non-negative decimal string to
 * Stellar's 7-fractional-digit precision, zero-padded to exactly that many
 * digits — the same shape every Horizon-sourced `activity.amount` value
 * already has (`normalize.ts`'s `ActivityInsert.amount`, e.g. `"10.0000000"`
 * — `HorizonPaymentRecord.amount` via `poller.ts`). Etherfuse's
 * `amountInTokens` carries up to 27 fractional digits, but the token amount
 * that actually lands on-chain is truncated to 7 decimals the instant it
 * settles: the sandbox's `amountInTokens: "19.620062792064687229069147940"`
 * delivered on Horizon as `"19.6200627"`
 * (`docs/evidence/etherfuse-sandbox-findings.md` "## Fiat received &
 * settlement") — dropping the excess fractional digits (floor) reproduces
 * that exactly; rounding would not.
 */
function formatStellarAmount(value: string): string {
  const match = /^(\d+)(?:\.(\d*))?$/.exec(value.trim());
  if (!match) throw new Error(`formatStellarAmount: expected a non-negative decimal string, got ${JSON.stringify(value)}`);
  const whole = match[1]!;
  const fraction = (match[2] ?? '').padEnd(STELLAR_DECIMALS, '0').slice(0, STELLAR_DECIMALS);
  return `${whole}.${fraction}`;
}

/** One pending `on_ramp`/`off_ramp` activity row this poller reconciles. */
export interface PendingOrderActivity {
  id: string;
  type: 'on_ramp' | 'off_ramp';
  externalRef: string;
}

/**
 * Persistence boundary for the ramp-status poller — deliberately narrow
 * (mirroring `poller.ts`'s `IndexerRepo`/`IndexerTx` split for the Horizon
 * poller) so `ramp-poller.test.ts` can fake it in-memory instead of a live
 * Postgres.
 */
export interface RampPollerRepo {
  /** Activity rows with `status: 'pending'`, `type IN ('on_ramp', 'off_ramp')`, and `externalRef LIKE 'order:%'` — anything else is out of scope for this poller. */
  listPendingOrderActivity(): Promise<PendingOrderActivity[]>;
  /**
   * `on_ramp`-only: flips the row to `'confirmed'`, sets `txHash` to
   * whatever the provider reported (including `null` — the sandbox's
   * completed onramp orders carry none at all, see Gotchas in
   * `docs/modules/api-indexer.md`), and overwrites `amount` ONLY when
   * non-null — a `null` here means the order read carried no
   * `amountInTokens` (every status but `completed`), so the row's existing
   * CLIENT-echoed amount (`ramp/service.ts`'s `createPayin`) is left as the
   * best-available figure rather than clobbered with nothing.
   */
  confirmOnRamp(id: string, input: {txHash: string | null; amount: string | null}): Promise<void>;
  /**
   * `off_ramp`-only: flips the row to `'confirmed'` and touches NOTHING
   * else — an off-ramp order's own `confirmedTxSignature` is Etherfuse's
   * internal transaction, never the merchant's payment hash
   * (`docs/evidence/etherfuse-sandbox-findings.md` "## Anchor payment &
   * completion"), and the row's `txHash`/`amount` were already set
   * correctly at submit time (`ramp/service.ts`'s `createPayout`).
   */
  confirmOffRamp(id: string): Promise<void>;
  /** Flips either row type to `'failed'`. */
  markFailed(id: string): Promise<void>;
}

/** Production `RampPollerRepo` backed by Drizzle over the real `activity` table. */
export function createDrizzleRampPollerRepo(db: NodePgDatabase<typeof schema>): RampPollerRepo {
  return {
    async listPendingOrderActivity() {
      const rows = await db
        .select({id: activity.id, type: activity.type, externalRef: activity.externalRef})
        .from(activity)
        .where(
          and(
            eq(activity.status, 'pending'),
            or(eq(activity.type, 'on_ramp'), eq(activity.type, 'off_ramp')),
            like(activity.externalRef, `${ORDER_EXTERNAL_REF_PREFIX}%`)
          )
        );
      // `type`/`externalRef` are widened/nullable at the schema level; the
      // WHERE clause above already excludes anything else at the SQL layer,
      // so this is a type-narrowing, not a real filter.
      return rows.flatMap((row) =>
        (row.type === 'on_ramp' || row.type === 'off_ramp') && row.externalRef
          ? [{id: row.id, type: row.type, externalRef: row.externalRef}]
          : []
      );
    },

    async confirmOnRamp(id, {txHash, amount}) {
      await db
        .update(activity)
        .set({status: 'confirmed', txHash, ...(amount !== null ? {amount} : {})})
        .where(eq(activity.id, id));
    },

    async confirmOffRamp(id) {
      await db.update(activity).set({status: 'confirmed'}).where(eq(activity.id, id));
    },

    async markFailed(id) {
      await db.update(activity).set({status: 'failed'}).where(eq(activity.id, id));
    }
  };
}

export interface RampPollerDeps {
  repo: RampPollerRepo;
  provider: Pick<RampProvider, 'getOrder'>;
}

export interface RampPollCycleSummary {
  /** Rows flipped to `'confirmed'` or `'failed'` this cycle — a `created`/`funded` row left pending does not count. */
  updated: number;
}

export interface RampPoller {
  /** One poll cycle: fetch every pending on_ramp/off_ramp order-tagged activity row, `getOrder` each, apply the resulting state. */
  pollOnce(): Promise<RampPollCycleSummary>;
}

/**
 * Builds the ramp-status poller: the sibling of `poller.ts`'s Horizon
 * poller, reconciling what Horizon can't see — (a) a payin's fiat/pix leg
 * through its full order lifecycle (`on_ramp` rows), and (b) an off-ramp
 * order's fiat-side exception states — refund/cancel — for a payout row
 * that is STILL pending when this poller looks (most `off_ramp` rows are
 * already `'confirmed'` by the time this runs, via `poller.ts`'s cross-type
 * dedupe — see `docs/modules/api-indexer.md`'s Gotchas for the full division
 * of labor). Every pending `on_ramp`/`off_ramp` row tagged
 * `externalRef: 'order:<id>'` is re-checked against `provider.getOrder` each
 * cycle: `completed`/`finalized` confirms it (on_ramp also gets its txHash
 * and, when the provider supplied one, its amount overwritten from the
 * order's own `amountInTokens`; off_ramp is confirmed with NO other column
 * touched), `failed`/`refunded`/`canceled` marks it failed, and
 * `created`/`funded` leave it untouched for the next cycle — sandbox orders
 * have been observed to sit at `funded` for 2+ hours with no deadline, so
 * there is deliberately no timeout logic here.
 */
export function createRampPoller(deps: RampPollerDeps): RampPoller {
  const {repo, provider} = deps;

  return {
    async pollOnce() {
      const rows = await repo.listPendingOrderActivity();
      let updated = 0;

      for (const row of rows) {
        // Defense in depth — the production repo's own query already filters
        // to `externalRef LIKE 'order:%'`, but a fake repo (or a future
        // caller of this same interface) isn't guaranteed to, and slicing an
        // unprefixed ref below would silently hand a garbage id to the
        // provider.
        if (!row.externalRef.startsWith(ORDER_EXTERNAL_REF_PREFIX)) continue;
        const orderId = row.externalRef.slice(ORDER_EXTERNAL_REF_PREFIX.length);

        let state;
        try {
          state = await provider.getOrder(orderId);
        } catch (err) {
          // A single bad row (e.g. a transient Etherfuse error) must not
          // stall the rest of the batch — log and move on to the next row,
          // same resilience stance as worker.ts's per-cycle catch. Anything
          // other than RampProviderError is an unexpected/programmer-error
          // condition and is left to propagate, to be caught by worker.ts's
          // own per-poller try/catch instead.
          if (err instanceof RampProviderError) {
            console.error(`[ramp-poller] getOrder failed for activity ${row.id} (order ${orderId}), reason=${err.reason}:`, err.message);
            continue;
          }
          throw err;
        }

        if (TERMINAL_SUCCESS.has(state.status)) {
          if (row.type === 'on_ramp') {
            await repo.confirmOnRamp(row.id, {
              txHash: state.txHash,
              amount: state.amountTokens !== null ? formatStellarAmount(state.amountTokens) : null
            });
          } else {
            await repo.confirmOffRamp(row.id);
          }
          updated++;
        } else if (TERMINAL_FAILURE.has(state.status)) {
          await repo.markFailed(row.id);
          updated++;
        }
        // 'created' | 'funded' — leave pending, re-checked next cycle.
      }

      return {updated};
    }
  };
}
