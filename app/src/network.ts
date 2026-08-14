export type StellarNetwork = 'testnet' | 'mainnet'

/**
 * Pure resolvers, exported so both network branches are unit-testable —
 * `import.meta.env` is read exactly once, in the constants below. Must stay
 * consistent with the API's own NetworkConfig (api/src/config/networks.ts):
 * the frontend only mirrors labels/links; every on-chain value (issuer,
 * passphrase, vault) lives server-side.
 */
export function resolveNetwork(raw: string | undefined): StellarNetwork {
  return raw === 'mainnet' ? 'mainnet' : 'testnet'
}

/** Etherfuse settles USDC on both testnet and mainnet — mirrors `api/src/config/assets.ts`'s `TESTNET_REGISTRY`/`MAINNET_REGISTRY`, both single-entry USDC now. */
export function assetCodeFor(_network: StellarNetwork): string {
  return 'USDC'
}

export function networkLabelFor(network: StellarNetwork): string {
  return network === 'mainnet' ? 'Stellar mainnet' : 'Stellar testnet'
}

/** stellar.expert's mainnet path segment is 'public', not 'mainnet'. */
export function explorerTxUrlFor(network: StellarNetwork, txHash: string): string {
  return `https://stellar.expert/explorer/${network === 'mainnet' ? 'public' : 'testnet'}/tx/${txHash}`
}

export const STELLAR_NETWORK: StellarNetwork = resolveNetwork(import.meta.env.VITE_STELLAR_NETWORK as string | undefined)

export const ASSET_CODE = assetCodeFor(STELLAR_NETWORK)

export const NETWORK_LABEL = networkLabelFor(STELLAR_NETWORK)

export function explorerTxUrl(txHash: string): string {
  return explorerTxUrlFor(STELLAR_NETWORK, txHash)
}
