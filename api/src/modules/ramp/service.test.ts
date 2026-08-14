import {AssetRegistry, type OnboardingStartRequest, type PixDetailsRequest} from '@paltalabs/shared';
import {Keypair, Networks, Transaction} from '@stellar/stellar-sdk';
import {describe, expect, it} from 'vitest';
import {StellarAccountNotFoundError, type StellarAccount, type StellarGateway} from '../../lib/stellar-gateway.js';
import type {
  KycLaunch,
  OfframpAnchorDetails,
  OnrampOrderState,
  OrderState,
  RampKycStatus,
  RampProvider,
  RampQuote
} from './provider.js';
import {RampProviderError} from './provider.js';
import {
  centsToDecimal,
  createRampService,
  type IntentRecord,
  type MerchantRecord,
  type RampCustomerRecord,
  type RampRepo
} from './service.js';

const KYC_RETURN_URL = 'http://localhost:5173/ramp/kyc-return';

// Mirrors payments/service.test.ts's and vault/service.test.ts's local
// registry construction (a fresh AssetRegistry, not the production
// TESTNET_REGISTRY) — ISSUER is a throwaway random keypair, valid-shaped but
// not a real testnet asset issuer.
const ISSUER = Keypair.random().publicKey();
const REGISTRY = new AssetRegistry([{code: 'USDC', issuer: ISSUER, decimals: 7}]);

const START_REQUEST: OnboardingStartRequest = {displayName: 'Ada Lovelace', email: 'ada@example.com'};

const PIX_DETAILS: PixDetailsRequest = {
  firstName: 'Ada',
  lastName: 'Lovelace',
  cpf: '12345678909',
  pixKey: 'ada@example.com',
  pixKeyType: 'email'
};

const LAUNCH: KycLaunch = {
  actionUrl: 'https://sandbox.etherfuse.com/auth/launch',
  assertion: 'header.payload.signature',
  target: '/idv'
};

const QUOTE: RampQuote = {
  quoteId: 'quo_abc123',
  expiresAt: 1785769762823,
  senderAmountCents: 10000,
  receiverAmountCents: 1962,
  flatFeeCents: 20,
  commercialQuotation: 0.1959394590264675
};

const ORDER_STATE: OnrampOrderState = {
  orderId: 'order-from-provider',
  deposit: {depositAmount: '100.00', depositBankName: 'PIX', depositAccountHolder: 'Etherfuse'}
};

// Verbatim from docs/evidence/etherfuse-sandbox-findings.md's "## Anchor
// order" section (live-verified: the base64 decodes to exactly 32 bytes).
const ANCHOR_DETAILS: OfframpAnchorDetails = {
  orderId: 'order-from-provider',
  withdrawAnchorAccount: 'GCUX6U4F5675FBA5LSVFCL7HGMRTMTXB4U2WSM5ZLUE4ORIHS6XNXY3X',
  withdrawMemoBase64: '2j2eY+8NQxyVF8GhRcECewAAAAAAAAAAAAAAAAAAAAA=',
  withdrawMemoType: 'hash'
};

const NETWORK_PASSPHRASE = Networks.TESTNET;

/**
 * Fake StellarGateway backed by a lookup table of publicKey -> account.
 * Absence rejects with `StellarAccountNotFoundError`, mirroring
 * `payments/service.test.ts`'s fake.
 */
function createFakeGateway(accounts: Record<string, StellarAccount> = {}): {gateway: StellarGateway; loadAccountCalls: string[]} {
  const loadAccountCalls: string[] = [];
  const gateway: StellarGateway = {
    async loadAccount(publicKey) {
      loadAccountCalls.push(publicKey);
      const account = accounts[publicKey];
      if (!account) throw new StellarAccountNotFoundError(publicKey);
      return account;
    },
    async submitTransaction() {
      throw new Error('unused in ramp service.test.ts: no test here submits a transaction');
    },
    async listPayments() {
      throw new Error('unused in ramp service.test.ts: no test here polls Horizon payments');
    }
  };
  return {gateway, loadAccountCalls};
}

function fakeAccount(publicKey: string, sequence = '100'): StellarAccount {
  return {
    accountId: () => publicKey,
    sequenceNumber: () => sequence,
    incrementSequenceNumber: () => {},
    balances: []
  };
}

interface FakeRepoHandle {
  repo: RampRepo;
  merchants: Map<string, MerchantRecord>;
  rampCustomers: Map<string, RampCustomerRecord>;
  activities: Array<{
    id: string;
    stellarAddress: string;
    externalRef: string;
    type: 'on_ramp';
    direction: 'in';
    amount: string;
    assetCode: string;
    assetIssuer: string;
  }>;
  insertedCustomerIds: string[];
  payoutIntents: IntentRecord[];
  payoutActivities: Array<{
    stellarAddress: string;
    externalRef: string;
    amount: string;
    assetCode: string;
    assetIssuer: string;
    counterparty: string;
  }>;
}

/**
 * In-memory fake of the ramp module's persistence boundary, mirroring
 * vault/service.test.ts's createFakeRepo. `onInsert` lets a test model the
 * concurrent-insert race (the losing call's own customerId never lands).
 */
