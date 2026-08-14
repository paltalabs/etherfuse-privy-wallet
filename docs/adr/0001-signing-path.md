# ADR 0001: Signing path for merchant-authorized transactions

**Status:** Accepted (spike-verified). **Date:** 2026-07-23.

## Context

A core product requirement is that the merchant's Stellar transactions be genuinely **merchant-authorized and merchant-signed**, not server-delegated: server-delegated signing was explicitly rejected as a design option because it would weaken that guarantee. The design specified a fallback cascade to de-risk this: **Privy `rawSign` → Crossmint → passkey**, with the Crossmint/passkey legs activating only if the initial spike had disproved `rawSign` viability. Privy's Stellar support is Tier 2 ("wallet abstractions"): embedded wallets via `@privy-io/react-auth/extended-chains`, signing via raw ed25519 `rawSign` over a hash, with no native tx building, no webhooks/indexing, and no gas sponsorship on Stellar. The Privy×Stellar testnet spike exercised this path end-to-end against Stellar testnet — including a transaction authored by a third-party ramp provider, not this codebase — to resolve the cascade before writing this ADR.

## Decision

**Privy `rawSign` is the signing path — no fallback to Crossmint or passkeys.** The pattern:

1. Backend builds the unsigned XDR (`@stellar/stellar-sdk`; Soroban ops go through simulate → assemble).
2. Frontend signs the tx hash **client-side**, in the browser, behind Privy login, via `useSignRawHash` from `@privy-io/react-auth/extended-chains` (`app/src/components/AuthGate.tsx:2,24,49`), which is passed into `signAndComplete` — the shared sign-then-complete step every intent-producing mutation calls (`app/src/core/signing.ts:14-26`).
3. Backend attaches the decorated signature (`api/src/modules/sponsor/stellar.ts:13`, `attachRawSignature`) and wraps the tx in a **fee-bump paid by the sponsor** (`api/src/modules/sponsor/stellar.ts:26`, `wrapFeeBump`), so the merchant's own wallet never needs XLM.

## Evidence

All hashes below are real Stellar testnet transactions, independently confirmed on Horizon (not just the client's own success codes) — see the linked evidence files for full request/response detail.

| Leg | Tx hash | Source |
|---|---|---|
| Sponsored provisioning (create account + trustline) | [`aebbb650d6695d59d4dcd0cf86e27ca5c731ec6fe615cf0d8cdd9c4a058443ce`](https://stellar.expert/explorer/testnet/tx/aebbb650d6695d59d4dcd0cf86e27ca5c731ec6fe615cf0d8cdd9c4a058443ce) | `docs/evidence/privy-stellar-spike.md:5` |
| Classic payment (merchant `rawSign`, sponsor fee-bump) | [`ea453da11b7dd959239740db45aa00f04209de68b5e5b93a11b7221be91ed7d5`](https://stellar.expert/explorer/testnet/tx/ea453da11b7dd959239740db45aa00f04209de68b5e5b93a11b7221be91ed7d5) | `docs/evidence/privy-stellar-spike.md:7` |
| Soroban SAC transfer (merchant `rawSign`, sponsor fee-bump) | [`777b1b3c3b19a6d2c0bf9921b14721879838e8abd3d6506ce21b60c03b5052c1`](https://stellar.expert/explorer/testnet/tx/777b1b3c3b19a6d2c0bf9921b14721879838e8abd3d6506ce21b60c03b5052c1) | `docs/evidence/privy-stellar-spike.md:11` |

**Browser-side signing, no backend involved:** Privy login → embedded Stellar wallet `GCFT36CUX6GBXQMSMQIZI2AAXZGSMB23NHQ3NX2SVKRCUIQZSIOTCDLD` created in-browser → `useSignRawHash` produced a signature that `Keypair.fromPublicKey(walletAddress).verify(...)` confirmed **`verified=true`** against the wallet's own public key (`docs/evidence/privy-stellar-spike.md:26-33`, screenshot `docs/evidence/browser-signing-spike.png`).

An earlier ramp provider's off-ramp payout flow handed the merchant an inner transaction authored by that third party, not by this codebase — the merchant's Privy `rawSign` plus the sponsor's fee-bump handled it identically to a self-built transaction, confirming the toolkit generalizes beyond in-house-built transactions. (Etherfuse, the current ramp provider, builds its off-ramp payment transaction in-house rather than handing back a third-party-authored one — see `api/src/modules/ramp/service.ts:311-318`'s `createPayout` doc comment — so this specific generalization isn't exercised in production today, but the signing-pattern capability it proved still holds.)

## Paths assessed

**Crossmint and passkey signing: not needed.** The design's cascade only activates them if the initial spike had disproved `rawSign` viability (not expected — Privy documents Stellar hash signing). The evidence above shows `rawSign` working end-to-end — classic payment, Soroban invocation, sponsor fee-bump, and a third-party-authored transaction, all merchant-signed with the merchant holding zero XLM throughout. Neither Crossmint nor a passkey path was built or evaluated further; there was no disproving result to react to.

## Limitations

- **No human-readable transaction preview in the wallet UI.** Privy Tier 2 signing is raw ed25519 `rawSign` over a hash, not a decoded/simulated transaction — the user sees an opaque hash, not "send 10 USDC to X," at signing time.
  **Mitigation:** the backend is the sole XDR builder (step 1 of the Decision above); the frontend only ever requests a pre-defined intent (send, deposit, off-ramp) and displays that intent's parameters itself before triggering the sign — the raw hash signed is never user-facing as the thing being "reviewed."
- **Privy Tier 2 constraints beyond signing:** no native tx building, no tx history/indexing, no webhooks, and no gas sponsorship on Stellar from Privy itself. Sponsorship is entirely ours — the fee-bump pattern above, proven working with a zero-XLM merchant across four independent tx legs (three in-house, one third-party-authored).

## Production integration requirements

- **Privy app config:** a Privy app (dashboard.privy.io) with social login (Google + email) and Stellar wallets enabled; frontend `PrivyProvider` config with `loginMethods: ['google', 'email']` and embedded-wallet auto-create left `'off'` for ethereum/solana since the Stellar wallet is created explicitly via `useCreateWallet` (`app/src/main.tsx:18-26`).
- **Sponsor account funding:** the sponsor keypair must hold enough XLM to cover base reserves + fees for every merchant it provisions and every tx it fee-bumps — testnet used `GCHLXZYVRTY6AVHY434FOGS24LF3J7TY7NYP6XQHKESJZNEO3QAEFFHJ`, which sponsored 3 reserves per merchant (2 for account creation's minimum reserve + 1 per additional trustline) and every operation's fee (`docs/evidence/privy-stellar-spike.md:2,20`). Mainnet needs a real-XLM-funded sponsor, not friendbot.
- **Env vars:** `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `SPONSOR_SECRET_KEY` on the backend; `VITE_PRIVY_APP_ID` on the frontend (`api/src/lib/env.ts:10-11,19`).
