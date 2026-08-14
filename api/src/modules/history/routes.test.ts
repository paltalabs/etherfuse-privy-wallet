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
import {historyRoutes} from './routes.js';
import type {HistoryService} from './service.js';

function fakeHistoryService(): HistoryService {
  return {
    getFeed: vi.fn(async () => ({items: [], nextBefore: null}))
  };
}

describe('historyRoutes (standalone plugin, request.privyDid stubbed directly)', () => {
  it('GET /activity with no query params calls getFeed(privyDid, {limit: 20, before: undefined})', async () => {
    const service = fakeHistoryService();
    const app = Fastify();
    app.decorateRequest('privyDid', '');
    app.addHook('onRequest', async (request) => {
      request.privyDid = 'did:privy:test-user';
    });
    await app.register(historyRoutes, {historyService: service});

    const res = await app.inject({method: 'GET', url: '/activity'});

    expect(res.statusCode).toBe(200);
    expect(service.getFeed).toHaveBeenCalledWith('did:privy:test-user', {limit: 20, before: undefined});
    expect(res.json()).toEqual({items: [], nextBefore: null});
  });

  it('GET /activity?limit=5&before=<iso> passes a parsed limit and a Date before through to the service', async () => {
    const service = fakeHistoryService();
    const app = Fastify();
    app.decorateRequest('privyDid', '');
    app.addHook('onRequest', async (request) => {
      request.privyDid = 'did:privy:test-user';
    });
    await app.register(historyRoutes, {historyService: service});
    const before = '2026-07-01T00:00:00.000Z';

    const res = await app.inject({method: 'GET', url: `/activity?limit=5&before=${before}`});

    expect(res.statusCode).toBe(200);
    expect(service.getFeed).toHaveBeenCalledWith('did:privy:test-user', {limit: 5, before: new Date(before)});
  });

  it('returns the service result through ActivityFeedResponseSchema', async () => {
    const item = {
      id: 'activity-1',
      type: 'send' as const,
      direction: 'out' as const,
      amount: '10.0000000',
      assetCode: 'USDC',
      assetIssuer: 'GISSUER',
      counterparty: 'GDEST',
      status: 'confirmed' as const,
      txHash: 'deadbeef',
      createdAt: '2026-07-01T00:00:00.000Z'
    };
    const service: HistoryService = {
      getFeed: vi.fn(async () => ({items: [item], nextBefore: '2026-06-01T00:00:00.000Z'}))
    };
    const app = Fastify();
    app.decorateRequest('privyDid', '');
    app.addHook('onRequest', async (request) => {
      request.privyDid = 'did:privy:test-user';
    });
    await app.register(historyRoutes, {historyService: service});

    const res = await app.inject({method: 'GET', url: '/activity'});

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({items: [item], nextBefore: '2026-06-01T00:00:00.000Z'});
  });

  it('rejects limit=101 (over the max) with a 400 before ever calling the service', async () => {
    const service = fakeHistoryService();
    const app = Fastify();
    app.decorateRequest('privyDid', '');
    app.addHook('onRequest', async (request) => {
      request.privyDid = 'did:privy:test-user';
    });
    await app.register(historyRoutes, {historyService: service});

    const res = await app.inject({method: 'GET', url: '/activity?limit=101'});

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({code: 'invalid_request'});
    expect(service.getFeed).not.toHaveBeenCalled();
  });

  it('rejects limit=0 with a 400 before ever calling the service', async () => {
    const service = fakeHistoryService();
    const app = Fastify();
    app.decorateRequest('privyDid', '');
    app.addHook('onRequest', async (request) => {
      request.privyDid = 'did:privy:test-user';
    });
    await app.register(historyRoutes, {historyService: service});

    const res = await app.inject({method: 'GET', url: '/activity?limit=0'});

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({code: 'invalid_request'});
    expect(service.getFeed).not.toHaveBeenCalled();
  });

  it('rejects a malformed before with a 400 before ever calling the service', async () => {
    const service = fakeHistoryService();
    const app = Fastify();
    app.decorateRequest('privyDid', '');
    app.addHook('onRequest', async (request) => {
      request.privyDid = 'did:privy:test-user';
    });
    await app.register(historyRoutes, {historyService: service});

    const res = await app.inject({method: 'GET', url: '/activity?before=not-a-date'});

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({code: 'invalid_request'});
    expect(service.getFeed).not.toHaveBeenCalled();
  });
});

