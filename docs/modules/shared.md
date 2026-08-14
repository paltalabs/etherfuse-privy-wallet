# shared Module

> **Living document.** Read this before modifying the module. Update it in the same change whenever the module's behavior, endpoints, files, or dependencies change.

**Source:** `packages/shared/` · **Last verified:** 2026-08-03

## Purpose

`@paltalabs/shared` (`packages/shared/package.json:2`) holds zod schemas and TypeScript types shared across workspaces (currently consumed by `api`, per its `workspace:*` dependency). Includes an asset registry for managing supported currencies/tokens and the wallet module's HTTP response contracts.

## Structure

| File | Purpose |
|---|---|
| `src/assets.ts` | Zod schema and registry for supported assets; exports `AssetConfigSchema`, `AssetConfig` type, `UnknownAssetError`, and `AssetRegistry` class (`packages/shared/src/assets.ts:1-38`). |
| `src/api.ts` | Zod schemas + inferred types for the wallet/intents/payments/history modules' HTTP contracts: `ProvisionResponseSchema`/`ProvisionResponse` (`{intentId, xdr, hashHex} \| {provisioned: true, stellarAddress}`), `WalletBalanceSchema`/`WalletBalance` (`{assetCode, assetIssuer, balance}` — `assetIssuer` required, see Gotchas), `WalletResponseSchema`/`WalletResponse` (`{stellarAddress, provisioned, balances}`), `CompleteIntentRequestSchema`/`CompleteIntentResponseSchema` (`POST /intents/:id/complete`), `stellarAmountSchema`/`toStroops` (the shared Stellar-amount contract + its decimal-to-stroops conversion, both exported), `PaymentRequestSchema`/`PaymentResponseSchema` (`POST /payments`), and `ActivityItemSchema`/`ActivityFeedResponseSchema` (`GET /activity` — see Endpoints below) (`packages/shared/src/api.ts`). Consumed by each module's `routes.ts`, which parses the request body / handler's result through the matching schema — see `docs/modules/api-wallet.md`, `docs/modules/api-intents.md`, `docs/modules/api-payments.md`, `docs/modules/api-history.md`. |
| `src/api.test.ts` | Tests for all schemas above: each `ProvisionResponse` branch accepted, a shape matching neither rejected; `WalletBalanceSchema` rejects a balance missing `assetIssuer`; populated (with `assetIssuer`)/empty `WalletResponse.balances` accepted, a missing `stellarAddress` rejected; `CompleteIntentRequestSchema`/`CompleteIntentResponseSchema` accept/reject their required field; `PaymentRequestSchema` accepts a valid request and rejects a bad `destination`/an amount with too many decimals or that's zero/negative/an empty `assetCode`; `PaymentResponseSchema` accepts a pending-intent shape and rejects a missing `intentId`; `ActivityItemSchema` accepts both a fully-populated row and an all-nullable-fields `'provision'` row, and rejects an unknown `type`/a missing `status`; `ActivityFeedResponseSchema` accepts a page with items and a `null` `nextBefore`, and rejects a missing `items` array (`packages/shared/src/api.test.ts`). |
| `src/ramp.ts` | Zod schemas + inferred types for the `ramp` module's Etherfuse-only onboarding + pix payin + Stellar payout HTTP contracts — 14 schemas: `RampQuoteResponseSchema`/`RampQuoteResponse` (`ramp.ts:10-18`, shared response shape for BOTH `POST /ramp/payin/quote` and `POST /ramp/payout/quote`), `PayinQuoteRequestSchema`/`PayinQuoteRequest` (`ramp.ts:21-22`, `{amountBrlCents: number}`), `PayoutQuoteRequestSchema`/`PayoutQuoteRequest` (`ramp.ts:25-26`, `{amountCents: number}`), `PayoutIntentResponseSchema`/`PayoutIntentResponse` (`ramp.ts:36-37`, `POST /ramp/payout`'s response, `{intentId, xdr, hashHex}`), `RampOnboardingStatusSchema`/`RampOnboardingStatus` (`ramp.ts:58-61` — RENAMED from `RampOnboardingStatusV2Schema`/`RampOnboardingStatusV2` in Task 7 once the old 3-state schema of the same base name was deleted; `{status: 'not_started' \| 'verifying' \| 'incomplete' \| 'ready'}`, `GET /ramp/onboarding`'s response and the state `POST /ramp/onboarding` returns), `OnboardingStartRequestSchema`/`OnboardingStartRequest` (`ramp.ts:71-75`, `{displayName, email}` — `POST /ramp/onboarding/start` and `POST /ramp/onboarding/kyc-launch`'s shared request body), `KycLaunchResponseSchema`/`KycLaunchResponse` (`ramp.ts:86-94`, `{launch: {actionUrl, assertion, target, returnUrl}}`), `PixDetailsRequestSchema`/`PixDetailsRequest` (`ramp.ts:107-114`, `{firstName, lastName, cpf, pixKey, pixKeyType}` — `POST /ramp/onboarding`'s request body), `RampOrderStatusSchema`/`RampOrderStatus` (`ramp.ts:126-135`, `z.enum(['created','funded','completed','finalized','failed','refunded','canceled'])`), `PixDepositSchema`/`PixDeposit` (`ramp.ts:148-153`, `{depositAmount, depositBankName, depositAccountHolder}`), `PayinExecuteRequestSchema`/`PayinExecuteRequest` (`ramp.ts:167-171`, `{quoteId, amountCents}` — `POST /ramp/payin`'s request body, the client echoing its own quote's `receiverAmountCents` as `amountCents`), `PayoutExecuteRequestSchema`/`PayoutExecuteRequest` (`ramp.ts:195-199`, `{quoteId, amountCents}` — `POST /ramp/payout`'s request body, same shape/rationale for the sender-side amount), `PayinOrderResponseSchema`/`PayinOrderResponse` (`ramp.ts:211-217`, `{orderId, status, deposit, receiverAmountCents}`), `PayinOrderStateResponseSchema`/`PayinOrderStateResponse` (`ramp.ts:227-232`, `{orderId, status, txHash}`). Consumed by `api/src/modules/ramp/routes.ts` (`docs/modules/api-ramp.md`) and, since Task 7, directly by `app/src/core/hooks/ramp.ts`/`app/src/screens/OnRamp.tsx`/`app/src/screens/OffRamp.tsx` (`docs/modules/app.md`). |
| `src/ramp.test.ts` | Tests for all 14 schemas above, 76 tests total (down from 100 — Task 7 removed 24 tests across the six deleted schemas, and renamed the `RampOnboardingStatusV2Schema` describe block onto the newly-free `RampOnboardingStatusSchema` name with no test-count change): `RampOnboardingStatusSchema` accepts each of the four enum values and rejects an unrecognized/missing status; `OnboardingStartRequestSchema` accepts a valid `{displayName, email}` and rejects an empty `displayName`/malformed `email`/missing `displayName`; `KycLaunchResponseSchema` accepts a fully-populated nested `launch` object and rejects a missing `launch`, a non-URL `actionUrl`, an empty `assertion`, and a non-URL `returnUrl`; `PixDetailsRequestSchema` accepts a complete body and each of the four `pixKeyType` enum values, and rejects an unknown `pixKeyType`, an empty `firstName`/`cpf`, and a missing `pixKey`; `RampQuoteResponseSchema` accepts a fully-populated quote and rejects a missing `quoteId`/non-numeric `expiresAt`; `PayinQuoteRequestSchema`/`PayoutQuoteRequestSchema` each accept a positive integer amount and reject zero/negative/non-integer/missing; `RampOrderStatusSchema` accepts each of the seven enum values and rejects an unrecognized one; `PixDepositSchema` accepts a fully-populated deposit and rejects an empty `depositAmount`/missing `depositBankName`; `PayinExecuteRequestSchema`/`PayoutExecuteRequestSchema` each accept a non-empty `quoteId` + positive integer `amountCents` and reject an empty/missing `quoteId` and a zero/negative/non-integer/missing `amountCents`; `PayinOrderResponseSchema` accepts a fully-populated order and rejects an empty `orderId`, an unrecognized `status`, a missing nested `deposit` field, and a negative/non-integer `receiverAmountCents`; `PayoutIntentResponseSchema` accepts a fully-populated triple and rejects a missing `intentId`/`xdr`/`hashHex`; `PayinOrderStateResponseSchema` accepts a `null` and a non-null `txHash`, and rejects a missing `txHash`/unrecognized `status` (`packages/shared/src/ramp.test.ts`). |
| `src/vault.ts` | Zod schemas + inferred types for the `vault` module's HTTP contracts: `VaultIntentResponseSchema`, `VaultDepositRequestSchema`, `VaultWithdrawRequestSchema`, `VaultPositionResponseSchema` (`packages/shared/src/vault.ts`). Consumed by `api/src/modules/vault/routes.ts` — see `docs/modules/api-vault.md`. |
| `src/vault.test.ts` | Tests for all four schemas above (`packages/shared/src/vault.test.ts`). |
| `src/index.ts` | Entry point; re-exports all from `./api.js`, `./assets.js`, `./ramp.js`, and `./vault.js` (`packages/shared/src/index.ts:1-4`). |
| `package.json` | Package entry point `exports["."]` → `./src/index.ts` (`packages/shared/package.json:6`). |
| `vitest.config.ts` | Test runner config — includes `src/**/*.test.ts` (`packages/shared/vitest.config.ts:2`). |

