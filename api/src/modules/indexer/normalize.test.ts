import {AssetRegistry} from '@paltalabs/shared';
import {describe, expect, it} from 'vitest';
import type {HorizonPaymentRecord} from '../../lib/stellar-gateway.js';
import {normalizePayment} from './normalize.js';

const OWN_ADDRESS = 'GOWNADDRESSAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const COUNTERPARTY = 'GCOUNTERPARTYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const REGISTRY_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const FOREIGN_ISSUER = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const registry = new AssetRegistry([{code: 'USDC', issuer: REGISTRY_ISSUER, decimals: 7}]);

function paymentRecord(overrides: Partial<HorizonPaymentRecord> = {}): HorizonPaymentRecord {
  return {
    type: 'payment',
    pagingToken: '100',
    transactionHash: 'txhash-payment',
    createdAt: '2026-07-23T00:00:00Z',
    from: COUNTERPARTY,
    to: OWN_ADDRESS,
    assetType: 'credit_alphanum4',
    assetCode: 'USDC',
    assetIssuer: REGISTRY_ISSUER,
    amount: '10.5000000',
    ...overrides
  };
}

describe('normalizePayment', () => {
  it('normalizes an outgoing registry-asset payment to a send row', () => {
    const record = paymentRecord({from: OWN_ADDRESS, to: COUNTERPARTY});

    const result = normalizePayment(record, OWN_ADDRESS, registry);

    expect(result).toEqual({
      stellarAddress: OWN_ADDRESS,
      type: 'send',
      direction: 'out',
      amount: '10.5000000',
      assetCode: 'USDC',
      assetIssuer: REGISTRY_ISSUER,
      counterparty: COUNTERPARTY,
      status: 'confirmed',
      txHash: 'txhash-payment',
      source: 'indexer'
    });
  });

  it('normalizes an incoming registry-asset payment to a receive row', () => {
    const record = paymentRecord({from: COUNTERPARTY, to: OWN_ADDRESS});

    const result = normalizePayment(record, OWN_ADDRESS, registry);

    expect(result).toEqual({
      stellarAddress: OWN_ADDRESS,
      type: 'receive',
      direction: 'in',
      amount: '10.5000000',
      assetCode: 'USDC',
      assetIssuer: REGISTRY_ISSUER,
      counterparty: COUNTERPARTY,
      status: 'confirmed',
      txHash: 'txhash-payment',
      source: 'indexer'
    });
  });

  it('skips a payment in a foreign-issuer asset sharing a registry asset code (spoofed-asset boundary)', () => {
    const record = paymentRecord({assetCode: 'USDC', assetIssuer: FOREIGN_ISSUER});

    expect(normalizePayment(record, OWN_ADDRESS, registry)).toBeNull();
  });

  it('skips a payment in an asset code not in the registry at all', () => {
    const record = paymentRecord({assetCode: 'UNKNOWN', assetIssuer: FOREIGN_ISSUER});

    expect(normalizePayment(record, OWN_ADDRESS, registry)).toBeNull();
  });

  it('skips a native XLM payment', () => {
    const record = paymentRecord({assetType: 'native', assetCode: undefined, assetIssuer: undefined});

    expect(normalizePayment(record, OWN_ADDRESS, registry)).toBeNull();
  });

  it('skips a non-payment operation type (e.g. account_merge)', () => {
    const record: HorizonPaymentRecord = {
      type: 'account_merge',
      pagingToken: '101',
      transactionHash: 'txhash-merge',
      createdAt: '2026-07-23T00:01:00Z'
    };

    expect(normalizePayment(record, OWN_ADDRESS, registry)).toBeNull();
  });

  it('normalizes a create_account record for the own (created) address to a provision row', () => {
    const record: HorizonPaymentRecord = {
      type: 'create_account',
      pagingToken: '99',
      transactionHash: 'txhash-create',
      createdAt: '2026-07-22T23:59:00Z',
      account: OWN_ADDRESS,
      funder: COUNTERPARTY
    };

    const result = normalizePayment(record, OWN_ADDRESS, registry);

    expect(result).toEqual({
      stellarAddress: OWN_ADDRESS,
      type: 'provision',
      direction: null,
      amount: null,
      assetCode: null,
      assetIssuer: null,
      counterparty: COUNTERPARTY,
      status: 'confirmed',
      txHash: 'txhash-create',
      source: 'indexer'
    });
  });

  it('skips a create_account record where the own address is only the funder, not the created account', () => {
    const record: HorizonPaymentRecord = {
      type: 'create_account',
      pagingToken: '98',
      transactionHash: 'txhash-create-2',
      createdAt: '2026-07-22T23:58:00Z',
      account: COUNTERPARTY,
      funder: OWN_ADDRESS
    };

    expect(normalizePayment(record, OWN_ADDRESS, registry)).toBeNull();
  });

  it('skips a payment where neither from nor to matches the own address (defensive)', () => {
    const record = paymentRecord({from: COUNTERPARTY, to: FOREIGN_ISSUER});

    expect(normalizePayment(record, OWN_ADDRESS, registry)).toBeNull();
  });
});
