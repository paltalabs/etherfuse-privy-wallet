import type {AssetRegistry} from '@paltalabs/shared';
import {and, eq, isNotNull} from 'drizzle-orm';
import type {NodePgDatabase} from 'drizzle-orm/node-postgres';
import type * as schema from '../../db/schema.js';
import {activity, cursors, merchants} from '../../db/schema.js';
import type {StellarGateway} from '../../lib/stellar-gateway.js';
import {normalizePayment, type ActivityInsert} from './normalize.js';

/** Horizon page size per merchant per poll cycle, when `PollerDeps.batchSize` is not given. */
const DEFAULT_BATCH_SIZE = 50;

/**
 * A normalized `'receive'`/`'send'` record's ramp-owned sibling type — a
 * pix payin settling to the merchant's Stellar address, or a Stellar payout
 * leaving it, shows up in Horizon's payments feed as a plain payment, but
 * `ramp/service.ts`'s `createPayin`/`createPayout` already wrote its own
 * `'on_ramp'`/`'off_ramp'` activity row for that same `(txHash,
 * stellarAddress)` pair before or after Horizon confirms it. `pollMerchant`
 * checks this map before `insertActivity` so that row isn't double-counted
 * as a second, indexer-sourced `'receive'`/`'send'` row — see
 * `docs/modules/api-indexer.md`'s Gotchas for the residual race this does
 * NOT close (a settlement Horizon sees before the ramp poller has written
 * the pending row's txHash).
 */
const RAMP_OWNER_TYPE: Partial<Record<ActivityInsert['type'], 'on_ramp' | 'off_ramp'>> = {
  receive: 'on_ramp',
  send: 'off_ramp'
};

/** Cursor-store key for one merchant's payments-feed poll position — `cursors.key`, `db/schema.ts`. */
function cursorKey(stellarAddress: string): string {
  return `horizon-payments:${stellarAddress}`;
}

/**
 * The activity types a `findActivity` lookup can query — the indexer's own
 * three normalized types (`ActivityInsert['type']`), plus the two
 * ramp-owned types (`'on_ramp'`/`'off_ramp'`) the cross-type dedupe check in
 * `pollMerchant` queries against (see `RAMP_OWNER_TYPE` and Gotchas in
 * `docs/modules/api-indexer.md`). Widening this union (rather than adding a
 * new `IndexerTx` method) is deliberate — the ramp check is just a second
 * call to the SAME lookup with a different `type` argument.
 */
export type QueryableActivityType = ActivityInsert['type'] | 'on_ramp' | 'off_ramp';

/**
 * Per-record operations run INSIDE the single transaction a batch is applied
 * in (`IndexerRepo.withTransaction`) — a narrow interface (mirroring this
 * codebase's other `XxxRepo` boundaries, e.g. `intents/service.ts`'s
 * `IntentsRepo`) so `poller.test.ts` can fake it in-memory instead of a live
 * Postgres, while still being able to assert every call happens between the
 * fake's "transaction start"/"transaction end" markers.
 */
export interface IndexerTx {
  /** Dedupe lookup — `pollMerchant` uses this to decide update-vs-insert for one normalized record, and a second time (with a ramp-owned type) for the cross-type dedupe check. */
  findActivity(
    txHash: string,
    stellarAddress: string,
    type: QueryableActivityType
  ): Promise<{id: string; status: string} | undefined>;
  /** Flips a `'pending'` row (written by the API path — e.g. `payments/service.ts`'s pending 'send') to `'confirmed'`. Never called for a row already `'confirmed'`/`'failed'`. */
  confirmActivity(id: string): Promise<void>;
  insertActivity(record: ActivityInsert): Promise<void>;
  /** Upsert-by-`key` — one row per polled stream (`cursors.key` is the primary key). */
  upsertCursor(key: string, value: string): Promise<void>;
}

/** A provisioned merchant the poller iterates — narrowed to what it needs. */
export interface ProvisionedMerchant {
  stellarAddress: string;
}

/**
 * Persistence boundary for the indexer module — deliberately narrower than
 * raw Drizzle access, mirroring `wallet`/`intents`/`payments`/`history`'s
 * `XxxRepo` pattern (`docs/modules/api-wallet.md` etc.).
 */
export interface IndexerRepo {
  /** `merchants` rows with `provisionedAt IS NOT NULL` — an unprovisioned merchant has no on-chain account to poll yet. */
  listProvisionedMerchants(): Promise<ProvisionedMerchant[]>;
  getCursor(key: string): Promise<string | undefined>;
  /**
   * Runs `fn` inside a single DB transaction — the production impl wraps
   * Drizzle's `db.transaction` (`createDrizzleIndexerRepo`, below), so a
   * batch's activity writes and its cursor advance commit atomically: a
   * crash mid-batch never advances the cursor past unwritten activity rows.
   * Re-polling the same batch after such a crash is safe/idempotent —
   * `findActivity`'s dedupe-by-`(txHash, stellarAddress, type)` means
   * redoing the batch produces the same end state.
   */
  withTransaction<T>(fn: (tx: IndexerTx) => Promise<T>): Promise<T>;
}

