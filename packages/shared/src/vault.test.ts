import {describe, expect, it} from 'vitest';
import {
  VaultDepositRequestSchema,
  VaultIntentResponseSchema,
  VaultPositionResponseSchema,
  VaultWithdrawRequestSchema
} from './vault.js';

describe('VaultDepositRequestSchema', () => {
  it('accepts a valid positive decimal amount', () => {
    const body = {amount: '10.5000000'};
    expect(VaultDepositRequestSchema.parse(body)).toEqual(body);
  });

  it('rejects a zero amount', () => {
    expect(() => VaultDepositRequestSchema.parse({amount: '0'})).toThrow();
  });

  it('rejects an amount with more than 7 decimal places', () => {
    expect(() => VaultDepositRequestSchema.parse({amount: '1.12345678'})).toThrow();
  });

  it('rejects a missing amount', () => {
    expect(() => VaultDepositRequestSchema.parse({})).toThrow();
  });
});

describe('VaultWithdrawRequestSchema', () => {
  it('accepts a valid positive decimal shares value', () => {
    const body = {shares: '2.5000000'};
    expect(VaultWithdrawRequestSchema.parse(body)).toEqual(body);
  });

  it('rejects a zero shares value', () => {
    expect(() => VaultWithdrawRequestSchema.parse({shares: '0'})).toThrow();
  });

  it('rejects a shares value with more than 7 decimal places', () => {
    expect(() => VaultWithdrawRequestSchema.parse({shares: '1.12345678'})).toThrow();
  });

  it('rejects a missing shares field', () => {
    expect(() => VaultWithdrawRequestSchema.parse({})).toThrow();
  });
});

describe('VaultIntentResponseSchema', () => {
  it('accepts an intent-created shape', () => {
    const body = {intentId: 'intent-1', xdr: 'AAAA', hashHex: '0x' + 'a'.repeat(64)};
    expect(VaultIntentResponseSchema.parse(body)).toEqual(body);
  });

  it('rejects a missing intentId', () => {
    expect(() => VaultIntentResponseSchema.parse({xdr: 'AAAA', hashHex: '0xabc'})).toThrow();
  });
});

describe('VaultPositionResponseSchema', () => {
  it('accepts a position shape', () => {
    const body = {shares: '1.5000000', underlyingBalance: '1.4800000', assetCode: 'USDC', assetIssuer: 'GISSUER'};
    expect(VaultPositionResponseSchema.parse(body)).toEqual(body);
  });

  it('rejects a missing assetIssuer', () => {
    expect(() =>
      VaultPositionResponseSchema.parse({shares: '1.5000000', underlyingBalance: '1.4800000', assetCode: 'USDC'})
    ).toThrow();
  });
});
