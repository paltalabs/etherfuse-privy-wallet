import {Keypair} from '@stellar/stellar-sdk';
import type {NodePgDatabase} from 'drizzle-orm/node-postgres';
import {describe, expect, it} from 'vitest';
import {buildApp} from './app.js';
import {TESTNET_NETWORK} from './config/networks.js';
import type {VaultConfig} from './config/vaults.js';
import type * as schema from './db/schema.js';
import {AppError} from './lib/errors.js';
import type {SpikeEnv} from './lib/env.js';
import type {SorobanGateway} from './lib/soroban-gateway.js';
import type {StellarGateway} from './lib/stellar-gateway.js';
import type {PrivyAuthVerifier} from './modules/auth/verifier.js';
import type {RampProvider} from './modules/ramp/provider.js';
import type {PrivyUserResolver} from './modules/wallet/privy-user.js';

// buildApp's `db` dependency is only touched if a wallet route actually
// runs its handler — none of the tests below hit `/wallet/*` — so a cast
// stand-in is enough; nothing here calls into Postgres.
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

// None of these are exercised by any test below (no `/wallet/*` route is
// hit on these app instances) — required only because they are non-optional
// AppDeps dependencies of buildApp. See routes.test.ts for the wallet
// module's own auth-wiring coverage.
const fakePrivyAuth: PrivyAuthVerifier = {
  verify: async () => ({privyDid: 'did:privy:unused-in-app-test'})
};
const fakeStellarGateway: StellarGateway = {
  loadAccount: async () => {
    throw new Error('unused in app.test.ts');
  },
  submitTransaction: async () => {
    throw new Error('unused in app.test.ts');
  },
  listPayments: async () => {
    throw new Error('unused in app.test.ts');
  }
};
const fakeSorobanGateway: SorobanGateway = {
  simulateAndAssemble: async () => {
    throw new Error('unused in app.test.ts');
  },
  simulateRead: async () => {
    throw new Error('unused in app.test.ts');
  },
  sendAndConfirm: async () => {
    throw new Error('unused in app.test.ts');
  },
  getContractEvents: async () => {
    throw new Error('unused in app.test.ts');
  },
  getLatestLedger: async () => {
    throw new Error('unused in app.test.ts');
  }
};
const fakePrivyUserResolver: PrivyUserResolver = {
  resolveStellarWallet: async () => {
    throw new Error('unused in app.test.ts');
  }
};
const fakeSponsorKeypair = Keypair.random();
const unusedRampMethod = (): never => {
  throw new Error('unused in app.test.ts');
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

// A syntactically-valid (checksum-passing) contract strkey, needed because
// `createDefindexProvider` calls `new Contract(vault.address)` eagerly
// inside `buildApp` whenever `network.vault` is non-null — any malformed
// address would throw during `buildApp()` itself, before the route-registration
// behavior under test even runs. This test-local fixture proves the vault
// module's generic "a vault is configured" wiring, independent of any real
// network's current deployment state (`config/vaults.ts`).
const FAKE_VAULT: VaultConfig = {
  address: 'CDTWG3OZERPUCD42KVZQUCOECYWUQ5HHFT6VFRTGKKVW46VSNQ3WOBYF',
  assetCode: 'USDC'
};

function testDeps() {
  return {
    db: fakeDb,
    env: fakeEnv,
    privyAuth: fakePrivyAuth,
    stellarGateway: fakeStellarGateway,
    sorobanGateway: fakeSorobanGateway,
    privyUserResolver: fakePrivyUserResolver,
    sponsorKeypair: fakeSponsorKeypair,
    rampProvider: fakeRampProvider,
    network: TESTNET_NETWORK
  };
}

describe('buildApp', () => {
  it('GET /health returns {status: "ok"}', async () => {
    const app = buildApp(testDeps());

    const res = await app.inject({method: 'GET', url: '/health'});

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({status: 'ok'});
  });

  it('a network with no vault (mainnet today) registers no /vault/* routes at all', async () => {
    const app = buildApp({...testDeps(), network: {...TESTNET_NETWORK, vault: null}});

    // 404 (route not registered) rather than 401 (route exists behind auth):
    // proves the vault module was skipped entirely, not just gated.
    const res = await app.inject({method: 'GET', url: '/vault/position'});

    expect(res.statusCode).toBe(404);
  });

  it('a network WITH a vault registers /vault/* inside the authenticated scope (401 without a token)', async () => {
    const app = buildApp({...testDeps(), network: {...TESTNET_NETWORK, vault: FAKE_VAULT}});

    const res = await app.inject({method: 'GET', url: '/vault/position'});

    expect(res.statusCode).toBe(401);
  });

  it('serializes a thrown AppError as {code, message, details?} with its statusCode', async () => {
    const app = buildApp(testDeps());
    app.get('/test/app-error', async () => {
      throw new AppError('test_error', 'something specific went wrong', 418, {field: 'x'});
    });

    const res = await app.inject({method: 'GET', url: '/test/app-error'});

    expect(res.statusCode).toBe(418);
    expect(res.json()).toEqual({
      code: 'test_error',
      message: 'something specific went wrong',
      details: {field: 'x'}
    });
  });

  it('omits details when the AppError has none', async () => {
    const app = buildApp(testDeps());
    app.get('/test/app-error-no-details', async () => {
      throw new AppError('no_details', 'no details here', 400);
    });

    const res = await app.inject({method: 'GET', url: '/test/app-error-no-details'});

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({code: 'no_details', message: 'no details here'});
  });

  it('maps an unknown thrown Error to a generic 500 without leaking its message', async () => {
    const app = buildApp(testDeps());
    app.get('/test/raw-error', async () => {
      throw new Error('leaked internals: connection string, stack trace, etc');
    });

    const res = await app.inject({method: 'GET', url: '/test/raw-error'});

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({code: 'internal_error', message: 'internal error'});
  });

  it('sets CORS headers restricted to env.CORS_ORIGIN', async () => {
    const app = buildApp(testDeps());

    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: {origin: 'http://localhost:5173'}
    });

    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });
});