## Endpoints / Public surface

**`ProvisionResponseSchema`** / **`ProvisionResponse`** (`packages/shared/src/api.ts:28-29`)
`z.union([ProvisionPendingSchema, ProvisionCompleteSchema])`. Either `{intentId: string, xdr: string, hashHex: string}` (a pending, sponsor-signed provisioning intent) or `{provisioned: true, stellarAddress: string}` (already on-chain).

**`WalletBalanceSchema`** / **`WalletBalance`** (`packages/shared/src/api.ts:39-44`)
`{assetCode: string, assetIssuer: string, balance: string}`. `assetIssuer` is required, not optional — the backend (`api/src/modules/wallet/service.ts`, see `docs/modules/api-wallet.md`) only ever populates `balances` with entries whose `(assetCode, assetIssuer)` pair exactly matches an asset-registry entry, specifically so a merchant-added trustline to a foreign issuer sharing a registry asset's code (e.g. a phishing "airdrop" using the real `USDC` code) can never be reported — and can never even be *represented* — as the genuine asset.

**`WalletResponseSchema`** / **`WalletResponse`** (`packages/shared/src/api.ts:47,52`)
`{stellarAddress: string, provisioned: boolean, balances: Array<WalletBalance>}`.

**`CompleteIntentRequestSchema`** / **`CompleteIntentResponseSchema`** (`packages/shared/src/api.ts:59-62,65-68`)
`POST /intents/:id/complete`'s contracts: `{signature: string}` in, `{txHash: string}` out — see `docs/modules/api-intents.md`.

