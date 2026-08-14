import {describe, expect, it, vi} from 'vitest';
import type {OrderState, RampProvider} from '../ramp/provider.js';
import {RampProviderError} from '../ramp/provider.js';
import {createRampPoller, type PendingOrderActivity, type RampPollerRepo} from './ramp-poller.js';

/**
 * In-memory `RampPollerRepo` fake seeded with a fixed set of pending
 * `on_ramp`/`off_ramp` rows, recording every `confirmOnRamp`/`confirmOffRamp`/
 * `markFailed` call. Mirrors the pre-rewrite fake this replaces (`git show
 * 0abbfa4:api/src/modules/indexer/ramp-poller.test.ts`), extended for the two
 * row types and the on_ramp-only txHash/amount overwrite.
 */
function fakeRepo(rows: PendingOrderActivity[]): {
  repo: RampPollerRepo;
  confirmOnRampCalls: Array<{id: string; txHash: string | null; amount: string | null}>;
  confirmOffRampCalls: string[];
  failCalls: string[];
} {
  const confirmOnRampCalls: Array<{id: string; txHash: string | null; amount: string | null}> = [];
  const confirmOffRampCalls: string[] = [];
  const failCalls: string[] = [];
  const repo: RampPollerRepo = {
    async listPendingOrderActivity() {
      return rows;
    },
    async confirmOnRamp(id, input) {
      confirmOnRampCalls.push({id, ...input});
    },
    async confirmOffRamp(id) {
      confirmOffRampCalls.push(id);
    },
    async markFailed(id) {
      failCalls.push(id);
    }
  };
  return {repo, confirmOnRampCalls, confirmOffRampCalls, failCalls};
}

/** Fake `RampProvider.getOrder`, keyed by the (prefix-stripped) order id — either a canned `OrderState` or an `Error` to throw. */
function fakeProvider(responses: Record<string, OrderState | Error>): Pick<RampProvider, 'getOrder'> {
  return {
    async getOrder(orderId) {
      const response = responses[orderId];
      if (response instanceof Error) throw response;
      if (!response) throw new Error(`fakeProvider: no response programmed for orderId=${orderId}`);
      return response;
    }
  };
}

function orderState(overrides: Partial<OrderState> = {}): OrderState {
  return {orderId: 'order-1', status: 'funded', txHash: null, amountTokens: null, ...overrides};
}