function createFakeRepo(opts: {onInsert?: (privyDid: string, customerId: string) => string} = {}): FakeRepoHandle {
  const merchants = new Map<string, MerchantRecord>();
  const rampCustomers = new Map<string, RampCustomerRecord>();
  const activities: FakeRepoHandle['activities'] = [];
  const insertedCustomerIds: string[] = [];
  const payoutIntents: IntentRecord[] = [];
  const payoutActivities: FakeRepoHandle['payoutActivities'] = [];
  let nextActivityId = 1;
  let nextIntentId = 1;

  const repo: RampRepo = {
    async getMerchant(privyDid) {
      return merchants.get(privyDid);
    },
    async getRampCustomer(privyDid) {
      return rampCustomers.get(privyDid);
    },
    async insertRampCustomer({privyDid, customerId}) {
      insertedCustomerIds.push(customerId);
      const winner = opts.onInsert ? opts.onInsert(privyDid, customerId) : customerId;
      if (rampCustomers.has(privyDid)) return; // ON CONFLICT DO NOTHING
      rampCustomers.set(privyDid, {
        privyDid,
        provider: 'etherfuse',
        customerId: winner,
        blockchainWalletId: null,
        bankAccountId: null,
        createdAt: new Date(),
        updatedAt: new Date()
      });
    },
    async setWalletId(privyDid, walletId) {
      const row = rampCustomers.get(privyDid);
      if (!row) throw new Error(`no ramp_customers row for privyDid=${privyDid}`);
      rampCustomers.set(privyDid, {...row, blockchainWalletId: walletId, updatedAt: new Date()});
    },
    async setBankAccountId(privyDid, bankAccountId) {
      const row = rampCustomers.get(privyDid);
      if (!row) throw new Error(`no ramp_customers row for privyDid=${privyDid}`);
      rampCustomers.set(privyDid, {...row, bankAccountId, updatedAt: new Date()});
    },
    async recordPendingActivity(input) {
      activities.push({id: `activity-${nextActivityId++}`, ...input});
    },
    async findActivityByExternalRef(stellarAddress, externalRef) {
      return activities.find((row) => row.stellarAddress === stellarAddress && row.externalRef === externalRef);
    },
    async createPayoutIntent({privyDid, xdr, hashHex, metadata}) {
      const row: IntentRecord = {
        id: `payout-intent-${nextIntentId++}`,
        privyDid,
        kind: 'payout',
        xdr,
        hashHex,
        status: 'pending',
        resultTxHash: null,
        error: null,
        metadata,
        createdAt: new Date(),
        updatedAt: new Date()
      };
      payoutIntents.push(row);
      return row;
    },
    async recordPendingPayoutActivity(input) {
      payoutActivities.push(input);
    }
  };

  return {repo, merchants, rampCustomers, activities, insertedCustomerIds, payoutIntents, payoutActivities};
}

function seedMerchant(
  merchants: Map<string, MerchantRecord>,
  privyDid: string,
  opts: {stellarAddress?: string; provisioned?: boolean} = {}
): void {
  merchants.set(privyDid, {
    privyDid,
    privyWalletId: 'wallet-1',
    stellarAddress: opts.stellarAddress ?? Keypair.random().publicKey(),
    provisionedAt: opts.provisioned === false ? null : new Date(),
    createdAt: new Date()
  });
}

function seedRampCustomer(
  rampCustomers: Map<string, RampCustomerRecord>,
  privyDid: string,
  overrides: Partial<RampCustomerRecord> = {}
): void {
  rampCustomers.set(privyDid, {
    privyDid,
    provider: 'etherfuse',
    customerId: 'cust-1',
    blockchainWalletId: null,
    bankAccountId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides
  });
}

/** A ready (both ids set) ramp_customers row — the shared fixture every payin test seeds. */
function seedReadyRampCustomer(rampCustomers: Map<string, RampCustomerRecord>, privyDid: string): void {
  seedRampCustomer(rampCustomers, privyDid, {blockchainWalletId: 'wallet-1', bankAccountId: 'bank-1'});
}

interface FakeProviderHandle {
  provider: RampProvider;
  createOrganizationCalls: Array<{customerId: string; displayName: string; email: string}>;
  getKycStatusCalls: string[];
  buildKycLaunchCalls: Array<{customerId: string; userInfo: {email: string; displayName: string}}>;
  registerBankAccountCalls: Array<{customerId: string; input: Record<string, string>}>;
  registerWalletCalls: Array<{customerId: string; publicKey: string}>;
  createOnrampQuoteCalls: Array<{customerId: string; walletAddress: string; amountBrl: string}>;
  createOnrampOrderCalls: Array<{orderId: string; quoteId: string; bankAccountId: string; cryptoWalletId: string}>;
  createOfframpQuoteCalls: Array<{customerId: string; walletAddress: string; amountToken: string}>;
  createAnchorOfframpOrderCalls: Array<{orderId: string; quoteId: string; bankAccountId: string; cryptoWalletId: string}>;
  getOrderCalls: string[];
  simulateFiatReceivedCalls: string[];
}

