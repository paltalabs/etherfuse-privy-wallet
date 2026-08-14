# Deployment guide

Provider-agnostic instructions for running this project outside of local development. Nothing here assumes a specific host — pick any static-file host for the frontend and any place that can run two long-lived Node processes plus Postgres for the backend.

**Network selection:** the stack runs against Stellar **testnet by default**, and switches to **mainnet** with `STELLAR_NETWORK=mainnet` (plus `VITE_STELLAR_NETWORK=mainnet` for the frontend). One env var selects the whole per-network constant set — Horizon URL, network passphrase, asset registry, vault, and the Etherfuse endpoints + settlement asset — from `api/src/config/networks.ts` (`TESTNET_NETWORK`/`MAINNET_NETWORK`, `api/src/config/networks.ts:37-63`). See "Going to mainnet" below for what mainnet additionally requires — it is not just the env var.

## Topology

Three deployable units:

1. **Static frontend** — `app/`, a Vite + React 19 SPA. Build with `pnpm --filter app build` (`app/package.json:8`, runs `tsc -b && vite build`), which produces `app/dist/`. Serve that directory from any static host.
2. **API server** — `api/src/server.ts`, the Fastify HTTP process (`api/src/server.ts:12-70`). Serves `/health`, `/wallet`, `/intents`, `/payments`, `/history`(`/activity`), `/vault/*` (only when the network has a vault — testnet today), `/ramp/*` (`api/src/app.ts:71,145-153`).
3. **Indexer/reconciliation worker** — `api/src/worker.ts`, a **separate** long-running Node process (`api/src/worker.ts:54-113`). No HTTP surface. Polls Horizon for merchant payments once per `POLL_INTERVAL_MS`, then also polls ramp-order reconciliation (pending `on_ramp`/`off_ramp` rows against Etherfuse) in the same cycle **when all four `ETHERFUSE_*` variables are set** — see "Etherfuse credential gating" below (`api/src/worker.ts:14-41`, `docs/modules/api-indexer.md`).

Both (2) and (3) come from the same `@paltalabs/api` workspace build/install — they are two entrypoints into one package, not two separate deployables to build differently.

Plus one **Postgres** database shared by both Node processes.

There is no dedicated production build/start script for the API today: `api/package.json`'s `dev` script runs `tsx watch src/server.ts` and `worker` runs `tsx src/worker.ts` (`api/package.json:7-8`) — both via `tsx`, a TypeScript runtime, not a compiled-JS entrypoint. `tsx` is a `devDependency` (`api/package.json:35`), so a production install must not prune dev dependencies. Run the same commands without `--watch` in production: `tsx src/server.ts` and `tsx src/worker.ts`.

## Environment variables

All backend variables are validated by `EnvSchema` in `api/src/lib/env.ts:9-39`, loaded from the **repo-root** `.env` (not `api/.env` — the workspace has none of its own, `api/src/lib/env.ts:4-7`).

