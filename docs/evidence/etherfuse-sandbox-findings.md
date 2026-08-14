# Etherfuse sandbox findings — BRL/PIX ↔ Stellar testnet USDC

Recorded 2026-08-03 against `https://api.sand.etherfuse.com` (dashboard `https://sandbox.etherfuse.com`) with `api/scripts/spike-etherfuse.ts`. Every payload below is verbatim from a live run (API key and the real inbox used for the email-confirmation PIN redacted; identities are placeholders).

Auth on every call: the raw API key in `Authorization` — **no `Bearer` prefix**.

## Org & KYC

`POST /ramp/organization` with a client-generated UUID (the org id IS the `customerId` used everywhere else) → `201`:

```json
// request
{
  "id": "ce667871-a026-4aab-aac6-d77ac0ad784a",
  "displayName": "Spike Merchant",
  "accountType": "personal",
  "userInfo": {"email": "<merchant-email>", "displayName": "Spike Merchant"}
}
// response 201
{
  "organizationId": "ce667871-a026-4aab-aac6-d77ac0ad784a",
  "displayName": "Spike Merchant",
  "accountType": "personal"
}
```

- Re-POSTing the same id is safe (idempotent by client UUID).
- **`userInfo.email` must be a real, receivable inbox.** The hosted `/idv` flow's `email_confirmation` requirement sends a real PIN to it **even in sandbox** — only document checks are skipped. A placeholder address dead-ends the KYC flow.

`GET /ramp/customer/{id}/kyc?requirements=true` → `200`:

```json
// fresh org
{
  "customerId": "ce667871-...",
  "status": "not_started",
  "currentRejectionReason": null,
  "selfies": [],
  "documents": [],
  "approvedAt": null,
  "needsWork": false
}
// after completing /idv (sandbox auto-approves; placeholder ID + selfie passed)
{
  "status": "approved",
  "approvedAt": "2026-08-03T15:06:46.955321Z",
  "requirements": [
    {"type": "personal_data",      "status": "satisfied", "requiresLaunch": false},
    {"type": "identity_document",  "status": "satisfied", "requiresLaunch": false},
    {"type": "proof_of_address",   "status": "satisfied", "requiresLaunch": false},
    {"type": "occupation",         "status": "satisfied", "requiresLaunch": false},
    {"type": "email_confirmation", "status": "satisfied", "requiresLaunch": true},
    {"type": "selfie",             "status": "satisfied", "requiresLaunch": true},
    {"type": "customer_agreement", "status": "satisfied", "requiresLaunch": true}
  ]
}
```

The `requirements` array only appears with `?requirements=true`. Agreement signing happens inside `/idv` (the separate `/agreements` launch is deprecated).

## Launch JWT