// Real-buildApp end-to-end wiring + validation tests, mirroring
// payments/routes.test.ts's pattern: proves authPlugin -> historyRoutes
// wiring inside the REAL app, and that the route's own zod validation
// produces the app's typed {code, ...} error envelope. Deliberately limited
// to paths that never touch the DB (401; malformed-query 400s, both of
// which throw before opts.historyService.getFeed is ever called) — the
// same DB-avoidance convention documented in payments/wallet/intents'
// module docs (no live Postgres in this test suite). Business-logic
// coverage for the DB-backed paths (empty feed for an unprovisioned
// merchant, newest-first ordering, the `before`-cursor pagination walk)
// lives in service.test.ts against a fake HistoryRepo instead.
describe('history routes wired through the real buildApp (authenticated-scope end-to-end)', () => {
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
      throw new Error('unused in history routes.test.ts');
    },
    submitTransaction: async () => {
      throw new Error('unused in history routes.test.ts');
    },
    listPayments: async () => {
      throw new Error('unused in history routes.test.ts');
    }
  };
  const fakeSorobanGateway: SorobanGateway = {
    simulateAndAssemble: async () => {
      throw new Error('unused in history routes.test.ts');
    },
    simulateRead: async () => {
      throw new Error('unused in history routes.test.ts');
    },
    sendAndConfirm: async () => {
      throw new Error('unused in history routes.test.ts');
    },
    getContractEvents: async () => {
      throw new Error('unused in history routes.test.ts');
    },
    getLatestLedger: async () => {
      throw new Error('unused in history routes.test.ts');
    }
  };
  const fakePrivyUserResolver: PrivyUserResolver = {
    resolveStellarWallet: async () => {
      throw new Error('unused in history routes.test.ts');
    }
  };
  const fakeSponsorKeypair = Keypair.random();
  // Required only because `AppDeps.rampProvider` is non-optional — no
  // `/ramp/*` route runs in this file.
  const unusedRampMethod = (): never => {
    throw new Error('unused in history routes.test.ts');
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

  it('GET /activity returns 401 {code: "unauthorized"} without an Authorization header', async () => {
    const privyAuth: PrivyAuthVerifier = {verify: async () => ({privyDid: 'should-not-be-reached'})};
    const app = buildApp(appDeps(privyAuth));

    const res = await app.inject({method: 'GET', url: '/activity'});

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({code: 'unauthorized'});
  });

  it('GET /activity?limit=101 returns 400 {code: "invalid_request"} without touching the db', async () => {
    const privyAuth: PrivyAuthVerifier = {verify: async () => ({privyDid: 'did:privy:end-to-end'})};
    const app = buildApp(appDeps(privyAuth));

    const res = await app.inject({
      method: 'GET',
      url: '/activity?limit=101',
      headers: {authorization: 'Bearer good-token'}
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({code: 'invalid_request'});
  });

  it('GET /activity?before=not-a-date returns 400 {code: "invalid_request"} without touching the db', async () => {
    const privyAuth: PrivyAuthVerifier = {verify: async () => ({privyDid: 'did:privy:end-to-end'})};
    const app = buildApp(appDeps(privyAuth));

    const res = await app.inject({
      method: 'GET',
      url: '/activity?before=not-a-date',
      headers: {authorization: 'Bearer good-token'}
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({code: 'invalid_request'});
  });
});
