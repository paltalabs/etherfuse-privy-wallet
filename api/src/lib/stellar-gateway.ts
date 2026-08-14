import {NotFoundError, type FeeBumpTransaction, type Horizon, type Transaction} from '@stellar/stellar-sdk';

/**
 * A single balance line on a Stellar account, narrowed to the fields this
 * codebase actually consumes. `assetCode`/`assetIssuer` are omitted for the
 * native XLM balance and for liquidity-pool-share lines (Horizon's
 * `BalanceLineNative`/`BalanceLineLiquidityPool` carry no asset code).
 */
export interface StellarBalance {
  assetCode?: string;
  assetIssuer?: string;
  balance: string;
}

/**
 * The subset of a Stellar account this codebase needs: enough to serve as a
 * `TransactionBuilder` source (matches stellar-sdk's `Account` class shape —
 * `accountId()`/`sequenceNumber()`/`incrementSequenceNumber()`, all public,
 * so this interface is structurally assignable to `Account` with no cast)
 * plus its balances for `GET /wallet`.
 */
export interface StellarAccount {
  accountId(): string;
  sequenceNumber(): string;
  incrementSequenceNumber(): void;
  balances: StellarBalance[];
}

/** The result of a successful `StellarGateway.submitTransaction` call. */
export interface StellarSubmitResult {
  /** The confirmed transaction hash, as reported by Horizon. */
  hash: string;
}

/**
 * One record from Horizon's payments collection (`GET
 * /accounts/{id}/payments`), narrowed and camelCased for this codebase —
 * mirrors `StellarBalance`'s "translate Horizon's snake_case shape at the
 * gateway boundary" convention. `PaymentCallBuilder`'s real return union
 * (verified against the installed `@stellar/stellar-sdk@14.6.1` types,
 * `lib/horizon/payment_call_builder.d.ts`) is `PaymentOperationRecord |
 * CreateAccountOperationRecord | AccountMergeOperationRecord |
 * PathPaymentOperationRecord | PathPaymentStrictSendOperationRecord |
 * InvokeHostFunctionOperationRecord` — every operation type Horizon's
 * payments collection can return still comes through here with its real
 * `type` string, but only `'payment'`/`'create_account'` populate their
 * type-specific fields; the rest have those left `undefined`.
 * `modules/indexer/normalize.ts`'s `normalizePayment` is the only consumer,
 * and it treats any other `type` as a non-payment op to skip.
 */
export interface HorizonPaymentRecord {
  type: string;
  /** Horizon's paging_token for this record — callers advance their stored cursor to the last record's value in a batch. */
  pagingToken: string;
  transactionHash: string;
  createdAt: string;
  // 'payment'-only fields (undefined on every other record type).
  from?: string;
  to?: string;
  assetType?: string;
  assetCode?: string;
  assetIssuer?: string;
  amount?: string;
  // 'create_account'-only fields (undefined on every other record type).
  account?: string;
  funder?: string;
}

/**
 * The wallet/intents modules' view of Stellar Horizon, narrowed to what
 * those modules need.
 */
export interface StellarGateway {
  /**
   * Rejects with `StellarAccountNotFoundError` if the account does not exist
   * on-chain (mirrors Horizon's 404). Any other failure (network error,
   * Horizon outage, etc.) rejects with whatever error caused it, UNCHANGED —
   * callers must not treat every rejection as "account not found" (that
   * would mask real outages as empty/missing accounts).
   */
  loadAccount(publicKey: string): Promise<StellarAccount>;

  /**
   * Submit a signed transaction via classic Horizon `POST /transactions`
   * only — Soroban RPC submission goes through the separate
   * `SorobanGateway` (`api/src/lib/soroban-gateway.ts`), not this method.
   * Resolves with `{hash}` on success.
   *
   * On failure, rejects with WHATEVER the underlying Horizon call rejected
   * with, UNCHANGED — deliberately not translated the way `loadAccount`
   * translates a 404 into `StellarAccountNotFoundError`. Unlike `loadAccount`
   * (which goes through stellar-sdk's call-builder path and gets a typed
   * `NotFoundError`), `Horizon.Server#submitTransaction` re-rejects the raw
   * Axios error unchanged on failure (verified against the installed
   * `@stellar/stellar-sdk` — see `createHorizonGateway`'s implementation
   * comment). Callers that need to classify the failure (e.g. detecting a
   * stale-sequence `tx_bad_seq` rejection) inspect that raw Axios error
   * shape themselves — see `modules/sponsor/submit.ts`.
   */
  submitTransaction(tx: Transaction | FeeBumpTransaction): Promise<StellarSubmitResult>;

  /**
   * List an account's payments-collection records (Horizon `GET
   * /accounts/{accountId}/payments`), oldest-first, starting after `cursor`
   * (Horizon's paging token; `undefined` starts from the beginning of the
   * account's history), capped at `limit` records. Used by the indexer's
   * poller (`modules/indexer/poller.ts`) — no other module calls this yet.
   * Horizon's payments collection only returns operations belonging to
   * SUCCESSFUL transactions by default (`includeFailed` is never set here),
   * so every record returned is already confirmed on-chain.
   */
  listPayments(accountId: string, cursor: string | undefined, limit: number): Promise<HorizonPaymentRecord[]>;
}