/** Fake RampProvider — records calls, returns programmed results, or throws a programmed error. */
function createFakeProvider(
  opts: {
    createOrganization?: Error;
    getKycStatus?: RampKycStatus | Error;
    registerBankAccount?: {bankAccountId: string} | Error;
    registerWallet?: {walletId: string} | Error;
    createOnrampQuote?: RampQuote | Error;
    createOnrampOrder?: OnrampOrderState | Error;
    createOfframpQuote?: RampQuote | Error;
    createAnchorOfframpOrder?: OfframpAnchorDetails | Error;
    getOrder?: OrderState | Error;
    simulateFiatReceived?: Error;
  } = {}
): FakeProviderHandle {
  const handle: Omit<FakeProviderHandle, 'provider'> = {
    createOrganizationCalls: [],
    getKycStatusCalls: [],
    buildKycLaunchCalls: [],
    registerBankAccountCalls: [],
    registerWalletCalls: [],
    createOnrampQuoteCalls: [],
    createOnrampOrderCalls: [],
    createOfframpQuoteCalls: [],
    createAnchorOfframpOrderCalls: [],
    getOrderCalls: [],
    simulateFiatReceivedCalls: []
  };

  const provider: RampProvider = {
    async createOrganization(input) {
      handle.createOrganizationCalls.push(input);
      if (opts.createOrganization) throw opts.createOrganization;
    },
    async getKycStatus(customerId) {
      handle.getKycStatusCalls.push(customerId);
      if (opts.getKycStatus instanceof Error) throw opts.getKycStatus;
      return opts.getKycStatus ?? 'not_started';
    },
    buildKycLaunch(customerId, userInfo) {
      handle.buildKycLaunchCalls.push({customerId, userInfo});
      return LAUNCH;
    },
    async registerBankAccount(customerId, input) {
      handle.registerBankAccountCalls.push({customerId, input});
      if (opts.registerBankAccount instanceof Error) throw opts.registerBankAccount;
      return opts.registerBankAccount ?? {bankAccountId: 'bank-1'};
    },
    async registerWallet(customerId, publicKey) {
      handle.registerWalletCalls.push({customerId, publicKey});
      if (opts.registerWallet instanceof Error) throw opts.registerWallet;
      return opts.registerWallet ?? {walletId: 'wallet-1'};
    },
    async createOnrampQuote(input) {
      handle.createOnrampQuoteCalls.push(input);
      if (opts.createOnrampQuote instanceof Error) throw opts.createOnrampQuote;
      return opts.createOnrampQuote ?? QUOTE;
    },
    async createOfframpQuote(input) {
      handle.createOfframpQuoteCalls.push(input);
      if (opts.createOfframpQuote instanceof Error) throw opts.createOfframpQuote;
      return opts.createOfframpQuote ?? QUOTE;
    },
    async createOnrampOrder(input) {
      handle.createOnrampOrderCalls.push(input);
      if (opts.createOnrampOrder instanceof Error) throw opts.createOnrampOrder;
      return opts.createOnrampOrder ?? {...ORDER_STATE, orderId: input.orderId};
    },
    async createAnchorOfframpOrder(input) {
      handle.createAnchorOfframpOrderCalls.push(input);
      if (opts.createAnchorOfframpOrder instanceof Error) throw opts.createAnchorOfframpOrder;
      return opts.createAnchorOfframpOrder ?? {...ANCHOR_DETAILS, orderId: input.orderId};
    },
    async getOrder(orderId) {
      handle.getOrderCalls.push(orderId);
      if (opts.getOrder instanceof Error) throw opts.getOrder;
      return opts.getOrder ?? {orderId, status: 'funded', txHash: null, amountTokens: null};
    },
    async simulateFiatReceived(orderId) {
      handle.simulateFiatReceivedCalls.push(orderId);
      if (opts.simulateFiatReceived) throw opts.simulateFiatReceived;
    }
  };

  return {...handle, provider};
}

function makeService(
  repo: RampRepo,
  provider: RampProvider,
  networkName: 'testnet' | 'mainnet' = 'testnet',
  gateway: StellarGateway = createFakeGateway().gateway
) {
  return createRampService({
    repo,
    provider,
    kycReturnUrl: KYC_RETURN_URL,
    registry: REGISTRY,
    assetCode: 'USDC',
    networkName,
    gateway,
    networkPassphrase: NETWORK_PASSPHRASE
  });
}

describe('createRampService.onboardingStatus', () => {
  it('returns not_started when no ramp_customers row exists, without asking the provider', async () => {
    const {repo} = createFakeRepo();
    const {provider, getKycStatusCalls} = createFakeProvider();

    await expect(makeService(repo, provider).onboardingStatus('did:privy:merchant')).resolves.toEqual({status: 'not_started'});
    expect(getKycStatusCalls).toHaveLength(0);
  });

  it('returns verifying while the live KYC status is anything other than approved', async () => {
    const {repo, rampCustomers} = createFakeRepo();
    seedRampCustomer(rampCustomers, 'did:privy:merchant');
    const {provider, getKycStatusCalls} = createFakeProvider({getKycStatus: 'in_progress'});

    await expect(makeService(repo, provider).onboardingStatus('did:privy:merchant')).resolves.toEqual({status: 'verifying'});
    expect(getKycStatusCalls).toEqual(['cust-1']);
  });

  it('returns incomplete once KYC is approved but the bank account or wallet is still missing', async () => {
    const {repo, rampCustomers} = createFakeRepo();
    seedRampCustomer(rampCustomers, 'did:privy:merchant', {bankAccountId: 'bank-1'});
    const {provider} = createFakeProvider({getKycStatus: 'approved'});

    await expect(makeService(repo, provider).onboardingStatus('did:privy:merchant')).resolves.toEqual({status: 'incomplete'});
  });

  it('returns ready when both ids are set, WITHOUT a live KYC call', async () => {
    const {repo, rampCustomers} = createFakeRepo();
    seedReadyRampCustomer(rampCustomers, 'did:privy:merchant');
    const {provider, getKycStatusCalls} = createFakeProvider({getKycStatus: 'approved'});

    await expect(makeService(repo, provider).onboardingStatus('did:privy:merchant')).resolves.toEqual({status: 'ready'});
    expect(getKycStatusCalls).toHaveLength(0);
  });

  it('maps a RampProviderError from getKycStatus to a 502 AppError carrying its reason', async () => {
    const {repo, rampCustomers} = createFakeRepo();
    seedRampCustomer(rampCustomers, 'did:privy:merchant');
    const {provider} = createFakeProvider({getKycStatus: new RampProviderError('kyc_fetch_failed', 'boom')});

    const failure = await makeService(repo, provider).onboardingStatus('did:privy:merchant').catch((e: unknown) => e);

    expect(failure).toMatchObject({code: 'ramp_provider_error', statusCode: 502, details: {reason: 'kyc_fetch_failed'}});
  });
});

