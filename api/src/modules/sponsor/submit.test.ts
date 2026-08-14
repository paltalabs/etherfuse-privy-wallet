import {Account, BASE_FEE, FeeBumpTransaction, Keypair, Networks, Operation, TransactionBuilder} from '@stellar/stellar-sdk';
import {describe, expect, it} from 'vitest';
import {SorobanSubmissionError, type SorobanGateway} from '../../lib/soroban-gateway.js';
import type {StellarGateway, StellarSubmitResult} from '../../lib/stellar-gateway.js';
import type {IntentRecord, MerchantRecord} from '../intents/service.js';
import {attachRawSignature} from './stellar.js';
import {
  createPaymentSubmitter,
  createProvisionSubmitter,
  createSorobanSubmitter,
  StaleSequenceError,
  SubmissionFailedError
} from './submit.js';

/**
 * Neither submitter here reads `ctx` (`buildSubmission`'s closure over
 * `sponsor`/`gateway` is all they need) -- a single type-satisfying stand-in
 * for `IntentSubmitter.submit`'s required `{intent, merchant}` second
 * argument, reused across every test below instead of an inline cast per call.
 */
const unusedCtx = {intent: undefined as unknown as IntentRecord, merchant: undefined as unknown as MerchantRecord};

function dummyTx(sourceKp: Keypair, sequence = '0') {
  const source = new Account(sourceKp.publicKey(), sequence);
  return new TransactionBuilder(source, {fee: BASE_FEE, networkPassphrase: Networks.TESTNET})
    .addOperation(Operation.manageData({name: 'spike', value: 'v'}))
    .setTimeout(300)
    .build();
}

/** Records every tx passed to submitTransaction; resolves/rejects per `outcome`. */
function fakeGateway(outcome: () => Promise<StellarSubmitResult>): {
  gateway: StellarGateway;
  submitted: Array<Parameters<StellarGateway['submitTransaction']>[0]>;
} {
  const submitted: Array<Parameters<StellarGateway['submitTransaction']>[0]> = [];
  return {
    submitted,
    gateway: {
      loadAccount: async () => {
        throw new Error('unused in submit.test.ts');
      },
      submitTransaction: async (tx) => {
        submitted.push(tx);
        return outcome();
      },
      listPayments: async () => {
        throw new Error('unused in submit.test.ts');
      }
    }
  };
}

/** Shapes a rejection the way stellar-sdk's Horizon.Server#submitTransaction actually
 * rejects with on a failed submission: a raw Axios error whose Horizon error body lives
 * at `err.response.data`, with the failure code at `.extras.result_codes.transaction`
 * (and, for a `tx_failed` transaction code, the per-operation codes at
 * `.extras.result_codes.operations` -- see stellar-gateway.ts's submitTransaction doc
 * comment for the verification trail). */
function horizonFailure(resultCode: string, operations: string[] = []) {
  return Object.assign(new Error('Transaction Failed'), {
    response: {
      status: 400,
      data: {
        status: 400,
        title: 'Transaction Failed',
        type: 'transaction_failed',
        detail: 'stub',
        extras: {
          envelope_xdr: 'AAAA',
          result_codes: {transaction: resultCode, operations},
          result_xdr: 'AAAA'
        }
      }
    }
  });
}

