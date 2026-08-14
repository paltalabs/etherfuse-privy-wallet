import {NotFoundError, type Horizon} from '@stellar/stellar-sdk';
import {describe, expect, it} from 'vitest';
import {createHorizonGateway, StellarAccountNotFoundError} from './stellar-gateway.js';

/** Minimal stand-in for `Horizon.Server`, just its `loadAccount` method. */
function fakeHorizonServer(account: unknown): Pick<Horizon.Server, 'loadAccount'> {
  return {loadAccount: async () => account as Awaited<ReturnType<Horizon.Server['loadAccount']>>};
}

describe('createHorizonGateway', () => {
  it('exposes the underlying account id/sequence via method calls', async () => {
    const server = fakeHorizonServer({
      accountId: () => 'GABC',
      sequenceNumber: () => '42',
      incrementSequenceNumber: () => {},
      balances: []
    });
    const gateway = createHorizonGateway(server as Horizon.Server);

    const account = await gateway.loadAccount('GABC');

    expect(account.accountId()).toBe('GABC');
    expect(account.sequenceNumber()).toBe('42');
  });

  it('maps credit-asset balance lines to {assetCode, assetIssuer, balance}', async () => {
    const server = fakeHorizonServer({
      accountId: () => 'GABC',
      sequenceNumber: () => '1',
      incrementSequenceNumber: () => {},
      balances: [
        {asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: 'GISSUER', balance: '10.0000000'},
        {asset_type: 'native', balance: '0.0000000'}
      ]
    });
    const gateway = createHorizonGateway(server as Horizon.Server);

    const account = await gateway.loadAccount('GABC');

    expect(account.balances).toEqual([
      {assetCode: 'USDC', assetIssuer: 'GISSUER', balance: '10.0000000'},
      {assetCode: undefined, assetIssuer: undefined, balance: '0.0000000'}
    ]);
  });

  it('translates a stellar-sdk NotFoundError (Horizon 404) into StellarAccountNotFoundError', async () => {
    const server: Pick<Horizon.Server, 'loadAccount'> = {
      loadAccount: async () => {
        throw new NotFoundError('Not Found', {});
      }
    };
    const gateway = createHorizonGateway(server as Horizon.Server);

    await expect(gateway.loadAccount('GMISSING')).rejects.toBeInstanceOf(StellarAccountNotFoundError);
  });

  it('propagates a non-404 rejection unchanged (e.g. a network/Horizon outage)', async () => {
    const server: Pick<Horizon.Server, 'loadAccount'> = {
      loadAccount: async () => {
        throw new Error('network timeout');
      }
    };
    const gateway = createHorizonGateway(server as Horizon.Server);

    await expect(gateway.loadAccount('GABC')).rejects.toThrow('network timeout');
    await expect(gateway.loadAccount('GABC')).rejects.not.toBeInstanceOf(StellarAccountNotFoundError);
  });

  describe('submitTransaction', () => {
    it('resolves with the confirmed tx hash on success', async () => {
      const server: Pick<Horizon.Server, 'submitTransaction'> = {
        submitTransaction: (async () => ({
          hash: 'deadbeef',
          ledger: 1,
          successful: true,
          envelope_xdr: 'AAAA',
          result_xdr: 'AAAA',
          result_meta_xdr: 'AAAA',
          paging_token: '1'
        })) as Horizon.Server['submitTransaction']
      };
      const gateway = createHorizonGateway(server as Horizon.Server);

      const result = await gateway.submitTransaction({} as never);

      expect(result).toEqual({hash: 'deadbeef'});
    });

    // FINDING: Horizon.Server#submitTransaction's own .catch handler
    // (installed @stellar/stellar-sdk@14.6.1, lib/horizon/server.js) always
    // re-rejects the raw Axios error UNCHANGED -- its `response instanceof
    // Error` guard is unconditionally true for a real Axios failure (an
    // AxiosError IS an Error), so the BadResponseError branch beside it is
    // dead code in practice. This differs from loadAccount's call-builder
    // path (which DOES translate a 404 into a typed NotFoundError, tested
    // above). So a submission failure surfaces as a plain Axios error shape:
    // `err.response.data` is Horizon's JSON error body
    // (HorizonApi.ErrorResponseData.TransactionFailed), and the failure code
    // lives at `err.response.data.extras.result_codes.transaction`
    // (HorizonApi.TransactionFailedResultCodes, e.g. 'tx_bad_seq') --
    // verified directly against the installed package's server.js and
    // horizon_api.d.ts. This gateway does NOT translate that shape into a
    // typed error (unlike loadAccount's 404 -> StellarAccountNotFoundError)
    // -- it propagates unchanged, and `sponsor/submit.ts` is the one place
    // that inspects it (see that module's docs).
    it('propagates a tx_bad_seq-shaped Horizon submission failure unchanged (Axios error shape)', async () => {
      const horizonError = Object.assign(new Error('Bad Request'), {
        response: {
          status: 400,
          data: {
            status: 400,
            title: 'Transaction Failed',
            type: 'transaction_failed',
            detail: 'the sequence number does not match',
            extras: {
              envelope_xdr: 'AAAA',
              result_codes: {transaction: 'tx_bad_seq', operations: []},
              result_xdr: 'AAAA'
            }
          }
        }
      });
      const server: Pick<Horizon.Server, 'submitTransaction'> = {
        submitTransaction: (async () => {
          throw horizonError;
        }) as Horizon.Server['submitTransaction']
      };
      const gateway = createHorizonGateway(server as Horizon.Server);

      await expect(gateway.submitTransaction({} as never)).rejects.toBe(horizonError);
    });
  });

  describe('listPayments', () => {
    /** Minimal chainable fake of `PaymentCallBuilder`, recording every call it received. */
    function fakePaymentCallBuilder(records: unknown[]): {
      builder: Pick<Horizon.Server, 'payments'>;
      calls: {forAccount?: string; order?: string; limit?: number; cursor?: string};
    } {
      const calls: {forAccount?: string; order?: string; limit?: number; cursor?: string} = {};
      const chain = {
        forAccount(accountId: string) {
          calls.forAccount = accountId;
          return chain;
        },
        order(direction: string) {
          calls.order = direction;
          return chain;
        },
        limit(n: number) {
          calls.limit = n;
          return chain;
        },
        cursor(c: string) {
          calls.cursor = c;
          return chain;
        },
        async call() {
          return {records};
        }
      };
      return {
        builder: {payments: () => chain as unknown as ReturnType<Horizon.Server['payments']>},
        calls
      };
    }

    it('maps a raw payment operation record to camelCase fields', async () => {
      const {builder} = fakePaymentCallBuilder([
        {
          type: 'payment',
          paging_token: '123',
          transaction_hash: 'txhash',
          created_at: '2026-07-23T00:00:00Z',
          from: 'GFROM',
          to: 'GTO',
          asset_type: 'credit_alphanum4',
          asset_code: 'USDC',
          asset_issuer: 'GISSUER',
          amount: '10.0000000'
        }
      ]);
      const gateway = createHorizonGateway(builder as Horizon.Server);

      const records = await gateway.listPayments('GACCOUNT', undefined, 50);

      expect(records).toEqual([
        {
          type: 'payment',
          pagingToken: '123',
          transactionHash: 'txhash',
          createdAt: '2026-07-23T00:00:00Z',
          from: 'GFROM',
          to: 'GTO',
          assetType: 'credit_alphanum4',
          assetCode: 'USDC',
          assetIssuer: 'GISSUER',
          amount: '10.0000000'
        }
      ]);
    });

    it('maps a raw create_account operation record to camelCase fields', async () => {
      const {builder} = fakePaymentCallBuilder([
        {
          type: 'create_account',
          paging_token: '124',
          transaction_hash: 'txhash-create',
          created_at: '2026-07-23T00:01:00Z',
          account: 'GNEWACCOUNT',
          funder: 'GFUNDER',
          starting_balance: '0.0000000'
        }
      ]);
      const gateway = createHorizonGateway(builder as Horizon.Server);

      const records = await gateway.listPayments('GACCOUNT', undefined, 50);

      expect(records).toEqual([
        {
          type: 'create_account',
          pagingToken: '124',
          transactionHash: 'txhash-create',
          createdAt: '2026-07-23T00:01:00Z',
          account: 'GNEWACCOUNT',
          funder: 'GFUNDER'
        }
      ]);
    });

    it('passes accountId/order/limit to the call builder and omits cursor() when none is given', async () => {
      const {builder, calls} = fakePaymentCallBuilder([]);
      const gateway = createHorizonGateway(builder as Horizon.Server);

      await gateway.listPayments('GACCOUNT', undefined, 25);

      expect(calls).toEqual({forAccount: 'GACCOUNT', order: 'asc', limit: 25});
    });

    it('passes a given cursor to cursor()', async () => {
      const {builder, calls} = fakePaymentCallBuilder([]);
      const gateway = createHorizonGateway(builder as Horizon.Server);

      await gateway.listPayments('GACCOUNT', 'some-cursor', 25);

      expect(calls.cursor).toBe('some-cursor');
    });
  });
});
