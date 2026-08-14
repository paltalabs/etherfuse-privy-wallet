# Module Documentation Index

Living docs — one per module. **Read the relevant doc before modifying a module; update it in the same change.** See the Convention section below for the workflow.

| Doc | Module | One-liner |
|---|---|---|
| [api.md](api.md) | `api/` | Fastify backend workspace (bootstrap + workspace-level wiring); feature modules under `api/src/modules/<name>/` get their own doc as they're created |
| [api-auth.md](api-auth.md) | `api/src/modules/auth/` | Privy access-token verification: `authPlugin` (Fastify auth scope + `request.privyDid`) and `createPrivyAuthVerifier` (wraps `@privy-io/node`) |
| [api-history.md](api-history.md) | `api/src/modules/history/` | Merchant activity feed (`GET /activity`) — keyset-paginated on `createdAt`, newest first, own `stellarAddress` only |
| [api-indexer.md](api-indexer.md) | `api/src/modules/indexer/` (+ `api/src/worker.ts`) | A standalone worker process running two pollers per cycle: the Horizon payments poller (`poller.ts`), which reconciles the `activity` table against on-chain ground truth per provisioned merchant, cursor-tracked, dedupe-by-`(txHash, stellarAddress, type)`; and the ramp-status poller (`ramp-poller.ts`), currently a no-op stub the worker does not call, pending its rewrite against Etherfuse order ids |
| [api-intents.md](api-intents.md) | `api/src/modules/intents/` (+ `api/src/modules/sponsor/submit.ts`) | Generic signing-flow completion (`POST /intents/:id/complete`) — attach merchant signature, fee-bump/submit, update intent+activity |
| [api-payments.md](api-payments.md) | `api/src/modules/payments/` | Build a pending payment intent (`POST /payments`) — unsigned classic payment tx for a registry asset + a pending 'send' activity row; submission reuses `intents`' completion endpoint |
| [api-ramp.md](api-ramp.md) | `api/src/modules/ramp/` | Etherfuse fiat on/off-ramp provider — merchant onboarding (`GET /ramp/onboarding`, `POST /ramp/onboarding/start`, `POST /ramp/onboarding/kyc-launch`, `POST /ramp/onboarding`) and the BRL-over-PIX payin (`POST /ramp/payin/quote`, `POST /ramp/payin`, `GET /ramp/payin/:orderId`, testnet-only `POST /ramp/payin/:orderId/simulate`); the off-ramp (payout) surface and its `IntentSubmitter` are not built yet, though the provider's anchor-mode half is |
| [api-sponsor.md](api-sponsor.md) | `api/src/modules/sponsor/` | Stellar signing toolkit — hash txs for Privy signing, attach raw signatures, wrap fee-bumps, submit intent transactions |
| [api-vault.md](api-vault.md) | `api/src/modules/vault/` (+ `api/src/modules/sponsor/submit.ts`'s `createSorobanSubmitter`) | DeFindex vault deposit/withdraw/position (`GET /vault/position`, `POST /vault/deposit`, `POST /vault/withdraw`) via the intent signing flow — provider builds unsigned txs, `VaultService` stores pending intents, `createSorobanSubmitter` submits through Soroban RPC |
| [api-wallet.md](api-wallet.md) | `api/src/modules/wallet/` (+ `api/src/lib/stellar-gateway.ts`) | Sponsored provisioning intents (`POST /wallet/provision`) and live balances (`GET /wallet`) |
| [app.md](app.md) | `app/` | Vite + React frontend — the wallet UI |
| [shared.md](shared.md) | `packages/shared/` | Shared zod schemas / types consumed across workspaces |

## Convention

Every module has a living doc at `docs/modules/<module>.md` (flat file, one per module). This file is the index that routes a module's source path → its doc. These are the fast on-ramp for anyone — human or agent — touching a module.

**Progressive disclosure — do NOT load all docs at once.** When you're about to touch a module, find the ONE doc matching the code you're changing above, and read only that. Never pull the whole `docs/modules/` folder into context.

**The workflow rule:**
1. **Before modifying a module, read its `docs/modules/<module>.md` first.** It holds the file map, key methods with `file:line`, dependencies, and gotchas.
2. **After modifying a module, update its doc in the same change.** New/removed endpoints, changed behavior, new gotchas, dependency changes — all go into the doc before the work is done. Bump the "Last verified" date.
3. Doc claims must be verified against source and cite `file:line`. Never document something you haven't confirmed exists.
4. **Adding a new module?** Create its `docs/modules/<module>.md` and add a row to the table above in the same change. This applies to submodules created under `api/src/modules/<name>/` (e.g. `sponsor`, `auth`, `wallet`, `ramp`, `vault`, `history`, `indexer`) — each gets its own doc distinct from `docs/modules/api.md`, which covers only the `api` workspace root.

Docs follow a shared template: Purpose, Structure, Endpoints/Public surface, Key methods (`file:line`), Dependencies, Gotchas & invariants, Testing.
