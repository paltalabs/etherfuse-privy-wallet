import {generateKeyPairSync} from 'node:crypto';
import {describe, expect, it} from 'vitest';
import {createEtherfuseProvider, decimalToCents} from './etherfuse.js';
import {RampProviderError} from './provider.js';

const TEST_API_KEY = 'test-etherfuse-api-key-fixture';
const API_BASE_URL = 'https://api.sand.etherfuse.com';
const DASHBOARD_BASE_URL = 'https://sandbox.etherfuse.com';
const ASSET_ID = 'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const JWT_ISSUER = 'https://paltalabs.example/etherfuse';
const JWT_KID = 'test-kid-1';

// Real ids from the recorded sandbox run (docs/evidence/etherfuse-sandbox-findings.md).
const CUSTOMER_ID = 'ce667871-a026-4aab-aac6-d77ac0ad784a';
const BANK_ACCOUNT_ID = '8851df52-95a5-4f5b-a5ba-0f9121298457';
const WALLET_ID = '6c9fe13a-c8f8-4036-a1bc-88191bb59282';
const ORDER_ID = '5777d79c-326a-418d-be30-63e7073f311c';
const QUOTE_ID = '4507597f-19de-4c71-bb52-7a4f92010732';
// The spike's throwaway testnet wallet (public key, truncated as `GDYJD3MF…`
// in the evidence doc's payloads).
const WALLET_ADDRESS = 'GDYJD3MFLVQNNX5YROT4PSK6JEDFAKQCKSZQKASYZLDZ6GWNVF6MGEH2';

// RSA, not EC: the sandbox rejects ES256 outright ("Disallowed signature
// algorithm: algorithm `ES256` is not one of: RS256" —
// docs/evidence/etherfuse-sandbox-findings.md "## Launch JWT"). Generated per
// test run; never a real key.
const {privateKey} = generateKeyPairSync('rsa', {modulusLength: 2048});
const JWT_PRIVATE_KEY_PEM = privateKey.export({type: 'pkcs8', format: 'pem'}) as string;

interface RecordedCall {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * A `fetch` fake programmed with an ordered list of `{status, json}` pairs
 * (one per expected call) that records every call's url/method/headers/
 * parsed-body. No live network call happens anywhere in this file — every
 * test injects this in place of `globalThis.fetch` via `EtherfuseDeps.fetchFn`.
 */
function fakeFetch(...responses: Array<{status: number; json: unknown}>): {fetchFn: typeof fetch; calls: RecordedCall[]} {
  const calls: RecordedCall[] = [];
  const queue = [...responses];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body
    });
    const next = queue.shift();
    if (!next) throw new Error(`fakeFetch: unexpected call #${calls.length} to ${String(url)} — no response programmed`);
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      json: async () => next.json
    } as Response;
  }) as typeof fetch;
  return {fetchFn, calls};
}

function makeProvider(fetchFn: typeof fetch, overrides: {jwtPrivateKeyPem?: string} = {}) {
  return createEtherfuseProvider({
    apiKey: TEST_API_KEY,
    apiBaseUrl: API_BASE_URL,
    dashboardBaseUrl: DASHBOARD_BASE_URL,
    blockchain: 'stellar',
    assetId: ASSET_ID,
    jwtIssuer: JWT_ISSUER,
    jwtKid: JWT_KID,
    jwtPrivateKeyPem: overrides.jwtPrivateKeyPem ?? JWT_PRIVATE_KEY_PEM,
    fetchFn
  });
}

/**
 * Asserts the Authorization header is the RAW api key with NO `Bearer `
 * prefix (docs/evidence/etherfuse-sandbox-findings.md's header note — a
 * Bearer prefix is Etherfuse's documented #1 cause of 401). Compared against
 * the local fixture constant via `toBe`, never snapshotted, so a real key can
 * never leak into a committed snapshot file.
 */
function expectAuthHeader(calls: RecordedCall[], index = 0): void {
  expect(calls[index]!.headers.Authorization).toBe(TEST_API_KEY);
}