describe('createRampService.startOnboarding', () => {
  it('throws AppError("merchant_not_found", 404) when the caller has never provisioned', async () => {
    const {repo} = createFakeRepo();
    const {provider} = createFakeProvider();

    await expect(makeService(repo, provider).startOnboarding('did:privy:unknown', START_REQUEST)).rejects.toMatchObject({
      code: 'merchant_not_found',
      statusCode: 404
    });
  });

  it('throws AppError("merchant_not_provisioned", 409) when the merchant row has no provisionedAt', async () => {
    const {repo, merchants} = createFakeRepo();
    seedMerchant(merchants, 'did:privy:pending', {provisioned: false});
    const {provider} = createFakeProvider();

    await expect(makeService(repo, provider).startOnboarding('did:privy:pending', START_REQUEST)).rejects.toMatchObject({
      code: 'merchant_not_provisioned',
      statusCode: 409
    });
  });

  it('creates the Etherfuse organization with a generated customerId, persists it, and returns the launch params', async () => {
    const {repo, merchants, rampCustomers, insertedCustomerIds} = createFakeRepo();
    seedMerchant(merchants, 'did:privy:merchant');
    const {provider, createOrganizationCalls, buildKycLaunchCalls} = createFakeProvider();

    const result = await makeService(repo, provider).startOnboarding('did:privy:merchant', START_REQUEST);

    expect(createOrganizationCalls).toHaveLength(1);
    const customerId = createOrganizationCalls[0]!.customerId;
    expect(typeof customerId).toBe('string');
    expect(createOrganizationCalls[0]).toEqual({customerId, displayName: 'Ada Lovelace', email: 'ada@example.com'});
    expect(insertedCustomerIds).toEqual([customerId]);
    expect(rampCustomers.get('did:privy:merchant')).toMatchObject({customerId, provider: 'etherfuse'});
    expect(buildKycLaunchCalls).toEqual([
      {customerId, userInfo: {email: 'ada@example.com', displayName: 'Ada Lovelace'}}
    ]);
    expect(result).toEqual({launch: {...LAUNCH, returnUrl: KYC_RETURN_URL}});
  });

  it('is idempotent: an existing row skips organization creation and just returns a fresh launch', async () => {
    const {repo, merchants, rampCustomers} = createFakeRepo();
    seedMerchant(merchants, 'did:privy:merchant');
    seedRampCustomer(rampCustomers, 'did:privy:merchant', {customerId: 'cust-existing'});
    const {provider, createOrganizationCalls, buildKycLaunchCalls} = createFakeProvider();

    const result = await makeService(repo, provider).startOnboarding('did:privy:merchant', START_REQUEST);

    expect(createOrganizationCalls).toHaveLength(0);
    expect(buildKycLaunchCalls[0]!.customerId).toBe('cust-existing');
    expect(result.launch.returnUrl).toBe(KYC_RETURN_URL);
  });

  it("a losing concurrent call builds the launch on the WINNER's customerId instead of its own orphaned organization", async () => {
    // Models the real repo's ON CONFLICT DO NOTHING: by the time this call's
    // insert runs, a concurrent request has already committed its own row.
    const {repo, merchants, rampCustomers} = createFakeRepo({
      onInsert: (privyDid) => {
        seedRampCustomer(rampCustomers, privyDid, {customerId: 'cust-winner'});
        return 'cust-winner';
      }
    });
    seedMerchant(merchants, 'did:privy:merchant');
    const {provider, createOrganizationCalls, buildKycLaunchCalls} = createFakeProvider();

    const result = await makeService(repo, provider).startOnboarding('did:privy:merchant', START_REQUEST);

    // The loser's own organization was still created provider-side (the
    // accepted orphan) ...
    expect(createOrganizationCalls).toHaveLength(1);
    expect(createOrganizationCalls[0]!.customerId).not.toBe('cust-winner');
    // ... but the launch — and every later step — runs on the winner's id.
    expect(buildKycLaunchCalls[0]!.customerId).toBe('cust-winner');
    expect(rampCustomers.get('did:privy:merchant')!.customerId).toBe('cust-winner');
    expect(result.launch.assertion).toBe(LAUNCH.assertion);
  });

  it('maps a RampProviderError from createOrganization to a 502 AppError carrying its reason', async () => {
    const {repo, merchants, rampCustomers} = createFakeRepo();
    seedMerchant(merchants, 'did:privy:merchant');
    const {provider} = createFakeProvider({
      createOrganization: new RampProviderError('organization_creation_failed', 'boom')
    });

    const failure = await makeService(repo, provider).startOnboarding('did:privy:merchant', START_REQUEST).catch((e: unknown) => e);

    expect(failure).toMatchObject({
      code: 'ramp_provider_error',
      statusCode: 502,
      details: {reason: 'organization_creation_failed'}
    });
    expect(rampCustomers.has('did:privy:merchant')).toBe(false);
  });
});

describe('createRampService.kycLaunch', () => {
  it('throws AppError("ramp_not_started", 404) when there is no ramp_customers row', async () => {
    const {repo} = createFakeRepo();
    const {provider} = createFakeProvider();

    await expect(makeService(repo, provider).kycLaunch('did:privy:merchant', START_REQUEST)).rejects.toMatchObject({
      code: 'ramp_not_started',
      statusCode: 404
    });
  });

  it("returns fresh launch params for the row's customerId and the caller-supplied identity", async () => {
    const {repo, rampCustomers} = createFakeRepo();
    seedRampCustomer(rampCustomers, 'did:privy:merchant', {customerId: 'cust-existing'});
    const {provider, buildKycLaunchCalls} = createFakeProvider();

    const result = await makeService(repo, provider).kycLaunch('did:privy:merchant', START_REQUEST);

    expect(buildKycLaunchCalls).toEqual([
      {customerId: 'cust-existing', userInfo: {email: 'ada@example.com', displayName: 'Ada Lovelace'}}
    ]);
    expect(result).toEqual({launch: {...LAUNCH, returnUrl: KYC_RETURN_URL}});
  });
});

