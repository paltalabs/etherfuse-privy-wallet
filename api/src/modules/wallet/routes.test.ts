import {Keypair} from '@stellar/stellar-sdk';
import type {NodePgDatabase} from 'drizzle-orm/node-postgres';
import Fastify from 'fastify';
import {describe, expect, it, vi} from 'vitest';
import {buildApp} from '../../app.js';
import {TESTNET_NETWORK} from '../../config/networks.js';
import type * as schema from '../../db/schema.js';
import type {SpikeEnv} from '../../lib/env.js';
import type {SorobanGateway} from '../../lib/soroban-gateway.js';
import type {StellarGateway} from '../../lib/stellar-gateway.js';
import type {PrivyAuthVerifier} from '../auth/verifier.js';
import type {RampProvider} from '../ramp/provider.js';
import type {PrivyUserResolver} from './privy-user.js';
import {walletRoutes} from './routes.js';
import type {WalletService} from './service.js';

function fakeWalletService(): WalletService {
  return {
    provision: vi.fn(async () => ({intentId: 'intent-1', xdr: 'AAAA', hashHex: '0x' + 'a'.repeat(64)})),
    getWallet: vi.fn(async () => ({stellarAddress: 'GABC', provisioned: false, balances: []}))
  };
}

describe('walletRoutes (standalone plugin, request.privyDid stubbed directly)', () => {
  it('POST /wallet/provision calls walletService.provision(request.privyDid) and returns its result', async () => {
    const service = fakeWalletService();
    const app = Fastify();
    app.decorateRequest('privyDid', '');
    app.addHook('onRequest', async (request) => {
      request.privyDid = 'did:privy:test-user';
    });
    await app.register(walletRoutes, {walletService: service});

    const res = await app.inject({method: 'POST', url: '/wallet/provision'});

    expect(res.statusCode).toBe(200);
    expect(service.provision).toHaveBeenCalledWith('did:privy:test-user');
    expect(res.json()).toEqual({intentId: 'intent-1', xdr: 'AAAA', hashHex: '0x' + 'a'.repeat(64)});
  });

  it('GET /wallet calls walletService.getWallet(request.privyDid) and returns its result', async () => {
    const service = fakeWalletService();
    const app = Fastify();
    app.decorateRequest('privyDid', '');
    app.addHook('onRequest', async (request) => {
      request.privyDid = 'did:privy:test-user';
    });
    await app.register(walletRoutes, {walletService: service});

    const res = await app.inject({method: 'GET', url: '/wallet'});

    expect(res.statusCode).toBe(200);
    expect(service.getWallet).toHaveBeenCalledWith('did:privy:test-user');
    expect(res.json()).toEqual({stellarAddress: 'GABC', provisioned: false, balances: []});
  });
});

// Closes a review gap from the auth module's work: the tests above prove
// walletRoutes itself reads request.privyDid correctly, but not that
// authPlugin -> walletRoutes wiring inside the REAL buildApp actually
// delivers it. These go through buildApp end-to-end (in-process, via
// app.inject — no listening socket).
describe('wallet routes wired through the real buildApp (authenticated-scope end-to-end)', () => {
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
      throw new Error('unused: resolveStellarWallet throws before any gateway/db access in this test');
    },
    submitTransaction: async () => {
      throw new Error('unused: resolveStellarWallet throws before any gateway/db access in this test');
    },
    listPayments: async () => {
      throw new Error('unused: resolveStellarWallet throws before any gateway/db access in this test');
    }
  };
  const fakeSorobanGateway: SorobanGateway = {
    simulateAndAssemble: async () => {
      throw new Error('unused: resolveStellarWallet throws before any gateway/db access in this test');
    },
    simulateRead: async () => {
      throw new Error('unused: resolveStellarWallet throws before any gateway/db access in this test');
    },
    sendAndConfirm: async () => {
      throw new Error('unused: resolveStellarWallet throws before any gateway/db access in this test');
    },
    getContractEvents: async () => {
      throw new Error('unused: resolveStellarWallet throws before any gateway/db access in this test');
    },
    getLatestLedger: async () => {
      throw new Error('unused: resolveStellarWallet throws before any gateway/db access in this test');
    }
  };
  const fakeSponsorKeypair = Keypair.random();
  // Required only because `AppDeps.rampProvider` is non-optional — no
  // `/ramp/*` route runs in this file.
  const unusedRampMethod = (): never => {
    throw new Error('unused in wallet routes.test.ts');
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

  it('POST /wallet/provision returns 401 {code: "unauthorized"} without an Authorization header', async () => {
    const privyAuth: PrivyAuthVerifier = {
      verify: async () => ({privyDid: 'should-not-be-reached'})
    };
    const privyUserResolver: PrivyUserResolver = {
      resolveStellarWallet: async () => {
        throw new Error('should not be reached: auth must fail first');
      }
    };
    const app = buildApp({
      db: fakeDb,
      env: fakeEnv,
      privyAuth,
      stellarGateway: fakeStellarGateway,
      sorobanGateway: fakeSorobanGateway,
      privyUserResolver,
      sponsorKeypair: fakeSponsorKeypair,
      rampProvider: fakeRampProvider,
      network: TESTNET_NETWORK
    });

    const res = await app.inject({method: 'POST', url: '/wallet/provision'});

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({code: 'unauthorized'});
  });

  it('POST /wallet/provision: a verified token reaches request.privyDid inside the wallet route handler', async () => {
    const privyAuth: PrivyAuthVerifier = {
      verify: async (accessToken) => {
        expect(accessToken).toBe('good-token');
        return {privyDid: 'did:privy:end-to-end'};
      }
    };
    // resolveStellarWallet is the FIRST thing service.provision() awaits
    // (before any db/gateway access) — capturing its argument here and
    // throwing proves request.privyDid made it all the way from authPlugin's
    // hook, through walletRoutes, into the service, without needing a
    // working fake Postgres for this wiring-only assertion.
    let seenPrivyDid: string | undefined;
    const privyUserResolver: PrivyUserResolver = {
      resolveStellarWallet: async (privyDid) => {
        seenPrivyDid = privyDid;
        throw new Error('stop here: only the routing/wiring is under test');
      }
    };
    const app = buildApp({
      db: fakeDb,
      env: fakeEnv,
      privyAuth,
      stellarGateway: fakeStellarGateway,
      sorobanGateway: fakeSorobanGateway,
      privyUserResolver,
      sponsorKeypair: fakeSponsorKeypair,
      rampProvider: fakeRampProvider,
      network: TESTNET_NETWORK
    });

    const res = await app.inject({
      method: 'POST',
      url: '/wallet/provision',
      headers: {authorization: 'Bearer good-token'}
    });

    expect(seenPrivyDid).toBe('did:privy:end-to-end');
    // The thrown Error is an unexpected (non-AppError) error -> generic 500,
    // per app.ts's global error handler — expected here since the fake
    // resolver throws deliberately once wiring is proven.
    expect(res.statusCode).toBe(500);
  });
});