// Etherfuse error bodies are frequently a BARE JSON STRING, not an object —
// this exact one was returned when a bank account was registered before the
// org's KYC was approved (docs/evidence/etherfuse-sandbox-findings.md
// "## Bank account (BRL/PIX)").
const STRING_ERROR_BODY = 'Organization must be approved before adding a bank account';
// The object-shaped variant, for the message-field branch.
const OBJECT_ERROR_BODY = {message: 'invalid_client', description: 'JWKS bad response'};

describe('createEtherfuseProvider.createOrganization', () => {
  it('POSTs the client-generated id, accountType personal, and userInfo with the raw-key auth header', async () => {
    const {fetchFn, calls} = fakeFetch({
      status: 201,
      // docs/evidence/etherfuse-sandbox-findings.md "## Org & KYC"
      json: {organizationId: CUSTOMER_ID, displayName: 'Spike Merchant', accountType: 'personal'}
    });

    await makeProvider(fetchFn).createOrganization({
      customerId: CUSTOMER_ID,
      displayName: 'Spike Merchant',
      email: 'merchant@example.com'
    });

    expect(calls[0]!.url).toBe(`${API_BASE_URL}/ramp/organization`);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toEqual({
      id: CUSTOMER_ID,
      displayName: 'Spike Merchant',
      accountType: 'personal',
      userInfo: {email: 'merchant@example.com', displayName: 'Spike Merchant'}
    });
    expectAuthHeader(calls);
  });

  it('throws RampProviderError(organization_creation_failed) on a non-2xx response, using a bare-string error body verbatim', async () => {
    const {fetchFn} = fakeFetch({status: 400, json: STRING_ERROR_BODY});

    const failure = await makeProvider(fetchFn)
      .createOrganization({customerId: CUSTOMER_ID, displayName: 'Spike Merchant', email: 'merchant@example.com'})
      .catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(RampProviderError);
    expect(failure).toMatchObject({reason: 'organization_creation_failed', message: STRING_ERROR_BODY});
  });
});

describe('createEtherfuseProvider.getKycStatus', () => {
  it('GETs the customer kyc endpoint and returns the raw status for a fresh org', async () => {
    // docs/evidence/etherfuse-sandbox-findings.md "## Org & KYC" (fresh org)
    const {fetchFn, calls} = fakeFetch({
      status: 200,
      json: {
        customerId: CUSTOMER_ID,
        status: 'not_started',
        currentRejectionReason: null,
        selfies: [],
        documents: [],
        approvedAt: null,
        needsWork: false
      }
    });

    const result = await makeProvider(fetchFn).getKycStatus(CUSTOMER_ID);

    expect(calls[0]!.url).toBe(`${API_BASE_URL}/ramp/customer/${CUSTOMER_ID}/kyc`);
    expect(calls[0]!.method).toBe('GET');
    expectAuthHeader(calls);
    expect(result).toBe('not_started');
  });

  it('returns approved once the hosted /idv flow has been completed', async () => {
    // docs/evidence/etherfuse-sandbox-findings.md "## Org & KYC" (after /idv)
    const {fetchFn} = fakeFetch({status: 200, json: {status: 'approved', approvedAt: '2026-08-03T15:06:46.955321Z'}});

    await expect(makeProvider(fetchFn).getKycStatus(CUSTOMER_ID)).resolves.toBe('approved');
  });

  it('maps an unrecognized status to in_progress rather than throwing (only approved ever unlocks the flow)', async () => {
    const {fetchFn} = fakeFetch({status: 200, json: {status: 'some_future_state'}});

    await expect(makeProvider(fetchFn).getKycStatus(CUSTOMER_ID)).resolves.toBe('in_progress');
  });

  it('throws RampProviderError(kyc_fetch_failed) on a non-2xx response', async () => {
    const {fetchFn} = fakeFetch({status: 404, json: OBJECT_ERROR_BODY});

    const failure = await makeProvider(fetchFn).getKycStatus(CUSTOMER_ID).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(RampProviderError);
    expect(failure).toMatchObject({reason: 'kyc_fetch_failed', message: OBJECT_ERROR_BODY.message});
  });
});

