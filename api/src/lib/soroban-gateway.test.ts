import {
  Account,
  Contract,
  Keypair,
  Networks,
  rpc,
  SorobanDataBuilder,
  TransactionBuilder,
  xdr,
  type Transaction
} from '@stellar/stellar-sdk';
import {describe, expect, it, vi} from 'vitest';
import {createSorobanGateway, SorobanSimulationError, SorobanSubmissionError} from './soroban-gateway.js';

// A real, valid-format testnet contract strkey, reused here only for its
// valid checksum -- never invoked live. Kept as a local literal rather than
// importing `config/vaults.ts` so this test has no dependency on that
// module.
const TEST_CONTRACT_ID = 'CDTWG3OZERPUCD42KVZQUCOECYWUQ5HHFT6VFRTGKKVW46VSNQ3WOBYF';

/**
 * A minimal, REAL invoke-tx draft -- a genuine `TransactionBuilder` output,
 * not a stub -- so `simulateAndAssemble`/`simulateRead` run their
 * `rpc.Api.isSimulationSuccess`/`JSON.stringify`/`sim.result.retval` logic
 * against real stellar-sdk `Transaction`/`xdr` types, the same pattern
 * `api/scripts/spike-privy-stellar.ts:216-223` uses live.
 */
function buildDraft(): Transaction {
  const account = new Account(Keypair.random().publicKey(), '0');
  return new TransactionBuilder(account, {fee: '1000000', networkPassphrase: Networks.TESTNET})
    .addOperation(new Contract(TEST_CONTRACT_ID).call('balance'))
    .setTimeout(300)
    .build();
}

/** Minimal fake `rpc.Server` -- only the methods `createSorobanGateway` calls. */
function fakeServer(
  overrides: Partial<Pick<rpc.Server, 'simulateTransaction' | 'sendTransaction' | 'pollTransaction' | 'getEvents' | 'getLatestLedger'>>
): rpc.Server {
  return overrides as unknown as rpc.Server;
}

/** A stubbed `Api.SimulateTransactionSuccessResponse` with a real, working `SorobanDataBuilder` so `rpc.assembleTransaction` can actually build a `Transaction` from it (verified against the installed SDK's `assembleTransaction`, see the module's doc comment). */
function successSim(retval: xdr.ScVal): rpc.Api.SimulateTransactionSuccessResponse {
  return {
    _parsed: true,
    id: 'req-id',
    latestLedger: 100,
    events: [],
    transactionData: new SorobanDataBuilder(),
    minResourceFee: '100',
    result: {auth: [], retval}
  } as unknown as rpc.Api.SimulateTransactionSuccessResponse;
}

function errorSim(error: string): rpc.Api.SimulateTransactionErrorResponse {
  return {
    _parsed: true,
    id: 'req-id',
    latestLedger: 100,
    events: [],
    error
  } as unknown as rpc.Api.SimulateTransactionErrorResponse;
}

/**
 * A stubbed restore-required response — shaped like a success (extends it),
 * with a `restorePreamble` field added to indicate restoration is needed.
 */
function restoreSim(): rpc.Api.SimulateTransactionRestoreResponse {
  return {
    _parsed: true,
    id: 'req-id',
    latestLedger: 100,
    events: [],
    transactionData: new SorobanDataBuilder(),
    minResourceFee: '100',
    restorePreamble: {
      minResourceFee: '0',
      transactionData: new SorobanDataBuilder()
    }
  } as unknown as rpc.Api.SimulateTransactionRestoreResponse;
}

