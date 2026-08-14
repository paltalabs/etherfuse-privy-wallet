import {Account, BASE_FEE, FeeBumpTransaction, Keypair, Networks, Operation, Transaction, TransactionBuilder} from '@stellar/stellar-sdk';
import {describe, expect, it} from 'vitest';
import {txHashHex, wrapFeeBump} from '../sponsor/stellar.js';
import {StaleSequenceError, SubmissionFailedError} from '../sponsor/submit.js';
import {
  createIntentsService,
  type ActivityInput,
  type IntentRecord,
  type IntentSubmitter,
  type IntentsRepo,
  type MerchantRecord
} from './service.js';

const networkPassphrase = Networks.TESTNET;
const sponsor = Keypair.random();

function dummyOp() {
  return Operation.manageData({name: 'spike', value: 'v'});
}

/** Builds+sponsor-signs a fake provisioning-style intent tx (sponsor is the tx source). */
function buildProvisionXdr(): {xdr: string; hashHex: string} {
  const source = new Account(sponsor.publicKey(), '0');
  const tx = new TransactionBuilder(source, {fee: BASE_FEE, networkPassphrase})
    .addOperation(dummyOp())
    .setTimeout(300)
    .build();
  tx.sign(sponsor);
  return {xdr: tx.toXDR(), hashHex: txHashHex(tx)};
}

/** Builds a fake payment-style intent tx (merchant is the tx source, unsigned yet). */
function buildPaymentXdr(merchant: Keypair): {xdr: string; hashHex: string} {
  const source = new Account(merchant.publicKey(), '0');
  const tx = new TransactionBuilder(source, {fee: BASE_FEE, networkPassphrase})
    .addOperation(dummyOp())
    .setTimeout(300)
    .build();
  return {xdr: tx.toXDR(), hashHex: txHashHex(tx)};
}

/**
 * The fake `activity` table row shape: `ActivityInput` (what `recordActivity`
 * receives) plus fields a pre-existing pending row can carry that
 * `ActivityInput` itself doesn't (e.g. `counterparty`/`amount`, written at
 * intent-creation time by a producer like `payments/service.ts`) — kept
 * broader than `ActivityInput` specifically so the "update preserves
 * creation-time fields it doesn't know about" test below has something to
 * assert on. `status` is widened to also allow `'pending'`: `ActivityInput`
 * itself only ever carries `'confirmed' | 'failed'` (the only statuses this
 * module ever writes), but a real `activity` row can already be `'pending'`
 * before this module's `recordActivity` ever touches it.
 */
type FakeActivityRow = Omit<ActivityInput, 'status'> & {
  status: 'pending' | 'confirmed' | 'failed';
  counterparty?: string;
  amount?: string;
};

interface FakeState {
  repo: IntentsRepo;
  intents: Map<string, IntentRecord>;
  merchants: Map<string, MerchantRecord>;
  activity: FakeActivityRow[];
}

function createFakeState(): FakeState {
  const intents = new Map<string, IntentRecord>();
  const merchants = new Map<string, MerchantRecord>();
  const activity: FakeState['activity'] = [];

  const repo: IntentsRepo = {
    async getOwnedIntent(id, privyDid) {
      const row = intents.get(id);
      return row && row.privyDid === privyDid ? row : undefined;
    },
    async claimIntent(id, privyDid) {
      const row = intents.get(id);
      if (!row || row.privyDid !== privyDid || row.status !== 'pending') return undefined;
      row.status = 'submitting';
      row.updatedAt = new Date();
      return row;
    },
    async getMerchant(privyDid) {
      return merchants.get(privyDid);
    },
    async markSubmitted(id, resultTxHash) {
      const row = intents.get(id);
      if (row) {
        row.status = 'submitted';
        row.resultTxHash = resultTxHash;
      }
    },
    async markFailed(id, error) {
      const row = intents.get(id);
      if (row) {
        row.status = 'failed';
        row.error = error;
      }
    },
    async markMerchantProvisioned(privyDid) {
      const row = merchants.get(privyDid);
      if (row) row.provisionedAt = new Date();
    },
    async recordActivity(input) {
      // Mirrors createDrizzleIntentsRepo's upsert-by-externalRef semantics:
      // update a pre-existing row matching externalRef in place (preserving
      // any fields beyond ActivityInput, e.g. counterparty/amount) rather
      // than inserting a second row; insert only when none is found.
      const existing = activity.find((row) => row.externalRef === input.externalRef);
      if (existing) {
        existing.status = input.status;
        existing.txHash = input.txHash;
        return;
      }
      activity.push(input);
    },
    async updateActivityTxHash(externalRef, stellarAddress, txHash) {
      // Mirrors createDrizzleIntentsRepo's real WHERE (externalRef AND
      // stellarAddress) -- a no-op when no pending row exists (e.g. a
      // 'provision' intent).
      const existing = activity.find((row) => row.externalRef === externalRef && row.stellarAddress === stellarAddress);
      if (existing) existing.txHash = txHash;
    }
  };

  return {repo, intents, merchants, activity};
}

/** Seeds a pending activity row as if written at intent-creation time (e.g. by payments/service.ts). */
function seedPendingActivity(state: FakeState, row: FakeActivityRow): void {
  state.activity.push(row);
}

