import {z} from 'zod';

/**
 * `POST /ramp/payin/quote`'s response — a pix on-ramp quote. Amounts are
 * integer cents (Etherfuse's own convention; see
 * `api/src/modules/ramp/service.ts`'s `centsToDecimal`), `expiresAt` is
 * epoch ms. Field-for-field identical to `api/src/modules/ramp/provider.ts`'s
 * `RampQuote` — `RampService.payinQuote` maps one straight onto the other.
 */
export const RampQuoteResponseSchema = z.object({
  quoteId: z.string(),
  expiresAt: z.number(),
  senderAmountCents: z.number(),
  receiverAmountCents: z.number(),
  flatFeeCents: z.number(),
  commercialQuotation: z.number()
});
export type RampQuoteResponse = z.infer<typeof RampQuoteResponseSchema>;

/** `POST /ramp/payin/quote`'s request body: the BRL amount to quote, in integer cents. */
export const PayinQuoteRequestSchema = z.object({amountBrlCents: z.number().int().positive()});
export type PayinQuoteRequest = z.infer<typeof PayinQuoteRequestSchema>;

/** `POST /ramp/payout/quote`'s request body: the sender-side settlement-token amount to quote, in integer cents. */
export const PayoutQuoteRequestSchema = z.object({amountCents: z.number().int().positive()});
export type PayoutQuoteRequest = z.infer<typeof PayoutQuoteRequestSchema>;

/**
 * `POST /ramp/payout`'s response: the created `'payout'`-kind signing
 * intent, field-for-field identical in shape to `CreateIntentResponse`-style
 * triples elsewhere in this codebase (`intentId`/`xdr`/`hashHex`) — the
 * client signs `hashHex` via Privy `rawSign` and submits through the
 * existing `POST /intents/:id/complete`; there is no dedicated payout
 * completion endpoint (`api/src/modules/ramp/service.ts`'s `createPayout`).
 */
export const PayoutIntentResponseSchema = z.object({intentId: z.string(), xdr: z.string(), hashHex: z.string()});
export type PayoutIntentResponse = z.infer<typeof PayoutIntentResponseSchema>;

// ---------------------------------------------------------------------------
// Etherfuse ramp schemas — see docs/evidence/etherfuse-sandbox-findings.md
// for the live sandbox payloads these are derived from.
// ---------------------------------------------------------------------------

/**
 * The Etherfuse onboarding ladder status: `not_started` (no org/customer
 * created yet), `verifying` (org created, hosted KYC launched but not yet
 * `approved` — see `docs/evidence/etherfuse-sandbox-findings.md`'s
 * `## Org & KYC` section for the underlying `GET /ramp/customer/{id}/kyc`
 * status field), `incomplete` (KYC approved but the BRL bank account and/or
 * Stellar wallet aren't registered yet — see that doc's `## Bank account
 * (BRL/PIX)` and `## Wallet registration` sections), `ready` (both
 * registered — payin/payout enabled).
 */
export const RampOnboardingStatusSchema = z.object({
  status: z.enum(['not_started', 'verifying', 'incomplete', 'ready'])
});
export type RampOnboardingStatus = z.infer<typeof RampOnboardingStatusSchema>;

/**
 * Request body to start Etherfuse onboarding (create the org/customer).
 * Field-for-field a subset of `POST /ramp/organization`'s request body
 * (`displayName`, `userInfo.email`) documented in
 * `docs/evidence/etherfuse-sandbox-findings.md`'s `## Org & KYC` section —
 * that section notes `userInfo.email` must be a real, receivable inbox
 * since the hosted KYC flow emails a PIN to it even in sandbox.
 */
export const OnboardingStartRequestSchema = z.object({
  displayName: z.string().min(1),
  email: z.string().email()
});
export type OnboardingStartRequest = z.infer<typeof OnboardingStartRequestSchema>;

/**
 * Response carrying the hosted KYC launch parameters, per
 * `docs/evidence/etherfuse-sandbox-findings.md`'s `## Launch JWT` section:
 * the launch is a browser form-POST of `assertion` (the signed RS256 JWT)
 * and `target` (`/idv`) to `actionUrl`
 * (`https://sandbox.etherfuse.com/auth/launch` in sandbox), with an optional
 * `return_url` the evidence calls out for post-KYC redirect — modeled here
 * as `returnUrl` since our surface always supplies one.
 */
export const KycLaunchResponseSchema = z.object({
  launch: z.object({
    actionUrl: z.string().url(),
    assertion: z.string().min(1),
    target: z.string().min(1),
    returnUrl: z.string().url()
  })
});
export type KycLaunchResponse = z.infer<typeof KycLaunchResponseSchema>;

/**
 * Request body to register the merchant's BRL/PIX bank account, field-for-field
 * matching the `account` payload of `POST /ramp/customer/{cid}/bank-account`
 * documented in `docs/evidence/etherfuse-sandbox-findings.md`'s `## Bank
 * account (BRL/PIX)` section (`transactionId` is generated server-side, not
 * part of this request). `pixKeyType` is typed as a plain string upstream —
 * only `'email'` is live-verified in the sandbox recording, and that section
 * notes an org can register only ONE BRL bank account, so the other
 * enumerated values (`cpf`, `phone`, `evp` — the standard PIX key types)
 * could not be probed; Etherfuse's own rejection is the backstop for those.
 */
export const PixDetailsRequestSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  cpf: z.string().min(1),
  pixKey: z.string().min(1),
  pixKeyType: z.enum(['email', 'cpf', 'phone', 'evp'])
});
export type PixDetailsRequest = z.infer<typeof PixDetailsRequestSchema>;

