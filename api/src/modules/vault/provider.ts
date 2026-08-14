/**
 * The vault module's own provider surface (spec's modularity rule: a module
 * defines the interfaces it needs rather than importing them from a shared
 * schemas package). `defindex.ts`'s `createDefindexProvider` is the only
 * concrete implementation today; a service/routes layer consuming
 * `VaultProvider` lands in a later change.
 */

/** A merchant's position in the vault: share balance and its underlying-asset value. */
export interface VaultPosition {
  /** Vault share balance (dfTokens), decimal string, 7 dp. */
  shares: string;
  /** Underlying-asset value of those shares, decimal string, 7 dp. */
  underlyingBalance: string;
}

/** An unsigned, simulated-and-assembled vault invocation awaiting the merchant's signature. */
export interface UnsignedVaultTx {
  xdr: string;
  /** 0x-prefixed hash for Privy rawSign (txHashHex convention). */
  hashHex: string;
}

/** Builds vault deposit/withdraw transactions and reads a merchant's vault position. */
export interface VaultProvider {
  /** Build an unsigned, assembled deposit tx sourced by the merchant. amount: decimal string, underlying units. */
  buildDepositTx(merchantAddress: string, amount: string): Promise<UnsignedVaultTx>;
  /** Build an unsigned, assembled withdraw tx sourced by the merchant. shares: decimal string, share units. */
  buildWithdrawTx(merchantAddress: string, shares: string): Promise<UnsignedVaultTx>;
  getPosition(merchantAddress: string): Promise<VaultPosition>;
}