**`stellarAmountSchema`** (`packages/shared/src/api.ts:116-123`)
The Stellar-amount contract, extracted out of `PaymentRequestSchema.amount` so other amount-bearing request shapes (e.g. a future vault deposit/withdraw request) can reuse it verbatim: `z.string()` that must match `/^\d+(\.\d{1,7})?$/` (a positive decimal string with at most 7 fractional digits, matching Stellar classic assets' fixed decimal convention), pass a `.refine((v) => Number(v) > 0, ...)` check (`'0'`/`'0.0000000'` rejected even though they match the regex), AND pass a max-value `.refine` capping it at Stellar's int64 ceiling (`922337203685.4775807`) — see Gotchas for why that comparison is `BigInt`-based (via `toStroops`), not `Number`-based.

**`toStroops`** (`packages/shared/src/api.ts:101-107`)
`(decimalAmount: string): bigint`. Converts a `stellarAmountSchema`-shaped decimal string to integer stroops (`whole * 10_000_000n + frac.padEnd(7, '0')`) — exported for reuse by any other amount-bearing schema/caller needing the same conversion. Only safe to call on a string that's already regex-validated (see Gotchas).

**`PaymentRequestSchema`** / **`PaymentRequest`** (`packages/shared/src/api.ts:131-136`)
`POST /payments`'s request body: `{destination: string, amount: string, assetCode: string}`. `destination` must match `/^G[A-Z2-7]{55}$/` (a Stellar ed25519 public key — the same pattern as `assets.ts`'s `stellarPublicKey`, deliberately duplicated rather than exported/shared, see Gotchas; only shape, not checksum — see `docs/modules/api-payments.md`'s Gotchas for the service-layer `StrKey` check). `amount` is `stellarAmountSchema` (above). `assetCode` is only shape-validated here (`z.string().min(1)`) — actual registry membership is checked in `api/src/modules/payments/service.ts`, since this package has no `AssetRegistry` instance of its own to check against (only the `AssetRegistry` *class*, `assets.ts`).

**`PaymentResponseSchema`** / **`PaymentResponse`** (`packages/shared/src/api.ts:127-132`)
`POST /payments`'s response: `{intentId: string, xdr: string, hashHex: string}` — a pending, unsigned-by-merchant payment intent. Structurally identical to `ProvisionPendingSchema` but independently defined (see Gotchas) — see `docs/modules/api-payments.md`.

**`ActivityItemSchema`** / **`ActivityItem`** (`packages/shared/src/api.ts:157-169`)
One row of `GET /activity`'s feed: `{id, type, direction, amount, assetCode, assetIssuer, counterparty, status, txHash, createdAt}`. Mirrors the `activity` table's client-relevant columns (`api/src/db/schema.ts`) exactly — `direction`/`amount`/`assetCode`/`assetIssuer`/`counterparty`/`txHash` are all nullable, matching the table's nullable columns — but omits `stellarAddress` (always the requester's own) and `source`/`externalRef` (internal reconciliation bookkeeping). `type` is `z.enum(['provision', 'send', 'receive', 'on_ramp', 'off_ramp', 'vault_deposit', 'vault_withdraw'])` — widened beyond the three original values to mirror `activity.type`'s widened `$type` union (`api/src/db/schema.ts`) ahead of the payout/vault intent kinds; `on_ramp` has no writer yet. `direction` is `z.enum(['in', 'out']).nullable()`, `status` is `z.enum(['pending', 'confirmed', 'failed'])` — see `docs/modules/api-history.md`.