describe('createSorobanGateway', () => {
  describe('simulateAndAssemble', () => {
    it('throws SorobanSimulationError on a simulation-error response', async () => {
      const server = fakeServer({simulateTransaction: vi.fn().mockResolvedValue(errorSim('HostError: Error(Contract, #1)'))});
      const gateway = createSorobanGateway(server);

      await expect(gateway.simulateAndAssemble(buildDraft())).rejects.toBeInstanceOf(SorobanSimulationError);
    });

    it('assembles a successful simulation into a signable Transaction', async () => {
      const server = fakeServer({simulateTransaction: vi.fn().mockResolvedValue(successSim(xdr.ScVal.scvVoid()))});
      const gateway = createSorobanGateway(server);

      const assembled = await gateway.simulateAndAssemble(buildDraft());

      expect(assembled.operations[0]?.type).toBe('invokeHostFunction');
    });
  });

  describe('simulateRead', () => {
    it('returns the stubbed retval on success', async () => {
      const retval = xdr.ScVal.scvI32(42);
      const server = fakeServer({simulateTransaction: vi.fn().mockResolvedValue(successSim(retval))});
      const gateway = createSorobanGateway(server);

      const result = await gateway.simulateRead(buildDraft());

      expect(result).toBe(retval);
    });

    it('throws SorobanSimulationError on a simulation-error response', async () => {
      const server = fakeServer({simulateTransaction: vi.fn().mockResolvedValue(errorSim('HostError: Error(Contract, #1)'))});
      const gateway = createSorobanGateway(server);

      await expect(gateway.simulateRead(buildDraft())).rejects.toBeInstanceOf(SorobanSimulationError);
    });

    it('throws SorobanSimulationError when a successful simulation carries no result (not an invocation)', async () => {
      const noResult = {
        _parsed: true,
        id: 'req-id',
        latestLedger: 100,
        events: [],
        transactionData: new SorobanDataBuilder(),
        minResourceFee: '100'
      } as unknown as rpc.Api.SimulateTransactionSuccessResponse;
      const server = fakeServer({simulateTransaction: vi.fn().mockResolvedValue(noResult)});
      const gateway = createSorobanGateway(server);

      await expect(gateway.simulateRead(buildDraft())).rejects.toBeInstanceOf(SorobanSimulationError);
    });

    it('throws SorobanSimulationError with detail "restore_required" when a simulation requires restoration', async () => {
      const server = fakeServer({simulateTransaction: vi.fn().mockResolvedValue(restoreSim())});
      const gateway = createSorobanGateway(server);

      const rejection = gateway.simulateRead(buildDraft());

      await expect(rejection).rejects.toBeInstanceOf(SorobanSimulationError);
      await expect(rejection).rejects.toMatchObject({detail: 'restore_required'});
    });
  });

  describe('sendAndConfirm', () => {
    it('resolves {txHash} when send + poll both report SUCCESS', async () => {
      const server = fakeServer({
        sendTransaction: vi.fn().mockResolvedValue({status: 'PENDING', hash: 'deadbeef', latestLedger: 1, latestLedgerCloseTime: 1}),
        pollTransaction: vi.fn().mockResolvedValue({
          status: rpc.Api.GetTransactionStatus.SUCCESS,
          txHash: 'deadbeef',
          latestLedger: 2,
          latestLedgerCloseTime: 2,
          oldestLedger: 1,
          oldestLedgerCloseTime: 1
        })
      });
      const gateway = createSorobanGateway(server);

      const result = await gateway.sendAndConfirm({} as never);

      expect(result).toEqual({txHash: 'deadbeef'});
    });

    it('throws SorobanSubmissionError with reason "send_error" immediately when send status is ERROR, without polling', async () => {
      const pollTransaction = vi.fn();
      const server = fakeServer({
        sendTransaction: vi.fn().mockResolvedValue({status: 'ERROR', hash: 'deadbeef', latestLedger: 1, latestLedgerCloseTime: 1}),
        pollTransaction
      });
      const gateway = createSorobanGateway(server);

      const rejection = gateway.sendAndConfirm({} as never);

      await expect(rejection).rejects.toBeInstanceOf(SorobanSubmissionError);
      await expect(rejection).rejects.toMatchObject({reason: 'send_error'});
      expect(pollTransaction).not.toHaveBeenCalled();
    });

    it('throws SorobanSubmissionError with reason "tx_failed" when polling settles on FAILED', async () => {
      const server = fakeServer({
        sendTransaction: vi.fn().mockResolvedValue({status: 'PENDING', hash: 'deadbeef', latestLedger: 1, latestLedgerCloseTime: 1}),
        pollTransaction: vi.fn().mockResolvedValue({
          status: rpc.Api.GetTransactionStatus.FAILED,
          txHash: 'deadbeef',
          latestLedger: 2,
          latestLedgerCloseTime: 2,
          oldestLedger: 1,
          oldestLedgerCloseTime: 1
        })
      });
      const gateway = createSorobanGateway(server);

      await expect(gateway.sendAndConfirm({} as never)).rejects.toMatchObject({reason: 'tx_failed'});
    });

    it('throws SorobanSubmissionError with reason "tx_not_found" when polling exhausts attempts as NOT_FOUND', async () => {
      const server = fakeServer({
        sendTransaction: vi.fn().mockResolvedValue({status: 'PENDING', hash: 'deadbeef', latestLedger: 1, latestLedgerCloseTime: 1}),
        pollTransaction: vi.fn().mockResolvedValue({
          status: rpc.Api.GetTransactionStatus.NOT_FOUND,
          txHash: 'deadbeef',
          latestLedger: 2,
          latestLedgerCloseTime: 2,
          oldestLedger: 1,
          oldestLedgerCloseTime: 1
        })
      });
      const gateway = createSorobanGateway(server);

      await expect(gateway.sendAndConfirm({} as never)).rejects.toMatchObject({reason: 'tx_not_found'});
    });

    it('polls with {attempts: 30}', async () => {
      const pollTransaction = vi.fn().mockResolvedValue({
        status: rpc.Api.GetTransactionStatus.SUCCESS,
        txHash: 'deadbeef',
        latestLedger: 2,
        latestLedgerCloseTime: 2,
        oldestLedger: 1,
        oldestLedgerCloseTime: 1
      });
      const server = fakeServer({
        sendTransaction: vi.fn().mockResolvedValue({status: 'PENDING', hash: 'deadbeef', latestLedger: 1, latestLedgerCloseTime: 1}),
        pollTransaction
      });
      const gateway = createSorobanGateway(server);

      await gateway.sendAndConfirm({} as never);

      expect(pollTransaction).toHaveBeenCalledWith('deadbeef', {attempts: 30});
    });
  });

  describe('getContractEvents', () => {
    function fakeEvent(overrides: Partial<rpc.Api.EventResponse> = {}): rpc.Api.EventResponse {
      return {
        id: 'evt-1',
        type: 'contract',
        ledger: 100,
        ledgerClosedAt: '2026-07-24T00:00:00Z',
        transactionIndex: 1,
        operationIndex: 0,
        inSuccessfulContractCall: true,
        txHash: 'txhash',
        contractId: new Contract(TEST_CONTRACT_ID),
        topic: [xdr.ScVal.scvSymbol('deposit')],
        value: xdr.ScVal.scvVoid(),
        ...overrides
      };
    }

    function fakeEventsResponse(events: rpc.Api.EventResponse[], cursor = 'next-cursor', latestLedger = 200): rpc.Api.GetEventsResponse {
      return {events, cursor, latestLedger, oldestLedger: 1, latestLedgerCloseTime: '1', oldestLedgerCloseTime: '1'};
    }

    it('maps the stubbed response to the narrow SorobanContractEvent/SorobanEventsPage shape', async () => {
      const getEvents = vi.fn().mockResolvedValue(fakeEventsResponse([fakeEvent()]));
      const server = fakeServer({getEvents});
      const gateway = createSorobanGateway(server);

      const page = await gateway.getContractEvents({contractId: TEST_CONTRACT_ID, startLedger: 50, limit: 10});

      expect(page).toEqual({
        events: [
          {
            id: 'evt-1',
            ledger: 100,
            contractId: TEST_CONTRACT_ID,
            txHash: 'txhash',
            topics: [xdr.ScVal.scvSymbol('deposit')],
            value: xdr.ScVal.scvVoid()
          }
        ],
        cursor: 'next-cursor',
        latestLedger: 200
      });
    });

    it('passes startLedger through to server.getEvents when no cursor is given', async () => {
      const getEvents = vi.fn().mockResolvedValue(fakeEventsResponse([]));
      const server = fakeServer({getEvents});
      const gateway = createSorobanGateway(server);

      await gateway.getContractEvents({contractId: TEST_CONTRACT_ID, startLedger: 42, limit: 10});

      expect(getEvents).toHaveBeenCalledWith({
        filters: [{type: 'contract', contractIds: [TEST_CONTRACT_ID]}],
        startLedger: 42,
        limit: 10
      });
    });

    it('passes cursor through to server.getEvents and drops startLedger when both are given (cursor wins)', async () => {
      const getEvents = vi.fn().mockResolvedValue(fakeEventsResponse([]));
      const server = fakeServer({getEvents});
      const gateway = createSorobanGateway(server);

      await gateway.getContractEvents({contractId: TEST_CONTRACT_ID, startLedger: 42, cursor: 'saved-cursor', limit: 10});

      expect(getEvents).toHaveBeenCalledWith({
        filters: [{type: 'contract', contractIds: [TEST_CONTRACT_ID]}],
        cursor: 'saved-cursor',
        limit: 10
      });
    });

    it('falls back to the requested contractId when a mapped event carries none (RPC always populates it for a single-contract filter; defensive only)', async () => {
      const getEvents = vi.fn().mockResolvedValue(fakeEventsResponse([fakeEvent({contractId: undefined})]));
      const server = fakeServer({getEvents});
      const gateway = createSorobanGateway(server);

      const page = await gateway.getContractEvents({contractId: TEST_CONTRACT_ID, startLedger: 1, limit: 10});

      expect(page.events[0]?.contractId).toBe(TEST_CONTRACT_ID);
    });

    it('rejects when neither startLedger nor cursor is given', async () => {
      const server = fakeServer({getEvents: vi.fn()});
      const gateway = createSorobanGateway(server);

      await expect(gateway.getContractEvents({contractId: TEST_CONTRACT_ID, limit: 10})).rejects.toThrow(/startLedger|cursor/);
    });
  });

  describe('getLatestLedger', () => {
    it('returns the ledger sequence number', async () => {
      const server = fakeServer({getLatestLedger: vi.fn().mockResolvedValue({id: 'ledger-id', sequence: 12345, protocolVersion: '21'})});
      const gateway = createSorobanGateway(server);

      await expect(gateway.getLatestLedger()).resolves.toBe(12345);
    });
  });
});
