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
import {intentRoutes} from './routes.js';
import type {IntentsService} from './service.js';

function fakeIntentsService(): IntentsService {
  return {
    complete: vi.fn(async () => ({txHash: 'deadbeef'}))
  };
}

// intentRoutes now validates :id as a UUID (input-validation hardening) -- routes.test.ts
// needs a real UUID wherever a request is meant to reach the service.
const VALID_INTENT_ID = '11111111-1111-4111-8111-111111111111';

describe('intentRoutes (standalone plugin, request.privyDid stubbed directly)', () => {
  it('POST /intents/:id/complete calls intentsService.complete(privyDid, id, signature) and returns its result', async () => {
    const service = fakeIntentsService();
    const app = Fastify();
    app.decorateRequest('privyDid', '');
    app.addHook('onRequest', async (request) => {
      request.privyDid = 'did:privy:test-user';
    });
    await app.register(intentRoutes, {intentsService: service});

    const res = await app.inject({
      method: 'POST',
      url: `/intents/${VALID_INTENT_ID}/complete`,
      payload: {signature: '0x' + 'ab'.repeat(64)}
    });

    expect(res.statusCode).toBe(200);
    expect(service.complete).toHaveBeenCalledWith('did:privy:test-user', VALID_INTENT_ID, '0x' + 'ab'.repeat(64));
    expect(res.json()).toEqual({txHash: 'deadbeef'});
  });

  it('rejects an invalid body (missing signature) with a 400 before ever calling the service', async () => {
    const service = fakeIntentsService();
    const app = Fastify();
    app.decorateRequest('privyDid', '');
    app.addHook('onRequest', async (request) => {
      request.privyDid = 'did:privy:test-user';
    });
    await app.register(intentRoutes, {intentsService: service});

    const res = await app.inject({
      method: 'POST',
      url: `/intents/${VALID_INTENT_ID}/complete`,
      payload: {}
    });

    expect(res.statusCode).toBe(400);
    expect(service.complete).not.toHaveBeenCalled();
  });

  it('rejects a malformed (non-UUID) :id with a 404 before ever calling the service', async () => {
    const service = fakeIntentsService();
    const app = Fastify();
    app.decorateRequest('privyDid', '');
    app.addHook('onRequest', async (request) => {
      request.privyDid = 'did:privy:test-user';
    });
    await app.register(intentRoutes, {intentsService: service});

    const res = await app.inject({
      method: 'POST',
      url: '/intents/not-a-uuid/complete',
      payload: {signature: '0x' + 'ab'.repeat(64)}
    });

    expect(res.statusCode).toBe(404);
    expect(service.complete).not.toHaveBeenCalled();
  });
});

// Real-buildApp end-to-end wiring test, mirroring wallet/routes.test.ts's
// pattern: proves authPlugin -> intentRoutes wiring inside the REAL app,
// not just the standalone plugin.
describe('intent routes wired through the real buildApp (authenticated-scope end-to-end)', () => {
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
      throw new Error('unused in intents routes.test.ts');
    },
    submitTransaction: async () => {
      throw new Error('unused in intents routes.test.ts');
    },
    listPayments: async () => {
      throw new Error('unused in intents routes.test.ts');
    }
  };
  const fakeSorobanGateway: SorobanGateway = {
    simulateAndAssemble: async () => {
      throw new Error('unused in intents routes.test.ts');
    },
    simulateRead: async () => {
      throw new Error('unused in intents routes.test.ts');
    },
    sendAndConfirm: async () => {
      throw new Error('unused in intents routes.test.ts');
    },
    getContractEvents: async () => {
      throw new Error('unused in intents routes.test.ts');
    },
    getLatestLedger: async () => {
      throw new Error('unused in intents routes.test.ts');
    }
  };
  const fakePrivyUserResolver: PrivyUserResolver = {
    resolveStellarWallet: async () => {
      throw new Error('unused in intents routes.test.ts');
    }
  };
  const fakeSponsorKeypair = Keypair.random();
  // Required only because `AppDeps.rampProvider` is non-optional — no
  // `/ramp/*` route runs in this file.
  const unusedRampMethod = (): never => {
    throw new Error('unused in intents routes.test.ts');
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

  it('POST /intents/:id/complete returns 401 {code: "unauthorized"} without an Authorization header', async () => {
    const privyAuth: PrivyAuthVerifier = {
      verify: async () => ({privyDid: 'should-not-be-reached'})
    };
    const app = buildApp({
      db: fakeDb,
      env: fakeEnv,
      privyAuth,
      stellarGateway: fakeStellarGateway,
      sorobanGateway: fakeSorobanGateway,
      privyUserResolver: fakePrivyUserResolver,
      sponsorKeypair: fakeSponsorKeypair,
      rampProvider: fakeRampProvider,
      network: TESTNET_NETWORK
    });

    const res = await app.inject({
      method: 'POST',
      url: '/intents/intent-1/complete',
      payload: {signature: '0x' + 'ab'.repeat(64)}
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({code: 'unauthorized'});
  });

  it('POST /intents/:id/complete with a malformed (non-UUID) :id returns the SAME 404 body as a not-found intent -- indistinguishable, never a 500', async () => {
    const privyAuth: PrivyAuthVerifier = {
      verify: async () => ({privyDid: 'did:privy:end-to-end'})
    };
    const app = buildApp({
      db: fakeDb,
      env: fakeEnv,
      privyAuth,
      stellarGateway: fakeStellarGateway,
      sorobanGateway: fakeSorobanGateway,
      privyUserResolver: fakePrivyUserResolver,
      sponsorKeypair: fakeSponsorKeypair,
      rampProvider: fakeRampProvider,
      network: TESTNET_NETWORK
    });

    const res = await app.inject({
      method: 'POST',
      url: '/intents/not-a-uuid/complete',
      headers: {authorization: 'Bearer good-token'},
      payload: {signature: '0x' + 'ab'.repeat(64)}
    });

    expect(res.statusCode).toBe(404);
    // Byte-identical to service.ts's getOwnedIntent-miss error (service.ts:
    // new AppError('intent_not_found', 'intent not found', 404)) -- a
    // malformed id must be indistinguishable from a real one that doesn't
    // exist (or belongs to someone else).
    expect(res.json()).toEqual({code: 'intent_not_found', message: 'intent not found'});
  });
});