**`ActivityFeedResponseSchema`** / **`ActivityFeedResponse`** (`packages/shared/src/api.ts:179-183`)
`GET /activity`'s response: `{items: ActivityItem[], nextBefore: string | null}`. `nextBefore` is the last item's `createdAt` when the returned page is full, `null` otherwise — see `docs/modules/api-history.md`.

**`RampOnboardingStatusSchema`** / **`RampOnboardingStatus`** (`packages/shared/src/ramp.ts:58-61`)
The Etherfuse 4-state onboarding ladder: `{status: 'not_started' | 'verifying' | 'incomplete' | 'ready'}` — `GET /ramp/onboarding`'s response and the state `POST /ramp/onboarding` returns after each step runs. See `docs/modules/api-ramp.md`'s onboarding state machine gotcha.

**`RampQuoteResponseSchema`** / **`RampQuoteResponse`** (`packages/shared/src/ramp.ts:10-18`)
The shared response shape for BOTH `POST /ramp/payin/quote` and `POST /ramp/payout/quote`: `{quoteId, expiresAt, senderAmountCents, receiverAmountCents, flatFeeCents, commercialQuotation}` — all `z.number()` except `quoteId` (`z.string()`). Amounts are integer cents, `expiresAt` is epoch ms. Field-for-field identical to `api/src/modules/ramp/provider.ts`'s `RampQuote`; `RampService.payinQuote`/`payoutQuote` each map one straight onto the other.

**`PayinQuoteRequestSchema`** / **`PayinQuoteRequest`** (`packages/shared/src/ramp.ts:21-22`)
`POST /ramp/payin/quote`'s request body: `{amountBrlCents: z.number().int().positive()}` — the BRL amount to quote, in integer cents.

