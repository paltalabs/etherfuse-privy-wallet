# Paltalabs

A merchant-focused Stellar wallet MVP. Merchants log in with an embedded wallet (email/Google, no seed phrase to manage), send and receive USDC on Stellar testnet, move funds in and out via a BRL/PIX on/off-ramp, and can deposit idle balance into a yield vault. Transaction fees are sponsored — merchants never need XLM in their wallet to transact.

- **Embedded-wallet auth**: Privy provisions and custodies each merchant's Stellar wallet; login is email/Google, not a seed phrase.
- **BRL/PIX on/off-ramp**: Etherfuse handles PIX-to-USDC on-ramp and USDC-to-PIX off-ramp, with hosted identity verification (`/idv`).
- **Yield vault**: DeFindex vault deposit/withdraw for idle balance.
- **Gasless UX**: a sponsor account fee-bumps every merchant transaction, so merchants never hold or spend XLM.

## Status

This is a **testnet/sandbox MVP**, not a production deployment:

- Every Stellar operation targets **testnet**, not mainnet.
- The ramp integration runs against **Etherfuse's sandbox** environment.
- **No vault is currently deployed on testnet**: the prior testnet vault held a since-retired asset and was retired alongside the provider migration (`TESTNET_VAULT` is `null`, `api/src/config/vaults.ts`) — the vault module's routes aren't registered on testnet at all until a new DeFindex vault is deployed for the current USDC asset. Details: `docs/modules/api-vault.md`.
- **PIX settlement is sandbox-limited**: the sandbox's on-ramp flow has no real PIX code/QR payload, and a testnet-only endpoint (`POST /ramp/payin/:orderId/simulate`) simulates deposit completion instead. Details: `docs/modules/api-ramp.md`, `docs/evidence/etherfuse-sandbox-findings.md`.

## Monorepo layout

pnpm workspace with three packages:

| Path | Package | What it is |
|---|---|---|
| `app/` | `app` | Vite + React 19 SPA — the wallet UI |
| `api/` | `@paltalabs/api` | Fastify backend: an HTTP API process (`src/server.ts`) and a separate indexer/reconciliation worker process (`src/worker.ts`) |
| `packages/shared/` | `@paltalabs/shared` | Shared zod schemas / TypeScript types consumed by both `app` and `api` |

## Quickstart

See `docs/deploy.md` for the full environment-variable reference, local dev setup, and deployment steps. Short version:

```
docker compose up -d db
pnpm install
pnpm --filter @paltalabs/api db:migrate
pnpm --filter @paltalabs/api dev      # API server
pnpm --filter @paltalabs/api worker   # indexer/reconciliation worker (separate terminal)
pnpm --filter app dev                   # frontend
```

## Documentation

- `docs/deploy.md` — deployment guide (topology, environment variables, local quickstart, production notes).
- `docs/modules/README.md` — per-module living documentation index; each backend/frontend module has its own doc with file maps, key methods, and known gotchas.
- `docs/evidence/` — recorded evidence from live runs against real testnet/sandbox infrastructure (end-to-end proofs, sandbox findings, screenshots).

## License

MIT licensed — see [`LICENSE`](./LICENSE).
