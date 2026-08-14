import {describe, expect, it} from 'vitest';
import {
  KycLaunchResponseSchema,
  OnboardingStartRequestSchema,
  PayinExecuteRequestSchema,
  PayinOrderResponseSchema,
  PayinOrderStateResponseSchema,
  PayinQuoteRequestSchema,
  PayoutExecuteRequestSchema,
  PayoutIntentResponseSchema,
  PayoutQuoteRequestSchema,
  PixDepositSchema,
  PixDetailsRequestSchema,
  RampOnboardingStatusSchema,
  RampOrderStatusSchema,
  RampQuoteResponseSchema
} from './ramp.js';

describe('RampQuoteResponseSchema', () => {
  const VALID_QUOTE = {
    quoteId: 'quo_abc123',
    expiresAt: 1735689600000,
    senderAmountCents: 10000,
    receiverAmountCents: 1949,
    flatFeeCents: 50,
    commercialQuotation: 5.12
  };

  it('accepts a fully-populated valid quote', () => {
    expect(RampQuoteResponseSchema.parse(VALID_QUOTE)).toEqual(VALID_QUOTE);
  });

  it('rejects a missing quoteId', () => {
    const {quoteId: _quoteId, ...withoutQuoteId} = VALID_QUOTE;
    expect(() => RampQuoteResponseSchema.parse(withoutQuoteId)).toThrow();
  });

  it('rejects a non-numeric expiresAt', () => {
    expect(() => RampQuoteResponseSchema.parse({...VALID_QUOTE, expiresAt: '1735689600000'})).toThrow();
  });
});

describe('PayinQuoteRequestSchema', () => {
  it('accepts a positive integer amountBrlCents', () => {
    expect(PayinQuoteRequestSchema.parse({amountBrlCents: 1949})).toEqual({amountBrlCents: 1949});
  });

  it('rejects a zero amountBrlCents', () => {
    expect(() => PayinQuoteRequestSchema.parse({amountBrlCents: 0})).toThrow();
  });

  it('rejects a negative amountBrlCents', () => {
    expect(() => PayinQuoteRequestSchema.parse({amountBrlCents: -100})).toThrow();
  });

  it('rejects a non-integer amountBrlCents', () => {
    expect(() => PayinQuoteRequestSchema.parse({amountBrlCents: 19.49})).toThrow();
  });

  it('rejects a missing amountBrlCents', () => {
    expect(() => PayinQuoteRequestSchema.parse({})).toThrow();
  });
});

describe('PayinExecuteRequestSchema', () => {
  const VALID_EXECUTE = {quoteId: 'quo_abc123', amountCents: 1962};

  it('accepts a non-empty quoteId and a positive integer amountCents', () => {
    expect(PayinExecuteRequestSchema.parse(VALID_EXECUTE)).toEqual(VALID_EXECUTE);
  });

  it('rejects an empty quoteId', () => {
    expect(() => PayinExecuteRequestSchema.parse({...VALID_EXECUTE, quoteId: ''})).toThrow();
  });

  it('rejects a missing quoteId', () => {
    const {quoteId: _quoteId, ...withoutQuoteId} = VALID_EXECUTE;
    expect(() => PayinExecuteRequestSchema.parse(withoutQuoteId)).toThrow();
  });

  it('rejects a zero amountCents', () => {
    expect(() => PayinExecuteRequestSchema.parse({...VALID_EXECUTE, amountCents: 0})).toThrow();
  });

  it('rejects a negative amountCents', () => {
    expect(() => PayinExecuteRequestSchema.parse({...VALID_EXECUTE, amountCents: -1})).toThrow();
  });

  it('rejects a non-integer amountCents', () => {
    expect(() => PayinExecuteRequestSchema.parse({...VALID_EXECUTE, amountCents: 19.62})).toThrow();
  });

  it('rejects a missing amountCents', () => {
    const {amountCents: _amountCents, ...withoutAmountCents} = VALID_EXECUTE;
    expect(() => PayinExecuteRequestSchema.parse(withoutAmountCents)).toThrow();
  });
});