**`PayinExecuteRequestSchema`** / **`PayinExecuteRequest`** (`packages/shared/src/ramp.ts:167-171`)
`POST /ramp/payin`'s request body: `{quoteId: z.string().min(1), amountCents: z.number().int().positive()}`. The client echoes the SAME quote's own `receiverAmountCents` as `amountCents` rather than the API deriving it via a provider read-back — Etherfuse validates the actual token delivery against the quote server-side, so a dishonest value only mislabels the sender's own `activity` row (same trust envelope as the payout flow's `{quoteId, amountCents}` design) — see `docs/modules/api-ramp.md`'s Gotchas.

**`PayoutQuoteRequestSchema`** / **`PayoutQuoteRequest`** (`packages/shared/src/ramp.ts:25-26`)
`POST /ramp/payout/quote`'s request body: `{amountCents: z.number().int().positive()}` — the sender-side settlement-token amount to quote, in integer cents.

**`PayoutIntentResponseSchema`** / **`PayoutIntentResponse`** (`packages/shared/src/ramp.ts:36-37`)
`POST /ramp/payout`'s response: `{intentId, xdr, hashHex}` — the created `'payout'`-kind signing intent. The client signs `hashHex` via Privy `rawSign` and submits through the EXISTING `POST /intents/:id/complete` — there is no dedicated payout completion endpoint.

**`PayoutExecuteRequestSchema`** / **`PayoutExecuteRequest`** (`packages/shared/src/ramp.ts:195-199`)
`POST /ramp/payout`'s request body (anchor-mode payout): `{quoteId: z.string().min(1), amountCents: z.number().int().positive()}`. The client echoes the SAME quote's own sender-side amount as `amountCents` rather than the API deriving it — Etherfuse's anchor order create response carries no settlement amount either (`OfframpAnchorDetails`, `api/src/modules/ramp/provider.ts`), and Etherfuse AUTO-REFUNDS any anchor payment whose on-chain amount doesn't match the order server-side, so a dishonest value here only gets the sender's own payment refunded — same trust envelope as `PayinExecuteRequestSchema`, applied to the direction where the backstop is a refund instead of a quote-validation rejection — see `docs/modules/api-ramp.md`'s Gotchas.

**`OnboardingStartRequestSchema`** / **`OnboardingStartRequest`** (`packages/shared/src/ramp.ts:71-75`)
Request body to start Etherfuse onboarding (and, reused verbatim, to re-launch hosted KYC): `{displayName: string.min(1), email: string.email()}` — a subset of `POST /ramp/organization`'s request body per `docs/evidence/etherfuse-sandbox-findings.md`'s `## Org & KYC` section, which notes `email` must be a real, receivable inbox since the hosted KYC flow emails a PIN to it even in sandbox.

**`KycLaunchResponseSchema`** / **`KycLaunchResponse`** (`packages/shared/src/ramp.ts:86-94`)
`{launch: {actionUrl: string.url(), assertion: string.min(1), target: string.min(1), returnUrl: string.url()}}` — the hosted KYC launch parameters. Per `docs/evidence/etherfuse-sandbox-findings.md`'s `## Launch JWT` section, the launch is a browser form-POST of `assertion` (the signed RS256 JWT) and `target` (`/idv`) to `actionUrl` (`https://sandbox.etherfuse.com/auth/launch` in sandbox), with `returnUrl` modeling the evidence's optional `return_url` field (our surface always supplies one) — `app/src/screens/OnRamp.tsx`'s `KycLaunchHiddenForm` renders these verbatim into a hidden, click-submitted `<form>` (`docs/modules/app.md`'s Gotchas).

