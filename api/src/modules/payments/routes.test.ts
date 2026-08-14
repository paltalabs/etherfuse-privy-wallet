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
import type {PrivyUserResolver} from '../wallet/privy-user.js';
import {paymentRoutes} from './routes.js';
import type {PaymentsService} from './service.js';

const VALID_DESTINATION = Keypair.random().publicKey();

function validBody() {
  return {destination: VALID_DESTINATION, amount: '10.5000000', assetCode: 'USDC'};
}

function fakePaymentsService(): PaymentsService {
  return {
    createPayment: vi.fn(async () => ({intentId: 'intent-1', xdr: 'AAAA', hashHex: '0x' + 'a'.repeat(64)}))
  };
}

describe('paymentRoutes (standalone plugin, request.privyDid stubbed directly)', () => {
  it('POST /payments calls paymentsService.createPayment(request.privyDid, parsedBody) and returns its result', async () => {
    const service = fakePaymentsService();
    const app = Fastify();
    app.decorateRequest('privyDid', '');
    app.addHook('onRequest', async (request) => {
      request.privyDid = 'did:privy:test-user';
    });
    await app.register(paymentRoutes, {paymentsService: service});

    const res = await app.inject({method: 'POST', url: '/payments', payload: validBody()});

    expect(res.statusCode).toBe(200);
    expect(service.createPayment).toHaveBeenCalledWith('did:privy:test-user', validBody());
    expect(res.json()).toEqual({intentId: 'intent-1', xdr: 'AAAA', hashHex: '0x' + 'a'.repeat(64)});
  });

  it('rejects an invalid body (bad destination) with a 400 before ever calling the service', async () => {
    const service = fakePaymentsService();
    const app = Fastify();
    app.decorateRequest('privyDid', '');
    app.addHook('onRequest', async (request) => {
      request.privyDid = 'did:privy:test-user';
    });
    await app.register(paymentRoutes, {paymentsService: service});

    const res = await app.inject({
      method: 'POST',
      url: '/payments',
      payload: {destination: 'not-a-stellar-address', amount: '10', assetCode: 'USDC'}
    });

    expect(res.statusCode).toBe(400);
    expect(service.createPayment).not.toHaveBeenCalled();
  });
});

// Real-buildApp end-to-end wiring + validation tests, mirroring
// wallet/routes.test.ts's and intents/routes.test.ts's pattern: proves
// authPlugin -> paymentRoutes wiring inside the REAL app, and that the
// route's own zod/registry validation produces the app's typed {code, ...}
// error envelope (only available via buildApp's global error handler, not
// a standalone Fastify instance).
describe('payment routes wired through the real buildApp (authenticated-scope end-to-end)', () => {
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
      throw new Error('unused in payments routes.test.ts: validation failures below never reach the gateway');
    },
    submitTransaction: async () => {
      throw new Error('unused in payments routes.test.ts');
    },
    listPayments: async () => {
      throw new Error('unused in payments routes.test.ts');
    }
  };
  const fakeSorobanGateway: SorobanGateway = {
    simulateAndAssemble: async () => {
      throw new Error('unused in payments routes.test.ts');
    },
    simulateRead: async () => {
      throw new Error('unused in payments routes.test.ts');
    },
    sendAndConfirm: async () => {
      throw new Error('unused in payments routes.test.ts');
    },
    getContractEvents: async () => {
      throw new Error('unused in payments routes.test.ts');
    },
    getLatestLedger: async () => {
      throw new Error('unused in payments routes.test.ts');
    }
  };
  const fakePrivyUserResolver: PrivyUserResolver = {
    resolveStellarWallet: async () => {
      throw new Error('unused in payments routes.test.ts');
    }
  };
  const fakeSponsorKeypair = Keypair.random();
  // Required only because `AppDeps.rampProvider` is non-optional — no
  // `/ramp/*` route runs in this file.
  const unusedRampMethod = (): never => {
    throw new Error('unused in payments routes.test.ts');
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
      network: TESTNET_NETWORK
    };
  }

  it('POST /payments returns 401 {code: "unauthorized"} without an Authorization header', async () => {
    const privyAuth: PrivyAuthVerifier = {verify: async () => ({privyDid: 'should-not-be-reached'})};
    const app = buildApp(appDeps(privyAuth));

    const res = await app.inject({method: 'POST', url: '/payments', payload: validBody()});

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({code: 'unauthorized'});
  });

  it('POST /payments: an invalid destination returns 400 {code: "invalid_request"} without touching the gateway/db', async () => {
    const privyAuth: PrivyAuthVerifier = {verify: async () => ({privyDid: 'did:privy:end-to-end'})};
    const app = buildApp(appDeps(privyAuth));

    const res = await app.inject({
      method: 'POST',
      url: '/payments',
      headers: {authorization: 'Bearer good-token'},
      payload: {destination: 'not-a-stellar-address', amount: '10', assetCode: 'USDC'}
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({code: 'invalid_request'});
  });

  it('POST /payments: an amount with more than 7 decimal places returns 400 {code: "invalid_request"}', async () => {
    const privyAuth: PrivyAuthVerifier = {verify: async () => ({privyDid: 'did:privy:end-to-end'})};
    const app = buildApp(appDeps(privyAuth));

    const res = await app.inject({
      method: 'POST',
      url: '/payments',
      headers: {authorization: 'Bearer good-token'},
      payload: {destination: VALID_DESTINATION, amount: '10.12345678', assetCode: 'USDC'}
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({code: 'invalid_request'});
  });

  it('POST /payments: a zero amount returns 400 {code: "invalid_request"}', async () => {
    const privyAuth: PrivyAuthVerifier = {verify: async () => ({privyDid: 'did:privy:end-to-end'})};
    const app = buildApp(appDeps(privyAuth));

    const res = await app.inject({
      method: 'POST',
      url: '/payments',
      headers: {authorization: 'Bearer good-token'},
      payload: {destination: VALID_DESTINATION, amount: '0', assetCode: 'USDC'}
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({code: 'invalid_request'});
  });

  it('POST /payments: an assetCode not in TESTNET_REGISTRY returns 400 {code: "unknown_asset"} without touching the gateway/db', async () => {
    const privyAuth: PrivyAuthVerifier = {verify: async () => ({privyDid: 'did:privy:end-to-end'})};
    const app = buildApp(appDeps(privyAuth));

    const res = await app.inject({
      method: 'POST',
      url: '/payments',
      headers: {authorization: 'Bearer good-token'},
      payload: {destination: VALID_DESTINATION, amount: '10', assetCode: 'NOPE'}
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({code: 'unknown_asset'});
  });
});
