# Asset alignment — testnet USDC & DeFindex vault

## Asset

The wallet's Stellar testnet asset is `USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5` (`api/src/config/assets.ts:19-21`, `TESTNET_REGISTRY`).

This is the official Circle/Centre testnet USDC issuer — verified live against the ramp provider's own sandbox (`GET /ramp/assets` on `https://api.sand.etherfuse.com`, see `docs/evidence/etherfuse-sandbox-findings.md`'s "## Assets" section) and independently against Horizon testnet, where the issuer account's `home_domain` is `centre.io` and `auth_required: false` — per `assets.ts:7-11`'s own verified comment. `auth_required: false` means ordinary peer-to-peer funding and a fresh trustline both work without any issuer-side authorization step.

`decimals: 7` follows the fixed Stellar classic-asset convention (int64 amounts, 7 fractional digits) — not provider-specific.

## Vault

A DeFindex testnet vault is deployed for this asset: `CCSPCCMFTRBKKVAW6HDFV47EAJ5UA2UYBC5QY2LH6SRBVF5APD6SYTFT` ("HodlUSDC" / `HUSDC`), deployed 2026-08-03 via the DeFindex factory's `create_defindex_vault` (creation tx [`18ba120eee1…`](https://stellar.expert/explorer/testnet/tx/18ba120eee1baa6a83591c4bd1f4e569f64aa730bd0377c64278dfe94d972068)) — `api/src/config/vaults.ts:19-22`, `TESTNET_VAULT`.

The vault has no strategies attached, so deposits sit as idle funds; `deposit` must be called with `invest: false` (`api/src/config/vaults.ts:10-17`).
