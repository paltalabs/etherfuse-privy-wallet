import {describe, expect, it} from 'vitest';
import {
  ActivityFeedResponseSchema,
  ActivityItemSchema,
  CompleteIntentRequestSchema,
  CompleteIntentResponseSchema,
  PaymentRequestSchema,
  PaymentResponseSchema,
  ProvisionResponseSchema,
  stellarAmountSchema,
  toStroops,
  WalletBalanceSchema,
  WalletResponseSchema
} from './api.js';

describe('ProvisionResponseSchema', () => {
  it('accepts a pending-intent shape', () => {
    const pending = {intentId: 'intent-1', xdr: 'AAAA', hashHex: '0xabc'};
    expect(ProvisionResponseSchema.parse(pending)).toEqual(pending);
  });

  it('accepts a provisioned-complete shape', () => {
    const complete = {provisioned: true, stellarAddress: 'GABC'};
    expect(ProvisionResponseSchema.parse(complete)).toEqual(complete);
  });

  it('rejects a shape matching neither branch', () => {
    expect(() => ProvisionResponseSchema.parse({foo: 'bar'})).toThrow();
  });
});

describe('WalletBalanceSchema', () => {
  it('requires assetIssuer alongside assetCode (issuer is load-bearing for spoof-resistance)', () => {
    expect(() => WalletBalanceSchema.parse({assetCode: 'USDC', balance: '10.0000000'})).toThrow();
  });
});

describe('WalletResponseSchema', () => {
  it('accepts a wallet response with balances', () => {
    const wallet = {
      stellarAddress: 'GABC',
      provisioned: true,
      balances: [{assetCode: 'USDC', assetIssuer: 'GISSUER', balance: '10.0000000'}]
    };
    expect(WalletResponseSchema.parse(wallet)).toEqual(wallet);
  });

  it('accepts an empty balances array', () => {
    const wallet = {stellarAddress: 'GABC', provisioned: false, balances: []};
    expect(WalletResponseSchema.parse(wallet)).toEqual(wallet);
  });

  it('rejects a missing stellarAddress', () => {
    expect(() => WalletResponseSchema.parse({provisioned: false, balances: []})).toThrow();
  });
});

describe('CompleteIntentRequestSchema', () => {
  it('accepts a 0x-hex signature body', () => {
    const body = {signature: '0x' + 'ab'.repeat(64)};
    expect(CompleteIntentRequestSchema.parse(body)).toEqual(body);
  });

  it('rejects a missing signature', () => {
    expect(() => CompleteIntentRequestSchema.parse({})).toThrow();
  });
});

describe('CompleteIntentResponseSchema', () => {
  it('accepts a txHash', () => {
    const body = {txHash: 'deadbeef'};
    expect(CompleteIntentResponseSchema.parse(body)).toEqual(body);
  });

  it('rejects a missing txHash', () => {
    expect(() => CompleteIntentResponseSchema.parse({})).toThrow();
  });
});

describe('PaymentRequestSchema', () => {
  const validDestination = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

  it('accepts a valid payment request', () => {
    const body = {destination: validDestination, amount: '10.5000000', assetCode: 'USDC'};
    expect(PaymentRequestSchema.parse(body)).toEqual(body);
  });

  it('accepts an integer amount with no decimal point', () => {
    const body = {destination: validDestination, amount: '10', assetCode: 'USDC'};
    expect(PaymentRequestSchema.parse(body)).toEqual(body);
  });

  it('rejects a destination that is not a Stellar G-address', () => {
    expect(() =>
      PaymentRequestSchema.parse({destination: 'not-a-stellar-address', amount: '10', assetCode: 'USDC'})
    ).toThrow();
  });

  it('rejects a destination one character short of a valid G-address', () => {
    expect(() =>
      PaymentRequestSchema.parse({destination: validDestination.slice(0, -1), amount: '10', assetCode: 'USDC'})
    ).toThrow();
  });

  it('rejects an amount with more than 7 decimal places', () => {
    expect(() =>
      PaymentRequestSchema.parse({destination: validDestination, amount: '10.12345678', assetCode: 'USDC'})
    ).toThrow();
  });

  it('rejects a zero amount', () => {
    expect(() =>
      PaymentRequestSchema.parse({destination: validDestination, amount: '0', assetCode: 'USDC'})
    ).toThrow();
  });

  it('rejects an all-zero decimal amount', () => {
    expect(() =>
      PaymentRequestSchema.parse({destination: validDestination, amount: '0.0000000', assetCode: 'USDC'})
    ).toThrow();
  });

  it('rejects a negative amount', () => {
    expect(() =>
      PaymentRequestSchema.parse({destination: validDestination, amount: '-1', assetCode: 'USDC'})
    ).toThrow();
  });

  it('rejects an empty assetCode', () => {
    expect(() =>
      PaymentRequestSchema.parse({destination: validDestination, amount: '10', assetCode: ''})
    ).toThrow();
  });

  it('accepts an amount exactly at Stellar\'s int64 maximum (922337203685.4775807)', () => {
    const body = {destination: validDestination, amount: '922337203685.4775807', assetCode: 'USDC'};
    expect(PaymentRequestSchema.parse(body)).toEqual(body);
  });

  it('rejects an amount one stroop over Stellar\'s int64 maximum -- a case floating-point comparison would silently accept', () => {
    expect(() =>
      PaymentRequestSchema.parse({destination: validDestination, amount: '922337203685.4775808', assetCode: 'USDC'})
    ).toThrow();
  });

  it('rejects an amount far beyond the int64 maximum', () => {
    expect(() =>
      PaymentRequestSchema.parse({destination: validDestination, amount: '999999999999999999999', assetCode: 'USDC'})
    ).toThrow();
  });
});

