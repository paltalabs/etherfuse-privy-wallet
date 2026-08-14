import type {AssetRegistry} from '@paltalabs/shared';
import {Networks} from '@stellar/stellar-sdk';
import {MAINNET_REGISTRY, TESTNET_REGISTRY} from './assets.js';
import {MAINNET_VAULT, TESTNET_VAULT, type VaultConfig} from './vaults.js';

export type StellarNetwork = 'testnet' | 'mainnet';

/**
 * Everything that varies between Stellar networks, selected once at boot by
 * `STELLAR_NETWORK` — the single seam between "which chain are we on" and
 * the rest of the codebase, which must never hardcode a per-network value.
 */
export interface NetworkConfig {
  name: StellarNetwork;
  horizonUrl: string;
  networkPassphrase: string;
  /**
   * Fallback Soroban RPC endpoint when `SOROBAN_RPC_URL` is unset. null =
   * no free public default exists for this network (SDF runs no public
   * mainnet Soroban RPC), so the env var becomes required there.
   */
  defaultSorobanRpcUrl: string | null;
  registry: AssetRegistry;
  /** null = no vault deployed on this network yet — `app.ts` skips the vault module entirely (no `/vault/*` routes). */
  vault: VaultConfig | null;
  /**
   * Etherfuse's per-network config: sandbox vs. production API base URL, the
   * dashboard/hosted-flow base URL (KYC `/idv`, order status pages), and the
   * `CODE:ISSUER` Stellar asset Etherfuse delivers on ramp/expects on
   * off-ramp for this chain. Verified live against the Etherfuse sandbox —
   * see `docs/evidence/etherfuse-sandbox-findings.md` "## Assets" (testnet)
   * and `assets.ts`'s `MAINNET_REGISTRY` comment (mainnet, Circle's USDC).
   */
  etherfuse: {apiBaseUrl: string; dashboardBaseUrl: string; assetId: string};
}

export const TESTNET_NETWORK: NetworkConfig = {
  name: 'testnet',
  horizonUrl: 'https://horizon-testnet.stellar.org',
  networkPassphrase: Networks.TESTNET,
  defaultSorobanRpcUrl: 'https://soroban-testnet.stellar.org',
  registry: TESTNET_REGISTRY,
  vault: TESTNET_VAULT,
  etherfuse: {
    apiBaseUrl: 'https://api.sand.etherfuse.com',
    dashboardBaseUrl: 'https://sandbox.etherfuse.com',
    assetId: 'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
  }
};

export const MAINNET_NETWORK: NetworkConfig = {
  name: 'mainnet',
  horizonUrl: 'https://horizon.stellar.org',
  networkPassphrase: Networks.PUBLIC,
  defaultSorobanRpcUrl: null,
  registry: MAINNET_REGISTRY,
  vault: MAINNET_VAULT,
  etherfuse: {
    apiBaseUrl: 'https://api.etherfuse.com',
    dashboardBaseUrl: 'https://app.etherfuse.com',
    assetId: 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
  }
};

export function getNetworkConfig(name: StellarNetwork): NetworkConfig {
  return name === 'mainnet' ? MAINNET_NETWORK : TESTNET_NETWORK;
}

/**
 * Resolves the Soroban RPC endpoint: an explicit `SOROBAN_RPC_URL` always
 * wins; otherwise the network's default. Throws (fail-fast at boot, before
 * any gateway is built) when neither exists — currently only possible on
 * mainnet, which has no free public RPC to default to.
 */
export function resolveSorobanRpcUrl(explicitUrl: string | undefined, config: NetworkConfig): string {
  const url = explicitUrl ?? config.defaultSorobanRpcUrl;
  if (!url) {
    throw new Error(
      `SOROBAN_RPC_URL is required when STELLAR_NETWORK=${config.name} (no public default Soroban RPC exists for this network).`
    );
  }
  return url;
}
