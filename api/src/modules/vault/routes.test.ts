import type {NodePgDatabase} from 'drizzle-orm/node-postgres';
import Fastify from 'fastify';
import {describe, expect, it, vi} from 'vitest';
import {buildApp} from '../../app.js';
import {TESTNET_NETWORK} from '../../config/networks.js';
import type {VaultConfig} from '../../config/vaults.js';
import type * as schema from '../../db/schema.js';
import type {SpikeEnv} from '../../lib/env.js';
import type {SorobanGateway} from '../../lib/soroban-gateway.js';
import type {StellarGateway} from '../../lib/stellar-gateway.js';
import {Keypair} from '@stellar/stellar-sdk';
import type {PrivyAuthVerifier} from '../auth/verifier.js';
import type {RampProvider} from '../ramp/provider.js';
import type {PrivyUserResolver} from '../wallet/privy-user.js';
import {vaultRoutes} from './routes.js';
import type {VaultService} from './service.js';

function fakeVaultService(): VaultService {
  return {
    deposit: vi.fn(async () => ({intentId: 'intent-1', xdr: 'AAAA', hashHex: '0x' + 'a'.repeat(64)})),
    withdraw: vi.fn(async () => ({intentId: 'intent-2', xdr: 'BBBB', hashHex: '0x' + 'b'.repeat(64)})),
    position: vi.fn(async () => ({
      shares: '1.5000000',
      underlyingBalance: '1.4800000',
      assetCode: 'USDC',
      assetIssuer: 'GISSUER'
    }))
  };
}

describe('vaultRoutes (standalone plugin, request.privyDid stubbed directly)', () => {
  it('GET /vault/position calls vaultService.position(request.privyDid) and returns its result', async () => {
    const service = fakeVaultService();
    const app = Fastify();
    app.decorateRequest('privyDid', '');
    app.addHook('onRequest', async (request) => {
      request.privyDid = 'did:privy:test-user';
    });
    await app.register(vaultRoutes, {vaultService: service});

    const res = await app.inject({method: 'GET', url: '/vault/position'});

    expect(res.statusCode).toBe(200);
    expect(service.position).toHaveBeenCalledWith('did:privy:test-user');
    expect(res.json()).toEqual({
      shares: '1.5000000',
      underlyingBalance: '1.4800000',
      assetCode: 'USDC',
      assetIssuer: 'GISSUER'
    });
  });

  it('POST /vault/deposit calls vaultService.deposit(request.privyDid, parsedBody) and returns its result', async () => {
    const service = fakeVaultService();
    const app = Fastify();
    app.decorateRequest('privyDid', '');
    app.addHook('onRequest', async (request) => {
      request.privyDid = 'did:privy:test-user';
    });
    await app.register(vaultRoutes, {vaultService: service});

    const res = await app.inject({method: 'POST', url: '/vault/deposit', payload: {amount: '10.5000000'}});

    expect(res.statusCode).toBe(200);
    expect(service.deposit).toHaveBeenCalledWith('did:privy:test-user', {amount: '10.5000000'});
    expect(res.json()).toEqual({intentId: 'intent-1', xdr: 'AAAA', hashHex: '0x' + 'a'.repeat(64)});
  });

  it('rejects an invalid /vault/deposit body (bad amount) with a 400 before ever calling the service', async () => {
    const service = fakeVaultService();
    const app = Fastify();
    app.decorateRequest('privyDid', '');
    app.addHook('onRequest', async (request) => {
      request.privyDid = 'did:privy:test-user';
    });
    await app.register(vaultRoutes, {vaultService: service});

    const res = await app.inject({method: 'POST', url: '/vault/deposit', payload: {amount: '0'}});

    expect(res.statusCode).toBe(400);
    expect(service.deposit).not.toHaveBeenCalled();
  });

  it('POST /vault/withdraw calls vaultService.withdraw(request.privyDid, parsedBody) and returns its result', async () => {
    const service = fakeVaultService();
    const app = Fastify();
    app.decorateRequest('privyDid', '');
    app.addHook('onRequest', async (request) => {
      request.privyDid = 'did:privy:test-user';
    });
    await app.register(vaultRoutes, {vaultService: service});

    const res = await app.inject({method: 'POST', url: '/vault/withdraw', payload: {shares: '2.5000000'}});

    expect(res.statusCode).toBe(200);
    expect(service.withdraw).toHaveBeenCalledWith('did:privy:test-user', {shares: '2.5000000'});
    expect(res.json()).toEqual({intentId: 'intent-2', xdr: 'BBBB', hashHex: '0x' + 'b'.repeat(64)});
  });

  it('rejects an invalid /vault/withdraw body (bad shares) with a 400 before ever calling the service', async () => {
    const service = fakeVaultService();
    const app = Fastify();
    app.decorateRequest('privyDid', '');
    app.addHook('onRequest', async (request) => {
      request.privyDid = 'did:privy:test-user';
    });
    await app.register(vaultRoutes, {vaultService: service});

    const res = await app.inject({method: 'POST', url: '/vault/withdraw', payload: {shares: '1.12345678'}});

    expect(res.statusCode).toBe(400);
    expect(service.withdraw).not.toHaveBeenCalled();
  });
});