describe('PayoutExecuteRequestSchema', () => {
  const VALID_EXECUTE = {quoteId: 'quo_sUetK7ZYbenp', amountCents: 1000};

  it('accepts a non-empty quoteId and a positive integer amountCents', () => {
    expect(PayoutExecuteRequestSchema.parse(VALID_EXECUTE)).toEqual(VALID_EXECUTE);
  });

  it('rejects an empty quoteId', () => {
    expect(() => PayoutExecuteRequestSchema.parse({...VALID_EXECUTE, quoteId: ''})).toThrow();
  });

  it('rejects a missing quoteId', () => {
    const {quoteId: _quoteId, ...withoutQuoteId} = VALID_EXECUTE;
    expect(() => PayoutExecuteRequestSchema.parse(withoutQuoteId)).toThrow();
  });

  it('rejects a zero amountCents', () => {
    expect(() => PayoutExecuteRequestSchema.parse({...VALID_EXECUTE, amountCents: 0})).toThrow();
  });

  it('rejects a negative amountCents', () => {
    expect(() => PayoutExecuteRequestSchema.parse({...VALID_EXECUTE, amountCents: -1})).toThrow();
  });

  it('rejects a non-integer amountCents', () => {
    expect(() => PayoutExecuteRequestSchema.parse({...VALID_EXECUTE, amountCents: 10.5})).toThrow();
  });

  it('rejects a missing amountCents', () => {
    const {amountCents: _amountCents, ...withoutAmountCents} = VALID_EXECUTE;
    expect(() => PayoutExecuteRequestSchema.parse(withoutAmountCents)).toThrow();
  });
});

describe('PayoutQuoteRequestSchema', () => {
  it('accepts a positive integer amountCents', () => {
    expect(PayoutQuoteRequestSchema.parse({amountCents: 1000})).toEqual({amountCents: 1000});
  });

  it('rejects a zero amountCents', () => {
    expect(() => PayoutQuoteRequestSchema.parse({amountCents: 0})).toThrow();
  });

  it('rejects a negative amountCents', () => {
    expect(() => PayoutQuoteRequestSchema.parse({amountCents: -100})).toThrow();
  });

  it('rejects a non-integer amountCents', () => {
    expect(() => PayoutQuoteRequestSchema.parse({amountCents: 10.5})).toThrow();
  });

  it('rejects a missing amountCents', () => {
    expect(() => PayoutQuoteRequestSchema.parse({})).toThrow();
  });
});

describe('PayoutIntentResponseSchema', () => {
  const VALID_PAYOUT_INTENT = {intentId: 'intent-1', xdr: 'AAAA...', hashHex: '0xdeadbeef'};

  it('accepts a fully-populated valid payout intent', () => {
    expect(PayoutIntentResponseSchema.parse(VALID_PAYOUT_INTENT)).toEqual(VALID_PAYOUT_INTENT);
  });

  it('rejects a missing intentId', () => {
    const {intentId: _intentId, ...withoutIntentId} = VALID_PAYOUT_INTENT;
    expect(() => PayoutIntentResponseSchema.parse(withoutIntentId)).toThrow();
  });

  it('rejects a missing xdr', () => {
    const {xdr: _xdr, ...withoutXdr} = VALID_PAYOUT_INTENT;
    expect(() => PayoutIntentResponseSchema.parse(withoutXdr)).toThrow();
  });

  it('rejects a missing hashHex', () => {
    const {hashHex: _hashHex, ...withoutHashHex} = VALID_PAYOUT_INTENT;
    expect(() => PayoutIntentResponseSchema.parse(withoutHashHex)).toThrow();
  });
});