describe('createEtherfuseProvider.buildKycLaunch', () => {
  function decodeSegment(segment: string): Record<string, unknown> {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as Record<string, unknown>;
  }

  it('signs an RS256 assertion carrying the kid, the /idv verification claims, and the caller identity', () => {
    // No HTTP at all — buildKycLaunch is pure signing, so the fake fetch is
    // programmed with nothing and must never be called.
    const {fetchFn, calls} = fakeFetch();

    const launch = makeProvider(fetchFn).buildKycLaunch(CUSTOMER_ID, {
      email: 'merchant@example.com',
      displayName: 'Spike Merchant'
    });

    expect(calls).toHaveLength(0);
    expect(launch.actionUrl).toBe(`${DASHBOARD_BASE_URL}/auth/launch`);
    expect(launch.target).toBe('/idv');

    const [headerSegment, payloadSegment, signatureSegment] = launch.assertion.split('.');
    expect(signatureSegment).toBeTruthy();
    expect(decodeSegment(headerSegment!)).toEqual({alg: 'RS256', typ: 'JWT', kid: JWT_KID});

    const claims = decodeSegment(payloadSegment!);
    expect(claims).toMatchObject({
      iss: JWT_ISSUER,
      sub: CUSTOMER_ID,
      aud: `${API_BASE_URL}/auth/token`,
      scope: 'verification',
      email: 'merchant@example.com',
      name: 'Spike Merchant'
    });
    expect(typeof claims.jti).toBe('string');
    expect(claims.exp).toBe((claims.iat as number) + 300);
  });

  it('mints a fresh jti per call so a launch assertion is never replayable', () => {
    const provider = makeProvider(fakeFetch().fetchFn);

    const first = provider.buildKycLaunch(CUSTOMER_ID, {email: 'a@example.com', displayName: 'A'});
    const second = provider.buildKycLaunch(CUSTOMER_ID, {email: 'a@example.com', displayName: 'A'});

    expect(decodeSegment(first.assertion.split('.')[1]!).jti).not.toBe(decodeSegment(second.assertion.split('.')[1]!).jti);
  });

  it('accepts a PEM whose newlines are backslash-escaped (the shape a .env value has)', () => {
    const escapedPem = JWT_PRIVATE_KEY_PEM.replace(/\n/g, '\\n');
    const provider = makeProvider(fakeFetch().fetchFn, {jwtPrivateKeyPem: escapedPem});

    const launch = provider.buildKycLaunch(CUSTOMER_ID, {email: 'merchant@example.com', displayName: 'Spike Merchant'});

    expect(launch.assertion.split('.')).toHaveLength(3);
  });
});

describe('createEtherfuseProvider.registerBankAccount', () => {
  const INPUT = {
    transactionId: '1717769c-bd4c-42b2-95aa-6c879e7eb4a0',
    firstName: 'Spike',
    lastName: 'Merchant',
    cpf: '12345678909',
    pixKey: 'spike-merchant@example.com',
    pixKeyType: 'email'
  };

  it('POSTs the BRL fields nested under `account` and returns the bank account id', async () => {
    // docs/evidence/etherfuse-sandbox-findings.md "## Bank account (BRL/PIX)"
    const {fetchFn, calls} = fakeFetch({
      status: 201,
      json: {
        bankAccountId: BANK_ACCOUNT_ID,
        customerId: CUSTOMER_ID,
        createdAt: '2026-08-03T15:07:13.059200Z',
        updatedAt: '2026-08-03T15:07:13.059200Z',
        currency: 'brl',
        abbrClabe: '',
        compliant: true,
        needsWork: false,
        status: 'active'
      }
    });

    const result = await makeProvider(fetchFn).registerBankAccount(CUSTOMER_ID, INPUT);

    expect(calls[0]!.url).toBe(`${API_BASE_URL}/ramp/customer/${CUSTOMER_ID}/bank-account`);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toEqual({account: INPUT});
    expectAuthHeader(calls);
    expect(result).toEqual({bankAccountId: BANK_ACCOUNT_ID});
  });

  it('throws RampProviderError(bank_account_registration_failed) on a non-2xx response', async () => {
    const {fetchFn} = fakeFetch({status: 409, json: STRING_ERROR_BODY});

    const failure = await makeProvider(fetchFn).registerBankAccount(CUSTOMER_ID, INPUT).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(RampProviderError);
    expect(failure).toMatchObject({reason: 'bank_account_registration_failed', message: STRING_ERROR_BODY});
  });
});

