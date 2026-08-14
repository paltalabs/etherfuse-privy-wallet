import {AssetRegistry} from '@paltalabs/shared';
import {Keypair, Networks, Transaction} from '@stellar/stellar-sdk';
import {describe, expect, it} from 'vitest';
import {StellarAccountNotFoundError, type StellarAccount, type StellarGateway} from '../../lib/stellar-gateway.js';
import {
  createPaymentsService,
  type IntentRecord,
  type MerchantRecord,
  type PaymentsRepo,
  type PendingPaymentActivity
} from './service.js';

const ISSUER = Keypair.random().publicKey();
const registry = new AssetRegistry([{code: 'USDC', issuer: ISSUER, decimals: 7}]);
const networkPassphrase = Networks.TESTNET;

/** In-memory fake of the payments module's persistence boundary. */
function createFakeRepo(): {
  repo: PaymentsRepo;
  merchants: Map<string, MerchantRecord>;
  intents: IntentRecord[];
  activity: PendingPaymentActivity[];
} {
  const merchantsStore = new Map<string, MerchantRecord>();
  const intentsStore: IntentRecord[] = [];
  const activityStore: PendingPaymentActivity[] = [];
  let nextId = 1;

  const repo: PaymentsRepo = {
    async getMerchant(privyDid) {
      return merchantsStore.get(privyDid);
    },
    async createPaymentIntent({privyDid, xdr, hashHex}) {
      const row: IntentRecord = {
        id: `intent-${nextId++}`,
        privyDid,
        kind: 'payment',
        xdr,
        hashHex,
        status: 'pending',
        resultTxHash: null,
        error: null,
        metadata: null,
        createdAt: new Date(),
        updatedAt: new Date()
      };
      intentsStore.push(row);
      return row;
    },
    async recordPendingActivity(input) {
      activityStore.push(input);
    }
  };

  return {repo, merchants: merchantsStore, intents: intentsStore, activity: activityStore};
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

/**
 * Fake StellarGateway backed by a lookup table of publicKey -> account.
 * Absence rejects with `StellarAccountNotFoundError`, matching the real
 * `createHorizonGateway`'s contract (see `stellar-gateway.ts`) — mirrors
 * `wallet/service.test.ts`'s fake.
 */
function createFakeGateway(accounts: Record<string, StellarAccount>): StellarGateway {
  return {
    async loadAccount(publicKey) {
      const account = accounts[publicKey];
      if (!account) throw new StellarAccountNotFoundError(publicKey);
      return account;
    },
    async submitTransaction() {
      throw new Error('unused in payments service.test.ts: no test here submits a transaction');
    },
    async listPayments() {
      throw new Error('unused in payments service.test.ts: no test here polls Horizon payments');
    }
  };
}

function fakeAccount(publicKey: string, sequence = '100'): StellarAccount {
  return {
    accountId: () => publicKey,
    sequenceNumber: () => sequence,
    incrementSequenceNumber: () => {},
    balances: []
  };
}

describe('createPaymentsService.createPayment', () => {
  it('builds and stores an unsigned payment intent + a pending "send" activity row', async () => {
    const merchant = Keypair.random();
    const destination = Keypair.random().publicKey();
    const {repo, merchants, activity} = createFakeRepo();
    seedMerchant(merchants, 'did:privy:payer', merchant.publicKey());
    const gateway = createFakeGateway({[merchant.publicKey()]: fakeAccount(merchant.publicKey(), '100')});
    const service = createPaymentsService({repo, stellarGateway: gateway, registry, networkPassphrase});

    const result = await service.createPayment('did:privy:payer', {
      destination,
      amount: '10.5000000',
      assetCode: 'USDC'
    });

    expect(result).toEqual({
      intentId: expect.any(String),
      xdr: expect.any(String),
      hashHex: expect.stringMatching(/^0x[0-9a-f]{64}$/)
    });

    // Unsigned: the merchant must co-sign via Privy rawSign before
    // POST /intents/:id/complete, sponsor signs nothing at build time.
    const tx = new Transaction(result.xdr, networkPassphrase);
    expect(tx.signatures).toHaveLength(0);
    expect(tx.source).toBe(merchant.publicKey());
    expect(tx.fee).toBe('100');
    expect(tx.operations).toHaveLength(1);
    const op = tx.operations[0];
    if (op?.type !== 'payment') throw new Error('expected a payment operation');
    expect(op.destination).toBe(destination);
    expect(op.amount).toBe('10.5000000');
    expect(op.asset.code).toBe('USDC');
    expect(op.asset.issuer).toBe(ISSUER);

    expect(activity).toEqual([
      {
        stellarAddress: merchant.publicKey(),
        externalRef: result.intentId,
        counterparty: destination,
        amount: '10.5000000',
        assetCode: 'USDC',
        assetIssuer: ISSUER
      }
    ]);
  });

  it('throws AppError("unknown_asset", 400) for an assetCode not in the registry', async () => {
    const merchant = Keypair.random();
    const {repo, merchants} = createFakeRepo();
    seedMerchant(merchants, 'did:privy:payer', merchant.publicKey());
    const gateway = createFakeGateway({[merchant.publicKey()]: fakeAccount(merchant.publicKey())});
    const service = createPaymentsService({repo, stellarGateway: gateway, registry, networkPassphrase});

    await expect(
      service.createPayment('did:privy:payer', {
        destination: Keypair.random().publicKey(),
        amount: '10',
        assetCode: 'NOPE'
      })
    ).rejects.toMatchObject({code: 'unknown_asset', statusCode: 400});
  });

  it('throws AppError("invalid_request", 400) for a shape-valid but bad-checksum destination', async () => {
    const merchant = Keypair.random();
    const {repo, merchants} = createFakeRepo();
    seedMerchant(merchants, 'did:privy:payer', merchant.publicKey());
    const gateway = createFakeGateway({[merchant.publicKey()]: fakeAccount(merchant.publicKey())});
    const service = createPaymentsService({repo, stellarGateway: gateway, registry, networkPassphrase});

    // Same length/alphabet as a real G-address (passes PaymentRequestSchema's
    // shape regex) but the last character -- part of the embedded CRC16
    // checksum -- is flipped, breaking StrKey's checksum validation.
    const validAddress = Keypair.random().publicKey();
    const badChecksum = validAddress.slice(0, -1) + (validAddress.at(-1) === 'A' ? 'B' : 'A');

    await expect(
      service.createPayment('did:privy:payer', {destination: badChecksum, amount: '10', assetCode: 'USDC'})
    ).rejects.toMatchObject({code: 'invalid_request', statusCode: 400});
  });

  it('throws AppError("merchant_not_found", 404) when the caller has never provisioned', async () => {
    const {repo} = createFakeRepo();
    const gateway = createFakeGateway({});
    const service = createPaymentsService({repo, stellarGateway: gateway, registry, networkPassphrase});

    await expect(
      service.createPayment('did:privy:unknown', {
        destination: Keypair.random().publicKey(),
        amount: '10',
        assetCode: 'USDC'
      })
    ).rejects.toMatchObject({code: 'merchant_not_found', statusCode: 404});
  });

  it('throws AppError("self_payment", 400) when destination is the merchant\'s own address', async () => {
    const merchant = Keypair.random();
    const {repo, merchants} = createFakeRepo();
    seedMerchant(merchants, 'did:privy:payer', merchant.publicKey());
    const gateway = createFakeGateway({[merchant.publicKey()]: fakeAccount(merchant.publicKey())});
    const service = createPaymentsService({repo, stellarGateway: gateway, registry, networkPassphrase});

    await expect(
      service.createPayment('did:privy:payer', {
        destination: merchant.publicKey(),
        amount: '10',
        assetCode: 'USDC'
      })
    ).rejects.toMatchObject({code: 'self_payment', statusCode: 400});
  });

  it('throws AppError("merchant_not_provisioned", 409) when the merchant account does not exist on-chain yet', async () => {
    const merchant = Keypair.random();
    const {repo, merchants} = createFakeRepo();
    seedMerchant(merchants, 'did:privy:pending', merchant.publicKey());
    const gateway = createFakeGateway({}); // no on-chain account for the merchant
    const service = createPaymentsService({repo, stellarGateway: gateway, registry, networkPassphrase});

    await expect(
      service.createPayment('did:privy:pending', {
        destination: Keypair.random().publicKey(),
        amount: '10',
        assetCode: 'USDC'
      })
    ).rejects.toMatchObject({code: 'merchant_not_provisioned', statusCode: 409});
  });

  it('rethrows a non-"not found" gateway failure instead of masking it', async () => {
    const merchant = Keypair.random();
    const {repo, merchants} = createFakeRepo();
    seedMerchant(merchants, 'did:privy:outage', merchant.publicKey());
    const gateway: StellarGateway = {
      loadAccount: async () => {
        throw new Error('Horizon is unreachable');
      },
      submitTransaction: async () => {
        throw new Error('unused: this test never submits a transaction');
      },
      listPayments: async () => {
        throw new Error('unused: this test never polls Horizon payments');
      }
    };
    const service = createPaymentsService({repo, stellarGateway: gateway, registry, networkPassphrase});

    await expect(
      service.createPayment('did:privy:outage', {
        destination: Keypair.random().publicKey(),
        amount: '10',
        assetCode: 'USDC'
      })
    ).rejects.toThrow('Horizon is unreachable');
  });
});