describe('createRampService.completeSetup', () => {
  it('throws AppError("ramp_not_started", 404) when there is no ramp_customers row', async () => {
    const {repo} = createFakeRepo();
    const {provider} = createFakeProvider();

    await expect(makeService(repo, provider).completeSetup('did:privy:merchant', PIX_DETAILS)).rejects.toMatchObject({
      code: 'ramp_not_started',
      statusCode: 404
    });
  });

  it('throws AppError("kyc_not_approved", 409) until the live KYC status is approved, without touching registration', async () => {
    const {repo, merchants, rampCustomers} = createFakeRepo();
    seedMerchant(merchants, 'did:privy:merchant');
    seedRampCustomer(rampCustomers, 'did:privy:merchant');
    const {provider, registerBankAccountCalls} = createFakeProvider({getKycStatus: 'submitted'});

    await expect(makeService(repo, provider).completeSetup('did:privy:merchant', PIX_DETAILS)).rejects.toMatchObject({
      code: 'kyc_not_approved',
      statusCode: 409
    });
    expect(registerBankAccountCalls).toHaveLength(0);
  });

  it('registers the bank account then the wallet, persisting each id as it lands, and reports ready', async () => {
    const merchant = Keypair.random();
    const {repo, merchants, rampCustomers} = createFakeRepo();
    seedMerchant(merchants, 'did:privy:merchant', {stellarAddress: merchant.publicKey()});
    seedRampCustomer(rampCustomers, 'did:privy:merchant');
    const {provider, registerBankAccountCalls, registerWalletCalls} = createFakeProvider({
      getKycStatus: 'approved',
      registerBankAccount: {bankAccountId: 'bank-42'},
      registerWallet: {walletId: 'wallet-42'}
    });

    const result = await makeService(repo, provider).completeSetup('did:privy:merchant', PIX_DETAILS);

    expect(result).toEqual({status: 'ready'});
    expect(registerBankAccountCalls).toHaveLength(1);
    expect(registerBankAccountCalls[0]!.customerId).toBe('cust-1');
    // transactionId is a server-generated idempotency UUID, not client input.
    expect(typeof registerBankAccountCalls[0]!.input.transactionId).toBe('string');
    expect(registerBankAccountCalls[0]!.input).toMatchObject(PIX_DETAILS);
    expect(registerWalletCalls).toEqual([{customerId: 'cust-1', publicKey: merchant.publicKey()}]);
    expect(rampCustomers.get('did:privy:merchant')).toMatchObject({bankAccountId: 'bank-42', blockchainWalletId: 'wallet-42'});
  });

  it('is resumable: after a wallet-registration failure the retry keeps the persisted bank account and only registers the wallet', async () => {
    const merchant = Keypair.random();
    const {repo, merchants, rampCustomers} = createFakeRepo();
    seedMerchant(merchants, 'did:privy:merchant', {stellarAddress: merchant.publicKey()});
    seedRampCustomer(rampCustomers, 'did:privy:merchant');
    const failing = createFakeProvider({
      getKycStatus: 'approved',
      registerBankAccount: {bankAccountId: 'bank-42'},
      registerWallet: new RampProviderError('wallet_registration_failed', 'boom')
    });

    await expect(makeService(repo, failing.provider).completeSetup('did:privy:merchant', PIX_DETAILS)).rejects.toMatchObject({
      code: 'ramp_provider_error',
      details: {reason: 'wallet_registration_failed'}
    });
    expect(rampCustomers.get('did:privy:merchant')).toMatchObject({bankAccountId: 'bank-42', blockchainWalletId: null});

    const retry = createFakeProvider({getKycStatus: 'approved', registerWallet: {walletId: 'wallet-42'}});
    const result = await makeService(repo, retry.provider).completeSetup('did:privy:merchant', PIX_DETAILS);

    expect(result).toEqual({status: 'ready'});
    expect(retry.registerBankAccountCalls).toHaveLength(0); // NOT registered again
    expect(retry.registerWalletCalls).toEqual([{customerId: 'cust-1', publicKey: merchant.publicKey()}]);
  });

  it('maps a RampProviderError from registerBankAccount to a 502 AppError carrying its reason', async () => {
    const {repo, merchants, rampCustomers} = createFakeRepo();
    seedMerchant(merchants, 'did:privy:merchant');
    seedRampCustomer(rampCustomers, 'did:privy:merchant');
    const {provider} = createFakeProvider({
      getKycStatus: 'approved',
      registerBankAccount: new RampProviderError('bank_account_registration_failed', 'boom')
    });

    const failure = await makeService(repo, provider).completeSetup('did:privy:merchant', PIX_DETAILS).catch((e: unknown) => e);

    expect(failure).toMatchObject({
      code: 'ramp_provider_error',
      statusCode: 502,
      details: {reason: 'bank_account_registration_failed'}
    });
  });
});

describe('createRampService.payinQuote', () => {
  it('throws AppError("ramp_not_onboarded", 409) when there is no ramp_customers row', async () => {
    const {repo} = createFakeRepo();
    const {provider} = createFakeProvider();

    await expect(makeService(repo, provider).payinQuote('did:privy:merchant', {amountBrlCents: 10000})).rejects.toMatchObject({
      code: 'ramp_not_onboarded',
      statusCode: 409,
      message: 'complete POST /ramp/onboarding first'
    });
  });

  it('throws AppError("ramp_not_onboarded", 409) when the row is missing bankAccountId', async () => {
    const {repo, rampCustomers} = createFakeRepo();
    seedRampCustomer(rampCustomers, 'did:privy:merchant', {blockchainWalletId: 'wallet-1'});
    const {provider} = createFakeProvider();

    await expect(makeService(repo, provider).payinQuote('did:privy:merchant', {amountBrlCents: 10000})).rejects.toMatchObject({
      code: 'ramp_not_onboarded',
      statusCode: 409
    });
  });

  it("quotes with the row's customerId, the merchant's own address, and the cents→decimal BRL amount", async () => {
    const merchant = Keypair.random();
    const {repo, merchants, rampCustomers} = createFakeRepo();
    seedMerchant(merchants, 'did:privy:merchant', {stellarAddress: merchant.publicKey()});
    seedReadyRampCustomer(rampCustomers, 'did:privy:merchant');
    const {provider, createOnrampQuoteCalls} = createFakeProvider();

    const result = await makeService(repo, provider).payinQuote('did:privy:merchant', {amountBrlCents: 10000});

    expect(createOnrampQuoteCalls).toEqual([
      {customerId: 'cust-1', walletAddress: merchant.publicKey(), amountBrl: '100.00'}
    ]);
    expect(result).toEqual(QUOTE);
  });

  it('maps a RampProviderError to a 502 AppError carrying its reason', async () => {
    const {repo, merchants, rampCustomers} = createFakeRepo();
    seedMerchant(merchants, 'did:privy:merchant');
    seedReadyRampCustomer(rampCustomers, 'did:privy:merchant');
    const {provider} = createFakeProvider({createOnrampQuote: new RampProviderError('quote_rejected', 'boom')});

    const failure = await makeService(repo, provider).payinQuote('did:privy:merchant', {amountBrlCents: 10000}).catch((e: unknown) => e);

    expect(failure).toMatchObject({code: 'ramp_provider_error', statusCode: 502, details: {reason: 'quote_rejected'}});
  });
});