describe('createEtherfuseProvider.registerWallet', () => {
  it('POSTs claimOwnership:true (without it orders fail the wallet T&C check) and returns the wallet id', async () => {
    // docs/evidence/etherfuse-sandbox-findings.md "## Wallet registration"
    const {fetchFn, calls} = fakeFetch({
      status: 200,
      json: {
        walletId: WALLET_ID,
        customerId: CUSTOMER_ID,
        publicKey: WALLET_ADDRESS,
        blockchain: 'stellar',
        kycStatus: 'approved',
        claimedOwnership: true
      }
    });

    const result = await makeProvider(fetchFn).registerWallet(CUSTOMER_ID, WALLET_ADDRESS);

    expect(calls[0]!.url).toBe(`${API_BASE_URL}/ramp/customer/${CUSTOMER_ID}/wallet`);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toEqual({publicKey: WALLET_ADDRESS, blockchain: 'stellar', claimOwnership: true});
    expectAuthHeader(calls);
    expect(result).toEqual({walletId: WALLET_ID});
  });

  it('throws RampProviderError(wallet_registration_failed) on a non-2xx response', async () => {
    const {fetchFn} = fakeFetch({status: 400, json: OBJECT_ERROR_BODY});

    const failure = await makeProvider(fetchFn).registerWallet(CUSTOMER_ID, WALLET_ADDRESS).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(RampProviderError);
    expect(failure).toMatchObject({reason: 'wallet_registration_failed'});
  });
});

// docs/evidence/etherfuse-sandbox-findings.md "## Onramp quote" — verbatim.
const ONRAMP_QUOTE_RESPONSE = {
  quoteId: QUOTE_ID,
  blockchain: 'stellar',
  quoteAssets: {type: 'onramp', sourceAsset: 'BRL', targetAsset: ASSET_ID},
  sourceAmount: '100',
  destinationAmount: '19.620062792064687229069147940',
  createdAt: '2026-08-03T15:07:22.822950855Z',
  updatedAt: '2026-08-03T15:07:22.822950855Z',
  expiresAt: '2026-08-03T15:09:22.823414202Z',
  exchangeRate: '0.1959394590264675335384349581',
  etherfuseMidMarketRate: '0.196332123273013560659754467',
  nominalRate: '0.196761060',
  feeBps: '20',
  feeAmount: '0.20',
  requiresSwap: true
};

