import type {AssetRegistry} from '@paltalabs/shared';
import type {HorizonPaymentRecord} from '../../lib/stellar-gateway.js';

/**
 * A normalized activity row, ready for `activity` table insertion — the
 * indexer's output for one Horizon payments-feed record that survived
 * normalization. Always `source: 'indexer'` and `status: 'confirmed'`:
 * Horizon's payments collection only returns operations of SUCCESSFUL
 * transactions by default (`StellarGateway.listPayments`'s doc comment —
 * `includeFailed` is never set), so anything reaching this shape is already
 * confirmed on-chain.
 */
export interface ActivityInsert {
  stellarAddress: string;
  type: 'provision' | 'send' | 'receive';
  direction: 'in' | 'out' | null;
  amount: string | null;
  assetCode: string | null;
  assetIssuer: string | null;
  counterparty: string | null;
  status: 'confirmed';
  txHash: string;
  source: 'indexer';
}

/**
 * Pure normalization of one Horizon payments-feed record into an
 * `ActivityInsert`, or `null` if the record should be skipped entirely:
 *
 * - `'create_account'` -> `'provision'`, only when `ownAddress` is the
 *   CREATED account (`record.account`) — a create_account op where
 *   `ownAddress` is merely the funder/sponsor leg is not this account's
 *   provisioning event (`null`).
 * - `'payment'` -> `'receive'` (`ownAddress === record.to`) or `'send'`
 *   (`ownAddress === record.from`); neither matching is `null` (defensive —
 *   shouldn't happen given `listPayments` is scoped `forAccount(ownAddress)`,
 *   but the dedupe key needs a definite direction, so this is a hard
 *   boundary, not a best-effort guess). Native XLM (`assetType === 'native'`,
 *   no `assetCode`) and any asset not in `registry` are also skipped —
 *   same registry-boundary rule `wallet/service.ts`'s `getWallet` enforces
 *   on live balances (`docs/modules/api-wallet.md`'s Gotchas): a foreign
 *   issuer sharing a registry asset's code must never be normalized as the
 *   genuine asset.
 * - Every other operation type Horizon's payments collection can return
 *   (`account_merge`, `path_payment_strict_receive`/`_send`,
 *   `invoke_host_function`) -> `null`, out of scope for this MVP.
 *
 * Deliberately takes `registry` as an explicit third parameter rather than
 * closing over it in a factory — keeps this pure and trivially
 * unit-testable with a plain `AssetRegistry` instance per test case.
 */
export function normalizePayment(
  record: HorizonPaymentRecord,
  ownAddress: string,
  registry: AssetRegistry
): ActivityInsert | null {
  if (record.type === 'create_account') {
    if (record.account !== ownAddress) return null;
    return {
      stellarAddress: ownAddress,
      type: 'provision',
      direction: null,
      amount: null,
      assetCode: null,
      assetIssuer: null,
      counterparty: record.funder ?? null,
      status: 'confirmed',
      txHash: record.transactionHash,
      source: 'indexer'
    };
  }

  if (record.type === 'payment') {
    if (record.to !== ownAddress && record.from !== ownAddress) return null;
    if (record.assetType === 'native') return null;
    if (!record.assetCode || !record.assetIssuer) return null;
    if (!isRegistryAsset(registry, record.assetCode, record.assetIssuer)) return null;

    const direction: 'in' | 'out' = record.to === ownAddress ? 'in' : 'out';
    return {
      stellarAddress: ownAddress,
      type: direction === 'in' ? 'receive' : 'send',
      direction,
      amount: record.amount ?? null,
      assetCode: record.assetCode,
      assetIssuer: record.assetIssuer,
      counterparty: (direction === 'in' ? record.from : record.to) ?? null,
      status: 'confirmed',
      txHash: record.transactionHash,
      source: 'indexer'
    };
  }

  // Non-payment op (account_merge, path_payment_*, invoke_host_function, ...).
  return null;
}

/** `(code, issuer)` exact-pair membership check — see `normalizePayment`'s doc comment for why code alone is never enough. */
function isRegistryAsset(registry: AssetRegistry, code: string, issuer: string): boolean {
  return registry.list().some((asset) => asset.code === code && asset.issuer === issuer);
}
