import type {OnboardingStartRequest, PixDetailsRequest} from '@paltalabs/shared';
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
import type {PrivyUserResolver} from '../wallet/privy-user.js';
import type {RampProvider} from './provider.js';
import {rampRoutes} from './routes.js';
import type {RampService} from './service.js';

const START_REQUEST: OnboardingStartRequest = {displayName: 'Ada Lovelace', email: 'ada@example.com'};

const PIX_DETAILS: PixDetailsRequest = {
  firstName: 'Ada',
  lastName: 'Lovelace',
  cpf: '12345678909',
  pixKey: 'ada@example.com',
  pixKeyType: 'email'
};

const LAUNCH_RESPONSE = {
  launch: {
    actionUrl: 'https://sandbox.etherfuse.com/auth/launch',
    assertion: 'header.payload.signature',
    target: '/idv',
    returnUrl: 'http://localhost:5173/ramp/kyc-return'
  }
};

const QUOTE_RESPONSE = {
  quoteId: 'quo_abc123',
  expiresAt: 1785769762823,
  senderAmountCents: 10000,
  receiverAmountCents: 1962,
  flatFeeCents: 20,
  commercialQuotation: 0.1959394590264675
};

const ORDER_RESPONSE = {
  orderId: '5777d79c-326a-418d-be30-63e7073f311c',
  status: 'created' as const,
  deposit: {depositAmount: '100.00', depositBankName: 'PIX', depositAccountHolder: 'Etherfuse'},
  receiverAmountCents: 1962
};

const PAYOUT_INTENT_RESPONSE = {intentId: 'intent-1', xdr: 'AAAA...', hashHex: '0xdeadbeef'};

function fakeRampService(): RampService {
  return {
    onboardingStatus: vi.fn(async () => ({status: 'not_started' as const})),
    startOnboarding: vi.fn(async () => LAUNCH_RESPONSE),
    kycLaunch: vi.fn(async () => LAUNCH_RESPONSE),
    completeSetup: vi.fn(async () => ({status: 'ready' as const})),
    payinQuote: vi.fn(async () => QUOTE_RESPONSE),
    createPayin: vi.fn(async () => ORDER_RESPONSE),
    getPayinState: vi.fn(async () => ({orderId: ORDER_RESPONSE.orderId, status: 'funded' as const, txHash: null})),
    simulatePayin: vi.fn(async () => undefined),
    payoutQuote: vi.fn(async () => QUOTE_RESPONSE),
    createPayout: vi.fn(async () => PAYOUT_INTENT_RESPONSE)
  };
}

/** A standalone Fastify with `request.privyDid` stubbed directly, mirroring vault/routes.test.ts. */
async function standaloneApp(service: RampService) {
  const app = Fastify();
  app.decorateRequest('privyDid', '');
  app.addHook('onRequest', async (request) => {
    request.privyDid = 'did:privy:test-user';
  });
  await app.register(rampRoutes, {rampService: service});
  return app;
}