/**
 * Etherfuse order lifecycle status, per
 * `docs/evidence/etherfuse-sandbox-findings.md`'s `## Fiat received &
 * settlement` and `## Onramp order & deposit payload` sections. Only
 * `created`, `funded`, and `completed` were directly observed in the sandbox
 * recording (`created` → `funded` seconds after `POST
 * /ramp/order/fiat_received` → `completed` ~1 min later); `finalized`,
 * `failed`, `refunded`, and `canceled` are the remaining documented Etherfuse
 * order states, included for forward-compatibility but not live-verified.
 */
export const RampOrderStatusSchema = z.enum([
  'created',
  'funded',
  'completed',
  'finalized',
  'failed',
  'refunded',
  'canceled'
]);
export type RampOrderStatus = z.infer<typeof RampOrderStatusSchema>;

/**
 * The BRL/PIX deposit instructions returned from `POST /ramp/order`, exactly
 * as recorded in `docs/evidence/etherfuse-sandbox-findings.md`'s `## Onramp
 * order & deposit payload` section: the sandbox's BRL response has NO pix
 * copy-paste code or QR payload — it reuses the CLABE-shaped
 * `OnrampOrderDetails` response, where `depositBankName` reads `"PIX"` and
 * `depositAccountHolder` reads `"Etherfuse"`. `depositClabe` exists on that
 * upstream shape but is always the empty string for BRL orders, so it's
 * deliberately omitted from our surface. That evidence section also warns
 * this must be revisited against real production payloads before mainnet.
 */
export const PixDepositSchema = z.object({
  depositAmount: z.string().min(1),
  depositBankName: z.string(),
  depositAccountHolder: z.string()
});
export type PixDeposit = z.infer<typeof PixDepositSchema>;

/**
 * `POST /ramp/payin`'s request body: the quote id from a prior `POST
 * /ramp/payin/quote` call, PLUS that same quote's `receiverAmountCents`,
 * echoed straight back by the client rather than re-derived server-side.
 * Etherfuse's order-create response carries no settlement amount at all
 * (see `PayinOrderResponseSchema`'s doc comment and
 * `api/src/modules/ramp/provider.ts`'s `OnrampOrderState`), and Etherfuse
 * validates the actual token delivery against the quote on its own side —
 * so a client that lies about `amountCents` here only mislabels its own
 * merchant's `activity` row, never what actually settles. Same trust
 * envelope the payout flow's `{quoteId, amountCents}` design relies on.
 */
export const PayinExecuteRequestSchema = z.object({
  quoteId: z.string().min(1),
  amountCents: z.number().int().positive()
});
export type PayinExecuteRequest = z.infer<typeof PayinExecuteRequestSchema>;

/**
 * `POST /ramp/payout`'s CURRENT request body: the quote id from a prior
 * `POST /ramp/payout/quote` call, PLUS that same quote's sender-side amount,
 * echoed straight back by the client — the exact same shape and trust
 * rationale as `PayinExecuteRequestSchema` above, mirrored for the payout
 * (anchor-mode off-ramp) direction: Etherfuse's anchor order create response
 * carries no settlement amount either (`api/src/modules/ramp/provider.ts`'s
 * `OfframpAnchorDetails`), so the amount for the payment the merchant is
 * about to sign has to come from somewhere the service already trusts — the
 * client's own echo of its prior quote.
 *
 * The payout side's trust envelope is actually TIGHTER than payin's:
 * Etherfuse auto-refunds any anchor payment whose amount doesn't match the
 * order server-side (`docs/evidence/etherfuse-sandbox-findings.md`'s
 * `## Anchor order` and `## Anchor payment & completion` sections), so a
 * client that lies about `amountCents` here can only ever get ITS OWN
 * payment refunded — it can never cause a different amount to actually
 * settle. Same conclusion as `PayinExecuteRequestSchema`'s doc comment,
 * applied to the direction where the provider's own anti-fraud check (the
 * refund) is the backstop instead of Etherfuse's server-side quote
 * validation.
 */
export const PayoutExecuteRequestSchema = z.object({
  quoteId: z.string().min(1),
  amountCents: z.number().int().positive()
});
export type PayoutExecuteRequest = z.infer<typeof PayoutExecuteRequestSchema>;

/**
 * `POST /ramp/order`'s (onramp) response shape for our surface, combining
 * the order id and status with the `PixDepositSchema` deposit instructions
 * above. `receiverAmountCents` follows this file's pre-existing integer-cents
 * convention (see `RampQuoteResponseSchema`) for the
 * expected crypto amount the merchant will receive — Etherfuse itself
 * returns this as a decimal string (`destinationAmount`, see
 * `docs/evidence/etherfuse-sandbox-findings.md`'s `## Onramp quote` section)
 * so the service layer is responsible for the cents conversion.
 */
export const PayinOrderResponseSchema = z.object({
  orderId: z.string().min(1),
  status: RampOrderStatusSchema,
  deposit: PixDepositSchema,
  receiverAmountCents: z.number().int().positive()
});
export type PayinOrderResponse = z.infer<typeof PayinOrderResponseSchema>;

/**
 * `GET /ramp/order/{id}`'s polled state for an onramp order. `txHash` is
 * nullable because `docs/evidence/etherfuse-sandbox-findings.md`'s `##
 * Fiat received & settlement` section found completed ONRAMP orders carry
 * NO `confirmedTxSignature` in sandbox — the delivery tx hash is absent from
 * the API response, so any consumer (e.g. an indexer poller) must treat it
 * as nullable rather than assume it's always populated once `completed`.
 */
export const PayinOrderStateResponseSchema = z.object({
  orderId: z.string().min(1),
  status: RampOrderStatusSchema,
  txHash: z.string().nullable()
});
export type PayinOrderStateResponse = z.infer<typeof PayinOrderStateResponseSchema>;