function seedMerchant(state: FakeState, privyDid: string, stellarAddress: string): void {
  state.merchants.set(privyDid, {
    privyDid,
    privyWalletId: 'wallet-1',
    stellarAddress,
    provisionedAt: null,
    createdAt: new Date()
  });
}

function seedIntent(
  state: FakeState,
  input: Partial<IntentRecord> & {id: string; privyDid: string; kind: IntentRecord['kind']; xdr: string; hashHex: string}
): IntentRecord {
  const row: IntentRecord = {
    status: 'pending',
    resultTxHash: null,
    error: null,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...input
  };
  state.intents.set(row.id, row);
  return row;
}

/**
 * Fake `IntentSubmitter` with test-programmable `buildSubmission`/`submit` --
 * deliberately decoupled from the real `sponsor/submit.ts` factories
 * (`createProvisionSubmitter`/`createPaymentSubmitter`, covered on their own
 * in `submit.test.ts`) so these tests exercise `complete()`'s OWN
 * routing/hashing/activity-stamping behavior against the `IntentSubmitter`
 * interface, not any particular kind's real submission logic. Records every
 * `submit` call's `built` tx and `ctx`, so tests can assert both which
 * submitter was invoked (proving kind-based routing) and what it received.
 */
function fakeSubmitter(params: {
  activityType: IntentSubmitter['activityType'];
  buildSubmission?: IntentSubmitter['buildSubmission'];
  submit: IntentSubmitter['submit'];
}): {
  submitter: IntentSubmitter;
  submitted: Array<Transaction | FeeBumpTransaction>;
  contexts: Array<{intent: IntentRecord; merchant: MerchantRecord}>;
} {
  const submitted: Array<Transaction | FeeBumpTransaction> = [];
  const contexts: Array<{intent: IntentRecord; merchant: MerchantRecord}> = [];
  return {
    submitted,
    contexts,
    submitter: {
      activityType: params.activityType,
      buildSubmission: params.buildSubmission ?? ((inner) => inner),
      async submit(built, ctx) {
        submitted.push(built);
        contexts.push(ctx);
        return params.submit(built, ctx);
      }
    }
  };
}