describe('rampRoutes (standalone plugin, request.privyDid stubbed directly)', () => {
  it('GET /ramp/onboarding calls rampService.onboardingStatus(request.privyDid) and returns its result', async () => {
    const service = fakeRampService();
    const app = await standaloneApp(service);

    const res = await app.inject({method: 'GET', url: '/ramp/onboarding'});

    expect(res.statusCode).toBe(200);
    expect(service.onboardingStatus).toHaveBeenCalledWith('did:privy:test-user');
    expect(res.json()).toEqual({status: 'not_started'});
  });

  it('POST /ramp/onboarding/start calls rampService.startOnboarding(privyDid, parsedBody) and returns the launch params', async () => {
    const service = fakeRampService();
    const app = await standaloneApp(service);

    const res = await app.inject({method: 'POST', url: '/ramp/onboarding/start', payload: START_REQUEST});

    expect(res.statusCode).toBe(200);
    expect(service.startOnboarding).toHaveBeenCalledWith('did:privy:test-user', START_REQUEST);
    expect(res.json()).toEqual(LAUNCH_RESPONSE);
  });

  it('rejects an invalid /ramp/onboarding/start body (bad email) with a 400 before ever calling the service', async () => {
    const service = fakeRampService();
    const app = await standaloneApp(service);

    const res = await app.inject({
      method: 'POST',
      url: '/ramp/onboarding/start',
      payload: {...START_REQUEST, email: 'not-an-email'}
    });

    expect(res.statusCode).toBe(400);
    expect(service.startOnboarding).not.toHaveBeenCalled();
  });

  it('POST /ramp/onboarding/kyc-launch calls rampService.kycLaunch(privyDid, parsedBody) and returns fresh launch params', async () => {
    const service = fakeRampService();
    const app = await standaloneApp(service);

    const res = await app.inject({method: 'POST', url: '/ramp/onboarding/kyc-launch', payload: START_REQUEST});

    expect(res.statusCode).toBe(200);
    expect(service.kycLaunch).toHaveBeenCalledWith('did:privy:test-user', START_REQUEST);
    expect(res.json()).toEqual(LAUNCH_RESPONSE);
  });

  it('rejects an invalid /ramp/onboarding/kyc-launch body (empty displayName) with a 400', async () => {
    const service = fakeRampService();
    const app = await standaloneApp(service);

    const res = await app.inject({method: 'POST', url: '/ramp/onboarding/kyc-launch', payload: {...START_REQUEST, displayName: ''}});

    expect(res.statusCode).toBe(400);
    expect(service.kycLaunch).not.toHaveBeenCalled();
  });

  it('POST /ramp/onboarding calls rampService.completeSetup(privyDid, parsedBody) and returns the resulting status', async () => {
    const service = fakeRampService();
    const app = await standaloneApp(service);

    const res = await app.inject({method: 'POST', url: '/ramp/onboarding', payload: PIX_DETAILS});

    expect(res.statusCode).toBe(200);
    expect(service.completeSetup).toHaveBeenCalledWith('did:privy:test-user', PIX_DETAILS);
    expect(res.json()).toEqual({status: 'ready'});
  });

  it('rejects an invalid /ramp/onboarding body (unsupported pixKeyType) with a 400 before ever calling the service', async () => {
    const service = fakeRampService();
    const app = await standaloneApp(service);

    const res = await app.inject({method: 'POST', url: '/ramp/onboarding', payload: {...PIX_DETAILS, pixKeyType: 'iban'}});

    expect(res.statusCode).toBe(400);
    expect(service.completeSetup).not.toHaveBeenCalled();
  });

  it('POST /ramp/payin/quote calls rampService.payinQuote(privyDid, parsedBody) and returns its result', async () => {
    const service = fakeRampService();
    const app = await standaloneApp(service);

    const res = await app.inject({method: 'POST', url: '/ramp/payin/quote', payload: {amountBrlCents: 10000}});

    expect(res.statusCode).toBe(200);
    expect(service.payinQuote).toHaveBeenCalledWith('did:privy:test-user', {amountBrlCents: 10000});
    expect(res.json()).toEqual(QUOTE_RESPONSE);
  });

  it('rejects an invalid /ramp/payin/quote body (zero amountBrlCents) with a 400 before ever calling the service', async () => {
    const service = fakeRampService();
    const app = await standaloneApp(service);

    const res = await app.inject({method: 'POST', url: '/ramp/payin/quote', payload: {amountBrlCents: 0}});

    expect(res.statusCode).toBe(400);
    expect(service.payinQuote).not.toHaveBeenCalled();
  });

  it('POST /ramp/payin calls rampService.createPayin(privyDid, parsedBody) and returns the deposit instructions', async () => {
    const service = fakeRampService();
    const app = await standaloneApp(service);

    const res = await app.inject({
      method: 'POST',
      url: '/ramp/payin',
      payload: {quoteId: 'quo_abc123', amountCents: 1962}
    });

    expect(res.statusCode).toBe(200);
    expect(service.createPayin).toHaveBeenCalledWith('did:privy:test-user', {quoteId: 'quo_abc123', amountCents: 1962});
    expect(res.json()).toEqual(ORDER_RESPONSE);
  });

  it('rejects an invalid /ramp/payin body (empty quoteId) with a 400 before ever calling the service', async () => {
    const service = fakeRampService();
    const app = await standaloneApp(service);

    const res = await app.inject({method: 'POST', url: '/ramp/payin', payload: {quoteId: '', amountCents: 1962}});

    expect(res.statusCode).toBe(400);
    expect(service.createPayin).not.toHaveBeenCalled();
  });

  it('rejects an invalid /ramp/payin body (zero amountCents) with a 400 before ever calling the service', async () => {
    const service = fakeRampService();
    const app = await standaloneApp(service);

    const res = await app.inject({method: 'POST', url: '/ramp/payin', payload: {quoteId: 'quo_abc123', amountCents: 0}});

    expect(res.statusCode).toBe(400);
    expect(service.createPayin).not.toHaveBeenCalled();
  });

  it('GET /ramp/payin/:orderId calls rampService.getPayinState(privyDid, orderId) and returns the polled state', async () => {
    const service = fakeRampService();
    const app = await standaloneApp(service);

    const res = await app.inject({method: 'GET', url: `/ramp/payin/${ORDER_RESPONSE.orderId}`});

    expect(res.statusCode).toBe(200);
    expect(service.getPayinState).toHaveBeenCalledWith('did:privy:test-user', ORDER_RESPONSE.orderId);
    expect(res.json()).toEqual({orderId: ORDER_RESPONSE.orderId, status: 'funded', txHash: null});
  });

  it('POST /ramp/payin/:orderId/simulate calls rampService.simulatePayin and returns 204 with no body', async () => {
    const service = fakeRampService();
    const app = await standaloneApp(service);

    const res = await app.inject({method: 'POST', url: `/ramp/payin/${ORDER_RESPONSE.orderId}/simulate`});

    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    expect(service.simulatePayin).toHaveBeenCalledWith('did:privy:test-user', ORDER_RESPONSE.orderId);
  });

  it('POST /ramp/payout/quote calls rampService.payoutQuote(privyDid, parsedBody) and returns its result', async () => {
    const service = fakeRampService();
    const app = await standaloneApp(service);

    const res = await app.inject({method: 'POST', url: '/ramp/payout/quote', payload: {amountCents: 1000}});

    expect(res.statusCode).toBe(200);
    expect(service.payoutQuote).toHaveBeenCalledWith('did:privy:test-user', {amountCents: 1000});
    expect(res.json()).toEqual(QUOTE_RESPONSE);
  });

  it('rejects an invalid /ramp/payout/quote body (zero amountCents) with a 400 before ever calling the service', async () => {
    const service = fakeRampService();
    const app = await standaloneApp(service);

    const res = await app.inject({method: 'POST', url: '/ramp/payout/quote', payload: {amountCents: 0}});

    expect(res.statusCode).toBe(400);
    expect(service.payoutQuote).not.toHaveBeenCalled();
  });

  it('POST /ramp/payout calls rampService.createPayout(privyDid, parsedBody) and returns the created payout intent', async () => {
    const service = fakeRampService();
    const app = await standaloneApp(service);

    const res = await app.inject({
      method: 'POST',
      url: '/ramp/payout',
      payload: {quoteId: 'quo_abc123', amountCents: 1000}
    });

    expect(res.statusCode).toBe(200);
    expect(service.createPayout).toHaveBeenCalledWith('did:privy:test-user', {quoteId: 'quo_abc123', amountCents: 1000});
    expect(res.json()).toEqual(PAYOUT_INTENT_RESPONSE);
  });

  it('rejects an invalid /ramp/payout body (empty quoteId) with a 400 before ever calling the service', async () => {
    const service = fakeRampService();
    const app = await standaloneApp(service);

    const res = await app.inject({method: 'POST', url: '/ramp/payout', payload: {quoteId: '', amountCents: 1000}});

    expect(res.statusCode).toBe(400);
    expect(service.createPayout).not.toHaveBeenCalled();
  });

  it('rejects an invalid /ramp/payout body (zero amountCents) with a 400 before ever calling the service', async () => {
    const service = fakeRampService();
    const app = await standaloneApp(service);

    const res = await app.inject({method: 'POST', url: '/ramp/payout', payload: {quoteId: 'quo_abc123', amountCents: 0}});

    expect(res.statusCode).toBe(400);
    expect(service.createPayout).not.toHaveBeenCalled();
  });
});