describe('createRampService.createPayin', () => {
  it('throws AppError("ramp_not_onboarded", 409) when the ramp_customers row is not ready', async () => {
    const {repo} = createFakeRepo();
    const {provider} = createFakeProvider();

    await expect(
      makeService(repo, provider).createPayin('did:privy:merchant', {quoteId: 'quo_abc123', amountCents: 1962})
    ).rejects.toMatchObject({
      code: 'ramp_not_onboarded',
      statusCode: 409
    });
  });

  it('creates the order with a generated orderId, writes a pending on_ramp activity row using the CLIENT-echoed amountCents, and returns the deposit instructions', async () => {
    const merchant = Keypair.random();
    const {repo, merchants, rampCustomers, activities} = createFakeRepo();
    seedMerchant(merchants, 'did:privy:merchant', {stellarAddress: merchant.publicKey()});
    seedReadyRampCustomer(rampCustomers, 'did:privy:merchant');
    const {provider, createOnrampOrderCalls} = createFakeProvider();

    const result = await makeService(repo, provider).createPayin('did:privy:merchant', {
      quoteId: 'quo_abc123',
      amountCents: 1962
    });

    expect(createOnrampOrderCalls).toHaveLength(1);
    const orderId = createOnrampOrderCalls[0]!.orderId;
    expect(typeof orderId).toBe('string');
    expect(createOnrampOrderCalls[0]).toEqual({
      orderId,
      quoteId: 'quo_abc123',
      bankAccountId: 'bank-1',
      cryptoWalletId: 'wallet-1'
    });
    // status is always 'created' — the provider's create response carries no
    // status, and receiverAmountCents is the client's OWN echoed amountCents,
    // not anything derived from the (now status/amount-free) provider result.
    expect(result).toEqual({
      orderId,
      status: 'created',
      deposit: ORDER_STATE.deposit,
      receiverAmountCents: 1962
    });
    expect(activities).toEqual([
      {
        id: 'activity-1',
        stellarAddress: merchant.publicKey(),
        externalRef: `order:${orderId}`,
        type: 'on_ramp',
        direction: 'in',
        amount: '19.62',
        assetCode: 'USDC',
        assetIssuer: ISSUER
      }
    ]);
  });

  it('maps a RampProviderError from the order call to a 502 AppError and writes no activity row', async () => {
    const {repo, merchants, rampCustomers, activities} = createFakeRepo();
    seedMerchant(merchants, 'did:privy:merchant');
    seedReadyRampCustomer(rampCustomers, 'did:privy:merchant');
    const {provider} = createFakeProvider({createOnrampOrder: new RampProviderError('order_rejected', 'boom')});

    const failure = await makeService(repo, provider)
      .createPayin('did:privy:merchant', {quoteId: 'quo_abc123', amountCents: 1962})
      .catch((e: unknown) => e);

    expect(failure).toMatchObject({code: 'ramp_provider_error', statusCode: 502, details: {reason: 'order_rejected'}});
    expect(activities).toHaveLength(0);
  });
});

describe('createRampService.getPayinState', () => {
  it('throws AppError("order_not_found", 404) when no activity row of the caller\'s own carries that order ref', async () => {
    const {repo, merchants} = createFakeRepo();
    seedMerchant(merchants, 'did:privy:merchant');
    const {provider, getOrderCalls} = createFakeProvider();

    await expect(makeService(repo, provider).getPayinState('did:privy:merchant', 'someone-elses-order')).rejects.toMatchObject({
      code: 'order_not_found',
      statusCode: 404
    });
    expect(getOrderCalls).toHaveLength(0);
  });

  it('returns the provider state for an order the caller owns', async () => {
    const merchant = Keypair.random();
    const {repo, merchants, rampCustomers} = createFakeRepo();
    seedMerchant(merchants, 'did:privy:merchant', {stellarAddress: merchant.publicKey()});
    seedReadyRampCustomer(rampCustomers, 'did:privy:merchant');
    const {provider, createOnrampOrderCalls, getOrderCalls} = createFakeProvider({
      getOrder: {orderId: 'ignored-echo', status: 'completed', txHash: null, amountTokens: null}
    });
    const service = makeService(repo, provider);
    await service.createPayin('did:privy:merchant', {quoteId: 'quo_abc123', amountCents: 1962});
    const orderId = createOnrampOrderCalls[0]!.orderId;

    const result = await service.getPayinState('did:privy:merchant', orderId);

    expect(getOrderCalls).toEqual([orderId]);
    expect(result).toEqual({orderId: 'ignored-echo', status: 'completed', txHash: null});
  });
});