/**
 * Thrown by `StellarGateway.loadAccount` specifically when the account does
 * not exist on-chain. Lets callers (e.g. `wallet/service.ts`'s `getWallet`)
 * distinguish "not provisioned yet" from a real Horizon/network failure via
 * `instanceof`, instead of a blanket catch that would silently turn an
 * outage into an empty-balances response.
 */
export class StellarAccountNotFoundError extends Error {
  constructor(publicKey: string) {
    super(`Stellar account not found: ${publicKey}`);
    this.name = 'StellarAccountNotFoundError';
  }
}

/**
 * Production `StellarGateway` wrapping a `Horizon.Server` instance.
 *
 * Horizon's own `Horizon.Server.loadAccount` rejects with `NotFoundError`
 * (a `NetworkError` subclass exported from `@stellar/stellar-sdk`) when the
 * account lookup 404s — verified directly against the installed package's
 * source (`node_modules/.pnpm/@stellar+stellar-sdk@14.6.1/node_modules/@stellar/stellar-sdk/lib/horizon/call_builder.js`:
 * `error.response.status === 404` maps to `new NotFoundError(...)`; any
 * other status maps to a plain `NetworkError`). This wrapper translates
 * `NotFoundError` specifically into our own `StellarAccountNotFoundError`
 * and rethrows everything else as-is, so `StellarGateway` consumers never
 * need to import a stellar-sdk error class themselves.
 */
export function createHorizonGateway(horizon: Horizon.Server): StellarGateway {
  return {
    async loadAccount(publicKey: string): Promise<StellarAccount> {
      let account: Horizon.AccountResponse;
      try {
        account = await horizon.loadAccount(publicKey);
      } catch (err) {
        if (err instanceof NotFoundError) {
          throw new StellarAccountNotFoundError(publicKey);
        }
        throw err;
      }
      return {
        accountId: () => account.accountId(),
        sequenceNumber: () => account.sequenceNumber(),
        incrementSequenceNumber: () => account.incrementSequenceNumber(),
        balances: account.balances.map((line) => ({
          assetCode: 'asset_code' in line ? line.asset_code : undefined,
          assetIssuer: 'asset_issuer' in line ? line.asset_issuer : undefined,
          balance: line.balance
        }))
      };
    },

    // FINDING (installed @stellar/stellar-sdk@14.6.1,
    // lib/horizon/server.js's submitTransaction method): its own `.catch`
    // handler always re-rejects the raw Axios error UNCHANGED — the
    // `response instanceof Error` guard beside it is unconditionally true
    // for a real Axios failure (an AxiosError IS an Error), so the
    // `BadResponseError` branch next to it is dead code in practice. This
    // differs from `loadAccount`'s call-builder path (`_handleNetworkError`),
    // which DOES translate a 404 into a typed `NotFoundError`. The result:
    // a submission failure surfaces here as a plain Axios error shape —
    // `err.response.data` is Horizon's JSON error body
    // (`HorizonApi.ErrorResponseData.TransactionFailed`), and the failure
    // code lives at `err.response.data.extras.result_codes.transaction`
    // (`HorizonApi.TransactionFailedResultCodes`, e.g. `'tx_bad_seq'`).
    // This method deliberately does NOT translate that shape — it just lets
    // `horizon.submitTransaction` reject as-is; see the `StellarGateway`
    // interface doc above and `modules/sponsor/submit.ts` for the consumer
    // that inspects it.
    async submitTransaction(tx) {
      const result = await horizon.submitTransaction(tx);
      return {hash: result.hash};
    },

    async listPayments(accountId, cursor, limit) {
      let builder = horizon.payments().forAccount(accountId).order('asc').limit(limit);
      if (cursor !== undefined) {
        builder = builder.cursor(cursor);
      }
      const page = await builder.call();
      return page.records.map(mapPaymentRecord);
    }
  };
}

/**
 * The exact union `PaymentCallBuilder.call()` resolves to (see
 * `HorizonPaymentRecord`'s doc comment for the verification trail).
 */
type HorizonRawPaymentRecord =
  | Horizon.ServerApi.PaymentOperationRecord
  | Horizon.ServerApi.CreateAccountOperationRecord
  | Horizon.ServerApi.AccountMergeOperationRecord
  | Horizon.ServerApi.PathPaymentOperationRecord
  | Horizon.ServerApi.PathPaymentStrictSendOperationRecord
  | Horizon.ServerApi.InvokeHostFunctionOperationRecord;

/** Maps one raw Horizon payments-collection record to `HorizonPaymentRecord` — see its doc comment. */
function mapPaymentRecord(record: HorizonRawPaymentRecord): HorizonPaymentRecord {
  const base: HorizonPaymentRecord = {
    type: record.type,
    pagingToken: record.paging_token,
    transactionHash: record.transaction_hash,
    createdAt: record.created_at
  };
  if (record.type === 'payment') {
    return {
      ...base,
      from: record.from,
      to: record.to,
      assetType: record.asset_type,
      assetCode: record.asset_code,
      assetIssuer: record.asset_issuer,
      amount: record.amount
    };
  }
  if (record.type === 'create_account') {
    return {...base, account: record.account, funder: record.funder};
  }
  return base;
}