describe('createRampPoller', () => {
  it("confirms a pending on_ramp row on 'completed', setting txHash and overwriting amount from amountTokens (truncated to 7-decimal Stellar precision)", async () => {
    const {repo, confirmOnRampCalls} = fakeRepo([{id: 'row-1', type: 'on_ramp', externalRef: 'order:ord-1'}]);
    const provider = fakeProvider({
      'ord-1': orderState({status: 'completed', txHash: 'tx-abc', amountTokens: '19.620062792064687229069147940'})
    });
    const poller = createRampPoller({repo, provider});

    const summary = await poller.pollOnce();

    expect(confirmOnRampCalls).toEqual([{id: 'row-1', txHash: 'tx-abc', amount: '19.6200627'}]);
    expect(summary).toEqual({updated: 1});
  });

  it("confirms a pending on_ramp row on 'finalized' with a null txHash (sandbox case) and leaves amount untouched when amountTokens is null", async () => {
    const {repo, confirmOnRampCalls} = fakeRepo([{id: 'row-2', type: 'on_ramp', externalRef: 'order:ord-2'}]);
    const provider = fakeProvider({'ord-2': orderState({status: 'finalized', txHash: null, amountTokens: null})});
    const poller = createRampPoller({repo, provider});

    const summary = await poller.pollOnce();

    expect(confirmOnRampCalls).toEqual([{id: 'row-2', txHash: null, amount: null}]);
    expect(summary).toEqual({updated: 1});
  });

  it("confirms a pending off_ramp row on 'completed' WITHOUT touching txHash/amount — the order's own confirmedTxSignature is never the merchant's payment hash", async () => {
    const {repo, confirmOffRampCalls, confirmOnRampCalls} = fakeRepo([
      {id: 'row-3', type: 'off_ramp', externalRef: 'order:ord-3'}
    ]);
    const provider = fakeProvider({
      'ord-3': orderState({status: 'completed', txHash: 'etherfuse-internal-tx', amountTokens: '5.0000000'})
    });
    const poller = createRampPoller({repo, provider});

    const summary = await poller.pollOnce();

    expect(confirmOffRampCalls).toEqual(['row-3']);
    expect(confirmOnRampCalls).toEqual([]);
    expect(summary).toEqual({updated: 1});
  });

  it.each(['failed', 'refunded', 'canceled'] as const)("marks a pending row 'failed' when the order status is %s", async (status) => {
    const {repo, failCalls, confirmOnRampCalls, confirmOffRampCalls} = fakeRepo([
      {id: 'row-4', type: 'on_ramp', externalRef: 'order:ord-4'}
    ]);
    const provider = fakeProvider({'ord-4': orderState({status})});
    const poller = createRampPoller({repo, provider});

    const summary = await poller.pollOnce();

    expect(failCalls).toEqual(['row-4']);
    expect(confirmOnRampCalls).toEqual([]);
    expect(confirmOffRampCalls).toEqual([]);
    expect(summary).toEqual({updated: 1});
  });

  it.each(['created', 'funded'] as const)("leaves a pending row untouched while the order status is still %s", async (status) => {
    const {repo, confirmOnRampCalls, confirmOffRampCalls, failCalls} = fakeRepo([
      {id: 'row-5', type: 'off_ramp', externalRef: 'order:ord-5'}
    ]);
    const provider = fakeProvider({'ord-5': orderState({status})});
    const poller = createRampPoller({repo, provider});

    const summary = await poller.pollOnce();

    expect(confirmOnRampCalls).toEqual([]);
    expect(confirmOffRampCalls).toEqual([]);
    expect(failCalls).toEqual([]);
    expect(summary).toEqual({updated: 0});
  });

  it('strips the order: externalRef prefix before calling provider.getOrder', async () => {
    const {repo} = fakeRepo([{id: 'row-6', type: 'on_ramp', externalRef: 'order:ord-strip-me'}]);
    const calledWith: string[] = [];
    const provider: Pick<RampProvider, 'getOrder'> = {
      async getOrder(orderId) {
        calledWith.push(orderId);
        return orderState({status: 'funded'});
      }
    };
    const poller = createRampPoller({repo, provider});

    await poller.pollOnce();

    expect(calledWith).toEqual(['ord-strip-me']);
  });

  it('ignores a pending row whose externalRef does not carry the order: prefix', async () => {
    const {repo, confirmOnRampCalls, confirmOffRampCalls, failCalls} = fakeRepo([
      {id: 'row-7', type: 'on_ramp', externalRef: 'payin:legacy-id'}
    ]);
    const provider: Pick<RampProvider, 'getOrder'> = {
      async getOrder() {
        throw new Error('provider.getOrder must not be called for a non-order externalRef');
      }
    };
    const poller = createRampPoller({repo, provider});

    const summary = await poller.pollOnce();

    expect(confirmOnRampCalls).toEqual([]);
    expect(confirmOffRampCalls).toEqual([]);
    expect(failCalls).toEqual([]);
    expect(summary).toEqual({updated: 0});
  });

  it('a RampProviderError on one row is logged and does not stop the next row from being processed', async () => {
    // The failing row's console.error is intentional (createRampPoller's own
    // per-row resilience logging) — silence it here so this expected-noise
    // line doesn't pollute the suite's real output.
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const {repo, confirmOnRampCalls} = fakeRepo([
      {id: 'row-8', type: 'on_ramp', externalRef: 'order:ord-8'},
      {id: 'row-9', type: 'on_ramp', externalRef: 'order:ord-9'}
    ]);
    const provider = fakeProvider({
      'ord-8': new RampProviderError('order_fetch_failed', 'boom'),
      'ord-9': orderState({status: 'completed', txHash: 'tx-def', amountTokens: null})
    });
    const poller = createRampPoller({repo, provider});

    const summary = await poller.pollOnce();

    expect(confirmOnRampCalls).toEqual([{id: 'row-9', txHash: 'tx-def', amount: null}]);
    expect(summary).toEqual({updated: 1});
    expect(consoleErrorSpy).toHaveBeenCalledOnce();

    consoleErrorSpy.mockRestore();
  });

  it('returns {updated: 0} without calling the provider when there are no pending order rows', async () => {
    const {repo, confirmOnRampCalls, confirmOffRampCalls, failCalls} = fakeRepo([]);
    const provider = fakeProvider({});
    const poller = createRampPoller({repo, provider});

    const summary = await poller.pollOnce();

    expect(confirmOnRampCalls).toEqual([]);
    expect(confirmOffRampCalls).toEqual([]);
    expect(failCalls).toEqual([]);
    expect(summary).toEqual({updated: 0});
  });
});