describe('PaymentResponseSchema', () => {
  it('accepts a pending payment intent shape', () => {
    const body = {intentId: 'intent-1', xdr: 'AAAA', hashHex: '0x' + 'a'.repeat(64)};
    expect(PaymentResponseSchema.parse(body)).toEqual(body);
  });

  it('rejects a missing intentId', () => {
    expect(() => PaymentResponseSchema.parse({xdr: 'AAAA', hashHex: '0xabc'})).toThrow();
  });
});

describe('ActivityItemSchema', () => {
  it('accepts a fully-populated send row', () => {
    const item = {
      id: 'activity-1',
      type: 'send',
      direction: 'out',
      amount: '10.5000000',
      assetCode: 'USDC',
      assetIssuer: 'GISSUER',
      counterparty: 'GDEST',
      status: 'confirmed',
      txHash: 'deadbeef',
      createdAt: '2026-07-23T00:00:00.000Z'
    };
    expect(ActivityItemSchema.parse(item)).toEqual(item);
  });

  it('accepts a provision row with all the nullable fields null', () => {
    const item = {
      id: 'activity-2',
      type: 'provision',
      direction: null,
      amount: null,
      assetCode: null,
      assetIssuer: null,
      counterparty: null,
      status: 'pending',
      txHash: null,
      createdAt: '2026-07-23T00:00:00.000Z'
    };
    expect(ActivityItemSchema.parse(item)).toEqual(item);
  });

  it('rejects an unknown type', () => {
    expect(() =>
      ActivityItemSchema.parse({
        id: 'activity-3',
        type: 'unknown',
        direction: null,
        amount: null,
        assetCode: null,
        assetIssuer: null,
        counterparty: null,
        status: 'pending',
        txHash: null,
        createdAt: '2026-07-23T00:00:00.000Z'
      })
    ).toThrow();
  });

  it.each(['on_ramp', 'off_ramp', 'vault_deposit', 'vault_withdraw'] as const)(
    'accepts the new "%s" type (widened for the payout/vault intent kinds)',
    (type) => {
      const item = {
        id: 'activity-new-type',
        type,
        direction: null,
        amount: null,
        assetCode: null,
        assetIssuer: null,
        counterparty: null,
        status: 'pending',
        txHash: null,
        createdAt: '2026-07-23T00:00:00.000Z'
      };
      expect(ActivityItemSchema.parse(item)).toEqual(item);
    }
  );

  it('rejects a missing status', () => {
    expect(() =>
      ActivityItemSchema.parse({
        id: 'activity-4',
        type: 'send',
        direction: 'out',
        amount: '10',
        assetCode: 'USDC',
        assetIssuer: 'GISSUER',
        counterparty: 'GDEST',
        txHash: null,
        createdAt: '2026-07-23T00:00:00.000Z'
      })
    ).toThrow();
  });
});

describe('ActivityFeedResponseSchema', () => {
  it('accepts a page with items and a nextBefore cursor', () => {
    const body = {
      items: [
        {
          id: 'activity-1',
          type: 'receive',
          direction: 'in',
          amount: '5.0000000',
          assetCode: 'USDC',
          assetIssuer: 'GISSUER',
          counterparty: 'GSENDER',
          status: 'confirmed',
          txHash: 'deadbeef',
          createdAt: '2026-07-23T00:00:00.000Z'
        }
      ],
      nextBefore: '2026-07-23T00:00:00.000Z'
    };
    expect(ActivityFeedResponseSchema.parse(body)).toEqual(body);
  });

  it('accepts an empty page with a null nextBefore', () => {
    const body = {items: [], nextBefore: null};
    expect(ActivityFeedResponseSchema.parse(body)).toEqual(body);
  });

  it('rejects a missing items array', () => {
    expect(() => ActivityFeedResponseSchema.parse({nextBefore: null})).toThrow();
  });
});

describe('toStroops', () => {
  it('converts a decimal amount to integer stroops (1 unit = 10_000_000 stroops)', () => {
    expect(toStroops('1.5')).toBe(15_000_000n);
  });

  it('converts a whole-number amount with no fractional part', () => {
    expect(toStroops('10')).toBe(100_000_000n);
  });
});

describe('stellarAmountSchema', () => {
  it('is the exact schema PaymentRequestSchema uses for `amount` — accepts a valid amount', () => {
    expect(stellarAmountSchema.parse('10.5000000')).toBe('10.5000000');
  });

  it('rejects a zero amount, same as PaymentRequestSchema\'s amount field', () => {
    expect(() => stellarAmountSchema.parse('0')).toThrow();
  });
});
