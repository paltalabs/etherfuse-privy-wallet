import {describe, expect, it, vi} from 'vitest';
import {createHistoryService, type ActivityRecord, type HistoryRepo, type MerchantRecord} from './service.js';

/**
 * In-memory fake of the history module's persistence boundary. `listActivity`
 * replicates the real Drizzle repo's SQL semantics (`WHERE stellarAddress =
 * ... AND createdAt < before ORDER BY createdAt DESC LIMIT limit`) in plain
 * JS so tests exercise the same filter/sort/limit behavior the production
 * repo relies on — mirrors `payments/service.test.ts`'s fake gateway
 * emulating `StellarAccountNotFoundError` semantics.
 */
function createFakeRepo(): {
  repo: HistoryRepo;
  merchants: Map<string, MerchantRecord>;
  activityRows: ActivityRecord[];
} {
  const merchantsStore = new Map<string, MerchantRecord>();
  const activityStore: ActivityRecord[] = [];

  const repo: HistoryRepo = {
    async getMerchant(privyDid) {
      return merchantsStore.get(privyDid);
    },
    async listActivity({stellarAddress, limit, before}) {
      return activityStore
        .filter((row) => row.stellarAddress === stellarAddress && (!before || row.createdAt < before))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, limit);
    }
  };

  return {repo, merchants: merchantsStore, activityRows: activityStore};
}

function seedMerchant(merchants: Map<string, MerchantRecord>, privyDid: string, stellarAddress: string): void {
  merchants.set(privyDid, {
    privyDid,
    privyWalletId: 'wallet-1',
    stellarAddress,
    provisionedAt: new Date(),
    createdAt: new Date()
  });
}

let nextActivityId = 1;

function makeActivityRow(overrides: Partial<ActivityRecord> & {stellarAddress: string; createdAt: Date}): ActivityRecord {
  return {
    id: `activity-${nextActivityId++}`,
    type: 'send',
    direction: 'out',
    amount: '10.0000000',
    assetCode: 'USDC',
    assetIssuer: 'GISSUER',
    counterparty: 'GDEST',
    status: 'confirmed',
    txHash: 'deadbeef',
    source: 'api',
    externalRef: null,
    ...overrides
  };
}