describe('RampOnboardingStatusSchema', () => {
  it.each(['not_started', 'verifying', 'incomplete', 'ready'] as const)('accepts status %s', (status) => {
    expect(RampOnboardingStatusSchema.parse({status})).toEqual({status});
  });

  it('rejects an unrecognized status value', () => {
    expect(() => RampOnboardingStatusSchema.parse({status: 'approved'})).toThrow();
  });

  it('rejects a missing status', () => {
    expect(() => RampOnboardingStatusSchema.parse({})).toThrow();
  });
});

describe('OnboardingStartRequestSchema', () => {
  it('accepts a valid displayName and email', () => {
    const body = {displayName: 'Spike Merchant', email: 'merchant@example.com'};
    expect(OnboardingStartRequestSchema.parse(body)).toEqual(body);
  });

  it('rejects an empty displayName', () => {
    expect(() => OnboardingStartRequestSchema.parse({displayName: '', email: 'merchant@example.com'})).toThrow();
  });

  it('rejects a malformed email', () => {
    expect(() => OnboardingStartRequestSchema.parse({displayName: 'Spike Merchant', email: 'not-an-email'})).toThrow();
  });

  it('rejects a missing displayName', () => {
    expect(() => OnboardingStartRequestSchema.parse({email: 'merchant@example.com'})).toThrow();
  });
});

describe('KycLaunchResponseSchema', () => {
  const VALID_LAUNCH = {
    launch: {
      actionUrl: 'https://sandbox.etherfuse.com/auth/launch',
      assertion: 'eyJhbGciOiJSUzI1NiJ9.payload.signature',
      target: '/idv',
      returnUrl: 'https://app.paltalabs.io/ramp/kyc/return'
    }
  };

  it('accepts a fully-populated launch payload', () => {
    expect(KycLaunchResponseSchema.parse(VALID_LAUNCH)).toEqual(VALID_LAUNCH);
  });

  it('rejects a missing nested launch field', () => {
    expect(() => KycLaunchResponseSchema.parse({})).toThrow();
  });

  it('rejects a non-url actionUrl', () => {
    expect(() =>
      KycLaunchResponseSchema.parse({launch: {...VALID_LAUNCH.launch, actionUrl: 'not-a-url'}})
    ).toThrow();
  });

  it('rejects an empty assertion', () => {
    expect(() => KycLaunchResponseSchema.parse({launch: {...VALID_LAUNCH.launch, assertion: ''}})).toThrow();
  });

  it('rejects a non-url returnUrl', () => {
    expect(() =>
      KycLaunchResponseSchema.parse({launch: {...VALID_LAUNCH.launch, returnUrl: 'not-a-url'}})
    ).toThrow();
  });
});

describe('PixDetailsRequestSchema', () => {
  const VALID_PIX_DETAILS = {
    firstName: 'Ana',
    lastName: 'Souza',
    cpf: '12345678909',
    pixKey: 'ana@example.com',
    pixKeyType: 'email'
  };

  it('accepts a complete pix details body', () => {
    expect(PixDetailsRequestSchema.parse(VALID_PIX_DETAILS)).toEqual(VALID_PIX_DETAILS);
  });

  it.each(['email', 'cpf', 'phone', 'evp'] as const)('accepts pixKeyType %s', (pixKeyType) => {
    expect(PixDetailsRequestSchema.parse({...VALID_PIX_DETAILS, pixKeyType})).toEqual({
      ...VALID_PIX_DETAILS,
      pixKeyType
    });
  });

  it('rejects an unknown pixKeyType', () => {
    expect(PixDetailsRequestSchema.safeParse({...VALID_PIX_DETAILS, pixKeyType: 'carrier-pigeon'}).success).toBe(
      false
    );
  });

  it('rejects an empty firstName', () => {
    expect(() => PixDetailsRequestSchema.parse({...VALID_PIX_DETAILS, firstName: ''})).toThrow();
  });

  it('rejects an empty cpf', () => {
    expect(() => PixDetailsRequestSchema.parse({...VALID_PIX_DETAILS, cpf: ''})).toThrow();
  });

  it('rejects a missing pixKey', () => {
    const {pixKey: _pixKey, ...withoutPixKey} = VALID_PIX_DETAILS;
    expect(() => PixDetailsRequestSchema.parse(withoutPixKey)).toThrow();
  });
});

