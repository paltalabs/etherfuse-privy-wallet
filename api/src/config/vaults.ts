import {TESTNET_REGISTRY} from './assets.js';

export interface VaultConfig {
  /** Soroban contract id of the vault (C...). */
  address: string;
  /** Registry code of the vault's single underlying asset. */
  assetCode: string;
}

/**
 * The testnet DeFindex vault this wallet deposits into: HodlUSDC (HUSDC),
 * deployed 2026-08-03 via the DeFindex factory's `create_defindex_vault`
 * for the registry's USDC (creation tx
 * `18ba120eee1baa6a83591c4bd1f4e569f64aa730bd0377c64278dfe94d972068`,
 * testnet). It has NO strategies attached, so deposits sit as idle funds and
 * `deposit` must be called with `invest: false`.
 */
export const TESTNET_VAULT: VaultConfig | null = {
  address: 'CCSPCCMFTRBKKVAW6HDFV47EAJ5UA2UYBC5QY2LH6SRBVF5APD6SYTFT',
  assetCode: 'USDC'
};

// Fail fast at import time if the vault's asset ever drifts out of the registry.
if (TESTNET_VAULT) TESTNET_REGISTRY.get(TESTNET_VAULT.assetCode);

/**
 * No DeFindex vault holding mainnet USDC has been deployed for this wallet
 * yet — deploying one via the DeFindex factory (the same
 * `create_defindex_vault` path that produced `TESTNET_VAULT`) is the
 * remaining step before mainnet Earn works. While this is null, `app.ts`
 * skips the vault module entirely on mainnet (no `/vault/*` routes).
 */
export const MAINNET_VAULT: VaultConfig | null = null;