describe('createHistoryService.getFeed', () => {
  it('returns an empty feed (not an error) for a caller with no merchants row', async () => {
    const {repo} = createFakeRepo();
    const service = createHistoryService({repo});

    const result = await service.getFeed('did:privy:unknown', {limit: 20});

    expect(result).toEqual({items: [], nextBefore: null});
  });

  it('does not query activity at all when the merchant is unknown', async () => {
    const {repo} = createFakeRepo();
    const listActivitySpy = vi.spyOn(repo, 'listActivity');
    const service = createHistoryService({repo});

    await service.getFeed('did:privy:unknown', {limit: 20});

    expect(listActivitySpy).not.toHaveBeenCalled();
  });

  it('returns rows newest-first for the merchant, mapped to ActivityItem shape', async () => {
    const {repo, merchants, activityRows} = createFakeRepo();
    seedMerchant(merchants, 'did:privy:merchant', 'GMERCHANT');
    const oldest = makeActivityRow({stellarAddress: 'GMERCHANT', createdAt: new Date('2026-01-01T00:00:00.000Z')});
    const middle = makeActivityRow({stellarAddress: 'GMERCHANT', createdAt: new Date('2026-01-02T00:00:00.000Z')});
    const newest = makeActivityRow({stellarAddress: 'GMERCHANT', createdAt: new Date('2026-01-03T00:00:00.000Z')});
    // Pushed out of order deliberately — the repo (real SQL ORDER BY, faked
    // here) is what's responsible for sorting, not insertion order.
    activityRows.push(middle, oldest, newest);
    const service = createHistoryService({repo});

    const result = await service.getFeed('did:privy:merchant', {limit: 20});

    expect(result.items.map((item) => item.id)).toEqual([newest.id, middle.id, oldest.id]);
    expect(result.items[0]).toEqual({
      id: newest.id,
      type: newest.type,
      direction: newest.direction,
      amount: newest.amount,
      assetCode: newest.assetCode,
      assetIssuer: newest.assetIssuer,
      counterparty: newest.counterparty,
      status: newest.status,
      txHash: newest.txHash,
      createdAt: newest.createdAt.toISOString()
    });
    // Page is not full (3 rows < limit 20) -> no next cursor.
    expect(result.nextBefore).toBeNull();
  });

  it('only returns rows for the caller\'s own stellarAddress', async () => {
    const {repo, merchants, activityRows} = createFakeRepo();
    seedMerchant(merchants, 'did:privy:merchant', 'GMERCHANT');
    const mine = makeActivityRow({stellarAddress: 'GMERCHANT', createdAt: new Date('2026-01-01T00:00:00.000Z')});
    const someoneElses = makeActivityRow({
      stellarAddress: 'GOTHER',
      createdAt: new Date('2026-01-02T00:00:00.000Z')
    });
    activityRows.push(mine, someoneElses);
    const service = createHistoryService({repo});

    const result = await service.getFeed('did:privy:merchant', {limit: 20});

    expect(result.items.map((item) => item.id)).toEqual([mine.id]);
  });

  it('sets nextBefore to the last item\'s createdAt when the page is full', async () => {
    const {repo, merchants, activityRows} = createFakeRepo();
    seedMerchant(merchants, 'did:privy:merchant', 'GMERCHANT');
    const rows = [
      makeActivityRow({stellarAddress: 'GMERCHANT', createdAt: new Date('2026-01-01T00:00:00.000Z')}),
      makeActivityRow({stellarAddress: 'GMERCHANT', createdAt: new Date('2026-01-02T00:00:00.000Z')}),
      makeActivityRow({stellarAddress: 'GMERCHANT', createdAt: new Date('2026-01-03T00:00:00.000Z')})
    ];
    activityRows.push(...rows);
    const service = createHistoryService({repo});

    const result = await service.getFeed('did:privy:merchant', {limit: 2});

    // Full page (2 items === limit 2): newest two rows, cursor = the older
    // of the two (last item in the page), even though we don't know for
    // certain more rows exist beyond it.
    expect(result.items.map((item) => item.id)).toEqual([rows[2]?.id, rows[1]?.id]);
    expect(result.nextBefore).toBe(rows[1]?.createdAt.toISOString());
  });

  it('walks two pages via before, and the second (non-full) page has a null nextBefore', async () => {
    const {repo, merchants, activityRows} = createFakeRepo();
    seedMerchant(merchants, 'did:privy:merchant', 'GMERCHANT');
    const rows = [
      makeActivityRow({stellarAddress: 'GMERCHANT', createdAt: new Date('2026-01-01T00:00:00.000Z')}),
      makeActivityRow({stellarAddress: 'GMERCHANT', createdAt: new Date('2026-01-02T00:00:00.000Z')}),
      makeActivityRow({stellarAddress: 'GMERCHANT', createdAt: new Date('2026-01-03T00:00:00.000Z')})
    ];
    activityRows.push(...rows);
    const service = createHistoryService({repo});

    const page1 = await service.getFeed('did:privy:merchant', {limit: 2});
    expect(page1.items.map((item) => item.id)).toEqual([rows[2]?.id, rows[1]?.id]);
    expect(page1.nextBefore).toBe(rows[1]?.createdAt.toISOString());

    const listActivitySpy = vi.spyOn(repo, 'listActivity');
    const page2 = await service.getFeed('did:privy:merchant', {
      limit: 2,
      before: page1.nextBefore ? new Date(page1.nextBefore) : undefined
    });

    // Proves `before` actually reached the repo and filtered correctly:
    // only the oldest row remains, strictly before page1's cursor.
    expect(listActivitySpy).toHaveBeenCalledWith({
      stellarAddress: 'GMERCHANT',
      limit: 2,
      before: rows[1]?.createdAt
    });
    expect(page2.items.map((item) => item.id)).toEqual([rows[0]?.id]);
    expect(page2.nextBefore).toBeNull();
  });
});
