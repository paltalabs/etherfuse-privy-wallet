import {type FeeBumpTransaction, rpc, type Transaction, xdr} from '@stellar/stellar-sdk';

/** One decoded contract event from RPC getEvents, narrowed for this codebase. */
export interface SorobanContractEvent {
  /** RPC event id — doubles as the resumption cursor. */
  id: string;
  ledger: number;
  contractId: string;
  txHash: string;
  /** Raw topic ScVals — consumers decode with scValToNative. */
  topics: xdr.ScVal[];
  value: xdr.ScVal;
}

export interface SorobanEventsPage {
  events: SorobanContractEvent[];
  /** Pass back as `cursor` to resume after the last returned event. */
  cursor: string;
  latestLedger: number;
}

/**
 * Thrown by `simulateAndAssemble`/`simulateRead` when `server.simulateTransaction`
 * returns an error response (`rpc.Api.isSimulationSuccess` false) or when a simulation
 * requires restoration (restore-footprint preamble). `detail` is the RPC's own diagnostic
 * string (`sim.error`, JSON-stringified, or the literal token `'restore_required'`) —
 * simulation errors carry no credentials, so nothing is stripped before it's surfaced.
 *
 * **IMPORTANT:** `detail` is a server-side diagnostic only and must never be forwarded
 * into HTTP error envelopes — HTTP layers must map this error to a fixed short sanitized
 * token (mirroring `modules/sponsor/submit.ts`'s `SubmissionFailedError.reason` convention),
 * never expose the raw diagnostic string to clients.
 */
export class SorobanSimulationError extends Error {
  constructor(public readonly detail: string) {
    super(`Soroban simulation failed: ${detail}`);
    this.name = 'SorobanSimulationError';
  }
}

/**
 * Thrown by `sendAndConfirm` when either `server.sendTransaction` reports
 * `'ERROR'` immediately or the subsequent `server.pollTransaction` never
 * reaches `SUCCESS`. `reason` is a short, sanitized token —
 * `'send_error'`/`'tx_failed'`/`'tx_not_found'` — never a raw XDR dump,
 * mirroring `modules/sponsor/submit.ts`'s `SubmissionFailedError.reason`
 * convention (safe to store/return as-is).
 */
export class SorobanSubmissionError extends Error {
  constructor(public readonly reason: string) {
    super(`Soroban submission failed: ${reason}`);
    this.name = 'SorobanSubmissionError';
  }
}

/**
 * The vault/events-poller modules' view of Soroban RPC, narrowed to what
 * those modules need — sibling to `stellar-gateway.ts`'s `StellarGateway`
 * (that one wraps classic Horizon; this one wraps Soroban RPC's
 * `rpc.Server`, which serves contract simulation/submission/events instead).
 */
export interface SorobanGateway {
  /** Simulate a draft invoke tx and assemble it (resource fees + auth). Throws SorobanSimulationError. */
  simulateAndAssemble(draft: Transaction): Promise<Transaction>;
  /** Read-only call: simulate and return the result ScVal without ever submitting. Throws SorobanSimulationError. */
  simulateRead(draft: Transaction): Promise<xdr.ScVal>;
  /** Send a signed tx and poll to a terminal status. Resolves {txHash} on SUCCESS; throws SorobanSubmissionError otherwise. */
  sendAndConfirm(tx: Transaction | FeeBumpTransaction): Promise<{txHash: string}>;
  /** Contract-events page for one contract, from a ledger or a saved cursor (cursor wins when both given). */
  getContractEvents(req: {contractId: string; startLedger?: number; cursor?: string; limit: number}): Promise<SorobanEventsPage>;
  getLatestLedger(): Promise<number>;
}

/**
 * Runs `server.simulateTransaction` and narrows it to the success variant,
 * throwing `SorobanSimulationError` otherwise. Shared by `simulateAndAssemble`
 * and `simulateRead` — both need the same guard before doing anything
 * result-specific.
 *
 * `rpc.Api.isSimulationSuccess` is implemented as `"transactionData" in sim`
 * (installed `@stellar/stellar-sdk@14.6.1`,
 * `lib/rpc/api.js:20-22`) — true for both a plain success AND a "restoration
 * needed" response (`Api.SimulateTransactionRestoreResponse` extends the
 * success shape, `lib/rpc/api.d.ts:349-363`). After the success check passes,
 * we explicitly check `rpc.Api.isSimulationRestore(sim)` and fail closed
 * (throw `SorobanSimulationError('restore_required')`) if restoration is
 * required. Archived-entry restoration is out of scope for this gateway;
 * callers see a distinguishable `restore_required` detail token and can
 * decide whether to retry with a footprint preamble or bail.
 *
 * `Api.SimulateTransactionErrorResponse.error` is always a defined `string`
 * (`lib/rpc/api.d.ts:345-348`, non-optional) once `isSimulationSuccess` is
 * false, so `sim.error` is always safe to read on the thrown path — the `??
 * sim` fallback guards only a future SDK version that might add another
 * union member.
 */
async function simulate(server: rpc.Server, draft: Transaction): Promise<rpc.Api.SimulateTransactionSuccessResponse> {
  const sim = await server.simulateTransaction(draft);
  if (!rpc.Api.isSimulationSuccess(sim)) {
    throw new SorobanSimulationError(JSON.stringify(sim.error ?? sim));
  }
  if (rpc.Api.isSimulationRestore(sim)) {
    throw new SorobanSimulationError('restore_required');
  }
  return sim;
}

