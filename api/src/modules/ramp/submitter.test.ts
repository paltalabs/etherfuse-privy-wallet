import {Account, BASE_FEE, FeeBumpTransaction, Keypair, Networks, Operation, TransactionBuilder} from '@stellar/stellar-sdk';
import {describe, expect, it} from 'vitest';
import type {StellarGateway, StellarSubmitResult} from '../../lib/stellar-gateway.js';
import {attachRawSignature, txHashHex} from '../sponsor/stellar.js';
import {SubmissionFailedError} from '../sponsor/submit.js';
import {createPayoutSubmitter} from './submitter.js';

/** A single-operation unsigned tx sourced by `sourceKp` — mirrors `sponsor/submit.test.ts`'s dummy-tx convention. */
function dummyTx(sourceKp: Keypair, sequence = '0') {
  const source = new Account(sourceKp.publicKey(), sequence);
  return new TransactionBuilder(source, {fee: BASE_FEE, networkPassphrase: Networks.TESTNET})
    .addOperation(Operation.manageData({name: 'spike', value: 'v'}))
    .setTimeout(300)
    .build();
}

/** Signs `inner` with `merchant` and attaches it the way `intents/service.ts`'s `complete` does before ever calling `buildSubmission`. */
function signAsMerchant(inner: ReturnType<typeof dummyTx>, merchant: Keypair): void {
  const hexSig = '0x' + merchant.sign(inner.hash()).toString('hex');
  attachRawSignature(inner, merchant.publicKey(), hexSig);
}

/**
 * Fake `StellarGateway` — only `submitTransaction` is exercised by
 * `createPayoutSubmitter`; every other method throws if called, mirroring
 * `sponsor/submit.test.ts`'s `fakeGateway` convention.
 */
function fakeGateway(submitImpl: (tx: unknown) => Promise<StellarSubmitResult>): {
  gateway: StellarGateway;
  calls: unknown[];
} {
  const calls: unknown[] = [];
  const gateway: StellarGateway = {
    loadAccount: async () => {
      throw new Error('unused in submitter.test.ts');
    },
    async submitTransaction(tx) {
      calls.push(tx);
      return submitImpl(tx);
    },
    listPayments: async () => {
      throw new Error('unused in submitter.test.ts');
    }
  };
  return {gateway, calls};
}

describe('createPayoutSubmitter', () => {
  it('activityType is "off_ramp"', () => {
    const sponsor = Keypair.random();
    const {gateway} = fakeGateway(async () => ({hash: 'unused'}));
    expect(createPayoutSubmitter(sponsor, gateway).activityType).toBe('off_ramp');
  });

  it('buildSubmission wraps the merchant-signed inner tx in a sponsor fee-bump at the default classic baseFee', () => {
    const sponsor = Keypair.random();
    const merchant = Keypair.random();
    const inner = dummyTx(merchant);
    signAsMerchant(inner, merchant);
    const {gateway} = fakeGateway(async () => ({hash: 'unused'}));
    const submitter = createPayoutSubmitter(sponsor, gateway);

    const built = submitter.buildSubmission(inner);

    expect(built).toBeInstanceOf(FeeBumpTransaction);
    expect((built as FeeBumpTransaction).feeSource).toBe(sponsor.publicKey());
    // wrapFeeBump's default baseFee (classic tx, sponsor/stellar.ts) = 10000
    // stroops; buildFeeBumpTransaction's fee = baseFee * (innerOps + 1) --
    // inner here has exactly 1 operation (dummyTx's manageData op), so
    // 10000 * (1 + 1) = 20000 pins the baseFee actually used.
    expect((built as FeeBumpTransaction).fee).toBe('20000');
  });

  it('submits the built fee-bump to the gateway and resolves with its OWN hash, not the gateway-reported one', async () => {
    const sponsor = Keypair.random();
    const merchant = Keypair.random();
    const inner = dummyTx(merchant);
    signAsMerchant(inner, merchant);
    const {gateway, calls} = fakeGateway(async () => ({hash: 'horizon-reported-hash-not-what-we-return'}));
    const submitter = createPayoutSubmitter(sponsor, gateway);
    const built = submitter.buildSubmission(inner);
    const intent = {
      id: 'intent-1',
      privyDid: 'did:privy:merchant',
      kind: 'payout' as const,
      xdr: 'unused',
      hashHex: 'unused',
      status: 'submitting' as const,
      resultTxHash: null,
      error: null,
      metadata: {orderId: 'order-1'},
      createdAt: new Date(),
      updatedAt: new Date()
    };
    const merchantRecord = {
      privyDid: 'did:privy:merchant',
      privyWalletId: 'wallet-1',
      stellarAddress: merchant.publicKey(),
      provisionedAt: new Date(),
      createdAt: new Date()
    };

    const result = await submitter.submit(built, {intent, merchant: merchantRecord});

    expect(calls).toEqual([built]);
    expect(result).toEqual({txHash: txHashHex(built).replace(/^0x/, '')});
    expect(result.txHash).not.toBe('horizon-reported-hash-not-what-we-return');
  });

  it('maps any gateway submission rejection to SubmissionFailedError("submission_failed") -- no provider call, no Horizon result-code parsing', async () => {
    const sponsor = Keypair.random();
    const merchant = Keypair.random();
    const inner = dummyTx(merchant);
    signAsMerchant(inner, merchant);
    const {gateway} = fakeGateway(async () => {
      throw new Error('horizon rejected the transaction');
    });
    const submitter = createPayoutSubmitter(sponsor, gateway);
    const built = submitter.buildSubmission(inner);
    const intent = {
      id: 'intent-1',
      privyDid: 'did:privy:merchant',
      kind: 'payout' as const,
      xdr: 'unused',
      hashHex: 'unused',
      status: 'submitting' as const,
      resultTxHash: null,
      error: null,
      metadata: {orderId: 'order-1'},
      createdAt: new Date(),
      updatedAt: new Date()
    };
    const merchantRecord = {
      privyDid: 'did:privy:merchant',
      privyWalletId: 'wallet-1',
      stellarAddress: merchant.publicKey(),
      provisionedAt: new Date(),
      createdAt: new Date()
    };

    const failure = await submitter.submit(built, {intent, merchant: merchantRecord}).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(SubmissionFailedError);
    expect((failure as SubmissionFailedError).reason).toBe('submission_failed');
  });
});