/** Production `IndexerRepo` backed by Drizzle over the real `merchants`/`activity`/`cursors` tables. */
export function createDrizzleIndexerRepo(db: NodePgDatabase<typeof schema>): IndexerRepo {
  return {
    async listProvisionedMerchants() {
      return db.select({stellarAddress: merchants.stellarAddress}).from(merchants).where(isNotNull(merchants.provisionedAt));
    },

    async getCursor(key) {
      const [row] = await db.select().from(cursors).where(eq(cursors.key, key));
      return row?.value;
    },

    async withTransaction(fn) {
      return db.transaction(async (tx) => {
        const indexerTx: IndexerTx = {
          async findActivity(txHash, stellarAddress, type) {
            const [row] = await tx
              .select({id: activity.id, status: activity.status})
              .from(activity)
              .where(and(eq(activity.txHash, txHash), eq(activity.stellarAddress, stellarAddress), eq(activity.type, type)));
            return row;
          },
          async confirmActivity(id) {
            await tx.update(activity).set({status: 'confirmed'}).where(eq(activity.id, id));
          },
          async insertActivity(record) {
            await tx.insert(activity).values(record);
          },
          async upsertCursor(key, value) {
            await tx
              .insert(cursors)
              .values({key, value})
              .onConflictDoUpdate({target: cursors.key, set: {value, updatedAt: new Date()}});
          }
        };
        return fn(indexerTx);
      });
    }
  };
}

export interface PollerDeps {
  gateway: Pick<StellarGateway, 'listPayments'>;
  repo: IndexerRepo;
  registry: AssetRegistry;
  /** Horizon page size per merchant per cycle — defaults to 50. */
  batchSize?: number;
}

export interface PollCycleSummary {
  merchantCount: number;
  /** Total activity rows normalized+applied (inserted or confirmed) across every merchant this cycle. */
  recordCount: number;
}

export interface Poller {
  /** One poll cycle: one Horizon page per provisioned merchant, sequentially. */
  pollOnce(): Promise<PollCycleSummary>;
}

/**
 * Builds the Horizon-payments poller: per provisioned merchant, fetches one
 * page of payments-feed records since its stored cursor (oldest-first),
 * normalizes them (`normalizePayment`), and applies the batch — dedupe-by-
 * `(txHash, stellarAddress, type)` update/insert plus the cursor advance —
 * atomically via `repo.withTransaction`.
 */
export function createPoller(deps: PollerDeps): Poller {
  const {gateway, repo, registry, batchSize = DEFAULT_BATCH_SIZE} = deps;

  async function pollMerchant(stellarAddress: string): Promise<number> {
    const key = cursorKey(stellarAddress);
    const cursor = await repo.getCursor(key);
    const rawRecords = await gateway.listPayments(stellarAddress, cursor, batchSize);
    if (rawRecords.length === 0) return 0;

    const normalized: ActivityInsert[] = [];
    for (const record of rawRecords) {
      const insert = normalizePayment(record, stellarAddress, registry);
      if (insert) normalized.push(insert);
    }

    // Advance to the LAST RAW record's paging token even when some/all of
    // the batch normalized to null (native/foreign-asset/non-payment-op) —
    // otherwise skipped records would be re-fetched forever.
    const lastRecord = rawRecords[rawRecords.length - 1];
    if (!lastRecord) {
      // Unreachable: the length-0 check above already returned.
      throw new Error(`pollMerchant: rawRecords unexpectedly empty for ${stellarAddress}`);
    }
    const newCursor = lastRecord.pagingToken;

    await repo.withTransaction(async (tx) => {
      for (const record of normalized) {
        const existing = await tx.findActivity(record.txHash, record.stellarAddress, record.type);
        if (existing) {
          // Only a 'pending' row (written by the API path) needs updating —
          // anything already 'confirmed'/'failed' is left as-is (re-polling
          // the same batch after a restart must not re-flip a row).
          if (existing.status === 'pending') {
            await tx.confirmActivity(existing.id);
          }
          continue;
        }

        // Cross-type dedupe: this record's own type has no match, but the
        // ramp module may already own this settlement under a sibling type
        // (see RAMP_OWNER_TYPE above) — never insert a duplicate 'receive'/
        // 'send' row alongside it. A pending 'off_ramp' sibling is
        // additionally flipped to 'confirmed' here rather than left
        // untouched: this closes the off-ramp crash window where a payout
        // was already accepted by the provider but the process died before
        // the completion flow (intents/service.ts's complete(), via
        // ramp/submitter.ts) confirmed the pending row itself — that row's
        // txHash is pre-computed onto it before submission
        // (docs/modules/api-intents.md's Gotchas), so this same-cycle
        // Horizon match still finds it even though the flow that was
        // supposed to confirm it never ran. A pending 'on_ramp' sibling is
        // deliberately left alone (plain skip, same as an already-confirmed/
        // failed sibling of either type) — confirming a payin stays
        // ramp-poller.ts's exclusive job, since only the ramp provider's own
        // order status (Etherfuse's `getOrder`, not merely Horizon seeing a
        // matching payment) tells this app the fiat leg actually settled;
        // see `docs/modules/api-indexer.md`'s Gotchas.
        const rampOwnerType = RAMP_OWNER_TYPE[record.type];
        if (rampOwnerType) {
          const rampOwned = await tx.findActivity(record.txHash, record.stellarAddress, rampOwnerType);
          if (rampOwned) {
            if (rampOwnerType === 'off_ramp' && rampOwned.status === 'pending') {
              await tx.confirmActivity(rampOwned.id);
            }
            continue;
          }
        }

        await tx.insertActivity(record);
      }
      await tx.upsertCursor(key, newCursor);
    });

    return normalized.length;
  }

  return {
    async pollOnce() {
      const merchantList = await repo.listProvisionedMerchants();
      let recordCount = 0;
      for (const merchant of merchantList) {
        recordCount += await pollMerchant(merchant.stellarAddress);
      }
      return {merchantCount: merchantList.length, recordCount};
    }
  };
}
