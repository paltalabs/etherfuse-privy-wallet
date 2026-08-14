import {AssetRegistry} from '@paltalabs/shared';

/**
 * Testnet asset registry — the single source for which asset the wallet
 * manages on Stellar testnet.
 *
 * USDC (the asset Etherfuse delivers on ramp and expects on off-ramp) is
 * verified live against `https://api.sand.etherfuse.com` (`GET /ramp/assets`)
 * and independently against Horizon testnet — issuer `home_domain` is
 * `centre.io` (official Circle/Centre testnet USDC), `auth_required: false`.
 * See `docs/evidence/etherfuse-sandbox-findings.md` "## Assets".
 * `decimals: 7` is the fixed Stellar classic-asset convention (int64 amounts,
 * 7 fractional digits), not provider-specific.
 *
 * `config/vaults.ts`'s `TESTNET_VAULT` deposits into this same registry
 * entry — see that file's doc comment for the deployed vault's address and
 * the alignment decision in `docs/evidence/asset-alignment.md`.
 */
export const TESTNET_REGISTRY = new AssetRegistry([
  {code: 'USDC', issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5', decimals: 7}
]);

/**
 * Mainnet asset registry. The issuer is Circle's canonical Stellar USDC,
 * verified two ways against mainnet Horizon (2026-07-30): the issuer
 * account's `home_domain` is `circle.com`, and it is the issuer the ramp
 * provider's own documented mainnet treasury wallet holds its USDC balance
 * against. `auth_required: false` — ordinary P2P funding works.
 */
export const MAINNET_REGISTRY = new AssetRegistry([
  {code: 'USDC', issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN', decimals: 7}
]);