describe('createEtherfuseProvider.createOnrampQuote', () => {
  it('POSTs BRL→asset quoteAssets with a generated quoteId and maps the decimal-string amounts to cents', async () => {
    const {fetchFn, calls} = fakeFetch({status: 200, json: ONRAMP_QUOTE_RESPONSE});

    const result = await makeProvider(fetchFn).createOnrampQuote({
      customerId: CUSTOMER_ID,
      walletAddress: WALLET_ADDRESS,
      amountBrl: '100.00'
    });

    expect(calls[0]!.url).toBe(`${API_BASE_URL}/ramp/quote`);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toMatchObject({
      customerId: CUSTOMER_ID,
      blockchain: 'stellar',
      quoteAssets: {type: 'onramp', sourceAsset: 'BRL', targetAsset: ASSET_ID},
      sourceAmount: '100.00',
      walletAddress: WALLET_ADDRESS
    });
    // quoteId is generated server-side (never client-supplied) — pin its
    // presence/shape, not its value.
    expect(typeof (calls[0]!.body as {quoteId: string}).quoteId).toBe('string');
    expectAuthHeader(calls);
    expect(result).toEqual({
      quoteId: QUOTE_ID,
      expiresAt: Date.parse('2026-08-03T15:09:22.823414202Z'),
      senderAmountCents: 10000,
      // destinationAmount floored: never promise more than gets delivered.
      receiverAmountCents: 1962,
      flatFeeCents: 20,
      commercialQuotation: 0.1959394590264675335384349581
    });
  });

  it('throws RampProviderError(quote_rejected) on a non-2xx response', async () => {
    const {fetchFn} = fakeFetch({status: 400, json: STRING_ERROR_BODY});

    const failure = await makeProvider(fetchFn)
      .createOnrampQuote({customerId: CUSTOMER_ID, walletAddress: WALLET_ADDRESS, amountBrl: '100.00'})
      .catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(RampProviderError);
    expect(failure).toMatchObject({reason: 'quote_rejected'});
  });

  it('throws RampProviderError(quote_rejected) when the response mapping itself fails (e.g. an unparseable decimal amount)', async () => {
    // A 2xx response whose body is malformed provider data, not a non-2xx
    // status — `decimalToCents`/`parseDecimal` throws on a non-decimal
    // string, and that throw must still surface as the SAME reason token a
    // non-2xx response would (provider.ts's RampProviderError contract).
    const {fetchFn} = fakeFetch({status: 200, json: {...ONRAMP_QUOTE_RESPONSE, sourceAmount: 'not-a-decimal'}});

    const failure = await makeProvider(fetchFn)
      .createOnrampQuote({customerId: CUSTOMER_ID, walletAddress: WALLET_ADDRESS, amountBrl: '100.00'})
      .catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(RampProviderError);
    expect(failure).toMatchObject({reason: 'quote_rejected'});
  });
});

describe('createEtherfuseProvider.createOfframpQuote', () => {
  // docs/evidence/etherfuse-sandbox-findings.md "## Offramp quote" records the
  // deltas from the onramp response above (assets reversed, sourceAmount "10",
  // destinationAmount "50.71017", exchangeRate "5.07101764", feeBps "20",
  // feeAmount "0.02", same 2-minute expiry) — the shared fields keep the
  // onramp response's recorded shape.
  const OFFRAMP_QUOTE_RESPONSE = {
    quoteId: QUOTE_ID,
    blockchain: 'stellar',
    quoteAssets: {type: 'offramp', sourceAsset: ASSET_ID, targetAsset: 'BRL'},
    sourceAmount: '10',
    destinationAmount: '50.71017',
    expiresAt: '2026-08-03T15:09:22.823414202Z',
    exchangeRate: '5.07101764',
    feeBps: '20',
    feeAmount: '0.02'
  };

  it('POSTs asset→BRL quoteAssets and maps the response to cents', async () => {
    const {fetchFn, calls} = fakeFetch({status: 200, json: OFFRAMP_QUOTE_RESPONSE});

    const result = await makeProvider(fetchFn).createOfframpQuote({
      customerId: CUSTOMER_ID,
      walletAddress: WALLET_ADDRESS,
      amountToken: '10.00'
    });

    expect(calls[0]!.url).toBe(`${API_BASE_URL}/ramp/quote`);
    expect(calls[0]!.body).toMatchObject({
      customerId: CUSTOMER_ID,
      blockchain: 'stellar',
      quoteAssets: {type: 'offramp', sourceAsset: ASSET_ID, targetAsset: 'BRL'},
      sourceAmount: '10.00',
      walletAddress: WALLET_ADDRESS
    });
    expectAuthHeader(calls);
    expect(result).toEqual({
      quoteId: QUOTE_ID,
      expiresAt: Date.parse('2026-08-03T15:09:22.823414202Z'),
      senderAmountCents: 1000,
      receiverAmountCents: 5071,
      flatFeeCents: 2,
      commercialQuotation: 5.07101764
    });
  });

  it('throws RampProviderError(quote_rejected) on a non-2xx response', async () => {
    const {fetchFn} = fakeFetch({status: 400, json: STRING_ERROR_BODY});

    const failure = await makeProvider(fetchFn)
      .createOfframpQuote({customerId: CUSTOMER_ID, walletAddress: WALLET_ADDRESS, amountToken: '10.00'})
      .catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(RampProviderError);
    expect(failure).toMatchObject({reason: 'quote_rejected'});
  });
});

