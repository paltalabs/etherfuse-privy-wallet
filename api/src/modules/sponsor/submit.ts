import type {FeeBumpTransaction, Keypair, Transaction} from '@stellar/stellar-sdk';
import {SorobanSubmissionError, type SorobanGateway} from '../../lib/soroban-gateway.js';
import type {StellarGateway} from '../../lib/stellar-gateway.js';
import type {IntentSubmitter} from '../intents/service.js';
import {wrapFeeBump} from './stellar.js';

/** The result of a successful submission. */
export interface SubmitIntentResult {
  txHash: string;
}

/**
 * Thrown when Horizon rejects a submission specifically for a stale
 * sequence number (`tx_bad_seq`) -- the intent's XDR embedded a sequence
 * number that is no longer valid by submission time. The caller must
 * invalidate the intent (it can never succeed as-is) and tell the client to
 * re-request a fresh one.
 */
export class StaleSequenceError extends Error {
  constructor() {
    super('transaction submission failed: stale sequence number (tx_bad_seq)');
    this.name = 'StaleSequenceError';
  }
}

/**
 * Thrown for any submission failure that is NOT a stale sequence number.
 * `reason` is a compact, sanitized code -- Horizon's `result_codes.transaction`
 * value (e.g. `'tx_insufficient_fee'`) when available, else `'unknown_error'`
 * -- safe to store in `intents.error` or return in an API response's
 * `details`. When the transaction-level code is `'tx_failed'` (the generic
 * "one of the operations failed" code, uninformative on its own), `reason`
 * is instead `'tx_failed:<opCode>'` -- the first non-`'op_success'` entry
 * from Horizon's per-operation `result_codes.operations` array (e.g.
 * `'tx_failed:op_no_trust'` for a payment to a destination with no
 * trustline) -- see `sanitizedReason`. Never carries the raw Horizon
 * `extras` payload (envelope/result XDR), which is not client-facing.
 */
export class SubmissionFailedError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`transaction submission failed: ${reason}`);
    this.name = 'SubmissionFailedError';
    this.reason = reason;
  }
}

/** Horizon's `result_codes` for a failed transaction submission, duck-typed out of a raw error (see `resultCodes`). */
interface HorizonResultCodes {
  transaction: string;
  operations: string[];
}

/**
 * Extract Horizon's `result_codes` (transaction-level code plus the
 * per-operation code array) from a raw submission-failure error, duck-typed
 * against the shape `Horizon.Server#submitTransaction` actually rejects
 * with in the installed `@stellar/stellar-sdk` -- a plain Axios error, NOT
 * a stellar-sdk `NetworkError`/`BadResponseError` instance (verified
 * against the installed package; see `stellar-gateway.ts`'s
 * `submitTransaction` doc comment for the full trail). The codes live at
 * `err.response.data.extras.result_codes`. Returns `undefined` for
 * anything that doesn't match this shape (e.g. a network-level error with
 * no Horizon response at all).
 */
function resultCodes(err: unknown): HorizonResultCodes | undefined {
  if (typeof err !== 'object' || err === null || !('response' in err)) return undefined;
  const response = (err as {response: unknown}).response;
  if (typeof response !== 'object' || response === null || !('data' in response)) return undefined;
  const data = (response as {data: unknown}).data;
  if (typeof data !== 'object' || data === null || !('extras' in data)) return undefined;
  const extras = (data as {extras: unknown}).extras;
  if (typeof extras !== 'object' || extras === null || !('result_codes' in extras)) return undefined;
  const raw = (extras as {result_codes: unknown}).result_codes;
  if (typeof raw !== 'object' || raw === null || !('transaction' in raw)) return undefined;
  const transaction = (raw as {transaction: unknown}).transaction;
  if (typeof transaction !== 'string') return undefined;
  const operationsRaw = 'operations' in raw ? (raw as {operations: unknown}).operations : undefined;
  const operations = Array.isArray(operationsRaw) ? operationsRaw.filter((code): code is string => typeof code === 'string') : [];
  return {transaction, operations};
}

/**
 * Builds `SubmissionFailedError`'s compact `reason` from Horizon's result
 * codes. `'tx_failed'` alone doesn't say WHICH operation failed or why
 * (e.g. it can't distinguish a missing destination trustline from an
 * underfunded source) -- Horizon reports that separately per-operation, so
 * for that one transaction-level code the first non-`'op_success'` entry in
 * `codes.operations` is appended (`'tx_failed:op_no_trust'`). Every other
 * transaction-level code is already specific enough on its own and is
 * returned unchanged. `undefined` input (a non-Horizon-shaped failure, e.g.
 * a bare network timeout) falls back to `'unknown_error'`.
 */
function sanitizedReason(codes: HorizonResultCodes | undefined): string {
  if (!codes) return 'unknown_error';
  if (codes.transaction === 'tx_failed') {
    const opFailure = codes.operations.find((code) => code !== 'op_success');
    if (opFailure) return `${codes.transaction}:${opFailure}`;
  }
  return codes.transaction;
}

