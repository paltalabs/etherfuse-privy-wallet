import {AssetRegistry} from '@paltalabs/shared';
import {Keypair} from '@stellar/stellar-sdk';
import {describe, expect, it} from 'vitest';
import type {VaultConfig} from '../../config/vaults.js';
import {SorobanSimulationError} from '../../lib/soroban-gateway.js';
import type {UnsignedVaultTx, VaultPosition, VaultProvider} from './provider.js';
import {createVaultService, type IntentRecord, type MerchantRecord, type VaultRepo} from './service.js';

const ISSUER = Keypair.random().publicKey();
const registry = new AssetRegistry([{code: 'USDC', issuer: ISSUER, decimals: 7}]);
const vault: VaultConfig = {address: 'CDTWG3OZERPUCD42KVZQUCOECYWUQ5HHFT6VFRTGKKVW46VSNQ3WOBYF', assetCode: 'USDC'};

interface PendingActivityCall {
  stellarAddress: string;
  externalRef: string;
  type: 'vault_deposit' | 'vault_withdraw';
  direction: 'in' | 'out';
  amount: string | null;
  assetCode: string;
  assetIssuer: string;
  counterparty: string;
}

/** In-memory fake of the vault module's persistence boundary, mirroring payments/service.test.ts's createFakeRepo. */
function createFakeRepo(): {
  repo: VaultRepo;
  merchants: Map<string, MerchantRecord>;
  intents: IntentRecord[];
  activity: PendingActivityCall[];
} {
  const merchantsStore = new Map<string, MerchantRecord>();
  const intentsStore: IntentRecord[] = [];
  const activityStore: PendingActivityCall[] = [];
  let nextId = 1;

  const repo: VaultRepo = {
    async getMerchant(privyDid) {
      return merchantsStore.get(privyDid);
    },
    async createIntent({privyDid, kind, xdr, hashHex}) {
      const row: IntentRecord = {
        id: `intent-${nextId++}`,
        privyDid,
        kind,
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

/** Fake VaultProvider — records calls, returns programmed results, or throws a programmed error. */
function createFakeProvider(opts: {
  deposit?: UnsignedVaultTx | Error;
  withdraw?: UnsignedVaultTx | Error;
  position?: VaultPosition | Error;
} = {}): {
  provider: VaultProvider;
  depositCalls: Array<{merchantAddress: string; amount: string}>;
  withdrawCalls: Array<{merchantAddress: string; shares: string}>;
  positionCalls: string[];
} {
  const depositCalls: Array<{merchantAddress: string; amount: string}> = [];
  const withdrawCalls: Array<{merchantAddress: string; shares: string}> = [];
  const positionCalls: string[] = [];

  const provider: VaultProvider = {
    async buildDepositTx(merchantAddress, amount) {
      depositCalls.push({merchantAddress, amount});
      if (opts.deposit instanceof Error) throw opts.deposit;
      return opts.deposit ?? {xdr: 'AAAA', hashHex: '0x' + 'a'.repeat(64)};
    },
    async buildWithdrawTx(merchantAddress, shares) {
      withdrawCalls.push({merchantAddress, shares});
      if (opts.withdraw instanceof Error) throw opts.withdraw;
      return opts.withdraw ?? {xdr: 'BBBB', hashHex: '0x' + 'b'.repeat(64)};
    },
    async getPosition(merchantAddress) {
      positionCalls.push(merchantAddress);
      if (opts.position instanceof Error) throw opts.position;
      return opts.position ?? {shares: '0.0000000', underlyingBalance: '0.0000000'};
    }
  };

  return {provider, depositCalls, withdrawCalls, positionCalls};
}

describe('createVaultService.deposit', () => {
  it('builds and stores an unsigned vault_deposit intent + a pending activity row with the vault address as counterparty', async () => {
    const merchant = Keypair.random();
    const {repo, merchants, activity} = createFakeRepo();
    seedMerchant(merchants, 'did:privy:merchant', merchant.publicKey());
    const {provider, depositCalls} = createFakeProvider({
      deposit: {xdr: 'DEPOSIT_XDR', hashHex: '0x' + 'c'.repeat(64)}
    });
    const service = createVaultService({repo, provider, registry, vault});

    const result = await service.deposit('did:privy:merchant', {amount: '10.5000000'});

    expect(result).toEqual({intentId: expect.any(String), xdr: 'DEPOSIT_XDR', hashHex: '0x' + 'c'.repeat(64)});
    expect(depositCalls).toEqual([{merchantAddress: merchant.publicKey(), amount: '10.5000000'}]);
    expect(activity).toEqual([
      {
        stellarAddress: merchant.publicKey(),
        externalRef: result.intentId,
        type: 'vault_deposit',
        direction: 'out',
        amount: '10.5000000',
        assetCode: 'USDC',
        assetIssuer: ISSUER,
        counterparty: vault.address
      }
    ]);
  });

  it('stores the intent with kind "vault_deposit"', async () => {
    const merchant = Keypair.random();
    const {repo, merchants, intents} = createFakeRepo();
    seedMerchant(merchants, 'did:privy:merchant', merchant.publicKey());
    const {provider} = createFakeProvider();
    const service = createVaultService({repo, provider, registry, vault});

    await service.deposit('did:privy:merchant', {amount: '1'});

    expect(intents).toHaveLength(1);
    expect(intents[0]?.kind).toBe('vault_deposit');
  });

  it('throws AppError("merchant_not_found", 404) when the caller has never provisioned', async () => {
    const {repo} = createFakeRepo();
    const {provider} = createFakeProvider();
    const service = createVaultService({repo, provider, registry, vault});

    await expect(service.deposit('did:privy:unknown', {amount: '1'})).rejects.toMatchObject({
      code: 'merchant_not_found',
      statusCode: 404
    });
  });

  it('maps a SorobanSimulationError from the provider to a 502 AppError without leaking the raw detail', async () => {
    const merchant = Keypair.random();
    const {repo, merchants} = createFakeRepo();
    seedMerchant(merchants, 'did:privy:merchant', merchant.publicKey());
    const {provider} = createFakeProvider({deposit: new SorobanSimulationError('raw diagnostic dump, not for clients')});
    const service = createVaultService({repo, provider, registry, vault});

    const failure = await service.deposit('did:privy:merchant', {amount: '1'}).catch((e: unknown) => e);

    expect(failure).toMatchObject({code: 'simulation_failed', statusCode: 502});
    const details = JSON.stringify((failure as {details?: unknown}).details);
    expect(details).not.toContain('raw diagnostic dump');
  });
});

describe('createVaultService.withdraw', () => {
  it('builds and stores an unsigned vault_withdraw intent + a pending activity row with amount null (direction in)', async () => {
    const merchant = Keypair.random();
    const {repo, merchants, activity, intents} = createFakeRepo();
    seedMerchant(merchants, 'did:privy:merchant', merchant.publicKey());
    const {provider, withdrawCalls} = createFakeProvider({
      withdraw: {xdr: 'WITHDRAW_XDR', hashHex: '0x' + 'd'.repeat(64)}
    });
    const service = createVaultService({repo, provider, registry, vault});

    const result = await service.withdraw('did:privy:merchant', {shares: '2.5000000'});

    expect(result).toEqual({intentId: expect.any(String), xdr: 'WITHDRAW_XDR', hashHex: '0x' + 'd'.repeat(64)});
    expect(withdrawCalls).toEqual([{merchantAddress: merchant.publicKey(), shares: '2.5000000'}]);
    expect(intents[0]?.kind).toBe('vault_withdraw');
    expect(activity).toEqual([
      {
        stellarAddress: merchant.publicKey(),
        externalRef: result.intentId,
        type: 'vault_withdraw',
        direction: 'in',
        amount: null,
        assetCode: 'USDC',
        assetIssuer: ISSUER,
        counterparty: vault.address
      }
    ]);
  });

  it('throws AppError("merchant_not_found", 404) when the caller has never provisioned', async () => {
    const {repo} = createFakeRepo();
    const {provider} = createFakeProvider();
    const service = createVaultService({repo, provider, registry, vault});

    await expect(service.withdraw('did:privy:unknown', {shares: '1'})).rejects.toMatchObject({
      code: 'merchant_not_found',
      statusCode: 404
    });
  });

  it('maps a SorobanSimulationError from the provider to a 502 AppError without leaking the raw detail', async () => {
    const merchant = Keypair.random();
    const {repo, merchants} = createFakeRepo();
    seedMerchant(merchants, 'did:privy:merchant', merchant.publicKey());
    const {provider} = createFakeProvider({withdraw: new SorobanSimulationError('raw diagnostic dump, not for clients')});
    const service = createVaultService({repo, provider, registry, vault});

    const failure = await service.withdraw('did:privy:merchant', {shares: '1'}).catch((e: unknown) => e);

    expect(failure).toMatchObject({code: 'simulation_failed', statusCode: 502});
    const details = JSON.stringify((failure as {details?: unknown}).details);
    expect(details).not.toContain('raw diagnostic dump');
  });
});

describe('createVaultService.position', () => {
  it('returns the provider position decorated with the vault asset code/issuer', async () => {
    const merchant = Keypair.random();
    const {repo, merchants} = createFakeRepo();
    seedMerchant(merchants, 'did:privy:merchant', merchant.publicKey());
    const {provider, positionCalls} = createFakeProvider({
      position: {shares: '1.5000000', underlyingBalance: '1.4800000'}
    });
    const service = createVaultService({repo, provider, registry, vault});

    const result = await service.position('did:privy:merchant');

    expect(result).toEqual({
      shares: '1.5000000',
      underlyingBalance: '1.4800000',
      assetCode: 'USDC',
      assetIssuer: ISSUER
    });
    expect(positionCalls).toEqual([merchant.publicKey()]);
  });

  it('throws AppError("merchant_not_found", 404) when the caller has never provisioned', async () => {
    const {repo} = createFakeRepo();
    const {provider} = createFakeProvider();
    const service = createVaultService({repo, provider, registry, vault});

    await expect(service.position('did:privy:unknown')).rejects.toMatchObject({
      code: 'merchant_not_found',
      statusCode: 404
    });
  });

  it('maps a SorobanSimulationError from the provider to a 502 AppError without leaking the raw detail', async () => {
    const merchant = Keypair.random();
    const {repo, merchants} = createFakeRepo();
    seedMerchant(merchants, 'did:privy:merchant', merchant.publicKey());
    const {provider} = createFakeProvider({position: new SorobanSimulationError('raw diagnostic dump, not for clients')});
    const service = createVaultService({repo, provider, registry, vault});

    const failure = await service.position('did:privy:merchant').catch((e: unknown) => e);

    expect(failure).toMatchObject({code: 'simulation_failed', statusCode: 502});
    const details = JSON.stringify((failure as {details?: unknown}).details);
    expect(details).not.toContain('raw diagnostic dump');
  });
});