// docs/evidence/etherfuse-sandbox-findings.md "## Onramp order & deposit
// payload" — the create response carries ONLY these deposit fields (no
// status, no token amount).
const ONRAMP_ORDER_RESPONSE = {
  onramp: {
    orderId: ORDER_ID,
    depositClabe: '',
    depositAmount: '100',
    depositBankName: 'PIX',
    depositAccountHolder: 'Etherfuse'
  }
};

describe('createEtherfuseProvider.createOnrampOrder', () => {
  it('POSTs the order and maps ONLY the deposit block the create response carries — no follow-up read', async () => {
    const {fetchFn, calls} = fakeFetch({status: 200, json: ONRAMP_ORDER_RESPONSE});

    const result = await makeProvider(fetchFn).createOnrampOrder({
      orderId: ORDER_ID,
      quoteId: QUOTE_ID,
      bankAccountId: BANK_ACCOUNT_ID,
      cryptoWalletId: WALLET_ID
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${API_BASE_URL}/ramp/order`);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toEqual({
      orderId: ORDER_ID,
      quoteId: QUOTE_ID,
      bankAccountId: BANK_ACCOUNT_ID,
      cryptoWalletId: WALLET_ID
    });
    expectAuthHeader(calls, 0);
    expect(result).toEqual({
      orderId: ORDER_ID,
      // depositClabe is always '' for BRL and is deliberately dropped.
      deposit: {depositAmount: '100', depositBankName: 'PIX', depositAccountHolder: 'Etherfuse'}
    });
  });

  it('throws RampProviderError(order_rejected) when the order POST is rejected (e.g. an expired quote or a duplicate open order)', async () => {
    const {fetchFn, calls} = fakeFetch({status: 400, json: STRING_ERROR_BODY});

    const failure = await makeProvider(fetchFn)
      .createOnrampOrder({orderId: ORDER_ID, quoteId: QUOTE_ID, bankAccountId: BANK_ACCOUNT_ID, cryptoWalletId: WALLET_ID})
      .catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(RampProviderError);
    expect(failure).toMatchObject({reason: 'order_rejected'});
    expect(calls).toHaveLength(1);
  });
});

describe('createEtherfuseProvider.createAnchorOfframpOrder', () => {
  const ANCHOR_ORDER_ID = 'da3d9e63-ef0d-431c-9517-c1a145c1027b';
  // docs/evidence/etherfuse-sandbox-findings.md "## Anchor order"
  const ANCHOR_ORDER_RESPONSE = {
    offramp: {
      orderId: ANCHOR_ORDER_ID,
      withdrawAnchorAccount: 'GCUX6U4F5675FBA5LSVFCL7HGMRTMTXB4U2WSM5ZLUE4ORIHS6XNXY3X',
      withdrawMemo: '2j2eY+8NQxyVF8GhRcECewAAAAAAAAAAAAAAAAAAAAA=',
      withdrawMemoType: 'hash'
    }
  };

  it('POSTs useAnchor:true and maps the anchor account + base64 hash memo', async () => {
    const {fetchFn, calls} = fakeFetch({status: 200, json: ANCHOR_ORDER_RESPONSE});

    const result = await makeProvider(fetchFn).createAnchorOfframpOrder({
      orderId: ANCHOR_ORDER_ID,
      quoteId: QUOTE_ID,
      bankAccountId: BANK_ACCOUNT_ID,
      cryptoWalletId: WALLET_ID
    });

    expect(calls[0]!.url).toBe(`${API_BASE_URL}/ramp/order`);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toEqual({
      orderId: ANCHOR_ORDER_ID,
      quoteId: QUOTE_ID,
      bankAccountId: BANK_ACCOUNT_ID,
      cryptoWalletId: WALLET_ID,
      useAnchor: true
    });
    expectAuthHeader(calls);
    expect(result).toEqual({
      orderId: ANCHOR_ORDER_ID,
      withdrawAnchorAccount: 'GCUX6U4F5675FBA5LSVFCL7HGMRTMTXB4U2WSM5ZLUE4ORIHS6XNXY3X',
      withdrawMemoBase64: '2j2eY+8NQxyVF8GhRcECewAAAAAAAAAAAAAAAAAAAAA=',
      withdrawMemoType: 'hash'
    });
  });

  it('throws RampProviderError(order_rejected) when the anchor response carries a memo type other than hash', async () => {
    const {fetchFn} = fakeFetch({
      status: 200,
      json: {offramp: {...ANCHOR_ORDER_RESPONSE.offramp, withdrawMemoType: 'text'}}
    });

    const failure = await makeProvider(fetchFn)
      .createAnchorOfframpOrder({
        orderId: ANCHOR_ORDER_ID,
        quoteId: QUOTE_ID,
        bankAccountId: BANK_ACCOUNT_ID,
        cryptoWalletId: WALLET_ID
      })
      .catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(RampProviderError);
    expect(failure).toMatchObject({reason: 'order_rejected'});
  });

  it('throws RampProviderError(order_rejected) on a non-2xx response', async () => {
    const {fetchFn} = fakeFetch({status: 409, json: STRING_ERROR_BODY});

    const failure = await makeProvider(fetchFn)
      .createAnchorOfframpOrder({
        orderId: ANCHOR_ORDER_ID,
        quoteId: QUOTE_ID,
        bankAccountId: BANK_ACCOUNT_ID,
        cryptoWalletId: WALLET_ID
      })
      .catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(RampProviderError);
    expect(failure).toMatchObject({reason: 'order_rejected'});
  });
});

describe('createEtherfuseProvider.getOrder', () => {
  it('maps a completed ONRAMP order with no confirmedTxSignature to a null txHash', async () => {
    // docs/evidence/etherfuse-sandbox-findings.md "## Fiat received &
    // settlement" — the completed onramp order carries no delivery tx hash.
    const {fetchFn, calls} = fakeFetch({
      status: 200,
      json: {
        orderId: ORDER_ID,
        status: 'completed',
        completedAt: '2026-08-03T15:09:59.724082Z',
        amountInFiat: '100',
        amountInTokens: '19.620062792064687229069147940',
        trackingCode: '2763296125929322112922',
        orderType: 'onramp',
        statusPage: `https://sandbox.etherfuse.com/ramp/order/${ORDER_ID}`,
        sourceAsset: 'BRL',
        targetAsset: ASSET_ID,
        blockchain: 'stellar'
      }
    });

    const result = await makeProvider(fetchFn).getOrder(ORDER_ID);

    expect(calls[0]!.url).toBe(`${API_BASE_URL}/ramp/order/${ORDER_ID}`);
    expect(calls[0]!.method).toBe('GET');
    expectAuthHeader(calls);
    expect(result).toEqual({
      orderId: ORDER_ID,
      status: 'completed',
      txHash: null,
      amountTokens: '19.620062792064687229069147940'
    });
  });

  it('maps a funded OFFRAMP order\'s confirmedTxSignature into txHash, with no amountInTokens yet', async () => {
    // docs/evidence/etherfuse-sandbox-findings.md "## Anchor payment &
    // completion" — Etherfuse's own internal hash, not the merchant's.
    const {fetchFn} = fakeFetch({
      status: 200,
      json: {
        orderId: 'da3d9e63-ef0d-431c-9517-c1a145c1027b',
        status: 'funded',
        confirmedTxSignature: 'dda943024bf84476fdefc1601686e00c9c4e458703132067668a3f465540cd0f',
        orderType: 'offramp',
        isAnchorOrder: true
      }
    });

    await expect(makeProvider(fetchFn).getOrder('da3d9e63-ef0d-431c-9517-c1a145c1027b')).resolves.toEqual({
      orderId: 'da3d9e63-ef0d-431c-9517-c1a145c1027b',
      status: 'funded',
      txHash: 'dda943024bf84476fdefc1601686e00c9c4e458703132067668a3f465540cd0f',
      amountTokens: null
    });
  });

  it('throws RampProviderError(order_fetch_failed) on an unrecognized status', async () => {
    const {fetchFn} = fakeFetch({status: 200, json: {orderId: ORDER_ID, status: 'some_future_state'}});

    const failure = await makeProvider(fetchFn).getOrder(ORDER_ID).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(RampProviderError);
    expect(failure).toMatchObject({reason: 'order_fetch_failed'});
  });

  it('throws RampProviderError(order_fetch_failed) on a non-2xx response', async () => {
    const {fetchFn} = fakeFetch({status: 404, json: STRING_ERROR_BODY});

    const failure = await makeProvider(fetchFn).getOrder(ORDER_ID).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(RampProviderError);
    expect(failure).toMatchObject({reason: 'order_fetch_failed'});
  });
});