**`PixDetailsRequestSchema`** / **`PixDetailsRequest`** (`packages/shared/src/ramp.ts:107-114`)
Request body to register the merchant's BRL/PIX bank account: `{firstName, lastName, cpf, pixKey, pixKeyType}`, field-for-field matching the `account` payload of `POST /ramp/customer/{cid}/bank-account` in `docs/evidence/etherfuse-sandbox-findings.md`'s `## Bank account (BRL/PIX)` section. `pixKeyType` is `z.enum(['email', 'cpf', 'phone', 'evp'])` — Etherfuse types it as a plain string upstream; only `'email'` is live-verified in the sandbox recording, and that section notes an org can register only ONE BRL bank account, so the other values could not be probed there.

**`RampOrderStatusSchema`** / **`RampOrderStatus`** (`packages/shared/src/ramp.ts:126-135`)
`z.enum(['created', 'funded', 'completed', 'finalized', 'failed', 'refunded', 'canceled'])` — the Etherfuse order lifecycle. Per `docs/evidence/etherfuse-sandbox-findings.md`'s `## Fiat received & settlement` section, only `created`, `funded`, and `completed` were directly observed live (`created` → `funded` seconds after `POST /ramp/order/fiat_received` → `completed` ~1 min later); the remaining values are documented Etherfuse states included for forward-compatibility but not live-verified.

**`PixDepositSchema`** / **`PixDeposit`** (`packages/shared/src/ramp.ts:148-153`)
`{depositAmount: string.min(1), depositBankName: string, depositAccountHolder: string}` — exactly as recorded in `docs/evidence/etherfuse-sandbox-findings.md`'s `## Onramp order & deposit payload` section. The sandbox's BRL response has NO pix copy-paste code/QR payload; `depositClabe` exists on the upstream `OnrampOrderDetails` shape (always `""` for BRL) and is deliberately omitted here.

