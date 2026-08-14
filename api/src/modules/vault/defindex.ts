import {toStroops, type AssetRegistry} from '@paltalabs/shared';
import {Address, Contract, nativeToScVal, scValToNative, TransactionBuilder, type Transaction, type xdr} from '@stellar/stellar-sdk';
import type {VaultConfig} from '../../config/vaults.js';
import type {SorobanGateway} from '../../lib/soroban-gateway.js';
import {StellarAccountNotFoundError, type StellarGateway} from '../../lib/stellar-gateway.js';
import {txHashHex} from '../sponsor/stellar.js';
import type {UnsignedVaultTx, VaultPosition, VaultProvider} from './provider.js';

export interface DefindexProviderDeps {
  soroban: SorobanGateway;
  /** Merchant sequence numbers only — narrowed the same way `sponsor/submit.ts` narrows its Horizon dependency. */
  horizon: Pick<StellarGateway, 'loadAccount'>;
  vault: VaultConfig;
  registry: AssetRegistry;
  networkPassphrase: string;
}

// Same constant + rationale as `api/scripts/spike-vault.ts:62` / the
// `wrapFeeBump` gotcha documented in `docs/modules/api-sponsor.md`: an
// assembled Soroban invoke tx's inclusion fee must be at or above this floor,
// confirmed live on testnet (default 10,000-stroop fee is rejected).
const SOROBAN_INVOKE_FEE = '1000000';
const TX_TIMEOUT_SECONDS = 300;
const ZERO_VAULT_POSITION: VaultPosition = {shares: '0.0000000', underlyingBalance: '0.0000000'};

/**
 * Stroops (bigint) -> 7dp decimal string; the inverse of `toStroops`
 * (`@paltalabs/shared`, `packages/shared/src/api.ts:101`). Pure BigInt
 * math throughout — safe past `Number.MAX_SAFE_INTEGER`, unlike a
 * `Number(stroops) / 1e7` conversion. Exported for direct unit testing; not
 * part of `VaultProvider`'s public surface.
 */
export function fromStroops(stroops: bigint): string {
  const negative = stroops < 0n;
  const abs = negative ? -stroops : stroops;
  const whole = abs / 10_000_000n;
  const frac = (abs % 10_000_000n).toString().padStart(7, '0');
  return `${negative ? '-' : ''}${whole.toString()}.${frac}`;
}

/**
 * Production `VaultProvider` for the DeFindex vault: builds unsigned,
 * assembled deposit/withdraw invocations and reads a merchant's position.
 * Every arg-encoding/simulation pattern here mirrors the proven live
 * round-trip in `api/scripts/spike-vault.ts` (`invokeVault`/`simulateRead`)
 * — see `docs/modules/api-vault.md` for the full trace.
 */
export function createDefindexProvider(deps: DefindexProviderDeps): VaultProvider {
  const {soroban, horizon, vault, networkPassphrase} = deps;
  const contract = new Contract(vault.address);

  /**
   * Loads the merchant account (for its sequence number) and builds one
   * invoke draft — the shared shape behind every call this provider makes.
   * Reloads the account fresh per call rather than reusing one `Account`
   * object across multiple builds, mirroring `spike-vault.ts`'s
   * `invokeVault`/`simulateRead` helpers: `TransactionBuilder.build()`
   * increments the source account's sequence number as a side effect, so
   * reusing one loaded account across two drafts would silently give the
   * second draft a sequence number one past what `loadAccount` actually
   * reported.
   */
  async function buildDraft(merchantAddress: string, method: string, args: xdr.ScVal[]): Promise<Transaction> {
    const account = await horizon.loadAccount(merchantAddress);
    return new TransactionBuilder(account, {fee: SOROBAN_INVOKE_FEE, networkPassphrase})
      .addOperation(contract.call(method, ...args))
      .setTimeout(TX_TIMEOUT_SECONDS)
      .build();
  }

  return {
    async buildDepositTx(merchantAddress, amount) {
      const stroops = toStroops(amount);
      const draft = await buildDraft(merchantAddress, 'deposit', [
        nativeToScVal([stroops], {type: 'i128'}), // amounts_desired
        nativeToScVal([stroops], {type: 'i128'}), // amounts_min (idle-funds vault, no slippage — see Gotchas)
        new Address(merchantAddress).toScVal(), // from
        nativeToScVal(false, {type: 'bool'}) // invest: false — load-bearing, the vault has no strategies attached
      ]);
      const tx = await soroban.simulateAndAssemble(draft);
      return {xdr: tx.toXDR(), hashHex: txHashHex(tx)};
    },

    async buildWithdrawTx(merchantAddress, shares) {
      const sharesStroops = toStroops(shares);
      const draft = await buildDraft(merchantAddress, 'withdraw', [
        nativeToScVal(sharesStroops, {type: 'i128'}), // withdraw_shares
        nativeToScVal([0n], {type: 'i128'}), // min_amounts_out — idle-funds vault, no slippage path (see Gotchas)
        new Address(merchantAddress).toScVal() // from
      ]);
      const tx = await soroban.simulateAndAssemble(draft);
      return {xdr: tx.toXDR(), hashHex: txHashHex(tx)};
    },

    async getPosition(merchantAddress): Promise<VaultPosition> {
      let balanceRetval: xdr.ScVal;
      try {
        const draft = await buildDraft(merchantAddress, 'balance', [new Address(merchantAddress).toScVal()]);
        balanceRetval = await soroban.simulateRead(draft);
      } catch (err) {
        // Unprovisioned merchant: no Stellar account, so no vault position either.
        if (err instanceof StellarAccountNotFoundError) return ZERO_VAULT_POSITION;
        throw err;
      }

      const shares = scValToNative(balanceRetval) as bigint;
      if (shares === 0n) return ZERO_VAULT_POSITION; // skip the second simulation — nothing to convert

      const amountsDraft = await buildDraft(merchantAddress, 'get_asset_amounts_per_shares', [
        nativeToScVal(shares, {type: 'i128'})
      ]);
      const amountsRetval = await soroban.simulateRead(amountsDraft);
      const amounts = scValToNative(amountsRetval) as bigint[];
      const underlying = amounts[0];
      if (underlying === undefined) {
        throw new Error('get_asset_amounts_per_shares returned an empty amounts vector');
      }
      return {shares: fromStroops(shares), underlyingBalance: fromStroops(underlying)};
    }
  };
}
