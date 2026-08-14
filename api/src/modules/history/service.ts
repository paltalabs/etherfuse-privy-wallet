import type {ActivityFeedResponse, ActivityItem} from '@paltalabs/shared';
import {and, desc, eq, lt, type InferSelectModel} from 'drizzle-orm';
import type {NodePgDatabase} from 'drizzle-orm/node-postgres';
import type * as schema from '../../db/schema.js';
import {activity, merchants} from '../../db/schema.js';

export type MerchantRecord = InferSelectModel<typeof merchants>;
export type ActivityRecord = InferSelectModel<typeof activity>;

/**
 * Persistence boundary for the history module — deliberately narrower than
 * raw Drizzle access so `service.ts` can be unit-tested with an in-memory
 * fake instead of a live Postgres (`service.test.ts`), mirroring
 * `payments`/`wallet`'s `PaymentsRepo`/`WalletRepo` pattern.
 */
export interface HistoryRepo {
  getMerchant(privyDid: string): Promise<MerchantRecord | undefined>;
  /**
   * Rows for `stellarAddress` only, newest first (`ORDER BY createdAt
   * DESC`), optionally starting strictly before `before`, capped at
   * `limit`. No secondary sort key — see `docs/modules/api-history.md`'s
   * Gotchas for the tie-on-`createdAt` keyset-pagination caveat this
   * implies.
   */
  listActivity(input: {stellarAddress: string; limit: number; before?: Date}): Promise<ActivityRecord[]>;
}

/** Production `HistoryRepo` backed by Drizzle over the real `merchants`/`activity` tables. */
export function createDrizzleHistoryRepo(db: NodePgDatabase<typeof schema>): HistoryRepo {
  return {
    async getMerchant(privyDid) {
      const [row] = await db.select().from(merchants).where(eq(merchants.privyDid, privyDid));
      return row;
    },

    async listActivity({stellarAddress, limit, before}) {
      const conditions = [eq(activity.stellarAddress, stellarAddress)];
      if (before) conditions.push(lt(activity.createdAt, before));
      return db
        .select()
        .from(activity)
        .where(and(...conditions))
        .orderBy(desc(activity.createdAt))
        .limit(limit);
    }
  };
}

export interface HistoryServiceDeps {
  repo: HistoryRepo;
}

export interface HistoryFeedQuery {
  limit: number;
  before?: Date;
}

export interface HistoryService {
  /**
   * The caller's activity feed, newest first, keyset-paginated on
   * `createdAt`. A caller with no `merchants` row yet (never provisioned)
   * gets an empty feed — `{items: [], nextBefore: null}` — not an error;
   * `repo.listActivity` is never even called in that case.
   */
  getFeed(privyDid: string, query: HistoryFeedQuery): Promise<ActivityFeedResponse>;
}

/**
 * Maps a raw `activity` row to the client-facing shape: drops
 * `stellarAddress` (always the requester's own — redundant on every row),
 * `source`/`externalRef` (internal reconciliation bookkeeping — see
 * `db/schema.ts`), and converts `createdAt` to an ISO string.
 */
function toActivityItem(row: ActivityRecord): ActivityItem {
  return {
    id: row.id,
    type: row.type,
    direction: row.direction,
    amount: row.amount,
    assetCode: row.assetCode,
    assetIssuer: row.assetIssuer,
    counterparty: row.counterparty,
    status: row.status,
    txHash: row.txHash,
    createdAt: row.createdAt.toISOString()
  };
}

/**
 * The history module's business logic: a validated `{limit, before}` query
 * in, a page of the caller's own activity feed out. Decoupled from Postgres
 * via `deps.repo`, mirroring `wallet`/`intents`/`payments`'s
 * `createXxxService` shape.
 */
export function createHistoryService(deps: HistoryServiceDeps): HistoryService {
  const {repo} = deps;

  return {
    async getFeed(privyDid, {limit, before}) {
      const merchant = await repo.getMerchant(privyDid);
      if (!merchant) {
        return {items: [], nextBefore: null};
      }

      const rows = await repo.listActivity({stellarAddress: merchant.stellarAddress, limit, before});
      const items = rows.map(toActivityItem);
      // A full page (items.length === limit) means more rows MAY exist
      // beyond it — return the last item's createdAt as the next cursor.
      // A short page means the feed is exhausted for this stellarAddress.
      const lastItem = items[items.length - 1];
      const nextBefore = items.length === limit && lastItem ? lastItem.createdAt : null;

      return {items, nextBefore};
    }
  };
}
