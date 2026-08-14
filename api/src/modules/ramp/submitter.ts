import type {FeeBumpTransaction, Keypair, Transaction} from '@stellar/stellar-sdk';
import type {StellarGateway} from '../../lib/stellar-gateway.js';
import type {IntentSubmitter} from '../intents/service.js';
import {txHashHex, wrapFeeBump} from '../sponsor/stellar.js';
import {SubmissionFailedError} from '../sponsor/submit.js';

/**
 * The `'payout'`-kind `IntentSubmitter` for Etherfuse's ANCHOR-mode off-ramp
 * (`docs/modules/api-ramp.md`'s payout section). The inner tx's source is
 * the MERCHANT (who holds zero XLM), same as `createPaymentSubmitter`
 * (`../sponsor/submit.ts`), so `buildSubmission` wraps it in a sponsor-signed
 * fee-bump at `wrapFeeBump`'s default classic baseFee — a payout is a plain
 * classic payment op to the anchor account, not a Soroban invoke, so no
 * elevated fee floor is needed.
 *
 * **No `RampProvider` dependency** — this submitter never calls back into
 * Etherfuse at all. Anchor mode needs no provider round-trip to submit the
 * payment: the merchant's signed transaction IS the withdrawal —
 * `ramp/service.ts`'s `createPayout`
 * already resolved the anchor account + memo from
 * `provider.createAnchorOfframpOrder` at INTENT-CREATION time, so by the
 * time this submitter runs there is nothing left to ask Etherfuse for. It
 * submits straight to `StellarGateway.submitTransaction` (classic Horizon),
 * exactly like `createPaymentSubmitter` does, and resolves with ITS OWN
 * precomputed hash — never a gateway-reported one, matching every other
 * submitter's convention (`intents/service.ts`'s `complete()` already
 * precomputes and stores this same hash before `submit` ever runs).
 *
 * Deliberately defined here in `ramp/`, not alongside the other
 * `IntentSubmitter` factories in `../sponsor/submit.ts` — this module owns
 * its own submission semantics (the payout is a `ramp`-produced intent).
 * Only `SubmissionFailedError` is imported FROM `sponsor/submit.ts` (the
 * shared failure-classification type every `IntentSubmitter` throws), not
 * the reverse.
 *
 * `submit`'s failure mapping is deliberately flat — ANY `gateway.submitTransaction`
 * rejection becomes `SubmissionFailedError('submission_failed')`, unlike
 * `sponsor/submit.ts`'s `submitAndClassify` (which parses Horizon's
 * `result_codes` to distinguish `tx_bad_seq`/pin a per-operation reason).
 * That richer classifier is module-private to `sponsor/submit.ts` (not
 * exported) and re-deriving it here for a single call site was judged not
 * worth the duplication for this MVP; a stale-sequence payout submission
 * simply surfaces as a generic `submission_failed` 502 instead of the
 * dedicated `intent_expired` 409 the other submitters get.
 */
export function createPayoutSubmitter(sponsor: Keypair, gateway: StellarGateway): IntentSubmitter {
  return {
    activityType: 'off_ramp',

    buildSubmission: (inner: Transaction) => wrapFeeBump(sponsor, inner),

    async submit(built: Transaction | FeeBumpTransaction) {
      try {
        await gateway.submitTransaction(built);
      } catch {
        throw new SubmissionFailedError('submission_failed');
      }

      // Our own submitted fee-bump's hash -- deliberately NOT anything
      // Horizon/the gateway reports back. Stripped of txHashHex's 0x prefix
      // so it matches Horizon's own hash format -- the same convention
      // intents/service.ts's precomputed hash and createPaymentSubmitter's
      // submitAndClassify both use.
      return {txHash: txHashHex(built).replace(/^0x/, '')};
    }
  };
}