| Variable | Required (schema) | Default | Purpose |
|---|---|---|---|
| `PRIVY_APP_ID` | Yes | — | Privy app ID, server-side verifier (`api/src/lib/env.ts:10`) |
| `PRIVY_APP_SECRET` | Yes | — | Privy app secret (`api/src/lib/env.ts:11`) |
| `ETHERFUSE_API_KEY` | No (schema-optional) | — | Etherfuse API key — a **sandbox** key on testnet, a **production** key on mainnet (the endpoints follow `STELLAR_NETWORK`, not the key). See "Etherfuse credential gating" below — required in practice to boot the HTTP server (`api/src/lib/env.ts:15`) |
| `ETHERFUSE_JWT_ISSUER` | No (schema-optional) | — | Must equal the Issuer URL registered in the Etherfuse dashboard's Partner JWT section (`api/src/lib/env.ts:18`) |
| `ETHERFUSE_JWT_KID` | No (schema-optional) | — | Must match a `kid` in the JWKS registered at that dashboard's JWKS URL — **which must serve `Content-Type: application/json`** (`api/src/lib/env.ts:19`) |
| `ETHERFUSE_JWT_PRIVATE_KEY` | No (schema-optional) | — | RSA (RS256 — **ES256 is rejected**) PKCS8 private-key PEM for signing hosted-KYC launch assertions; `\n`-escaped newlines are accepted (`api/src/lib/env.ts:23`) |
| `DEFINDEX_API_KEY` | No (schema-optional) | — | Only read by the manual probe script `api/scripts/spike-vault.ts:261-270`; not read by `server.ts`, `app.ts`, or `worker.ts` |
| `SPONSOR_SECRET_KEY` | No (schema-optional, must match `^S[A-Z2-7]{55}$` if set) | — | Sponsor Stellar secret key, pays fees/reserves via fee-bump. See "Sponsor key gating" below — required in practice to boot the HTTP server (`api/src/lib/env.ts:20`) |
| `DATABASE_URL` | No | `postgres://paltalabs:paltalabs@localhost:5432/paltalabs` | Postgres connection string (`api/src/lib/env.ts:23`) |
| `PORT` | No | `3000` | Fastify HTTP port, `server.ts` only (`api/src/lib/env.ts:25`) |
| `CORS_ORIGIN` | No | `http://localhost:5173` | Allowed CORS origin **and** the base of the hosted-KYC return URL — see "CORS_ORIGIN" below (`api/src/lib/env.ts:38`) |
| `POLL_INTERVAL_MS` | No | `5000` | `worker.ts`'s poll-cycle interval, ms; not read by the HTTP server (`api/src/lib/env.ts:29`) |
| `LOG_LEVEL` | No | `info` | API server pino log level: `fatal`/`error`/`warn`/`info`/`debug`/`trace`/`silent`; `server.ts` only — pretty output on a TTY, JSON otherwise (`api/src/lib/env.ts:32`, `api/src/server.ts:68-76`) |
| `STELLAR_NETWORK` | No | `testnet` | `'testnet'` or `'mainnet'` — selects the whole `NetworkConfig` (Horizon URL, passphrase, registry, vault, Etherfuse endpoints + asset) in `server.ts` and `worker.ts` (`api/src/lib/env.ts:47`, `api/src/config/networks.ts:37-49`) |
| `SOROBAN_RPC_URL` | Testnet: no; **mainnet: yes** | testnet: `https://soroban-testnet.stellar.org`; mainnet: none | Soroban RPC endpoint for vault contract simulate/assemble/submit. `resolveSorobanRpcUrl` falls back to the network default and **fail-fasts at boot on mainnet when unset** — there is no free public mainnet Soroban RPC (`api/src/lib/env.ts:41`, `api/src/config/networks.ts:64-73`) |

There is no `HORIZON_URL` variable — the Horizon endpoint comes from the selected `NetworkConfig` (`horizonUrl`, `api/src/config/networks.ts:36,46`), not its own env var.

Frontend (read by Vite at build time, `import.meta.env.*`):

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `VITE_PRIVY_APP_ID` | Yes | — | Privy app ID passed to `<PrivyProvider appId=...>` (`app/src/main.tsx:19`) |
| `VITE_API_URL` | No | `http://localhost:3000` | Backend API base URL (`app/src/components/AuthGate.tsx:7`) |
| `VITE_STELLAR_NETWORK` | No | `testnet` | `'testnet'` or `'mainnet'` — drives the asset label and stellar.expert explorer links (`app/src/network.ts:28`). **Keep in sync with the API's `STELLAR_NETWORK`** — the frontend only mirrors labels; every on-chain value lives server-side |

`app/vite.config.ts:9` sets `envDir` to the repo root, so Vite reads these from the **same root `.env`** the API reads — there is no `app/.env`.

### Sponsor key gating

`SPONSOR_SECRET_KEY` is optional in the zod schema (kept that way only so `api/scripts/spike-privy-stellar.ts` can generate a throwaway key on first run — see the comment at `api/src/lib/env.ts:15-19`), but `server.ts` fail-fasts before ever calling `app.listen`: if `env.SPONSOR_SECRET_KEY` is unset it throws and exits (`api/src/server.ts:22-26`). In practice, the HTTP server cannot start at all without a valid sponsor key.

### Etherfuse credential gating

All four `ETHERFUSE_*` variables are optional in the schema for the same spike-script-compatibility reason, but the two processes handle their absence differently:

- **`server.ts`** fail-fasts the same way as the sponsor key: if ANY of the four is unset, it throws before `app.listen` and the process exits (`api/src/server.ts:34-38`). The three JWT variables are just as load-bearing as the API key — they sign the hosted-KYC launch assertion, which cannot be recovered from at request time. `api/src/app.ts` itself has no conditional route registration for `ramp` — `rampRoutes` is always registered inside the authenticated scope (`api/src/app.ts:152`; only the vault module's registration is conditional, on `NetworkConfig.vault`, `api/src/app.ts:151`) — so the gating is entirely at server-boot fail-fast, not at the route level. Concretely: **the HTTP API cannot run at all without all four Etherfuse variables set.**
- **`worker.ts`** reads them too, but tolerantly: `buildRampPoller` (`api/src/worker.ts:14-41`) checks all four and, if ANY is unset, logs a one-line notice and runs chain-only (Horizon polling only, no crash) rather than failing to start. If all four ARE set, it builds a real Etherfuse ramp provider and runs the ramp-status poller every cycle alongside the Horizon poller, reconciling pending `on_ramp`/`off_ramp` rows (`api/src/modules/indexer/ramp-poller.ts`, `docs/modules/api-indexer.md`). So `worker.ts` can run on `DATABASE_URL`/`STELLAR_NETWORK`/`POLL_INTERVAL_MS` alone, but gets strictly more functionality (ramp reconciliation) when the four `ETHERFUSE_*` variables are also set.

### CORS_ORIGIN

`CORS_ORIGIN` does two things, both from the same value:

1. Fastify CORS is locked to it: `app.register(cors, {origin: deps.env.CORS_ORIGIN})` (`api/src/app.ts:61`). If it doesn't exactly match the origin the frontend is actually served from (scheme + host + port), browser requests from the frontend will be rejected by CORS.
2. It's also the base of the hosted-KYC return URL: `kycReturnUrl: \`${deps.env.CORS_ORIGIN}/ramp/kyc-return\`` (`api/src/app.ts:149`). The backend signs and returns that URL with the launch parameters, and the merchant's browser is sent back to it after Etherfuse's hosted `/idv` flow.

The frontend has a matching client-side route for that return path: `screens/KycReturn.tsx`, registered at `/ramp/kyc-return` (`app/src/App.tsx:26`) — a static "safe to close this tab" landing page, reached via `react-router`'s `BrowserRouter` (`app/src/main.tsx:6,17`). A plain static-file host that doesn't fall back to `index.html` for unknown paths will 404 on this redirect (and on any other client-side route hit via direct navigation or refresh). **The static host must be configured with SPA fallback to `index.html`.**

Set `CORS_ORIGIN` to the exact deployed frontend origin before onboarding any merchant through Etherfuse — a mismatch breaks both API access and the post-KYC return.

### Privy dashboard configuration

Privy's embedded-wallet login only works from origins registered in the Privy dashboard for the app (`VITE_PRIVY_APP_ID`). Add the deployed frontend's exact origin to that app's allowed-origins list before deploying, or login will fail in the browser.

## Going to mainnet

`STELLAR_NETWORK=mainnet` + `VITE_STELLAR_NETWORK=mainnet` flip every per-network constant (`MAINNET_NETWORK`, `api/src/config/networks.ts:44-52`): public Horizon, `Networks.PUBLIC` passphrase, the mainnet asset registry, and Etherfuse's production endpoints (`https://api.etherfuse.com` / `https://app.etherfuse.com`) with Circle's mainnet USDC as the settlement asset. What the switch does NOT provide:

1. **The USDC issuer changes.** Testnet uses the Circle/Centre testnet issuer Etherfuse delivers against (`USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`, `api/src/config/assets.ts:19-21`); mainnet uses Circle's canonical issuer (`USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN`, verified against mainnet Horizon — `MAINNET_REGISTRY`, `api/src/config/assets.ts:30-32`). Both have `auth_required: false`, so ordinary P2P funding works.
2. **Production Etherfuse credentials** (`ETHERFUSE_API_KEY` plus a Partner JWT issuer/kid/key registered in the PRODUCTION dashboard — the JWKS URL must serve `Content-Type: application/json`). Production identity verification is a real KYC review: the sandbox's `/idv` flow skips document checks and auto-approves, production does not. Deposit instructions also differ — the sandbox returns no PIX code or QR payload at all (`docs/evidence/etherfuse-sandbox-findings.md`), so the payin UI must be re-checked against real production payloads before launch.
3. **A mainnet-funded sponsor key** (`SPONSOR_SECRET_KEY`) — it pays real XLM for fees and sponsored reserves (~0.5 XLM per merchant trustline, plus base reserves). There is no friendbot on mainnet.
4. **An explicit `SOROBAN_RPC_URL`** — the server fail-fasts at boot without one on mainnet.
5. **No vault yet**: `MAINNET_VAULT` is null (`api/src/config/vaults.ts:34`) — no DeFindex vault holding mainnet USDC has been deployed, so `/vault/*` routes are not registered on mainnet and the Earn screen degrades. Deploy one via the DeFindex factory and fill the constant to enable it.
6. **Real money**: PIX settlement actually executes in production, and the sandbox-only deposit simulator (`POST /ramp/payin/:orderId/simulate`) 404s on mainnet by design. Test with small amounts first.

## Local quickstart

1. Copy `.env.example` to `.env` at the repo root and fill in `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, the four `ETHERFUSE_*` variables, `SPONSOR_SECRET_KEY`, and `VITE_PRIVY_APP_ID` (`.env.example`).
2. `docker compose up -d db` — starts the `db` service (`postgres:16-alpine`, `docker-compose.yml:1-11`) on port `5432`. If that port is taken locally, override it: `DB_HOST_PORT=5439 docker compose up -d db`, and point `DATABASE_URL` at the same port.
3. `pnpm install` (repo root).
4. `pnpm --filter @paltalabs/api db:migrate` — applies `api/drizzle/`'s committed migrations via drizzle-kit (`api/package.json:17`).
5. `pnpm --filter @paltalabs/api dev` — starts the Fastify server (`tsx watch src/server.ts`, `api/package.json:7`) on `PORT` (default `3000`). Fails fast per the gating rules above if `SPONSOR_SECRET_KEY`/`ETHERFUSE_*` are missing.
6. `pnpm --filter @paltalabs/api worker` (or `pnpm worker` from the repo root, `package.json:8`) — starts the indexer/reconciliation worker **in a separate terminal**; it is not started by step 5 or by `pnpm dev`.
7. `pnpm --filter app dev` — starts the Vite dev server (default `http://localhost:5173`, matching `CORS_ORIGIN`'s default).

Running `pnpm dev` from the repo root (`package.json:7`, `pnpm -r --parallel dev`) starts every workspace's own `dev` script in parallel — this covers the frontend and API server together, but **not** the worker, which is started separately (step 6).

## Deploying

1. **Postgres**: provision any Postgres instance; set `DATABASE_URL` to point at it.
2. **Migrate**: run `pnpm --filter @paltalabs/api db:migrate` against that `DATABASE_URL` before starting either Node process.
3. **API server**: run `tsx src/server.ts` from `api/` (or `pnpm --filter @paltalabs/api dev`, which also enables file-watching — not desirable in production) with the full backend env-var set above. Put it behind whatever HTTPS-terminating reverse proxy/load balancer the host provides, and set `CORS_ORIGIN` to that public origin.
4. **Worker**: run `tsx src/worker.ts` from `api/` (`pnpm --filter @paltalabs/api worker`) as a second, independent long-running process, same `DATABASE_URL`. No inbound network access needed.
5. **Frontend**: run `pnpm --filter app build` to produce `app/dist/`; upload that directory to any static host with SPA fallback enabled (see CORS_ORIGIN section above). Set `VITE_PRIVY_APP_ID`/`VITE_API_URL` in the root `.env` **before** building — Vite bakes them in at build time, they are not runtime-configurable afterward.
6. Register the deployed frontend origin in the Privy dashboard, and set `CORS_ORIGIN` on the API to that same origin.

For the full endpoint surface and module-level detail, see `docs/modules/README.md`.