describe('createIntentsService.complete', () => {
  it('throws AppError("intent_not_found", 404) when the intent does not exist', async () => {
    const state = createFakeState();
    const service = createIntentsService({repo: state.repo, networkPassphrase, submitters: {}});

    await expect(service.complete('did:privy:someone', 'missing-id', '0x' + 'aa'.repeat(64))).rejects.toMatchObject({
      code: 'intent_not_found',
      statusCode: 404
    });
  });

  it('throws AppError("intent_not_found", 404) — not 403 — when the intent belongs to a different privyDid', async () => {
    const state = createFakeState();
    const merchant = Keypair.random();
    seedMerchant(state, 'did:privy:owner', merchant.publicKey());
    const {xdr, hashHex} = buildProvisionXdr();
    seedIntent(state, {id: 'intent-1', privyDid: 'did:privy:owner', kind: 'provision', xdr, hashHex});
    const service = createIntentsService({repo: state.repo, networkPassphrase, submitters: {}});

    await expect(
      service.complete('did:privy:attacker', 'intent-1', '0x' + 'aa'.repeat(64))
    ).rejects.toMatchObject({code: 'intent_not_found', statusCode: 404});
  });

  it('throws AppError("invalid_signature", 400) for a valid-but-wrong-key signature, leaving the intent pending', async () => {
    const state = createFakeState();
    const merchant = Keypair.random();
    const wrongKey = Keypair.random();
    seedMerchant(state, 'did:privy:owner', merchant.publicKey());
    const {xdr, hashHex} = buildProvisionXdr();
    seedIntent(state, {id: 'intent-1', privyDid: 'did:privy:owner', kind: 'provision', xdr, hashHex});
    const provision = fakeSubmitter({activityType: 'provision', submit: async () => ({txHash: 'unused'})});
    const service = createIntentsService({repo: state.repo, networkPassphrase, submitters: {provision: provision.submitter}});

    // Valid signature format, but signed by the WRONG key -- addSignature's
    // internal verification must reject it.
    const wrongHexSig = '0x' + wrongKey.sign(Buffer.from(hashHex.replace(/^0x/, ''), 'hex')).toString('hex');

    await expect(service.complete('did:privy:owner', 'intent-1', wrongHexSig)).rejects.toMatchObject({
      code: 'invalid_signature',
      statusCode: 400
    });
    expect(provision.submitted).toHaveLength(0);
    expect(state.intents.get('intent-1')?.status).toBe('pending');
  });

  it('happy path (provision): picks the "provision" submitter (not "payment"), marks submitted, records activity via its activityType, sets provisionedAt', async () => {
    const state = createFakeState();
    const merchant = Keypair.random();
    seedMerchant(state, 'did:privy:owner', merchant.publicKey());
    const {xdr, hashHex} = buildProvisionXdr();
    seedIntent(state, {id: 'intent-1', privyDid: 'did:privy:owner', kind: 'provision', xdr, hashHex});
    const provision = fakeSubmitter({activityType: 'provision', submit: async () => ({txHash: 'confirmed-hash'})});
    const payment = fakeSubmitter({
      activityType: 'send',
      submit: async () => {
        throw new Error('unused: intent kind is "provision", the "payment" submitter must never be invoked');
      }
    });
    const service = createIntentsService({
      repo: state.repo,
      networkPassphrase,
      submitters: {provision: provision.submitter, payment: payment.submitter}
    });

    const hexSig = '0x' + merchant.sign(Buffer.from(hashHex.replace(/^0x/, ''), 'hex')).toString('hex');

    const result = await service.complete('did:privy:owner', 'intent-1', hexSig);

    expect(result).toEqual({txHash: 'confirmed-hash'});
    expect(provision.submitted).toHaveLength(1);
    expect(provision.submitted[0]).not.toBeInstanceOf(FeeBumpTransaction);
    expect(payment.submitted).toHaveLength(0);
    expect(provision.contexts[0]).toMatchObject({intent: {id: 'intent-1'}, merchant: {stellarAddress: merchant.publicKey()}});
    expect(state.intents.get('intent-1')).toMatchObject({status: 'submitted', resultTxHash: 'confirmed-hash'});
    expect(state.merchants.get('did:privy:owner')?.provisionedAt).not.toBeNull();
    expect(state.activity).toEqual([
      {stellarAddress: merchant.publicKey(), type: 'provision', status: 'confirmed', source: 'api', txHash: 'confirmed-hash', externalRef: 'intent-1'}
    ]);
  });

  it('happy path (payment): picks the "payment" submitter (not "provision"), records a "send" activity row via its activityType, does NOT set provisionedAt', async () => {
    const state = createFakeState();
    const merchant = Keypair.random();
    seedMerchant(state, 'did:privy:owner', merchant.publicKey());
    const {xdr, hashHex} = buildPaymentXdr(merchant);
    seedIntent(state, {id: 'intent-1', privyDid: 'did:privy:owner', kind: 'payment', xdr, hashHex});
    const provision = fakeSubmitter({
      activityType: 'provision',
      submit: async () => {
        throw new Error('unused: intent kind is "payment", the "provision" submitter must never be invoked');
      }
    });
    const payment = fakeSubmitter({
      activityType: 'send',
      buildSubmission: (inner) => wrapFeeBump(sponsor, inner),
      submit: async () => ({txHash: 'confirmed-hash-2'})
    });
    const service = createIntentsService({
      repo: state.repo,
      networkPassphrase,
      submitters: {provision: provision.submitter, payment: payment.submitter}
    });

    const hexSig = '0x' + merchant.sign(Buffer.from(hashHex.replace(/^0x/, ''), 'hex')).toString('hex');

    const result = await service.complete('did:privy:owner', 'intent-1', hexSig);

    expect(result).toEqual({txHash: 'confirmed-hash-2'});
    expect(payment.submitted).toHaveLength(1);
    expect(provision.submitted).toHaveLength(0);
    const submittedTx = payment.submitted[0];
    expect(submittedTx).toBeInstanceOf(FeeBumpTransaction);
    expect((submittedTx as FeeBumpTransaction).feeSource).toBe(sponsor.publicKey());
    expect(state.activity).toEqual([
      {stellarAddress: merchant.publicKey(), type: 'send', status: 'confirmed', source: 'api', txHash: 'confirmed-hash-2', externalRef: 'intent-1'}
    ]);
    expect(state.merchants.get('did:privy:owner')?.provisionedAt).toBeNull();
  });

  it('happy path (payment) with a pre-existing pending activity row: UPDATES that row in place (by externalRef) instead of inserting a second one, preserving its creation-time fields', async () => {
    const state = createFakeState();
    const merchant = Keypair.random();
    seedMerchant(state, 'did:privy:owner', merchant.publicKey());
    const {xdr, hashHex} = buildPaymentXdr(merchant);
    seedIntent(state, {id: 'intent-1', privyDid: 'did:privy:owner', kind: 'payment', xdr, hashHex});
    // Simulates payments/service.ts's POST /payments creation-time write: a
    // pending 'send' row tagged with externalRef = the intent id, carrying
    // details (counterparty/amount) recordActivity's ActivityInput doesn't
    // even know about.
    seedPendingActivity(state, {
      stellarAddress: merchant.publicKey(),
      type: 'send',
      status: 'pending',
      source: 'api',
      txHash: null,
      externalRef: 'intent-1',
      counterparty: 'GDEST...',
      amount: '10.5000000'
    });
    const payment = fakeSubmitter({
      activityType: 'send',
      buildSubmission: (inner) => wrapFeeBump(sponsor, inner),
      submit: async () => ({txHash: 'confirmed-hash-3'})
    });
    const service = createIntentsService({repo: state.repo, networkPassphrase, submitters: {payment: payment.submitter}});

    const hexSig = '0x' + merchant.sign(Buffer.from(hashHex.replace(/^0x/, ''), 'hex')).toString('hex');

    const result = await service.complete('did:privy:owner', 'intent-1', hexSig);

    expect(result).toEqual({txHash: 'confirmed-hash-3'});
    // Exactly one row -- not a second pending+confirmed row.
    expect(state.activity).toHaveLength(1);
    expect(state.activity[0]).toEqual({
      stellarAddress: merchant.publicKey(),
      type: 'send',
      status: 'confirmed',
      source: 'api',
      txHash: 'confirmed-hash-3',
      externalRef: 'intent-1',
      // Creation-time fields recordActivity's ActivityInput never carries
      // must survive the update untouched.
      counterparty: 'GDEST...',
      amount: '10.5000000'
    });
  });

  it('a failed completion also UPDATES a pre-existing pending activity row in place (by externalRef), not just the success path', async () => {
    const state = createFakeState();
    const merchant = Keypair.random();
    seedMerchant(state, 'did:privy:owner', merchant.publicKey());
    const {xdr, hashHex} = buildPaymentXdr(merchant);
    seedIntent(state, {id: 'intent-1', privyDid: 'did:privy:owner', kind: 'payment', xdr, hashHex});
    seedPendingActivity(state, {
      stellarAddress: merchant.publicKey(),
      type: 'send',
      status: 'pending',
      source: 'api',
      txHash: null,
      externalRef: 'intent-1',
      counterparty: 'GDEST...',
      amount: '5.0000000'
    });
    const payment = fakeSubmitter({
      activityType: 'send',
      buildSubmission: (inner) => wrapFeeBump(sponsor, inner),
      submit: async () => {
        throw new SubmissionFailedError('tx_insufficient_fee');
      }
    });
    const service = createIntentsService({repo: state.repo, networkPassphrase, submitters: {payment: payment.submitter}});

    const hexSig = '0x' + merchant.sign(Buffer.from(hashHex.replace(/^0x/, ''), 'hex')).toString('hex');

    await expect(service.complete('did:privy:owner', 'intent-1', hexSig)).rejects.toMatchObject({
      code: 'submission_failed',
      statusCode: 502
    });
    expect(state.activity).toHaveLength(1);
    expect(state.activity[0]).toMatchObject({status: 'failed', txHash: null, counterparty: 'GDEST...', amount: '5.0000000'});
  });

  it("writes the pending activity row's txHash BEFORE calling submit(), computed from buildSubmission's OUTPUT -- a deliberately differently-fee'd tx, not the original inner tx (closes the crash-window gap)", async () => {
    const state = createFakeState();
    const merchant = Keypair.random();
    seedMerchant(state, 'did:privy:owner', merchant.publicKey());
    const {xdr, hashHex} = buildPaymentXdr(merchant);
    seedIntent(state, {id: 'intent-1', privyDid: 'did:privy:owner', kind: 'payment', xdr, hashHex});
    seedPendingActivity(state, {
      stellarAddress: merchant.publicKey(),
      type: 'send',
      status: 'pending',
      source: 'api',
      txHash: null,
      externalRef: 'intent-1',
      counterparty: 'GDEST...',
      amount: '1.0000000'
    });

    let hashAtSubmitTime: string | null | undefined;
    const payment = fakeSubmitter({
      activityType: 'send',
      // wrapFeeBump's output has a DIFFERENT hash than the inner tx handed
      // to buildSubmission -- pins that complete() hashes buildSubmission's
      // RETURN VALUE for updateActivityTxHash, not the pre-buildSubmission
      // inner tx.
      buildSubmission: (inner) => wrapFeeBump(sponsor, inner),
      submit: async () => {
        // Captured mid-flight, before this call resolves -- proves the write
        // happened BEFORE submit(), not merely after a successful result.
        hashAtSubmitTime = state.activity.find((row) => row.externalRef === 'intent-1')?.txHash;
        // Deliberately a DIFFERENT hash than the real submitted tx's own
        // hash, so a passing assertion below can't be explained by "the
        // precomputed value was just copied from the eventual result".
        return {txHash: 'a-completely-different-horizon-hash'};
      }
    });
    const service = createIntentsService({repo: state.repo, networkPassphrase, submitters: {payment: payment.submitter}});

    const hexSig = '0x' + merchant.sign(Buffer.from(hashHex.replace(/^0x/, ''), 'hex')).toString('hex');
    await service.complete('did:privy:owner', 'intent-1', hexSig);

    expect(payment.submitted).toHaveLength(1);
    // The exact tx instance handed to submit(), hashed independently here --
    // must equal what was already written to the pending row before that
    // call was even made (wrapFeeBump's determinism means the hash computed
    // inside service.ts and this one agree).
    const actualSubmittedHash = payment.submitted[0]?.hash().toString('hex');
    expect(hashAtSubmitTime).toBe(actualSubmittedHash);
  });

  it('writes the pending activity row\'s txHash before calling submit() even when submission ultimately fails (unconditional, not success-gated)', async () => {
    const state = createFakeState();
    const merchant = Keypair.random();
    seedMerchant(state, 'did:privy:owner', merchant.publicKey());
    const {xdr, hashHex} = buildPaymentXdr(merchant);
    seedIntent(state, {id: 'intent-1', privyDid: 'did:privy:owner', kind: 'payment', xdr, hashHex});
    seedPendingActivity(state, {
      stellarAddress: merchant.publicKey(),
      type: 'send',
      status: 'pending',
      source: 'api',
      txHash: null,
      externalRef: 'intent-1',
      counterparty: 'GDEST...',
      amount: '1.0000000'
    });

    let hashAtSubmitTime: string | null | undefined;
    const payment = fakeSubmitter({
      activityType: 'send',
      buildSubmission: (inner) => wrapFeeBump(sponsor, inner),
      submit: async () => {
        hashAtSubmitTime = state.activity.find((row) => row.externalRef === 'intent-1')?.txHash;
        throw new SubmissionFailedError('tx_insufficient_fee');
      }
    });
    const service = createIntentsService({repo: state.repo, networkPassphrase, submitters: {payment: payment.submitter}});

    const hexSig = '0x' + merchant.sign(Buffer.from(hashHex.replace(/^0x/, ''), 'hex')).toString('hex');
    await expect(service.complete('did:privy:owner', 'intent-1', hexSig)).rejects.toMatchObject({code: 'submission_failed'});

    // The pre-submission write happened regardless of outcome.
    expect(hashAtSubmitTime).toBeTruthy();
    // The subsequent (unchanged) failure-path recordActivity call still
    // nulls txHash back out afterward -- nothing confirmed on-chain for a
    // genuinely rejected submission -- this test only proves the
    // pre-submission write itself ran, independent of what happens after.
    expect(state.activity[0]?.txHash).toBeNull();
  });

  describe('activityExternalRef contract (generic, kind-agnostic — exercised here via a "payout"-kind intent, its only producer today)', () => {
    it('the PRE-submission crash-window write also targets activityExternalRef, not claimed.id -- otherwise the crash-window protection silently drops for reconciler-keyed rows', async () => {
      const state = createFakeState();
      const merchant = Keypair.random();
      seedMerchant(state, 'did:privy:owner', merchant.publicKey());
      const {xdr, hashHex} = buildPaymentXdr(merchant);
      seedIntent(state, {
        id: 'intent-1',
        privyDid: 'did:privy:owner',
        kind: 'payout',
        xdr,
        hashHex,
        metadata: {orderId: 'order-1', activityExternalRef: 'order:order-1'}
      });
      seedPendingActivity(state, {
        stellarAddress: merchant.publicKey(),
        type: 'off_ramp',
        status: 'pending',
        source: 'api',
        txHash: null,
        externalRef: 'order:order-1',
        counterparty: 'GANCHOR7X4Q5P6Y2K3M9NBVCXZLKJHGFDSAQWERTYUIOPASDFGHJKL',
        amount: '10.0000000'
      });

      let hashAtSubmitTime: string | null | undefined;
      const payout = fakeSubmitter({
        activityType: 'off_ramp',
        buildSubmission: (inner) => wrapFeeBump(sponsor, inner),
        submit: async () => {
          // Captured mid-flight, BEFORE this call resolves: if the
          // pre-submission write were still hardcoded to `claimed.id`
          // ('intent-1'), this lookup by the row's REAL externalRef
          // ('order:order-1') would find nothing and `hashAtSubmitTime`
          // would stay `undefined` -- exactly the regression this test pins.
          hashAtSubmitTime = state.activity.find((row) => row.externalRef === 'order:order-1')?.txHash;
          return {txHash: 'submitted-hash'};
        }
      });
      const service = createIntentsService({repo: state.repo, networkPassphrase, submitters: {payout: payout.submitter}});

      const hexSig = '0x' + merchant.sign(Buffer.from(hashHex.replace(/^0x/, ''), 'hex')).toString('hex');
      await service.complete('did:privy:owner', 'intent-1', hexSig);

      expect(payout.submitted).toHaveLength(1);
      // The exact tx instance handed to submit(), hashed independently here
      // -- must equal what was already written to the reconciler-keyed row
      // before that call was even made.
      const actualSubmittedHash = payout.submitted[0]?.hash().toString('hex');
      expect(hashAtSubmitTime).toBe(actualSubmittedHash);
      // Still exactly one row, matched by the SAME key throughout -- no
      // phantom `externalRef: 'intent-1'` row from a pre-submission write
      // that used the wrong key.
      expect(state.activity).toHaveLength(1);
      expect(state.activity.some((row) => row.externalRef === 'intent-1')).toBe(false);
    });

    it('success: keeps the pending activity row at status "pending" but writes its real txHash, and inserts NO second row', async () => {
      const state = createFakeState();
      const merchant = Keypair.random();
      seedMerchant(state, 'did:privy:owner', merchant.publicKey());
      const {xdr, hashHex} = buildPaymentXdr(merchant); // payout intents are merchant-sourced + unsigned, same tx shape as payment intents
      seedIntent(state, {
        id: 'intent-1',
        privyDid: 'did:privy:owner',
        kind: 'payout',
        xdr,
        hashHex,
        metadata: {orderId: 'order-1', activityExternalRef: 'order:order-1'}
      });
      // Simulates ramp/service.ts's createPayout's creation-time write: a
      // pending 'off_ramp' row tagged with externalRef = 'order:order-1' --
      // NOT the intent's own id -- see RampRepo.recordPendingPayoutActivity's
      // doc comment.
      seedPendingActivity(state, {
        stellarAddress: merchant.publicKey(),
        type: 'off_ramp',
        status: 'pending',
        source: 'api',
        txHash: null,
        externalRef: 'order:order-1',
        counterparty: 'GANCHOR7X4Q5P6Y2K3M9NBVCXZLKJHGFDSAQWERTYUIOPASDFGHJKL',
        amount: '10.0000000'
      });
      const payout = fakeSubmitter({
        activityType: 'off_ramp',
        buildSubmission: (inner) => wrapFeeBump(sponsor, inner),
        submit: async () => ({txHash: 'submitted-hash'})
      });
      const service = createIntentsService({repo: state.repo, networkPassphrase, submitters: {payout: payout.submitter}});

      const hexSig = '0x' + merchant.sign(Buffer.from(hashHex.replace(/^0x/, ''), 'hex')).toString('hex');

      const result = await service.complete('did:privy:owner', 'intent-1', hexSig);

      expect(result).toEqual({txHash: 'submitted-hash'});
      // The INTENT's own status still transitions normally -- only the
      // ACTIVITY row's status is withheld.
      expect(state.intents.get('intent-1')).toMatchObject({status: 'submitted', resultTxHash: 'submitted-hash'});
      expect(state.activity).toHaveLength(1);
      expect(state.activity[0]).toEqual({
        stellarAddress: merchant.publicKey(),
        type: 'off_ramp',
        status: 'pending', // unchanged -- an external reconciler owns this transition
        source: 'api',
        txHash: 'submitted-hash',
        externalRef: 'order:order-1',
        counterparty: 'GANCHOR7X4Q5P6Y2K3M9NBVCXZLKJHGFDSAQWERTYUIOPASDFGHJKL',
        amount: '10.0000000'
      });
    });

    it('failure: flips that SAME pending row to "failed" (keyed by activityExternalRef, not the intent id)', async () => {
      const state = createFakeState();
      const merchant = Keypair.random();
      seedMerchant(state, 'did:privy:owner', merchant.publicKey());
      const {xdr, hashHex} = buildPaymentXdr(merchant);
      seedIntent(state, {
        id: 'intent-1',
        privyDid: 'did:privy:owner',
        kind: 'payout',
        xdr,
        hashHex,
        metadata: {orderId: 'order-1', activityExternalRef: 'order:order-1'}
      });
      seedPendingActivity(state, {
        stellarAddress: merchant.publicKey(),
        type: 'off_ramp',
        status: 'pending',
        source: 'api',
        txHash: null,
        externalRef: 'order:order-1',
        counterparty: 'GANCHOR7X4Q5P6Y2K3M9NBVCXZLKJHGFDSAQWERTYUIOPASDFGHJKL',
        amount: '10.0000000'
      });
      const payout = fakeSubmitter({
        activityType: 'off_ramp',
        buildSubmission: (inner) => wrapFeeBump(sponsor, inner),
        submit: async () => {
          throw new SubmissionFailedError('submission_failed');
        }
      });
      const service = createIntentsService({repo: state.repo, networkPassphrase, submitters: {payout: payout.submitter}});

      const hexSig = '0x' + merchant.sign(Buffer.from(hashHex.replace(/^0x/, ''), 'hex')).toString('hex');

      await expect(service.complete('did:privy:owner', 'intent-1', hexSig)).rejects.toMatchObject({
        code: 'submission_failed',
        statusCode: 502
      });
      expect(state.intents.get('intent-1')).toMatchObject({status: 'failed', error: 'submission_failed'});
      // Still exactly one row -- the SAME pending row, now flipped to failed
      // (not a second row inserted under externalRef: 'intent-1').
      expect(state.activity).toHaveLength(1);
      expect(state.activity[0]).toMatchObject({
        status: 'failed',
        externalRef: 'order:order-1',
        counterparty: 'GANCHOR7X4Q5P6Y2K3M9NBVCXZLKJHGFDSAQWERTYUIOPASDFGHJKL',
        amount: '10.0000000'
      });
    });

    it('regression: an intent with no metadata.activityExternalRef (e.g. "payment") still confirms its activity row exactly as before this contract existed', async () => {
      const state = createFakeState();
      const merchant = Keypair.random();
      seedMerchant(state, 'did:privy:owner', merchant.publicKey());
      const {xdr, hashHex} = buildPaymentXdr(merchant);
      // No `metadata` supplied -- seedIntent defaults it to null, exactly
      // like every non-payout intent producer today.
      seedIntent(state, {id: 'intent-1', privyDid: 'did:privy:owner', kind: 'payment', xdr, hashHex});
      const payment = fakeSubmitter({
        activityType: 'send',
        buildSubmission: (inner) => wrapFeeBump(sponsor, inner),
        submit: async () => ({txHash: 'confirmed-hash-regression'})
      });
      const service = createIntentsService({repo: state.repo, networkPassphrase, submitters: {payment: payment.submitter}});

      const hexSig = '0x' + merchant.sign(Buffer.from(hashHex.replace(/^0x/, ''), 'hex')).toString('hex');

      const result = await service.complete('did:privy:owner', 'intent-1', hexSig);

      expect(result).toEqual({txHash: 'confirmed-hash-regression'});
      expect(state.activity).toEqual([
        {
          stellarAddress: merchant.publicKey(),
          type: 'send',
          status: 'confirmed',
          source: 'api',
          txHash: 'confirmed-hash-regression',
          externalRef: 'intent-1'
        }
      ]);
    });
  });

  it('tx_bad_seq (StaleSequenceError from submit()): marks the intent failed with "stale_sequence", records a failed activity row via the submitter\'s activityType, and throws AppError("intent_expired", 409)', async () => {
    const state = createFakeState();
    const merchant = Keypair.random();
    seedMerchant(state, 'did:privy:owner', merchant.publicKey());
    const {xdr, hashHex} = buildProvisionXdr();
    seedIntent(state, {id: 'intent-1', privyDid: 'did:privy:owner', kind: 'provision', xdr, hashHex});
    const provision = fakeSubmitter({
      activityType: 'provision',
      submit: async () => {
        throw new StaleSequenceError();
      }
    });
    const service = createIntentsService({repo: state.repo, networkPassphrase, submitters: {provision: provision.submitter}});

    const hexSig = '0x' + merchant.sign(Buffer.from(hashHex.replace(/^0x/, ''), 'hex')).toString('hex');

    await expect(service.complete('did:privy:owner', 'intent-1', hexSig)).rejects.toMatchObject({
      code: 'intent_expired',
      statusCode: 409
    });
    expect(state.intents.get('intent-1')).toMatchObject({status: 'failed', error: 'stale_sequence'});
    expect(state.activity).toEqual([
      {stellarAddress: merchant.publicKey(), type: 'provision', status: 'failed', source: 'api', txHash: null, externalRef: 'intent-1'}
    ]);
  });

  it('other submission failure (SubmissionFailedError from submit()): marks the intent failed with a compact reason, records a failed activity row via the submitter\'s activityType, and throws AppError("submission_failed", 502)', async () => {
    const state = createFakeState();
    const merchant = Keypair.random();
    seedMerchant(state, 'did:privy:owner', merchant.publicKey());
    const {xdr, hashHex} = buildPaymentXdr(merchant);
    seedIntent(state, {id: 'intent-1', privyDid: 'did:privy:owner', kind: 'payment', xdr, hashHex});
    const payment = fakeSubmitter({
      activityType: 'send',
      buildSubmission: (inner) => wrapFeeBump(sponsor, inner),
      submit: async () => {
        throw new SubmissionFailedError('tx_insufficient_fee');
      }
    });
    const service = createIntentsService({repo: state.repo, networkPassphrase, submitters: {payment: payment.submitter}});

    const hexSig = '0x' + merchant.sign(Buffer.from(hashHex.replace(/^0x/, ''), 'hex')).toString('hex');

    await expect(service.complete('did:privy:owner', 'intent-1', hexSig)).rejects.toMatchObject({
      code: 'submission_failed',
      statusCode: 502,
      details: {reason: 'tx_insufficient_fee'}
    });
    expect(state.intents.get('intent-1')).toMatchObject({status: 'failed', error: 'tx_insufficient_fee'});
    // kind: 'payment' -> the "payment" submitter's activityType 'send',
    // proving the failure-path activity row's type comes from
    // submitter.activityType (not hardcoded to 'provision').
    expect(state.activity).toEqual([
      {stellarAddress: merchant.publicKey(), type: 'send', status: 'failed', source: 'api', txHash: null, externalRef: 'intent-1'}
    ]);
  });

  it('throws a plain Error (integrity bug, not a client-facing AppError) when no submitter is registered for the claimed intent\'s kind', async () => {
    const state = createFakeState();
    const merchant = Keypair.random();
    seedMerchant(state, 'did:privy:owner', merchant.publicKey());
    const {xdr, hashHex} = buildProvisionXdr();
    seedIntent(state, {id: 'intent-1', privyDid: 'did:privy:owner', kind: 'provision', xdr, hashHex});
    // No 'provision' entry -- simulates a kind whose submitter hasn't been
    // wired into app.ts yet (IntentsServiceDeps.submitters is Partial for
    // exactly this reason).
    const service = createIntentsService({repo: state.repo, networkPassphrase, submitters: {}});

    const hexSig = '0x' + merchant.sign(Buffer.from(hashHex.replace(/^0x/, ''), 'hex')).toString('hex');

    await expect(service.complete('did:privy:owner', 'intent-1', hexSig)).rejects.toThrow(
      /no IntentSubmitter registered for intent kind "provision"/
    );
  });

  it('already-submitted: throws AppError("intent_already_submitted", 409) without resubmitting', async () => {
    const state = createFakeState();
    const merchant = Keypair.random();
    seedMerchant(state, 'did:privy:owner', merchant.publicKey());
    const {xdr, hashHex} = buildProvisionXdr();
    seedIntent(state, {
      id: 'intent-1',
      privyDid: 'did:privy:owner',
      kind: 'provision',
      xdr,
      hashHex,
      status: 'submitted',
      resultTxHash: 'already-there'
    });
    const provision = fakeSubmitter({activityType: 'provision', submit: async () => ({txHash: 'should-not-happen'})});
    const service = createIntentsService({repo: state.repo, networkPassphrase, submitters: {provision: provision.submitter}});

    const hexSig = '0x' + merchant.sign(Buffer.from(hashHex.replace(/^0x/, ''), 'hex')).toString('hex');

    await expect(service.complete('did:privy:owner', 'intent-1', hexSig)).rejects.toMatchObject({
      code: 'intent_already_submitted',
      statusCode: 409
    });
    expect(provision.submitted).toHaveLength(0);
  });

  it('already-failed: throws AppError("intent_failed", 409) without resubmitting', async () => {
    const state = createFakeState();
    const merchant = Keypair.random();
    seedMerchant(state, 'did:privy:owner', merchant.publicKey());
    const {xdr, hashHex} = buildProvisionXdr();
    seedIntent(state, {
      id: 'intent-1',
      privyDid: 'did:privy:owner',
      kind: 'provision',
      xdr,
      hashHex,
      status: 'failed',
      error: 'stale_sequence'
    });
    const provision = fakeSubmitter({activityType: 'provision', submit: async () => ({txHash: 'should-not-happen'})});
    const service = createIntentsService({repo: state.repo, networkPassphrase, submitters: {provision: provision.submitter}});

    const hexSig = '0x' + merchant.sign(Buffer.from(hashHex.replace(/^0x/, ''), 'hex')).toString('hex');

    await expect(service.complete('did:privy:owner', 'intent-1', hexSig)).rejects.toMatchObject({
      code: 'intent_failed',
      statusCode: 409
    });
    expect(provision.submitted).toHaveLength(0);
  });

  it('already-claimed (status "submitting", a concurrent completion is in flight): throws AppError("intent_already_submitted", 409) without resubmitting', async () => {
    const state = createFakeState();
    const merchant = Keypair.random();
    seedMerchant(state, 'did:privy:owner', merchant.publicKey());
    const {xdr, hashHex} = buildProvisionXdr();
    // Simulates the state right after a concurrent request's atomic claim
    // (pending -> submitting) has landed, before that request has finished
    // submitting.
    seedIntent(state, {id: 'intent-1', privyDid: 'did:privy:owner', kind: 'provision', xdr, hashHex, status: 'submitting'});
    const provision = fakeSubmitter({activityType: 'provision', submit: async () => ({txHash: 'should-not-happen'})});
    const service = createIntentsService({repo: state.repo, networkPassphrase, submitters: {provision: provision.submitter}});

    const hexSig = '0x' + merchant.sign(Buffer.from(hashHex.replace(/^0x/, ''), 'hex')).toString('hex');

    await expect(service.complete('did:privy:owner', 'intent-1', hexSig)).rejects.toMatchObject({
      code: 'intent_already_submitted',
      statusCode: 409
    });
    expect(provision.submitted).toHaveLength(0);
  });

  it('TOCTOU: a valid-signature completion that loses the atomic claim race (won by a concurrent request between the initial read and the claim) gets 409 without ever calling submit()', async () => {
    const merchant = Keypair.random();
    const {xdr, hashHex} = buildProvisionXdr();
    const pendingSnapshot: IntentRecord = {
      id: 'intent-1',
      privyDid: 'did:privy:owner',
      kind: 'provision',
      xdr,
      hashHex,
      status: 'pending',
      resultTxHash: null,
      error: null,
      metadata: null,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    let getOwnedIntentCalls = 0;
    // A hand-built repo (not createFakeState's) that deliberately decouples
    // getOwnedIntent's answer from claimIntent's, to simulate the real
    // Postgres CAS race deterministically: this caller's initial read still
    // sees 'pending' (stale by the time it matters), its claimIntent call
    // loses the race (another request's UPDATE ... WHERE status='pending'
    // won first), and a re-read after the failed claim sees the WINNER's
    // result already landed.
    const repo: IntentsRepo = {
      async getOwnedIntent() {
        getOwnedIntentCalls += 1;
        // First call: the initial pre-claim read (still 'pending').
        // Any subsequent call: the fallback re-read after losing the claim
        // -- the concurrent winner has already flipped it to 'submitted'.
        return getOwnedIntentCalls === 1 ? pendingSnapshot : {...pendingSnapshot, status: 'submitted', resultTxHash: 'winner-hash'};
      },
      async claimIntent() {
        // This caller always loses the race.
        return undefined;
      },
      async getMerchant() {
        return {privyDid: 'did:privy:owner', privyWalletId: 'wallet-1', stellarAddress: merchant.publicKey(), provisionedAt: null, createdAt: new Date()};
      },
      markSubmitted: async () => {
        throw new Error('unused: this caller never wins the claim');
      },
      markFailed: async () => {
        throw new Error('unused: this caller never wins the claim');
      },
      markMerchantProvisioned: async () => {
        throw new Error('unused: this caller never wins the claim');
      },
      recordActivity: async () => {
        throw new Error('unused: this caller never wins the claim');
      },
      updateActivityTxHash: async () => {
        throw new Error('unused: this caller never wins the claim');
      }
    };
    const provision = fakeSubmitter({
      activityType: 'provision',
      submit: async () => {
        throw new Error('unused: this caller never wins the claim');
      }
    });
    const service = createIntentsService({repo, networkPassphrase, submitters: {provision: provision.submitter}});

    const hexSig = '0x' + merchant.sign(Buffer.from(hashHex.replace(/^0x/, ''), 'hex')).toString('hex');

    await expect(service.complete('did:privy:owner', 'intent-1', hexSig)).rejects.toMatchObject({
      code: 'intent_already_submitted',
      statusCode: 409,
      details: {resultTxHash: 'winner-hash'}
    });
    expect(provision.submitted).toHaveLength(0);
  });
});
