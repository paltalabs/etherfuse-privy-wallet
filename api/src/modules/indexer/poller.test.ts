import {AssetRegistry} from '@paltalabs/shared';
import {describe, expect, it} from 'vitest';
import type {HorizonPaymentRecord, StellarGateway} from '../../lib/stellar-gateway.js';
import type {ActivityInsert} from './normalize.js';
import {createPoller, type IndexerRepo, type IndexerTx, type ProvisionedMerchant} from './poller.js';

const OWN_ADDRESS = 'GOWNADDRESSAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const OTHER_ADDRESS = 'GEXTERNALADDRAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const REGISTRY_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

const registry = new AssetRegistry([{code: 'USDC', issuer: REGISTRY_ISSUER, decimals: 7}]);

interface ActivityRow {
  id: string;
  stellarAddress: string;
  // Widened beyond ActivityInsert['type'] so tests can seed 'on_ramp'/'off_ramp'
  // rows too — the cross-type dedupe check queries findActivity with those
  // types (poller.ts's QueryableActivityType).
  type: ActivityInsert['type'] | 'on_ramp' | 'off_ramp';
  status: string;
  txHash: string;
}

/** A fake `StellarGateway.listPayments` returning one pre-programmed page per account, and recording every call it received. */
function fakeGateway(pages: Record<string, HorizonPaymentRecord[]>): {
  gateway: Pick<StellarGateway, 'listPayments'>;
  calls: Array<{accountId: string; cursor: string | undefined; limit: number}>;
} {
  const calls: Array<{accountId: string; cursor: string | undefined; limit: number}> = [];
  return {
    calls,
    gateway: {
      async listPayments(accountId, cursor, limit) {
        calls.push({accountId, cursor, limit});
        return pages[accountId] ?? [];
      }
    }
  };
}

/**
 * In-memory `IndexerRepo` fake. `withTransaction` pushes explicit
 * 'transaction-start'/'transaction-end' markers around the callback so
 * tests can assert every write for a batch happened strictly between them
 * — the "transactional grouping" evidence a real `db.transaction` call
 * would also provide (`createDrizzleIndexerRepo`'s production impl wraps
 * Drizzle's `db.transaction` the same way).
 */
function fakeRepo(
  merchantList: ProvisionedMerchant[],
  seedActivity: ActivityRow[] = []
): {
  repo: IndexerRepo;
  calls: string[];
  activityRows: ActivityRow[];
  cursors: Map<string, string>;
} {
  const calls: string[] = [];
  const activityRows: ActivityRow[] = [...seedActivity];
  const cursorStore = new Map<string, string>();
  let nextId = 1;

  const repo: IndexerRepo = {
    async listProvisionedMerchants() {
      calls.push('listProvisionedMerchants');
      return merchantList;
    },
    async getCursor(key) {
      calls.push('getCursor');
      return cursorStore.get(key);
    },
    async withTransaction(fn) {
      calls.push('transaction-start');
      const tx: IndexerTx = {
        async findActivity(txHash, stellarAddress, type) {
          calls.push('findActivity');
          const row = activityRows.find(
            (r) => r.txHash === txHash && r.stellarAddress === stellarAddress && r.type === type
          );
          return row ? {id: row.id, status: row.status} : undefined;
        },
        async confirmActivity(id) {
          calls.push('confirmActivity');
          const row = activityRows.find((r) => r.id === id);
          if (row) row.status = 'confirmed';
        },
        async insertActivity(record) {
          calls.push('insertActivity');
          activityRows.push({
            id: `new-${nextId++}`,
            stellarAddress: record.stellarAddress,
            type: record.type,
            status: record.status,
            txHash: record.txHash
          });
        },
        async upsertCursor(key, value) {
          calls.push('upsertCursor');
          cursorStore.set(key, value);
        }
      };
      const result = await fn(tx);
      calls.push('transaction-end');
      return result;
    }
  };

  return {repo, calls, activityRows, cursors: cursorStore};
}

function paymentRecord(overrides: Partial<HorizonPaymentRecord> = {}): HorizonPaymentRecord {
  return {
    type: 'payment',
    pagingToken: '1',
    transactionHash: 'tx-1',
    createdAt: '2026-07-23T00:00:00Z',
    from: OTHER_ADDRESS,
    to: OWN_ADDRESS,
    assetType: 'credit_alphanum4',
    assetCode: 'USDC',
    assetIssuer: REGISTRY_ISSUER,
    amount: '5.0000000',
    ...overrides
  };
}