// Real-buildApp end-to-end wiring test, mirroring vault/routes.test.ts's
// pattern: proves authPlugin -> rampRoutes wiring inside the REAL app.
describe('ramp routes wired through the real buildApp (authenticated-scope end-to-end)', () => {
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
      throw new Error('unused in ramp routes.test.ts');
    },
    submitTransaction: async () => {
      throw new Error('unused in ramp routes.test.ts');
    },
    listPayments: async () => {
      throw new Error('unused in ramp routes.test.ts');
    }
  };
  const fakeSorobanGateway: SorobanGateway = {
    simulateAndAssemble: async () => {
      throw new Error('unused in ramp routes.test.ts');
    },
    simulateRead: async () => {
      throw new Error('unused in ramp routes.test.ts');
    },
    sendAndConfirm: async () => {
      throw new Error('unused in ramp routes.test.ts');
    },
    getContractEvents: async () => {
      throw new Error('unused in ramp routes.test.ts');
    },
    getLatestLedger: async () => {
      throw new Error('unused in ramp routes.test.ts');
    }
  };
  const fakePrivyUserResolver: PrivyUserResolver = {
    resolveStellarWallet: async () => {
      throw new Error('unused in ramp routes.test.ts');
    }
  };
  const unused = (): never => {
    throw new Error('unused in ramp routes.test.ts');
  };
  const fakeRampProvider: RampProvider = {
    createOrganization: unused,
    getKycStatus: unused,
    buildKycLaunch: unused,
    registerBankAccount: unused,
    registerWallet: unused,
    createOnrampQuote: unused,
    createOfframpQuote: unused,
    createOnrampOrder: unused,
    createAnchorOfframpOrder: unused,
    getOrder: unused,
    simulateFiatReceived: unused
  };
  const fakeSponsorKeypair = Keypair.random();

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

  it('GET /ramp/onboarding returns 401 {code: "unauthorized"} without an Authorization header', async () => {
    const privyAuth: PrivyAuthVerifier = {verify: async () => ({privyDid: 'should-not-be-reached'})};
    const app = buildApp(appDeps(privyAuth));

    const res = await app.inject({method: 'GET', url: '/ramp/onboarding'});

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({code: 'unauthorized'});
  });

  it('POST /ramp/onboarding/start: an invalid body returns 400 {code: "invalid_request"} without touching the gateway/db', async () => {
    const privyAuth: PrivyAuthVerifier = {verify: async () => ({privyDid: 'did:privy:end-to-end'})};
    const app = buildApp(appDeps(privyAuth));

    const res = await app.inject({
      method: 'POST',
      url: '/ramp/onboarding/start',
      headers: {authorization: 'Bearer good-token'},
      payload: {...START_REQUEST, email: 'not-an-email'}
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({code: 'invalid_request'});
  });

  it('POST /ramp/onboarding: an invalid body returns 400 {code: "invalid_request"} without touching the gateway/db', async () => {
    const privyAuth: PrivyAuthVerifier = {verify: async () => ({privyDid: 'did:privy:end-to-end'})};
    const app = buildApp(appDeps(privyAuth));

    const res = await app.inject({
      method: 'POST',
      url: '/ramp/onboarding',
      headers: {authorization: 'Bearer good-token'},
      payload: {...PIX_DETAILS, cpf: ''}
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({code: 'invalid_request'});
  });

  it('POST /ramp/payin/quote: an invalid body returns 400 {code: "invalid_request"} without touching the gateway/db', async () => {
    const privyAuth: PrivyAuthVerifier = {verify: async () => ({privyDid: 'did:privy:end-to-end'})};
    const app = buildApp(appDeps(privyAuth));

    const res = await app.inject({
      method: 'POST',
      url: '/ramp/payin/quote',
      headers: {authorization: 'Bearer good-token'},
      payload: {amountBrlCents: 0}
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({code: 'invalid_request'});
  });

  it('POST /ramp/payout/quote: an invalid body returns 400 {code: "invalid_request"} without touching the gateway/db', async () => {
    const privyAuth: PrivyAuthVerifier = {verify: async () => ({privyDid: 'did:privy:end-to-end'})};
    const app = buildApp(appDeps(privyAuth));

    const res = await app.inject({
      method: 'POST',
      url: '/ramp/payout/quote',
      headers: {authorization: 'Bearer good-token'},
      payload: {amountCents: 0}
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({code: 'invalid_request'});
  });

  it('POST /ramp/payout: an invalid body returns 400 {code: "invalid_request"} without touching the gateway/db', async () => {
    const privyAuth: PrivyAuthVerifier = {verify: async () => ({privyDid: 'did:privy:end-to-end'})};
    const app = buildApp(appDeps(privyAuth));

    const res = await app.inject({
      method: 'POST',
      url: '/ramp/payout',
      headers: {authorization: 'Bearer good-token'},
      payload: {quoteId: '', amountCents: 1000}
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({code: 'invalid_request'});
  });
});
