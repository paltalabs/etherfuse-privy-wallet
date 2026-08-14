import {AssetRegistry} from '@paltalabs/shared';
import {Keypair, Networks} from '@stellar/stellar-sdk';
import {describe, expect, it} from 'vitest';
import {StellarAccountNotFoundError, type StellarAccount, type StellarGateway} from '../../lib/stellar-gateway.js';
import type {PrivyUserResolver} from './privy-user.js';
import {createWalletService, type IntentRecord, type MerchantRecord, type WalletRepo} from './service.js';

const ISSUER = Keypair.random().publicKey();
const registry = new AssetRegistry([{code: 'USDC', issuer: ISSUER, decimals: 7}]);
const sponsor = Keypair.random();
const networkPassphrase = Networks.TESTNET;

/** In-memory fake of the wallet module's persistence boundary. */
function createFakeRepo(): WalletRepo {
  const merchantsStore = new Map<string, MerchantRecord>();
  const intentsStore: IntentRecord[] = [];
  let nextId = 1;

  return {
    async upsertMerchant({privyDid, privyWalletId, stellarAddress}) {
      const existing = merchantsStore.get(privyDid);
      if (existing) return existing;
      const row: MerchantRecord = {privyDid, privyWalletId, stellarAddress, provisionedAt: null, createdAt: new Date()};
      merchantsStore.set(privyDid, row);
      return row;
    },
    async getMerchant(privyDid) {
      return merchantsStore.get(privyDid);
    },
    async markProvisioned(privyDid) {
      const row = merchantsStore.get(privyDid);
      if (row) row.provisionedAt = new Date();
    },
    async findPendingProvisionIntent(privyDid) {
      return intentsStore.find((i) => i.privyDid === privyDid && i.kind === 'provision' && i.status === 'pending');
    },
    async createProvisionIntent({privyDid, xdr, hashHex}) {
      const row: IntentRecord = {
        id: `intent-${nextId++}`,
        privyDid,
        kind: 'provision',
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
    }
  };
}

/**
 * Fake StellarGateway backed by a lookup table of publicKey -> account.
 * Absence rejects with `StellarAccountNotFoundError`, matching the real
 * `createHorizonGateway`'s contract (see `stellar-gateway.ts`) — this is
 * what lets `getWallet`'s "account not on-chain yet -> empty balances"
 * branch trigger correctly in these tests, as opposed to a generic outage.
 */
function createFakeGateway(accounts: Record<string, StellarAccount>): StellarGateway {
  return {
    async loadAccount(publicKey) {
      const account = accounts[publicKey];
      if (!account) throw new StellarAccountNotFoundError(publicKey);
      return account;
    },
    async submitTransaction() {
      throw new Error('unused in wallet service.test.ts: no test here submits a transaction');
    },
    async listPayments() {
      throw new Error('unused in wallet service.test.ts: no test here polls Horizon payments');
    }
  };
}

function fakeAccount(publicKey: string, balances: StellarAccount['balances'] = []): StellarAccount {
  return {
    accountId: () => publicKey,
    sequenceNumber: () => '0',
    incrementSequenceNumber: () => {},
    balances
  };
}

function fakePrivyUser(address: string, walletId = 'wallet-1'): PrivyUserResolver {
  return {resolveStellarWallet: async () => ({walletId, address})};
}

describe('createWalletService.provision', () => {
  it('fresh merchant, no on-chain account: builds and stores a sponsor-signed intent', async () => {
    const merchant = Keypair.random();
    const repo = createFakeRepo();
    const gateway = createFakeGateway({[sponsor.publicKey()]: fakeAccount(sponsor.publicKey())});
    const service = createWalletService({
      repo,
      stellarGateway: gateway,
      privyUser: fakePrivyUser(merchant.publicKey()),
      sponsor,
      registry,
      networkPassphrase
    });

    const result = await service.provision('did:privy:fresh');

    expect(result).toEqual({
      intentId: expect.any(String),
      xdr: expect.any(String),
      hashHex: expect.stringMatching(/^0x[0-9a-f]{64}$/)
    });
    const stored = await repo.getMerchant('did:privy:fresh');
    expect(stored?.stellarAddress).toBe(merchant.publicKey());
    expect(stored?.provisionedAt).toBeNull();
  });

  it('merchant account already exists on-chain: marks provisioned and returns {provisioned: true}', async () => {
    const merchant = Keypair.random();
    const repo = createFakeRepo();
    const gateway = createFakeGateway({[merchant.publicKey()]: fakeAccount(merchant.publicKey())});
    const service = createWalletService({
      repo,
      stellarGateway: gateway,
      privyUser: fakePrivyUser(merchant.publicKey()),
      sponsor,
      registry,
      networkPassphrase
    });

    const result = await service.provision('did:privy:already-on-chain');

    expect(result).toEqual({provisioned: true, stellarAddress: merchant.publicKey()});
    const stored = await repo.getMerchant('did:privy:already-on-chain');
    expect(stored?.provisionedAt).not.toBeNull();
  });

  it('repeat call with a still-pending intent reuses the same intent (no duplicate)', async () => {
    const merchant = Keypair.random();
    const repo = createFakeRepo();
    const gateway = createFakeGateway({[sponsor.publicKey()]: fakeAccount(sponsor.publicKey())});
    const service = createWalletService({
      repo,
      stellarGateway: gateway,
      privyUser: fakePrivyUser(merchant.publicKey()),
      sponsor,
      registry,
      networkPassphrase
    });

    const first = await service.provision('did:privy:repeat');
    const second = await service.provision('did:privy:repeat');

    expect(second).toEqual(first);
  });
});

describe('createWalletService.getWallet', () => {
  it('throws AppError("merchant_not_found", 404) when the merchant has never been provisioned', async () => {
    const repo = createFakeRepo();
    const gateway = createFakeGateway({});
    const service = createWalletService({
      repo,
      stellarGateway: gateway,
      privyUser: fakePrivyUser(Keypair.random().publicKey()),
      sponsor,
      registry,
      networkPassphrase
    });

    await expect(service.getWallet('did:privy:unknown')).rejects.toMatchObject({
      code: 'merchant_not_found',
      statusCode: 404
    });
  });

  it('returns balances filtered to registry assets; provisioned reflects the DB row', async () => {
    const merchant = Keypair.random();
    const repo = createFakeRepo();
    await repo.upsertMerchant({
      privyDid: 'did:privy:has-balances',
      privyWalletId: 'w',
      stellarAddress: merchant.publicKey()
    });
    const gateway = createFakeGateway({
      [merchant.publicKey()]: fakeAccount(merchant.publicKey(), [
        {assetCode: 'USDC', assetIssuer: ISSUER, balance: '42.0000000'},
        {assetCode: 'OTHER', assetIssuer: ISSUER, balance: '5.0000000'},
        {balance: '0.0000000'} // native XLM: no assetCode
      ])
    });
    const service = createWalletService({
      repo,
      stellarGateway: gateway,
      privyUser: fakePrivyUser(merchant.publicKey()),
      sponsor,
      registry,
      networkPassphrase
    });

    const result = await service.getWallet('did:privy:has-balances');

    expect(result).toEqual({
      stellarAddress: merchant.publicKey(),
      provisioned: false,
      balances: [{assetCode: 'USDC', assetIssuer: ISSUER, balance: '42.0000000'}]
    });
  });

  it('excludes a same-code different-issuer balance (spoofed foreign trustline) from the report', async () => {
    const merchant = Keypair.random();
    // The merchant fully controls their own key and can add a trustline to
    // ANY issuer outside this backend — this simulates a phishing "airdrop"
    // trustline using the real USDC code but a foreign issuer.
    const spoofIssuer = Keypair.random().publicKey();
    const repo = createFakeRepo();
    await repo.upsertMerchant({
      privyDid: 'did:privy:spoofed-trustline',
      privyWalletId: 'w',
      stellarAddress: merchant.publicKey()
    });
    const gateway = createFakeGateway({
      [merchant.publicKey()]: fakeAccount(merchant.publicKey(), [
        {assetCode: 'USDC', assetIssuer: ISSUER, balance: '42.0000000'}, // genuine registry asset
        {assetCode: 'USDC', assetIssuer: spoofIssuer, balance: '999999.0000000'} // spoofed: same code, foreign issuer
      ])
    });
    const service = createWalletService({
      repo,
      stellarGateway: gateway,
      privyUser: fakePrivyUser(merchant.publicKey()),
      sponsor,
      registry,
      networkPassphrase
    });

    const result = await service.getWallet('did:privy:spoofed-trustline');

    expect(result.balances).toEqual([{assetCode: 'USDC', assetIssuer: ISSUER, balance: '42.0000000'}]);
  });

  it('returns empty balances (not a throw) when the account is not yet on-chain', async () => {
    const merchant = Keypair.random();
    const repo = createFakeRepo();
    await repo.upsertMerchant({privyDid: 'did:privy:pending', privyWalletId: 'w', stellarAddress: merchant.publicKey()});
    const gateway = createFakeGateway({}); // no accounts registered -> loadAccount rejects with StellarAccountNotFoundError
    const service = createWalletService({
      repo,
      stellarGateway: gateway,
      privyUser: fakePrivyUser(merchant.publicKey()),
      sponsor,
      registry,
      networkPassphrase
    });

    const result = await service.getWallet('did:privy:pending');

    expect(result).toEqual({stellarAddress: merchant.publicKey(), provisioned: false, balances: []});
  });

  it('rethrows a non-"not found" gateway failure instead of masking it as an empty wallet', async () => {
    const merchant = Keypair.random();
    const repo = createFakeRepo();
    await repo.upsertMerchant({privyDid: 'did:privy:outage', privyWalletId: 'w', stellarAddress: merchant.publicKey()});
    // A real network/Horizon-outage error, deliberately NOT a
    // StellarAccountNotFoundError — must propagate, not collapse to [].
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
    const service = createWalletService({
      repo,
      stellarGateway: gateway,
      privyUser: fakePrivyUser(merchant.publicKey()),
      sponsor,
      registry,
      networkPassphrase
    });

    await expect(service.getWallet('did:privy:outage')).rejects.toThrow('Horizon is unreachable');
  });
});