describe('createEtherfuseProvider.simulateFiatReceived', () => {
  it('POSTs just the order id and tolerates the empty (null) response body', async () => {
    // docs/evidence/etherfuse-sandbox-findings.md "## Fiat received &
    // settlement": 200 with an empty body.
    const {fetchFn, calls} = fakeFetch({status: 200, json: null});

    await expect(makeProvider(fetchFn).simulateFiatReceived(ORDER_ID)).resolves.toBeUndefined();

    expect(calls[0]!.url).toBe(`${API_BASE_URL}/ramp/order/fiat_received`);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toEqual({orderId: ORDER_ID});
    expectAuthHeader(calls);
  });

  it('throws RampProviderError(simulate_failed) on a non-2xx response', async () => {
    const {fetchFn} = fakeFetch({status: 400, json: STRING_ERROR_BODY});

    const failure = await makeProvider(fetchFn).simulateFiatReceived(ORDER_ID).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(RampProviderError);
    expect(failure).toMatchObject({reason: 'simulate_failed'});
  });
});

describe('decimalToCents', () => {
  it('converts a whole-unit amount', () => {
    expect(decimalToCents('100', 'floor')).toBe(10000);
  });

  it('floors a long-tail decimal instead of rounding it up', () => {
    expect(decimalToCents('19.620062792064687229069147940', 'floor')).toBe(1962);
    expect(decimalToCents('19.629999999', 'floor')).toBe(1962);
  });

  it('rounds a fee up so the quoted fee is never understated', () => {
    expect(decimalToCents('0.20', 'ceil')).toBe(20);
    expect(decimalToCents('0.201', 'ceil')).toBe(21);
    expect(decimalToCents('0.02', 'ceil')).toBe(2);
  });

  it('handles a bare fraction and a missing fraction alike', () => {
    expect(decimalToCents('0.5', 'floor')).toBe(50);
    expect(decimalToCents('7', 'ceil')).toBe(700);
  });

  it('throws on a value that is not a non-negative decimal string', () => {
    expect(() => decimalToCents('-1.00', 'floor')).toThrow();
    expect(() => decimalToCents('abc', 'floor')).toThrow();
    expect(() => decimalToCents('', 'floor')).toThrow();
  });
});