- **Accepted scope string: `verification`** (target `/idv`). Any other scope is rejected with `invalid_scope`.
- **The sandbox ONLY accepts RS256.** An ES256 assertion is rejected at launch with `invalid_client` / ``Disallowed signature algorithm: algorithm `ES256` is not one of: RS256`` — despite JWKS being an open format. Sign with an RSA key (2048-bit worked).
- Required claims (all verified live): `iss` (must equal the Issuer URL registered in the dashboard), `sub` (= the customer's org UUID — anything else registers a brand-new person), `aud` = `https://api.sand.etherfuse.com/auth/token`, `scope` = `verification`, `jti` (fresh per token), **`email` and `name` (required — not optional)**, `iat`, `exp` (~5 min).
- JWT header must carry the `kid` matching a key in the registered JWKS.
- JWKS registration is self-serve in the sandbox dashboard (Partner JWT section: Issuer URL + JWKS URL). **The JWKS URL must respond with `Content-Type: application/json`** — a `text/plain` response (e.g. a GitHub gist raw URL) is rejected with `invalid_client` / `JWKS bad response ... should be application/json`. Etherfuse fetches the JWKS fresh on every verification (no caching on their side).
- Launch mechanics (browser, not JSON): form-POST to `https://sandbox.etherfuse.com/auth/launch` with fields `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`, `assertion=<jwt>`, `target=/idv` (optional `return_url`; `/idv?lang=es` for Spanish). Launch errors render on the page; to read them as JSON, exchange the JWT server-side at `POST /auth/token` first.

## Bank account (BRL/PIX)

`POST /ramp/customer/{cid}/bank-account`. The BRL fields nest under **`account`** (the flat shape is not accepted at the top level — the body is `ApiCreateBankAccountPayload`):

```json
// request
{
  "account": {
    "transactionId": "1717769c-bd4c-42b2-95aa-6c879e7eb4a0",
    "firstName": "Spike",
    "lastName": "Merchant",
    "cpf": "12345678909",
    "pixKey": "spike-merchant@example.com",
    "pixKeyType": "email"
  }
}
// response 201
{
  "bankAccountId": "8851df52-95a5-4f5b-a5ba-0f9121298457",
  "customerId": "ce667871-a026-4aab-aac6-d77ac0ad784a",
  "createdAt": "2026-08-03T15:07:13.059200Z",
  "updatedAt": "2026-08-03T15:07:13.059200Z",
  "currency": "brl",
  "abbrClabe": "",
  "compliant": true,
  "needsWork": false,
  "status": "active"
}
```

- `pixKeyType: "email"` accepted and live-verified. Other values could NOT be probed: **"Only one BRL bank account is allowed per organization"** (400) — once an org has a BRL account, further registrations are rejected, so PIX details are effectively one-shot per org. The OpenAPI spec types `pixKeyType` as a plain string with no enum; client-side validation should offer the standard PIX key types (`email`, `cpf`, `phone`, `evp`) with only `email` live-verified, and surface Etherfuse's rejection for the rest.
- **Immediately `active`** — no activation delay, no BRL equivalent of the MXN `XEXX010101000` RFC trick needed.
- **Gated on KYC**: before the org's KYC was approved the same call returned `409` `"Organization must be approved before adding a bank account"`.
- `transactionId` is a client-generated idempotency UUID.
- The standard test CPF `12345678909` (valid checksum) was accepted.

## Wallet registration

`POST /ramp/customer/{cid}/wallet` (BYO):

```json
// request — claimOwnership is LOAD-BEARING, see below
{"publicKey": "GDYJD3MF...", "blockchain": "stellar", "claimOwnership": true}
// response 200
{
  "walletId": "6c9fe13a-c8f8-4036-a1bc-88191bb59282",
  "customerId": "ce667871-...",
  "publicKey": "GDYJD3MF...",
  "blockchain": "stellar",
  "kycStatus": "approved",
  "claimedOwnership": true
}
```

- **Without `claimOwnership: true` the wallet's `kycStatus` stays `not_started`** — even after the org's KYC is approved, and even after deleting (`DELETE /ramp/wallet/{id}` → 200, resurrects the same `walletId` on re-register) and re-registering. Order creation then fails with `400` `"Terms and conditions have not been completed for the selected wallet"`. With `claimOwnership: true` the wallet flips to `kycStatus: "approved"` immediately and orders work.
- Registration is idempotent per (customer, publicKey) — same `walletId` comes back.
- The spike wallet was funded via friendbot with the `USDC:GBBD47…` trustline pre-established (mirrors our provisioning).

## Assets

`GET /ramp/assets` requires **three** query params — `blockchain`, `currency`, and `wallet` (missing ones 400 with `Query deserialize error: missing field …`; the docs guide shows only `blockchain`):

`GET /ramp/assets?blockchain=stellar&currency=BRL&wallet=GDYJD3MF...` → `200`, items including:

```json
{
  "symbol": "USDC",
  "identifier": "USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  "name": "USDC (Etherfuse Devnet)",
  "currency": "usd",
  "balance": "0.0000000"
}
```

**Testnet USDC identifier confirmed**: `USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`. The list also carries EURC, stablebonds (CETES/KTB/USTRY), etc. `balance` is the queried wallet's live on-chain balance.

## Onramp quote

`POST /ramp/quote` → `200`:

```json
// request
{
  "quoteId": "4507597f-19de-4c71-bb52-7a4f92010732",
  "customerId": "ce667871-...",
  "blockchain": "stellar",
  "quoteAssets": {"type": "onramp", "sourceAsset": "BRL", "targetAsset": "USDC:GBBD47IF6..."},
  "sourceAmount": "100",
  "walletAddress": "GDYJD3MF..."
}
// response 200
{
  "quoteId": "4507597f-...",
  "blockchain": "stellar",
  "quoteAssets": {"type": "onramp", "sourceAsset": "BRL", "targetAsset": "USDC:GBBD47IF6..."},
  "sourceAmount": "100",
  "destinationAmount": "19.620062792064687229069147940",
  "createdAt": "2026-08-03T15:07:22.822950855Z",
  "updatedAt": "2026-08-03T15:07:22.822950855Z",
  "expiresAt": "2026-08-03T15:09:22.823414202Z",
  "exchangeRate": "0.1959394590264675335384349581",
  "etherfuseMidMarketRate": "0.196332123273013560659754467",
  "nominalRate": "0.196761060",
  "feeBps": "20",
  "feeAmount": "0.20",
  "requiresSwap": true
}
```

- Amounts are decimal **strings**; `expiresAt` is an RFC 3339 timestamp exactly 2 minutes out.
- `destinationAmount` is already net of all fees. `feeAmount` is denominated in the source asset (BRL here); `feeBps` is a string.
- `quoteId` is client-generated.

## Onramp order & deposit payload

`POST /ramp/order` `{orderId, quoteId, bankAccountId, cryptoWalletId}` → `200`:

```json
{
  "onramp": {
    "orderId": "5777d79c-326a-418d-be30-63e7073f311c",
    "depositClabe": "",
    "depositAmount": "100",
    "depositBankName": "PIX",
    "depositAccountHolder": "Etherfuse"
  }
}
```

- **The sandbox returns NO PIX copy-paste code and no QR payload for BRL** — the response reuses the CLABE-shaped `OnrampOrderDetails` with `depositClabe: ""` and `depositBankName: "PIX"`. The order read (`GET /ramp/order/{id}`) adds nothing PIX-specific either (and there `depositBankName` reads `STP`, an MXN rail label). The only user-facing deposit reference is `depositAmount` plus the hosted `statusPage` (`https://sandbox.etherfuse.com/ramp/order/<orderId>`).
- Consequence for the app: render amount + status (+ statusPage link); do NOT design a PIX-code/QR panel around sandbox data. Revisit against production payloads before mainnet.
- Stale/expired `quoteId` → `400`; a duplicate open order for the same (bank account, amount) → `409`.
- **`GET /ramp/order/{id}`'s `customerId` is the PARTNER org's id, not the merchant's org id** (side effect of `claimOwnership`). Never use it for ownership checks — resolve ownership from our own DB (`externalRef`).

## Fiat received & settlement

Sandbox-only deposit simulator — **body is just the order id**:

```
POST /ramp/order/fiat_received
{"orderId": "5777d79c-326a-418d-be30-63e7073f311c"}
→ 200 (empty body)
```

Order lifecycle observed via `GET /ramp/order/{id}` polling: `created` → `funded` (seconds after fiat_received) → `completed` (~1 min).

In-flight read, `status: created` (recorded immediately after order creation, before fiat_received):

```json
{
  "orderId": "5777d79c-326a-418d-be30-63e7073f311c",
  "customerId": "27c212ef-3cca-41aa-bdb3-46695a8d9251",
  "createdAt": "2026-08-03T15:08:55.130729Z",
  "updatedAt": "2026-08-03T15:08:55.130730Z",
  "amountInFiat": "100",
  "walletId": "6c9fe13a-c8f8-4036-a1bc-88191bb59282",
  "bankAccountId": "8851df52-95a5-4f5b-a5ba-0f9121298457",
  "orderType": "onramp",
  "status": "created",
  "statusPage": "https://sandbox.etherfuse.com/ramp/order/5777d79c-326a-418d-be30-63e7073f311c",
  "feeBps": 20,
  "feeAmountInFiat": "0.20",
  "depositBankName": "STP",
  "depositAccountHolder": "Etherfuse",
  "exchangeRate": "0.1962006279",
  "etherfuseMidMarketRate": "0.1965938156",
  "sourceAsset": "BRL",
  "targetAsset": "USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  "blockchain": "stellar",
  "partnerFeeBps": 0
}
```

- The in-flight read carries no token amount (`amountInTokens` appears only at `completed`) and no `trackingCode` (appears at `funded`).
- **Rate semantics**: the order's `exchangeRate` (`0.1962006279`) is the ORDERED quote's effective fee-inclusive rate (`destinationAmount / sourceAmount` = `0.196200627920…`), truncated to 10 decimals — NOT a re-quoted rate. (An earlier expired quote from the same run had rate `0.19593945…`; the order echoes the quote it was created from.) `amountInFiat × exchangeRate ≈ destinationAmount` therefore holds, but only at 10-decimal precision.

Completed onramp order:

```json
{
  "orderId": "5777d79c-...",
  "status": "completed",
  "completedAt": "2026-08-03T15:09:59.724082Z",
  "amountInFiat": "100",
  "amountInTokens": "19.620062792064687229069147940",
  "trackingCode": "2763296125929322112922",
  "orderType": "onramp",
  "statusPage": "https://sandbox.etherfuse.com/ramp/order/5777d79c-...",
  "sourceAsset": "BRL",
  "targetAsset": "USDC:GBBD47IF6...",
  "blockchain": "stellar"
}
```

- **Delivery mode: DIRECT.** Horizon shows a `path_payment_strict_receive` of `19.6200627` USDC landing in the wallet (tx `773a7202667707db75cd0b1cf6bd81e94e9907992378c3ff15e0662570e67c7b`); **zero claimable balances** for the wallet. With the trustline pre-established (as our provisioning guarantees) there is no claim step.
- **The completed ONRAMP order carries NO `confirmedTxSignature` in sandbox** — the delivery tx hash is absent from the API response. Anything consuming it (indexer poller) must treat `txHash` as nullable.

## Offramp quote

Same endpoint, assets reversed — `{type: "offramp", sourceAsset: "USDC:GBBD47IF6...", targetAsset: "BRL"}`, `sourceAmount: "10"` (USDC) → `200`: `destinationAmount: "50.71017"` (BRL), `exchangeRate: "5.07101764"`, `feeBps: "20"`, `feeAmount: "0.02"` (denominated in USDC, the source asset), same 2-minute `expiresAt`.

## Anchor order

`POST /ramp/order` with `useAnchor: true` → `200`:

```json
{
  "offramp": {
    "orderId": "da3d9e63-ef0d-431c-9517-c1a145c1027b",
    "withdrawAnchorAccount": "GCUX6U4F5675FBA5LSVFCL7HGMRTMTXB4U2WSM5ZLUE4ORIHS6XNXY3X",
    "withdrawMemo": "2j2eY+8NQxyVF8GhRcECewAAAAAAAAAAAAAAAAAAAAA=",
    "withdrawMemoType": "hash"
  }
}
```

- **`withdrawMemo` is base64** (decodes to exactly 32 bytes), `withdrawMemoType: "hash"` — build the payment with `Memo.hash(<decoded 32 bytes>)`.
- The order read echoes the anchor fields plus `isAnchorOrder: true`.

## Anchor payment & completion

Payment built locally: source = spike wallet, destination = `withdrawAnchorAccount`, `10` USDC (the quote's `sourceAmount`), memo = hash memo from the order. Submitted to Horizon: tx `9ec033df77845aa8d5d10644c900143db033debed08072519726eaf2992deb35`.

- Etherfuse detected the payment on-chain within ~25s: order flipped to **`funded`** with `confirmedTxSignature: "dda943024bf84476fdefc1601686e00c9c4e458703132067668a3f465540cd0f"`.
- **`confirmedTxSignature` on the OFFRAMP order is NOT the merchant's payment hash** (ours was `9ec033df…`) — it is an Etherfuse-internal transaction. The off-ramp activity row must keep the hash we computed at submit time; never overwrite it from the order.
- Fiat payout completion: the order was still `funded` (no `completedAt`, no `trackingCode`) ~10 minutes after payment detection, when this recording session ended. The sandbox's BRL fiat leg settles asynchronously (or not at all without operator action). Poller design must treat `funded` as pending indefinitely — there is no deadline after which it can be assumed settled or failed.

## Conclusions

1. **BRL over PIX is enabled and works end-to-end on the sandbox org** — bank account instantly `active`, BRL quotes/orders accepted in both directions.
2. **Token delivery is DIRECT** for a wallet with the USDC trustline (our provisioning case): real `path_payment`, no claimable balance, no claim-signing step needed.
3. **Anchor mode works for BRL offramp**: anchor account + 32-byte base64 hash memo returned; our self-built payment was detected (`funded` + internal `confirmedTxSignature`). Fiat-side completion in sandbox is slow/asynchronous — do not gate UX on `completed`.
4. **JWT launch works — with RS256, not ES256.** ES256 is rejected outright. JWKS URL must serve `Content-Type: application/json`. Required claims include `email` and `name`. Scope string: `verification`.
5. **`claimOwnership: true` is required on BYO wallet registration** — without it orders fail with a wallet-T&C 400 regardless of the customer's KYC state.
6. **The org email must be receivable** (real PIN via email even in sandbox).
7. `GET /ramp/assets` needs `blockchain` + `currency` + `wallet`; testnet USDC identifier confirmed as `USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`.
8. Sandbox gives **no PIX code/QR** in BRL deposit instructions — onramp UX = amount + status polling (+ statusPage link).
9. Onramp `completed` orders carry no `confirmedTxSignature`; offramp orders carry one that is not ours. `txHash` stays nullable end-to-end; the offramp keeps the locally computed hash.
10. Order `customerId` = partner org id — ownership checks must use our own records.