describe('createRampService.simulatePayin', () => {
  it('throws AppError("not_found", 404) on mainnet before any ownership lookup or provider call', async () => {
    const {repo} = createFakeRepo();
    const {provider, simulateFiatReceivedCalls} = createFakeProvider();

    await expect(makeService(repo, provider, 'mainnet').simulatePayin('did:privy:merchant', 'order-1')).rejects.toMatchObject({
      code: 'not_found',
      statusCode: 404
    });
    expect(simulateFiatReceivedCalls).toHaveLength(0);
  });

  it('throws AppError("order_not_found", 404) on testnet when the caller does not own the order', async () => {
    const {repo, merchants} = createFakeRepo();
    seedMerchant(merchants, 'did:privy:merchant');
    const {provider, simulateFiatReceivedCalls} = createFakeProvider();

    await expect(makeService(repo, provider).simulatePayin('did:privy:merchant', 'order-1')).rejects.toMatchObject({
      code: 'order_not_found',
      statusCode: 404
    });
    expect(simulateFiatReceivedCalls).toHaveLength(0);
  });

  it('calls the sandbox simulator for an order the caller owns', async () => {
    const merchant = Keypair.random();
    const {repo, merchants, rampCustomers} = createFakeRepo();
    seedMerchant(merchants, 'did:privy:merchant', {stellarAddress: merchant.publicKey()});
    seedReadyRampCustomer(rampCustomers, 'did:privy:merchant');
    const {provider, createOnrampOrderCalls, simulateFiatReceivedCalls} = createFakeProvider();
    const service = makeService(repo, provider);
    await service.createPayin('did:privy:merchant', {quoteId: 'quo_abc123', amountCents: 1962});
    const orderId = createOnrampOrderCalls[0]!.orderId;

    await expect(service.simulatePayin('did:privy:merchant', orderId)).resolves.toBeUndefined();

    expect(simulateFiatReceivedCalls).toEqual([orderId]);
  });

  it('maps a RampProviderError from the simulator to a 502 AppError carrying its reason', async () => {
    const merchant = Keypair.random();
    const {repo, merchants, rampCustomers} = createFakeRepo();
    seedMerchant(merchants, 'did:privy:merchant', {stellarAddress: merchant.publicKey()});
    seedReadyRampCustomer(rampCustomers, 'did:privy:merchant');
    const {provider, createOnrampOrderCalls} = createFakeProvider({
      simulateFiatReceived: new RampProviderError('simulate_failed', 'boom')
    });
    const service = makeService(repo, provider);
    await service.createPayin('did:privy:merchant', {quoteId: 'quo_abc123', amountCents: 1962});

    const failure = await service.simulatePayin('did:privy:merchant', createOnrampOrderCalls[0]!.orderId).catch((e: unknown) => e);

    expect(failure).toMatchObject({code: 'ramp_provider_error', statusCode: 502, details: {reason: 'simulate_failed'}});
  });
});

describe('createRampService.payoutQuote', () => {
  it('throws AppError("ramp_not_onboarded", 409) when the ramp_customers row is not ready', async () => {
    const {repo} = createFakeRepo();
    const {provider} = createFakeProvider();

    await expect(makeService(repo, provider).payoutQuote('did:privy:merchant', {amountCents: 1000})).rejects.toMatchObject({
      code: 'ramp_not_onboarded',
      statusCode: 409
    });
  });

  it("quotes with the row's customerId, the merchant's own address, and the cents→decimal token amount", async () => {
    const merchant = Keypair.random();
    const {repo, merchants, rampCustomers} = createFakeRepo();
    seedMerchant(merchants, 'did:privy:merchant', {stellarAddress: merchant.publicKey()});
    seedReadyRampCustomer(rampCustomers, 'did:privy:merchant');
    const {provider, createOfframpQuoteCalls} = createFakeProvider();

    const result = await makeService(repo, provider).payoutQuote('did:privy:merchant', {amountCents: 1000});

    expect(createOfframpQuoteCalls).toEqual([{customerId: 'cust-1', walletAddress: merchant.publicKey(), amountToken: '10.00'}]);
    expect(result).toEqual(QUOTE);
  });

  it('maps a RampProviderError to a 502 AppError carrying its reason', async () => {
    const {repo, merchants, rampCustomers} = createFakeRepo();
    seedMerchant(merchants, 'did:privy:merchant');
    seedReadyRampCustomer(rampCustomers, 'did:privy:merchant');
    const {provider} = createFakeProvider({createOfframpQuote: new RampProviderError('quote_rejected', 'boom')});

    const failure = await makeService(repo, provider).payoutQuote('did:privy:merchant', {amountCents: 1000}).catch((e: unknown) => e);

    expect(failure).toMatchObject({code: 'ramp_provider_error', statusCode: 502, details: {reason: 'quote_rejected'}});
  });
});