/**
 * Maps one raw `getEvents` record (`rpc.Api.EventResponse`) to
 * `SorobanContractEvent`. Two field-shape findings verified against the
 * installed `@stellar/stellar-sdk@14.6.1` types
 * (`lib/rpc/api.d.ts:238-242`) — worth double-checking on any future SDK
 * bump, since these are exactly the kind of field renamed across a v14 minor:
 * - `contractId` is `Contract | undefined` (a class instance, NOT a string) —
 *   the numeric/base32 id comes from calling `.contractId()` on it
 *   (`@stellar/stellar-base@14.1.0`'s `Contract.contractId(): string`,
 *   `types/index.d.ts:28-31`), same as `api/scripts/spike-vault.ts:242`'s
 *   `event.contractId?.contractId()`. It's optional on the raw response, but
 *   every call here filters `getEvents` by a single `contractIds: [contractId]`,
 *   so `req.contractId` (the value that was filtered on) is used as the
 *   fallback rather than throwing.
 * - the topics field is named `topic` (singular), not `topics`.
 */
function mapEvent(event: rpc.Api.EventResponse, requestedContractId: string): SorobanContractEvent {
  return {
    id: event.id,
    ledger: event.ledger,
    contractId: event.contractId?.contractId() ?? requestedContractId,
    txHash: event.txHash,
    topics: event.topic,
    value: event.value
  };
}

/**
 * Production `SorobanGateway` wrapping an `rpc.Server` instance — the
 * Soroban-RPC counterpart to `stellar-gateway.ts`'s `createHorizonGateway`.
 */
export function createSorobanGateway(server: rpc.Server): SorobanGateway {
  return {
    async simulateAndAssemble(draft) {
      const sim = await simulate(server, draft);
      // `rpc.assembleTransaction` (installed SDK, `lib/rpc/transaction.d.ts:21`)
      // returns a `TransactionBuilder`, not a `Transaction` — `.build()` is
      // required to get a signable tx, the same pattern already proven at
      // `api/scripts/spike-privy-stellar.ts:224-226`.
      return rpc.assembleTransaction(draft, sim).build();
    },

    async simulateRead(draft) {
      const sim = await simulate(server, draft);
      // `SimulateTransactionSuccessResponse.result` is `SimulateHostFunctionResult
      // | undefined` — "present only for invocation simulation"
      // (`lib/rpc/api.d.ts:339-340`). A draft with no invoke op would simulate
      // successfully but carry no result; that's still a caller error for a
      // read, not a submission concern, so it's raised as SorobanSimulationError.
      if (!sim.result) {
        throw new SorobanSimulationError('simulation succeeded but returned no result (not an invocation)');
      }
      return sim.result.retval;
    },

    async sendAndConfirm(tx) {
      const sendResult = await server.sendTransaction(tx);
      // `Api.SendTransactionStatus` (`lib/rpc/api.d.ts:277`) is
      // `'PENDING' | 'DUPLICATE' | 'TRY_AGAIN_LATER' | 'ERROR'` — only
      // `'ERROR'` means the network rejected the tx outright (bad XDR,
      // insufficient fee, etc.) without ever enqueueing it, so there is
      // nothing to poll for.
      if (sendResult.status === 'ERROR') {
        throw new SorobanSubmissionError('send_error');
      }
      const result = await server.pollTransaction(sendResult.hash, {attempts: 30});
      if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) {
        return {txHash: sendResult.hash};
      }
      // `Api.GetTransactionStatus` (`lib/rpc/api.d.ts:49-53`) has exactly
      // three members — SUCCESS (handled above), FAILED, and NOT_FOUND (the
      // poll exhausted its attempts without the tx ever landing) — so this
      // covers every remaining case explicitly rather than a generic default.
      const reason = result.status === rpc.Api.GetTransactionStatus.NOT_FOUND ? 'tx_not_found' : 'tx_failed';
      throw new SorobanSubmissionError(reason);
    },

    async getContractEvents(req) {
      const {contractId, startLedger, cursor, limit} = req;
      const filters: rpc.Api.EventFilter[] = [{type: 'contract', contractIds: [contractId]}];
      // `Api.GetEventsRequest` (`lib/rpc/api.d.ts:221-233`) is a discriminated
      // union that enforces cursor/startLedger as mutually exclusive at the
      // type level (each variant types the other as `never`) — branching
      // here (rather than one object literal with both keys) is required for
      // it to type-check, and also implements "cursor wins when both given".
      let response: rpc.Api.GetEventsResponse;
      if (cursor !== undefined) {
        response = await server.getEvents({filters, cursor, limit});
      } else if (startLedger !== undefined) {
        response = await server.getEvents({filters, startLedger, limit});
      } else {
        throw new Error('getContractEvents requires a startLedger or a cursor');
      }
      return {
        events: response.events.map((event) => mapEvent(event, contractId)),
        cursor: response.cursor,
        latestLedger: response.latestLedger
      };
    },

    async getLatestLedger() {
      const response = await server.getLatestLedger();
      return response.sequence;
    }
  };
}