describe('createProvisionSubmitter', () => {
  it('activityType is "provision"', () => {
    const {gateway} = fakeGateway(async () => ({hash: 'unused'}));
    expect(createProvisionSubmitter(gateway).activityType).toBe('provision');
  });

  it('buildSubmission is identity: submits the inner tx directly, no fee-bump', async () => {
    const sponsor = Keypair.random();
    const merchant = Keypair.random();
    // Provisioning intents are sponsor-sourced and already sponsor-signed at
    // build time (per wallet/service.ts) -- only the merchant co-signature
    // is attached here before submission.
    const inner = dummyTx(sponsor);
    inner.sign(sponsor);
    const hexSig = '0x' + merchant.sign(inner.hash()).toString('hex');
    attachRawSignature(inner, merchant.publicKey(), hexSig);

    const {gateway, submitted} = fakeGateway(async () => ({hash: 'confirmed-hash'}));
    const submitter = createProvisionSubmitter(gateway);

    const built = submitter.buildSubmission(inner);
    expect(built).toBe(inner);
    expect(built).not.toBeInstanceOf(FeeBumpTransaction);

    const result = await submitter.submit(built, unusedCtx);

    expect(result).toEqual({txHash: 'confirmed-hash'});
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toBe(inner);
  });

  it('throws StaleSequenceError when Horizon rejects with tx_bad_seq', async () => {
    const sponsor = Keypair.random();
    const merchant = Keypair.random();
    const inner = dummyTx(sponsor);
    inner.sign(sponsor);
    const hexSig = '0x' + merchant.sign(inner.hash()).toString('hex');
    attachRawSignature(inner, merchant.publicKey(), hexSig);
    const {gateway} = fakeGateway(async () => {
      throw horizonFailure('tx_bad_seq');
    });
    const submitter = createProvisionSubmitter(gateway);
    const built = submitter.buildSubmission(inner);

    await expect(submitter.submit(built, unusedCtx)).rejects.toBeInstanceOf(StaleSequenceError);
  });

  it('throws SubmissionFailedError with a compact reason for any other Horizon failure', async () => {
    const sponsor = Keypair.random();
    const merchant = Keypair.random();
    const inner = dummyTx(sponsor);
    inner.sign(sponsor);
    const hexSig = '0x' + merchant.sign(inner.hash()).toString('hex');
    attachRawSignature(inner, merchant.publicKey(), hexSig);
    const {gateway} = fakeGateway(async () => {
      throw horizonFailure('tx_insufficient_fee');
    });
    const submitter = createProvisionSubmitter(gateway);
    const built = submitter.buildSubmission(inner);

    const failure = await submitter.submit(built, unusedCtx).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(SubmissionFailedError);
    expect((failure as SubmissionFailedError).reason).toBe('tx_insufficient_fee');
  });

  it('a tx_failed transaction code with no informative op-level code (e.g. an empty operations array) falls back to the bare transaction code', async () => {
    const sponsor = Keypair.random();
    const merchant = Keypair.random();
    const inner = dummyTx(sponsor);
    inner.sign(sponsor);
    const hexSig = '0x' + merchant.sign(inner.hash()).toString('hex');
    attachRawSignature(inner, merchant.publicKey(), hexSig);
    const {gateway} = fakeGateway(async () => {
      throw horizonFailure('tx_failed', []);
    });
    const submitter = createProvisionSubmitter(gateway);
    const built = submitter.buildSubmission(inner);

    const failure = await submitter.submit(built, unusedCtx).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(SubmissionFailedError);
    expect((failure as SubmissionFailedError).reason).toBe('tx_failed');
  });

  it('SubmissionFailedError falls back to a generic reason for a non-Horizon-shaped failure', async () => {
    const sponsor = Keypair.random();
    const merchant = Keypair.random();
    const inner = dummyTx(sponsor);
    inner.sign(sponsor);
    const hexSig = '0x' + merchant.sign(inner.hash()).toString('hex');
    attachRawSignature(inner, merchant.publicKey(), hexSig);
    const {gateway} = fakeGateway(async () => {
      throw new Error('network timeout');
    });
    const submitter = createProvisionSubmitter(gateway);
    const built = submitter.buildSubmission(inner);

    const failure = await submitter.submit(built, unusedCtx).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(SubmissionFailedError);
    expect((failure as SubmissionFailedError).reason).toBe('unknown_error');
  });
});

describe('createPaymentSubmitter', () => {
  it('activityType is "send"', () => {
    const sponsor = Keypair.random();
    const {gateway} = fakeGateway(async () => ({hash: 'unused'}));
    expect(createPaymentSubmitter(sponsor, gateway).activityType).toBe('send');
  });

  it('buildSubmission wraps the merchant-signed inner tx in a sponsor fee-bump before submitting', async () => {
    const sponsor = Keypair.random();
    const merchant = Keypair.random();
    const inner = dummyTx(merchant);
    const hexSig = '0x' + merchant.sign(inner.hash()).toString('hex');
    attachRawSignature(inner, merchant.publicKey(), hexSig);

    const {gateway, submitted} = fakeGateway(async () => ({hash: 'confirmed-hash-2'}));
    const submitter = createPaymentSubmitter(sponsor, gateway);

    const built = submitter.buildSubmission(inner);
    expect(built).toBeInstanceOf(FeeBumpTransaction);
    expect((built as FeeBumpTransaction).feeSource).toBe(sponsor.publicKey());

    const result = await submitter.submit(built, unusedCtx);

    expect(result).toEqual({txHash: 'confirmed-hash-2'});
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toBe(built);
  });

  it('op_no_trust: a tx_failed transaction code appends the first op-level failure code to the reason', async () => {
    const sponsor = Keypair.random();
    const merchant = Keypair.random();
    const inner = dummyTx(merchant);
    const hexSig = '0x' + merchant.sign(inner.hash()).toString('hex');
    attachRawSignature(inner, merchant.publicKey(), hexSig);
    const {gateway} = fakeGateway(async () => {
      // A payment op failing (destination has no trustline) alongside other
      // ops that succeeded -- 'op_success' entries must be skipped in favor
      // of the actual failure code.
      throw horizonFailure('tx_failed', ['op_success', 'op_no_trust']);
    });
    const submitter = createPaymentSubmitter(sponsor, gateway);
    const built = submitter.buildSubmission(inner);

    const failure = await submitter.submit(built, unusedCtx).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(SubmissionFailedError);
    expect((failure as SubmissionFailedError).reason).toBe('tx_failed:op_no_trust');
  });
});