describe('createRampService.createPayout', () => {
  it('throws AppError("ramp_not_onboarded", 409) when the ramp_customers row is not ready', async () => {
    const {repo} = createFakeRepo();
    const {provider} = createFakeProvider();

    await expect(
      makeService(repo, provider).createPayout('did:privy:merchant', {quoteId: 'quo_abc123', amountCents: 1000})
    ).rejects.toMatchObject({
      code: 'ramp_not_onboarded',
      statusCode: 409
    });
  });

  it('creates the anchor order, builds an unsigned payment tx to the anchor account with the hash memo, stores a "payout"-kind intent, and writes a pending off_ramp activity row', async () => {
    const merchant = Keypair.random();
    const {repo, merchants, rampCustomers, payoutIntents, payoutActivities} = createFakeRepo();
    seedMerchant(merchants, 'did:privy:merchant', {stellarAddress: merchant.publicKey()});
    seedReadyRampCustomer(rampCustomers, 'did:privy:merchant');
    const {gateway, loadAccountCalls} = createFakeGateway({[merchant.publicKey()]: fakeAccount(merchant.publicKey(), '100')});
    const {provider, createAnchorOfframpOrderCalls} = createFakeProvider();

    const result = await makeService(repo, provider, 'testnet', gateway).createPayout('did:privy:merchant', {
      quoteId: 'quo_abc123',
      amountCents: 1000
    });

    expect(createAnchorOfframpOrderCalls).toHaveLength(1);
    const orderId = createAnchorOfframpOrderCalls[0]!.orderId;
    expect(typeof orderId).toBe('string');
    expect(createAnchorOfframpOrderCalls[0]).toEqual({
      orderId,
      quoteId: 'quo_abc123',
      bankAccountId: 'bank-1',
      cryptoWalletId: 'wallet-1'
    });
    expect(loadAccountCalls).toEqual([merchant.publicKey()]);

    // Decode the stored, unsigned XDR and assert its real shape -- not a mock.
    const tx = new Transaction(result.xdr, NETWORK_PASSPHRASE);
    expect(tx.source).toBe(merchant.publicKey());
    expect(tx.signatures).toHaveLength(0);
    expect(tx.operations).toHaveLength(1);
    const op = tx.operations[0];
    if (op?.type !== 'payment') throw new Error('expected a payment operation');
    expect(op.destination).toBe(ANCHOR_DETAILS.withdrawAnchorAccount);
    expect(op.amount).toBe('10.0000000');
    expect(op.asset.code).toBe('USDC');
    expect(op.asset.issuer).toBe(ISSUER);
    expect(tx.memo.type).toBe('hash');
    expect(tx.memo.value).toEqual(Buffer.from(ANCHOR_DETAILS.withdrawMemoBase64, 'base64'));

    expect(payoutIntents).toEqual([
      {
        id: payoutIntents[0]!.id,
        privyDid: 'did:privy:merchant',
        kind: 'payout',
        xdr: result.xdr,
        hashHex: result.hashHex,
        status: 'pending',
        resultTxHash: null,
        error: null,
        metadata: {orderId, activityExternalRef: `order:${orderId}`},
        createdAt: payoutIntents[0]!.createdAt,
        updatedAt: payoutIntents[0]!.updatedAt
      }
    ]);
    expect(result).toEqual({intentId: payoutIntents[0]!.id, xdr: result.xdr, hashHex: result.hashHex});

    expect(payoutActivities).toEqual([
      {
        stellarAddress: merchant.publicKey(),
        externalRef: `order:${orderId}`,
        amount: '10.00',
        assetCode: 'USDC',
        assetIssuer: ISSUER,
        counterparty: ANCHOR_DETAILS.withdrawAnchorAccount
      }
    ]);
  });

  it('keys activityExternalRef/metadata.orderId off the LOCALLY-generated orderId, not a differing provider-echoed one -- nothing guarantees Etherfuse echoes back exactly what was sent', async () => {
    const merchant = Keypair.random();
    const {repo, merchants, rampCustomers, payoutIntents, payoutActivities} = createFakeRepo();
    seedMerchant(merchants, 'did:privy:merchant', {stellarAddress: merchant.publicKey()});
    seedReadyRampCustomer(rampCustomers, 'did:privy:merchant');
    const {gateway} = createFakeGateway({[merchant.publicKey()]: fakeAccount(merchant.publicKey(), '100')});
    // Deliberately returns a DIFFERENT orderId than whatever gets generated
    // and sent as input -- proves the service doesn't trust the echo.
    const {provider, createAnchorOfframpOrderCalls} = createFakeProvider({
      createAnchorOfframpOrder: {...ANCHOR_DETAILS, orderId: 'provider-echoed-different-order-id'}
    });

    const result = await makeService(repo, provider, 'testnet', gateway).createPayout('did:privy:merchant', {
      quoteId: 'quo_abc123',
      amountCents: 1000
    });

    const localOrderId = createAnchorOfframpOrderCalls[0]!.orderId;
    expect(localOrderId).not.toBe('provider-echoed-different-order-id');

    expect(payoutIntents[0]!.metadata).toEqual({
      orderId: localOrderId,
      activityExternalRef: `order:${localOrderId}`
    });
    expect(payoutActivities[0]!.externalRef).toBe(`order:${localOrderId}`);
    expect(result).toEqual({intentId: payoutIntents[0]!.id, xdr: result.xdr, hashHex: result.hashHex});
  });

  it('maps a RampProviderError from the anchor order call to a 502 AppError and writes no intent/activity row, never touching the gateway', async () => {
    const {repo, merchants, rampCustomers, payoutIntents, payoutActivities} = createFakeRepo();
    seedMerchant(merchants, 'did:privy:merchant');
    seedReadyRampCustomer(rampCustomers, 'did:privy:merchant');
    const {gateway, loadAccountCalls} = createFakeGateway();
    const {provider} = createFakeProvider({createAnchorOfframpOrder: new RampProviderError('order_rejected', 'boom')});

    const failure = await makeService(repo, provider, 'testnet', gateway)
      .createPayout('did:privy:merchant', {quoteId: 'quo_abc123', amountCents: 1000})
      .catch((e: unknown) => e);

    expect(failure).toMatchObject({code: 'ramp_provider_error', statusCode: 502, details: {reason: 'order_rejected'}});
    expect(payoutIntents).toHaveLength(0);
    expect(payoutActivities).toHaveLength(0);
    expect(loadAccountCalls).toHaveLength(0);
  });

  it('fails closed with a 502 when the anchor order memo does not decode to exactly 32 bytes, without ever touching the gateway', async () => {
    const {repo, merchants, rampCustomers, payoutIntents, payoutActivities} = createFakeRepo();
    seedMerchant(merchants, 'did:privy:merchant');
    seedReadyRampCustomer(rampCustomers, 'did:privy:merchant');
    const {gateway, loadAccountCalls} = createFakeGateway();
    const {provider} = createFakeProvider({
      createAnchorOfframpOrder: {...ANCHOR_DETAILS, withdrawMemoBase64: Buffer.from('too-short').toString('base64')}
    });

    const failure = await makeService(repo, provider, 'testnet', gateway)
      .createPayout('did:privy:merchant', {quoteId: 'quo_abc123', amountCents: 1000})
      .catch((e: unknown) => e);

    expect(failure).toMatchObject({code: 'ramp_provider_error', statusCode: 502, details: {reason: 'order_rejected'}});
    expect(payoutIntents).toHaveLength(0);
    expect(payoutActivities).toHaveLength(0);
    expect(loadAccountCalls).toHaveLength(0);
  });
});

describe('centsToDecimal', () => {
  it('converts 1949 cents to "19.49"', () => {
    expect(centsToDecimal(1949)).toBe('19.49');
  });

  it('converts 5 cents to "0.05"', () => {
    expect(centsToDecimal(5)).toBe('0.05');
  });

  it('converts 0 cents to "0.00"', () => {
    expect(centsToDecimal(0)).toBe('0.00');
  });

  it('converts a whole-unit amount (100 cents) to "1.00"', () => {
    expect(centsToDecimal(100)).toBe('1.00');
  });

  it('throws on a negative amount', () => {
    expect(() => centsToDecimal(-1)).toThrow();
  });

  it('throws on a non-integer amount', () => {
    expect(() => centsToDecimal(19.5)).toThrow();
  });
});