**`PayinOrderResponseSchema`** / **`PayinOrderResponse`** (`packages/shared/src/ramp.ts:211-217`)
`POST /ramp/order`'s (onramp) response for our surface: `{orderId: string.min(1), status: RampOrderStatusSchema, deposit: PixDepositSchema, receiverAmountCents: int.positive()}`. `receiverAmountCents` follows this file's pre-existing integer-cents convention (see `RampQuoteResponseSchema`) for the crypto amount the merchant will receive; Etherfuse itself returns this as a decimal string (`destinationAmount`, per `docs/evidence/etherfuse-sandbox-findings.md`'s `## Onramp quote` section), so the service layer converts.

**`PayinOrderStateResponseSchema`** / **`PayinOrderStateResponse`** (`packages/shared/src/ramp.ts:227-232`)
`GET /ramp/order/{id}`'s polled onramp state: `{orderId, status: RampOrderStatusSchema, txHash: string.nullable()}`. `txHash` is nullable because `docs/evidence/etherfuse-sandbox-findings.md`'s `## Fiat received & settlement` section found completed ONRAMP orders carry NO `confirmedTxSignature` in sandbox.

**`AssetConfigSchema`** (`packages/shared/src/assets.ts:6-10`)  
Zod validator for asset configurations. Enforces:
- `code`: 1-12 character string
- `issuer`: Stellar public key (G + 55 base32 chars)
- `decimals`: positive integer

**`AssetConfig`** (`packages/shared/src/assets.ts:12`)  
TypeScript type inferred from `AssetConfigSchema`.

**`UnknownAssetError`** (`packages/shared/src/assets.ts:14-19`)  
Custom error thrown when `AssetRegistry.get()` receives an unknown asset code.

**`AssetRegistry`** (`packages/shared/src/assets.ts:21-38`)  
Class managing a map of supported assets:
- `constructor(assets: AssetConfig[])` — validates and indexes assets by code.
- `get(code: string): AssetConfig` — throws `UnknownAssetError` if not found.
- `list(): AssetConfig[]` — returns a copy of all registered assets.

## Key methods

**`AssetRegistry.get(code: string)`** (`packages/shared/src/assets.ts:29-33`)  
Lookup asset by code. Throws `UnknownAssetError` if not registered.

**`AssetRegistry.list()`** (`packages/shared/src/assets.ts:35-37`)  
Returns a copy of all registered assets (safe iteration).

**`AssetConfigSchema.parse(data)`** (`packages/shared/src/assets.ts:6-10`)  
Validates asset data against schema; throws ZodError on failure.

## Dependencies

- `zod` — `packages/shared/package.json:11`.
- Consumed by `api` via `workspace:*` (`api/package.json:15`). Not yet wired into `app` (no such dependency in `app/package.json`).

## Gotchas & invariants

- **Asset code immutability**: `AssetRegistry` validates all assets at construction time. Invalid configs raise `ZodError` immediately.
- **Single source of truth**: The wallet ONLY manages assets in the registry — adding a new asset requires updating this registry (production values are recorded from the sandbox asset-alignment evidence).
- **Stellar public key format**: Issuer must be exactly G + 55 base32 characters (A-Z, 2-7). Test uses valid placeholder key; real keys must match actual issuers.
- **`PaymentRequestSchema`'s G-address regex is a deliberate duplicate of `assets.ts`'s private `stellarPublicKey` regex, not a shared export** — both are `/^G[A-Z2-7]{55}$/`; kept independent since `assets.ts` doesn't currently export the pattern and adding a cross-file export for one shared literal was judged not worth the coupling for a single reuse site. If either is ever changed, check the other.
- **`stellarAmountSchema`'s max-value check compares `BigInt` stroops, not `Number`s — a plain `Number` comparison at this boundary is silently wrong (`api.ts:83-123`).** Stellar classic assets store amounts as a signed int64 count of stroops (1 unit = 10,000,000 stroops), so the largest representable amount is `922337203685.4775807`. Verified directly: `Number('922337203685.4775807') === Number('922337203685.4775808')` in JS — both round to the identical double, because the string has 19 significant decimal digits and IEEE-754 doubles only reliably hold ~15–17. A `.refine((v) => Number(v) <= 922337203685.4775807, ...)` would therefore silently ACCEPT an amount one stroop over the true ceiling. The fix: `toStroops` (`api.ts:101-107`) converts the already-regex-validated decimal string to an exact `BigInt` of stroops (`whole * 10_000_000n + frac.padEnd(7, '0')`), compared against `STELLAR_INT64_MAX_STROOPS = 9223372036854775807n` — exact integer arithmetic, no precision loss at any boundary.
- **`stellarAmountSchema`/`toStroops` were extracted out of `PaymentRequestSchema` and exported (submitter-routing widening) so a future amount-bearing request shape can reuse them verbatim instead of re-deriving the same regex/refine chain.** `PaymentRequestSchema.amount` now just references the exported const (`api.ts:133`) — behaviorally identical to the inline chain it replaced, verified by the unchanged `PaymentRequestSchema` test cases in `api.test.ts` still passing. `toStroops` is only safe to call on a string that's already matched `DECIMAL_AMOUNT_REGEX` (module-private) — its `whole`/`frac` destructuring assumes that shape.
- **`PaymentResponseSchema` is structurally identical to `ProvisionPendingSchema`** (`{intentId, xdr, hashHex}`) but is its own independently-defined schema, not a type alias — matches this file's existing pattern of one schema per endpoint response (e.g. `CompleteIntentResponseSchema` isn't aliased to anything either), so a future divergence between the two endpoints' response shapes doesn't require an awkward split later.

## Testing

- `assets.test.ts` (`packages/shared/src/assets.test.ts:1-31`) — 6 tests covering:
  - Schema validation (valid configs, invalid issuer, empty code)
  - Registry lookup (found, not found with error, list all)