/**
 * Submits `built` to `gateway` and classifies any rejection -- the shared
 * submit-and-classify tail both `createProvisionSubmitter` and
 * `createPaymentSubmitter` use, so the Horizon-error handling lives in
 * exactly one place regardless of which kind's submitter is calling it. A
 * Horizon `tx_bad_seq` result throws `StaleSequenceError`; anything else
 * throws `SubmissionFailedError` with a compact, storable/returnable
 * `reason`.
 */
async function submitAndClassify(gateway: StellarGateway, built: Transaction | FeeBumpTransaction): Promise<SubmitIntentResult> {
  try {
    const result = await gateway.submitTransaction(built);
    return {txHash: result.hash};
  } catch (err) {
    const codes = resultCodes(err);
    if (codes?.transaction === 'tx_bad_seq') {
      throw new StaleSequenceError();
    }
    throw new SubmissionFailedError(sanitizedReason(codes));
  }
}

/**
 * The `'provision'`-kind `IntentSubmitter`: the inner tx's source IS the
 * sponsor -- already sponsor-signed at build time (`wallet/service.ts`'s
 * `provision()` calls `tx.sign(sponsor)` right after building it). Built
 * submission is the inner tx unchanged (identity -- NOT fee-bumped:
 * wrapping a tx the sponsor already fully funds in a sponsor-paid fee-bump
 * would just make the sponsor pay twice for nothing) and submitted
 * directly. `inner` must already carry the merchant's signature (attached
 * via `attachRawSignature`) before `buildSubmission`/`submit` run.
 */
export function createProvisionSubmitter(gateway: StellarGateway): IntentSubmitter {
  return {
    activityType: 'provision',
    buildSubmission: (inner) => inner,
    submit: (built) => submitAndClassify(gateway, built)
  };
}

/**
 * The `'payment'`-kind `IntentSubmitter`: the inner tx's source is the
 * MERCHANT (who holds zero XLM), so `buildSubmission` wraps it in a
 * sponsor-signed fee-bump (`wrapFeeBump`) before submitting. `inner` must
 * already carry the merchant's signature before `buildSubmission`/`submit`
 * run.
 */
export function createPaymentSubmitter(sponsor: Keypair, gateway: StellarGateway): IntentSubmitter {
  return {
    activityType: 'send',
    buildSubmission: (inner) => wrapFeeBump(sponsor, inner),
    submit: (built) => submitAndClassify(gateway, built)
  };
}

// Same floor as `vault/defindex.ts`'s `SOROBAN_INVOKE_FEE` and
// `spike-privy-stellar.ts:227-231`'s adjustment comment: `wrapFeeBump`'s
// default 10,000-stroop baseFee is below a Soroban invoke tx's own
// ~1,000,000-stroop inclusion fee, so `buildFeeBumpTransaction` rejects that
// combination -- the fee-bump's baseFee must cover the inner tx's own fee.
const SOROBAN_INVOKE_FEE = '1000000';

/**
 * Submits `built` to `gateway` and classifies any rejection for Soroban
 * intents -- the RPC-submission counterpart to `submitAndClassify`, which
 * only ever talks to classic Horizon. `SorobanGateway.sendAndConfirm` throws
 * `SorobanSubmissionError` (never Horizon's raw Axios error shape
 * `resultCodes`/`sanitizedReason` above decode), so there is no
 * `tx_bad_seq`/`StaleSequenceError` classification here -- `reason` is
 * already a short, sanitized token per `SorobanSubmissionError`'s own doc
 * comment (`../../lib/soroban-gateway.ts`), passed straight through.
 */
async function submitAndClassifySoroban(gateway: SorobanGateway, built: Transaction | FeeBumpTransaction): Promise<SubmitIntentResult> {
  try {
    const result = await gateway.sendAndConfirm(built);
    return {txHash: result.txHash};
  } catch (err) {
    if (err instanceof SorobanSubmissionError) {
      throw new SubmissionFailedError(err.reason);
    }
    throw err;
  }
}

/**
 * The `'vault_deposit'`/`'vault_withdraw'`-kind `IntentSubmitter`s: the
 * inner tx's source is the MERCHANT (who holds zero XLM), same as
 * `createPaymentSubmitter`, so `buildSubmission` wraps it in a sponsor fee-bump
 * -- but at `SOROBAN_INVOKE_FEE`, not `wrapFeeBump`'s default, since the
 * inner tx is itself a Soroban invoke with a much higher inclusion fee than a
 * classic payment. Submission goes through Soroban RPC (`SorobanGateway.sendAndConfirm`),
 * not Horizon, since these are contract invocations, not classic-ledger
 * transactions. `inner` must already carry the merchant's signature before
 * `buildSubmission`/`submit` run.
 */
export function createSorobanSubmitter(
  sponsor: Keypair,
  soroban: SorobanGateway,
  activityType: 'vault_deposit' | 'vault_withdraw'
): IntentSubmitter {
  return {
    activityType,
    buildSubmission: (inner) => wrapFeeBump(sponsor, inner, SOROBAN_INVOKE_FEE),
    submit: (built) => submitAndClassifySoroban(soroban, built)
  };
}