// Real-buildApp end-to-end wiring test, mirroring payments/routes.test.ts's
// pattern: proves authPlugin -> vaultRoutes wiring inside the REAL app.
describe('vault routes wired through the real buildApp (authenticated-scope end-to-end)', () => {
  const fakeDb = {} as NodePgDatabase<typeof schema>;
  const fakeEnv: SpikeEnv = {
    PRIVY_APP_ID: 'test-app-id',
    PRIVY_APP_SECRET: 'test-app-secret',
    DATABASE_URL: 'postgres://paltalabs:paltalabs@localhost:5432/paltalabs',
    PORT: 3000,
    CORS_ORIGIN: 'http://localhost:5173',
    POLL_INTERVAL_MS: 5000,
    STELLAR_NETWORK: 'testnet',
    LOG_LEVEL: 'silent',
    SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org'
  };
  const fakeStellarGateway: StellarGateway = {
    loadAccount: async () => {
      throw new Error('unused in vault routes.test.ts');
    },
    submitTransaction: async () => {
      throw new Error('unused in vault routes.test.ts');
    },
    listPayments: async () => {
      throw new Error('unused in vault routes.test.ts');
    }
  };
  const fakeSorobanGateway: SorobanGateway = {
    simulateAndAssemble: async () => {
      throw new Error('unused in vault routes.test.ts');
    },
    simulateRead: async () => {
      throw new Error('unused in vault routes.test.ts');
    },
    sendAndConfirm: async () => {
      throw new Error('unused in vault routes.test.ts');
    },
    getContractEvents: async () => {
      throw new Error('unused in vault routes.test.ts');
    },
    getLatestLedger: async () => {
      throw new Error('unused in vault routes.test.ts');
    }
  };
  const fakePrivyUserResolver: PrivyUserResolver = {
    resolveStellarWallet: async () => {
      throw new Error('unused in vault routes.test.ts');
    }
  };
  const fakeSponsorKeypair = Keypair.random();
  // Required only because `AppDeps.rampProvider` is non-optional — no
  // `/ramp/*` route runs in this file.
  const unusedRampMethod = (): never => {
    throw new Error('unused in vault routes.test.ts');
  };
  const fakeRampProvider: RampProvider = {
    createOrganization: unusedRampMethod,
    getKycStatus: unusedRampMethod,
    buildKycLaunch: unusedRampMethod,
    registerBankAccount: unusedRampMethod,
    registerWallet: unusedRampMethod,
    createOnrampQuote: unusedRampMethod,
    createOfframpQuote: unusedRampMethod,
    createOnrampOrder: unusedRampMethod,
    createAnchorOfframpOrder: unusedRampMethod,
    getOrder: unusedRampMethod,
    simulateFiatReceived: unusedRampMethod
  };

  // A syntactically-valid (checksum-passing) contract strkey — `createDefindexProvider`
  // calls `new Contract(vault.address)` eagerly inside `buildApp` whenever
  // `network.vault` is non-null, so a malformed address would throw before
  // these route tests ever ran. `TESTNET_VAULT` (`config/vaults.ts`) is null
  // (no vault deployed yet post-Etherfuse migration), so this test-local
  // fixture exercises the vault module's own routes end-to-end independent
  // of any real network's current deployment state.
  const fakeVault: VaultConfig = {
    address: 'CDTWG3OZERPUCD42KVZQUCOECYWUQ5HHFT6VFRTGKKVW46VSNQ3WOBYF',
    assetCode: 'USDC'
  };

  function appDeps(privyAuth: PrivyAuthVerifier) {
    return {
      db: fakeDb,
      env: fakeEnv,
      privyAuth,
      stellarGateway: fakeStellarGateway,
      sorobanGateway: fakeSorobanGateway,
      privyUserResolver: fakePrivyUserResolver,
      sponsorKeypair: fakeSponsorKeypair,
      rampProvider: fakeRampProvider,
      network: {...TESTNET_NETWORK, vault: fakeVault}
    };
  }

  it('GET /vault/position returns 401 {code: "unauthorized"} without an Authorization header', async () => {
    const privyAuth: PrivyAuthVerifier = {verify: async () => ({privyDid: 'should-not-be-reached'})};
    const app = buildApp(appDeps(privyAuth));

    const res = await app.inject({method: 'GET', url: '/vault/position'});

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({code: 'unauthorized'});
  });

  it('POST /vault/deposit: a zero amount returns 400 {code: "invalid_request"} without touching the gateway/db', async () => {
    const privyAuth: PrivyAuthVerifier = {verify: async () => ({privyDid: 'did:privy:end-to-end'})};
    const app = buildApp(appDeps(privyAuth));

    const res = await app.inject({
      method: 'POST',
      url: '/vault/deposit',
      headers: {authorization: 'Bearer good-token'},
      payload: {amount: '0'}
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({code: 'invalid_request'});
  });

  it('POST /vault/withdraw: a shares value with more than 7 decimal places returns 400 {code: "invalid_request"}', async () => {
    const privyAuth: PrivyAuthVerifier = {verify: async () => ({privyDid: 'did:privy:end-to-end'})};
    const app = buildApp(appDeps(privyAuth));

    const res = await app.inject({
      method: 'POST',
      url: '/vault/withdraw',
      headers: {authorization: 'Bearer good-token'},
      payload: {shares: '1.12345678'}
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({code: 'invalid_request'});
  });
});