- `api.test.ts` (`packages/shared/src/api.test.ts`) — 40 tests, up from 32 (submitter-routing widening added the last 8: 4 for `ActivityItemSchema`'s new types, 2 for `toStroops`, 2 for `stellarAmountSchema`): both `ProvisionResponse` branches + a shape-matches-neither rejection; `WalletBalanceSchema` rejecting a balance missing `assetIssuer`; `WalletResponse` with populated/empty balances + a missing-`stellarAddress` rejection; `CompleteIntentRequestSchema`/`CompleteIntentResponseSchema` each accepting their valid shape and rejecting a missing required field; `PaymentRequestSchema` accepting a valid request (with and without a decimal amount) and rejecting a non-G-address destination, a destination one character short, an amount with more than 7 decimal places, a zero amount, an all-zero decimal amount, a negative amount, and an empty `assetCode`; accepting an amount exactly at Stellar's int64 maximum (`922337203685.4775807`) and rejecting one stroop over it (`922337203685.4775808`) — the exact boundary a `Number`-based comparison gets wrong, see Gotchas — plus rejecting an amount far beyond the maximum; `PaymentResponseSchema` accepting a pending-intent shape and rejecting a missing `intentId`; `ActivityItemSchema` accepting a fully-populated row and an all-nullable-fields `'provision'` row, rejecting an unknown `type` and a missing `status`, **and accepting each of the four newly-widened types (`on_ramp`/`off_ramp`/`vault_deposit`/`vault_withdraw`)**; `ActivityFeedResponseSchema` accepting a page with items + a `nextBefore` cursor and an empty page with a `null` `nextBefore`, and rejecting a missing `items` array; **`toStroops` converting `'1.5'` to `15_000_000n` and a whole-number amount with no fractional part; `stellarAmountSchema` accepting a valid amount and rejecting zero, proving it's the exact schema `PaymentRequestSchema.amount` now references**.
- `vault.test.ts` (`packages/shared/src/vault.test.ts`) — 12 tests: `VaultDepositRequestSchema`/`VaultWithdrawRequestSchema` each accepting a valid decimal amount and rejecting zero, more than 7 decimal places, and a missing field; `VaultIntentResponseSchema` accepting an intent-created shape and rejecting a missing `intentId`; `VaultPositionResponseSchema` accepting a position shape and rejecting a missing `assetIssuer`.
- `ramp.test.ts` (`packages/shared/src/ramp.test.ts`) — 76 tests: `RampOnboardingStatusSchema` accepting each of the four enum values and rejecting an unrecognized/missing status; `OnboardingStartRequestSchema` accepting a valid body and rejecting an empty `displayName`/malformed `email`/missing `displayName`; `KycLaunchResponseSchema` accepting a fully-populated nested `launch` object and rejecting a missing `launch`/non-URL `actionUrl`/empty `assertion`/non-URL `returnUrl`; `PixDetailsRequestSchema` accepting a complete body and each of the four `pixKeyType` values, and rejecting an unknown `pixKeyType`/empty `firstName`/empty `cpf`/missing `pixKey`; `RampQuoteResponseSchema` accepting a fully-populated quote and rejecting a missing `quoteId`/non-numeric `expiresAt`; `PayinQuoteRequestSchema`/`PayoutQuoteRequestSchema` each accepting a positive integer amount and rejecting zero/negative/non-integer/missing; `RampOrderStatusSchema` accepting each of the seven enum values and rejecting an unrecognized one; `PixDepositSchema` accepting a fully-populated deposit and rejecting an empty `depositAmount`/missing `depositBankName`; `PayinExecuteRequestSchema`/`PayoutExecuteRequestSchema` each accepting a valid `{quoteId, amountCents}` and rejecting an empty/missing `quoteId` and a zero/negative/non-integer/missing `amountCents`; `PayoutIntentResponseSchema` accepting a fully-populated triple and rejecting a missing `intentId`/`xdr`/`hashHex`; `PayinOrderResponseSchema` accepting a fully-populated order and rejecting an empty `orderId`/unrecognized `status`/missing nested `deposit` field/negative or non-integer `receiverAmountCents`; `PayinOrderStateResponseSchema` accepting a `null` and non-null `txHash`, and rejecting a missing `txHash`/unrecognized `status`.
- Run `pnpm --filter @paltalabs/shared test` to execute vitest suite (134 tests total: 6 `assets.test.ts` + 40 `api.test.ts` + 12 `vault.test.ts` + 76 `ramp.test.ts`) — `packages/shared/package.json:8`, `packages/shared/vitest.config.ts:2`.
- Run `pnpm --filter @paltalabs/shared typecheck` for `tsc --noEmit` — `packages/shared/package.json:9`.