/** Records every tx passed to sendAndConfirm; resolves/rejects per `outcome`. simulateAndAssemble/simulateRead/getContractEvents/getLatestLedger all throw-if-called (unused by createSorobanSubmitter). */
function fakeSorobanGateway(outcome: () => Promise<{txHash: string}>): {
  gateway: SorobanGateway;
  submitted: Array<Parameters<SorobanGateway['sendAndConfirm']>[0]>;
} {
  const submitted: Array<Parameters<SorobanGateway['sendAndConfirm']>[0]> = [];
  return {
    submitted,
    gateway: {
      simulateAndAssemble: async () => {
        throw new Error('unused in submit.test.ts');
      },
      simulateRead: async () => {
        throw new Error('unused in submit.test.ts');
      },
      sendAndConfirm: async (tx) => {
        submitted.push(tx);
        return outcome();
      },
      getContractEvents: async () => {
        throw new Error('unused in submit.test.ts');
      },
      getLatestLedger: async () => {
        throw new Error('unused in submit.test.ts');
      }
    }
  };
}

describe('createSorobanSubmitter', () => {
  it('activityType is whatever kind it is constructed with', () => {
    const sponsor = Keypair.random();
    const {gateway} = fakeSorobanGateway(async () => ({txHash: 'unused'}));
    expect(createSorobanSubmitter(sponsor, gateway, 'vault_deposit').activityType).toBe('vault_deposit');
    expect(createSorobanSubmitter(sponsor, gateway, 'vault_withdraw').activityType).toBe('vault_withdraw');
  });

  it('buildSubmission wraps the merchant-signed inner tx in a sponsor fee-bump at baseFee 1000000', async () => {
    const sponsor = Keypair.random();
    const merchant = Keypair.random();
    const inner = dummyTx(merchant);
    const hexSig = '0x' + merchant.sign(inner.hash()).toString('hex');
    attachRawSignature(inner, merchant.publicKey(), hexSig);

    const {gateway, submitted} = fakeSorobanGateway(async () => ({txHash: 'confirmed-hash-3'}));
    const submitter = createSorobanSubmitter(sponsor, gateway, 'vault_deposit');

    const built = submitter.buildSubmission(inner);
    expect(built).toBeInstanceOf(FeeBumpTransaction);
    expect((built as FeeBumpTransaction).feeSource).toBe(sponsor.publicKey());
    // buildFeeBumpTransaction's fee = baseFee * (innerOps + 1) -- inner here
    // has exactly 1 operation (dummyTx's manageData op), so
    // 1000000 * (1 + 1) = 2000000 pins the baseFee actually used.
    expect((built as FeeBumpTransaction).fee).toBe('2000000');

    const result = await submitter.submit(built, unusedCtx);

    expect(result).toEqual({txHash: 'confirmed-hash-3'});
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toBe(built);
  });

  it('throws SubmissionFailedError(reason) when SorobanGateway.sendAndConfirm rejects with SorobanSubmissionError', async () => {
    const sponsor = Keypair.random();
    const merchant = Keypair.random();
    const inner = dummyTx(merchant);
    const hexSig = '0x' + merchant.sign(inner.hash()).toString('hex');
    attachRawSignature(inner, merchant.publicKey(), hexSig);
    const {gateway} = fakeSorobanGateway(async () => {
      throw new SorobanSubmissionError('tx_failed');
    });
    const submitter = createSorobanSubmitter(sponsor, gateway, 'vault_withdraw');
    const built = submitter.buildSubmission(inner);

    const failure = await submitter.submit(built, unusedCtx).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(SubmissionFailedError);
    expect((failure as SubmissionFailedError).reason).toBe('tx_failed');
  });

  it('propagates a non-SorobanSubmissionError failure unchanged', async () => {
    const sponsor = Keypair.random();
    const merchant = Keypair.random();
    const inner = dummyTx(merchant);
    const hexSig = '0x' + merchant.sign(inner.hash()).toString('hex');
    attachRawSignature(inner, merchant.publicKey(), hexSig);
    const {gateway} = fakeSorobanGateway(async () => {
      throw new Error('network timeout');
    });
    const submitter = createSorobanSubmitter(sponsor, gateway, 'vault_deposit');
    const built = submitter.buildSubmission(inner);

    await expect(submitter.submit(built, unusedCtx)).rejects.toThrow('network timeout');
  });
});