describe('createPoller', () => {
  it("advances the cursor to the last raw record's paging token after a batch", async () => {
    const records = [
      paymentRecord({pagingToken: '10', transactionHash: 'tx-a'}),
      paymentRecord({pagingToken: '20', transactionHash: 'tx-b'})
    ];
    const {gateway} = fakeGateway({[OWN_ADDRESS]: records});
    const {repo, cursors} = fakeRepo([{stellarAddress: OWN_ADDRESS}]);
    const poller = createPoller({gateway, repo, registry});

    await poller.pollOnce();

    expect(cursors.get(`horizon-payments:${OWN_ADDRESS}`)).toBe('20');
  });

  it('passes the stored cursor into the next poll cycle', async () => {
    const {gateway, calls: gatewayCalls} = fakeGateway({
      [OWN_ADDRESS]: [paymentRecord({pagingToken: '10', transactionHash: 'tx-a'})]
    });
    const {repo} = fakeRepo([{stellarAddress: OWN_ADDRESS}]);
    const poller = createPoller({gateway, repo, registry});

    await poller.pollOnce();
    await poller.pollOnce();

    expect(gatewayCalls[0]?.cursor).toBeUndefined();
    expect(gatewayCalls[1]?.cursor).toBe('10');
  });

  it('updates a pending API-written row to confirmed instead of inserting a duplicate (dedupe-update path)', async () => {
    const record = paymentRecord({transactionHash: 'tx-pending', pagingToken: '5'});
    const {gateway} = fakeGateway({[OWN_ADDRESS]: [record]});
    const seeded: ActivityRow[] = [
      {id: 'pending-1', stellarAddress: OWN_ADDRESS, type: 'receive', status: 'pending', txHash: 'tx-pending'}
    ];
    const {repo, activityRows} = fakeRepo([{stellarAddress: OWN_ADDRESS}], seeded);
    const poller = createPoller({gateway, repo, registry});

    await poller.pollOnce();

    expect(activityRows).toHaveLength(1);
    expect(activityRows[0]).toMatchObject({id: 'pending-1', status: 'confirmed'});
  });

  it("closes the crash-window gap: a pending 'send' row already carrying the pre-computed txHash (written by intents/service.ts before submission, per docs/modules/api-intents.md's Gotchas) is matched and flipped to confirmed -- no duplicate indexer-sourced row", async () => {
    // Simulates: payments/service.ts wrote a pending 'send' row at
    // creation time; intents/service.ts's complete() pre-computed and
    // wrote the real txHash onto it BEFORE calling the gateway; the
    // process then crashed before markSubmitted/recordActivity could run,
    // so the row is still 'pending' -- but, unlike before the crash-window fix, its
    // txHash is no longer null. Before the fix this same crash left the
    // row stuck at txHash: null, which findActivity's dedupe-by-
    // (txHash, stellarAddress, type) lookup could never match against a
    // real on-chain hash, producing a duplicate indexer-inserted row.
    const record = paymentRecord({
      transactionHash: 'precomputed-hash-abc',
      pagingToken: '9',
      from: OWN_ADDRESS,
      to: OTHER_ADDRESS
    });
    const {gateway} = fakeGateway({[OWN_ADDRESS]: [record]});
    const seeded: ActivityRow[] = [
      {id: 'send-pending-1', stellarAddress: OWN_ADDRESS, type: 'send', status: 'pending', txHash: 'precomputed-hash-abc'}
    ];
    const {repo, activityRows, calls} = fakeRepo([{stellarAddress: OWN_ADDRESS}], seeded);
    const poller = createPoller({gateway, repo, registry});

    await poller.pollOnce();

    expect(activityRows).toHaveLength(1);
    expect(activityRows[0]).toMatchObject({id: 'send-pending-1', status: 'confirmed', txHash: 'precomputed-hash-abc'});
    expect(calls).not.toContain('insertActivity');
  });

  it('leaves an already-confirmed matching row untouched (idempotent re-poll of the same batch)', async () => {
    const record = paymentRecord({transactionHash: 'tx-done', pagingToken: '6'});
    const {gateway} = fakeGateway({[OWN_ADDRESS]: [record]});
    const seeded: ActivityRow[] = [
      {id: 'done-1', stellarAddress: OWN_ADDRESS, type: 'receive', status: 'confirmed', txHash: 'tx-done'}
    ];
    const {repo, activityRows, calls} = fakeRepo([{stellarAddress: OWN_ADDRESS}], seeded);
    const poller = createPoller({gateway, repo, registry});

    await poller.pollOnce();

    expect(activityRows).toHaveLength(1);
    expect(activityRows[0]?.status).toBe('confirmed');
    expect(calls).not.toContain('confirmActivity');
    expect(calls).not.toContain('insertActivity');
  });

  it('inserts a new row for a record with no existing match (external receive)', async () => {
    const record = paymentRecord({transactionHash: 'tx-external', pagingToken: '7', from: OTHER_ADDRESS, to: OWN_ADDRESS});
    const {gateway} = fakeGateway({[OWN_ADDRESS]: [record]});
    const {repo, activityRows} = fakeRepo([{stellarAddress: OWN_ADDRESS}]);
    const poller = createPoller({gateway, repo, registry});

    await poller.pollOnce();

    expect(activityRows).toHaveLength(1);
    expect(activityRows[0]).toMatchObject({
      stellarAddress: OWN_ADDRESS,
      type: 'receive',
      status: 'confirmed',
      txHash: 'tx-external'
    });
  });

  it('groups every write for a batch (dedupe lookups, updates, inserts, cursor upsert) inside one db.transaction call', async () => {
    const records = [
      paymentRecord({transactionHash: 'tx-1', pagingToken: '1'}),
      paymentRecord({transactionHash: 'tx-2', pagingToken: '2', from: OWN_ADDRESS, to: OTHER_ADDRESS})
    ];
    const {gateway} = fakeGateway({[OWN_ADDRESS]: records});
    const {repo, calls} = fakeRepo([{stellarAddress: OWN_ADDRESS}]);
    const poller = createPoller({gateway, repo, registry});

    await poller.pollOnce();

    const startIndex = calls.indexOf('transaction-start');
    const endIndex = calls.indexOf('transaction-end');
    expect(startIndex).toBeGreaterThanOrEqual(0);
    expect(endIndex).toBeGreaterThan(startIndex);
    // Exactly one transaction for the whole batch, not one per record.
    expect(calls.filter((c) => c === 'transaction-start')).toHaveLength(1);
    // Every write-side call happened strictly between start and end.
    const writeCalls = new Set(['findActivity', 'insertActivity', 'upsertCursor']);
    calls.forEach((call, index) => {
      if (writeCalls.has(call)) {
        expect(index).toBeGreaterThan(startIndex);
        expect(index).toBeLessThan(endIndex);
      }
    });
    expect(calls).toContain('upsertCursor');
  });

  it('skips a merchant with no new records without opening a transaction', async () => {
    const {gateway} = fakeGateway({[OWN_ADDRESS]: []});
    const {repo, calls} = fakeRepo([{stellarAddress: OWN_ADDRESS}]);
    const poller = createPoller({gateway, repo, registry});

    const summary = await poller.pollOnce();

    expect(summary).toEqual({merchantCount: 1, recordCount: 0});
    expect(calls).not.toContain('transaction-start');
  });

  it('polls every provisioned merchant sequentially in one cycle', async () => {
    const merchantA = 'GMERCHANTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const merchantB = 'GMERCHANTBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const {gateway} = fakeGateway({
      [merchantA]: [paymentRecord({transactionHash: 'tx-a', pagingToken: '1', to: merchantA})],
      [merchantB]: [paymentRecord({transactionHash: 'tx-b', pagingToken: '1', to: merchantB})]
    });
    const {repo} = fakeRepo([{stellarAddress: merchantA}, {stellarAddress: merchantB}]);
    const poller = createPoller({gateway, repo, registry});

    const summary = await poller.pollOnce();

    expect(summary).toEqual({merchantCount: 2, recordCount: 2});
  });

  it("skips inserting a normalized 'receive' whose (txHash, address) matches an existing 'on_ramp' row — the ramp poller owns that settlement (cross-type dedupe)", async () => {
    const record = paymentRecord({transactionHash: 'tx-payin-settle', pagingToken: '11', from: OTHER_ADDRESS, to: OWN_ADDRESS});
    const {gateway} = fakeGateway({[OWN_ADDRESS]: [record]});
    const seeded: ActivityRow[] = [
      {id: 'on-ramp-1', stellarAddress: OWN_ADDRESS, type: 'on_ramp', status: 'pending', txHash: 'tx-payin-settle'}
    ];
    const {repo, activityRows, calls} = fakeRepo([{stellarAddress: OWN_ADDRESS}], seeded);
    const poller = createPoller({gateway, repo, registry});

    await poller.pollOnce();

    // No second, indexer-sourced row — the pre-existing 'on_ramp' row is left
    // exactly as-is (still 'pending'; the ramp poller, not this one, confirms it).
    expect(activityRows).toHaveLength(1);
    expect(activityRows[0]).toMatchObject({id: 'on-ramp-1', type: 'on_ramp', status: 'pending'});
    expect(calls).not.toContain('insertActivity');
  });

  it("skips inserting a normalized 'send' whose (txHash, address) matches an existing, already-confirmed 'off_ramp' row — a terminal-status sibling is left untouched (the off_ramp mirror of the on_ramp dedupe case)", async () => {
    const record = paymentRecord({transactionHash: 'tx-payout-settle', pagingToken: '12', from: OWN_ADDRESS, to: OTHER_ADDRESS});
    const {gateway} = fakeGateway({[OWN_ADDRESS]: [record]});
    const seeded: ActivityRow[] = [
      {id: 'off-ramp-1', stellarAddress: OWN_ADDRESS, type: 'off_ramp', status: 'confirmed', txHash: 'tx-payout-settle'}
    ];
    const {repo, activityRows, calls} = fakeRepo([{stellarAddress: OWN_ADDRESS}], seeded);
    const poller = createPoller({gateway, repo, registry});

    await poller.pollOnce();

    expect(activityRows).toHaveLength(1);
    expect(activityRows[0]).toMatchObject({id: 'off-ramp-1', type: 'off_ramp', status: 'confirmed'});
    expect(calls).not.toContain('insertActivity');
    expect(calls).not.toContain('confirmActivity');
  });

  it("closes the off-ramp crash window: a normalized 'send' whose (txHash, address) matches a still-PENDING 'off_ramp' row confirms that row instead of bare-skipping it — no duplicate insert either", async () => {
    // Simulates: ramp/service.ts's createPayout wrote the pending 'off_ramp'
    // row; intents/service.ts's complete() pre-computed and wrote the real
    // txHash onto it before calling the provider; the payout was accepted
    // (it lands on Horizon under that same txHash), but the process crashed
    // before complete()'s own success path could flip the row to
    // 'confirmed'. Before this fix the cross-type dedupe check found the
    // sibling and bare-skipped it, leaving it stuck 'pending' forever even
    // though the funds had actually moved.
    const record = paymentRecord({
      transactionHash: 'tx-payout-crash',
      pagingToken: '14',
      from: OWN_ADDRESS,
      to: OTHER_ADDRESS
    });
    const {gateway} = fakeGateway({[OWN_ADDRESS]: [record]});
    const seeded: ActivityRow[] = [
      {id: 'off-ramp-2', stellarAddress: OWN_ADDRESS, type: 'off_ramp', status: 'pending', txHash: 'tx-payout-crash'}
    ];
    const {repo, activityRows, calls} = fakeRepo([{stellarAddress: OWN_ADDRESS}], seeded);
    const poller = createPoller({gateway, repo, registry});

    await poller.pollOnce();

    // No second, indexer-sourced row -- the pre-existing 'off_ramp' row is
    // confirmed in place, not duplicated.
    expect(activityRows).toHaveLength(1);
    expect(activityRows[0]).toMatchObject({id: 'off-ramp-2', type: 'off_ramp', status: 'confirmed'});
    expect(calls).toContain('confirmActivity');
    expect(calls).not.toContain('insertActivity');
  });

  it("still inserts a normalized 'receive' when no matching 'on_ramp' row exists (cross-type check is a negative lookup, not a blanket skip)", async () => {
    const record = paymentRecord({transactionHash: 'tx-plain-receive', pagingToken: '13', from: OTHER_ADDRESS, to: OWN_ADDRESS});
    const {gateway} = fakeGateway({[OWN_ADDRESS]: [record]});
    const {repo, activityRows} = fakeRepo([{stellarAddress: OWN_ADDRESS}]);
    const poller = createPoller({gateway, repo, registry});

    await poller.pollOnce();

    expect(activityRows).toHaveLength(1);
    expect(activityRows[0]).toMatchObject({type: 'receive', status: 'confirmed', txHash: 'tx-plain-receive'});
  });
});