describe('RampOrderStatusSchema', () => {
  it.each(['created', 'funded', 'completed', 'finalized', 'failed', 'refunded', 'canceled'] as const)(
    'accepts status %s',
    (status) => {
      expect(RampOrderStatusSchema.parse(status)).toEqual(status);
    }
  );

  it('rejects an unrecognized status value', () => {
    expect(() => RampOrderStatusSchema.parse('pending')).toThrow();
  });
});

describe('PixDepositSchema', () => {
  const VALID_DEPOSIT = {
    depositAmount: '100',
    depositBankName: 'PIX',
    depositAccountHolder: 'Etherfuse'
  };

  it('accepts a fully-populated deposit payload', () => {
    expect(PixDepositSchema.parse(VALID_DEPOSIT)).toEqual(VALID_DEPOSIT);
  });

  it('rejects an empty depositAmount', () => {
    expect(() => PixDepositSchema.parse({...VALID_DEPOSIT, depositAmount: ''})).toThrow();
  });

  it('rejects a missing depositBankName', () => {
    const {depositBankName: _depositBankName, ...withoutBankName} = VALID_DEPOSIT;
    expect(() => PixDepositSchema.parse(withoutBankName)).toThrow();
  });
});

describe('PayinOrderResponseSchema', () => {
  const VALID_ORDER = {
    orderId: '5777d79c-326a-418d-be30-63e7073f311c',
    status: 'created',
    deposit: {
      depositAmount: '100',
      depositBankName: 'PIX',
      depositAccountHolder: 'Etherfuse'
    },
    receiverAmountCents: 1962
  };

  it('accepts a fully-populated valid order', () => {
    expect(PayinOrderResponseSchema.parse(VALID_ORDER)).toEqual(VALID_ORDER);
  });

  it('rejects an empty orderId', () => {
    expect(() => PayinOrderResponseSchema.parse({...VALID_ORDER, orderId: ''})).toThrow();
  });

  it('rejects an unrecognized order status', () => {
    expect(() => PayinOrderResponseSchema.parse({...VALID_ORDER, status: 'pending'})).toThrow();
  });

  it('rejects a missing nested deposit field', () => {
    expect(() => PayinOrderResponseSchema.parse({...VALID_ORDER, deposit: {}})).toThrow();
  });

  it('rejects a negative receiverAmountCents', () => {
    expect(() => PayinOrderResponseSchema.parse({...VALID_ORDER, receiverAmountCents: -1})).toThrow();
  });

  it('rejects a non-integer receiverAmountCents', () => {
    expect(() => PayinOrderResponseSchema.parse({...VALID_ORDER, receiverAmountCents: 19.62})).toThrow();
  });
});

describe('PayinOrderStateResponseSchema', () => {
  const VALID_STATE = {
    orderId: '5777d79c-326a-418d-be30-63e7073f311c',
    status: 'completed',
    txHash: null
  };

  it('accepts a fully-populated state with a null txHash', () => {
    expect(PayinOrderStateResponseSchema.parse(VALID_STATE)).toEqual(VALID_STATE);
  });

  it('accepts a non-null txHash', () => {
    const body = {...VALID_STATE, txHash: '773a7202667707db75cd0b1cf6bd81e94e9907992378c3ff15e0662570e67c7b'};
    expect(PayinOrderStateResponseSchema.parse(body)).toEqual(body);
  });

  it('rejects a missing txHash (undefined is not the same as null)', () => {
    const {txHash: _txHash, ...withoutTxHash} = VALID_STATE;
    expect(() => PayinOrderStateResponseSchema.parse(withoutTxHash)).toThrow();
  });

  it('rejects an unrecognized order status', () => {
    expect(() => PayinOrderStateResponseSchema.parse({...VALID_STATE, status: 'pending'})).toThrow();
  });
});
