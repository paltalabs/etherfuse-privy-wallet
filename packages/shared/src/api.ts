import {z} from 'zod';

/**
 * A fresh (or reused-pending) provisioning intent: a sponsor-signed
 * account-creation + trustline transaction waiting on the merchant's
 * signature. Returned by `POST /wallet/provision` when the merchant's
 * Stellar account does not exist on-chain yet.
 */
export const ProvisionPendingSchema = z.object({
  intentId: z.string(),
  xdr: z.string(),
  hashHex: z.string()
});
export type ProvisionPending = z.infer<typeof ProvisionPendingSchema>;

/**
 * The merchant's Stellar account already exists on-chain — nothing left to
 * sign. Returned by `POST /wallet/provision` once Horizon confirms the
 * account (whether provisioned by a prior completed intent or otherwise).
 */
export const ProvisionCompleteSchema = z.object({
  provisioned: z.literal(true),
  stellarAddress: z.string()
});
export type ProvisionComplete = z.infer<typeof ProvisionCompleteSchema>;

/** `POST /wallet/provision`'s response: either branch, discriminated by shape. */
export const ProvisionResponseSchema = z.union([ProvisionPendingSchema, ProvisionCompleteSchema]);
export type ProvisionResponse = z.infer<typeof ProvisionResponseSchema>;

/**
 * One asset balance line in `WalletResponse`, filtered to registry assets
 * only. Carries `assetIssuer` (not just `assetCode`) because the backend
 * matches balances against the asset registry by (code, issuer) together —
 * a merchant-controlled account can hold a trustline to a foreign issuer
 * using the same code as a real registry asset (e.g. a phishing "airdrop"
 * trustline), so the issuer is load-bearing for telling the two apart.
 */
export const WalletBalanceSchema = z.object({
  assetCode: z.string(),
  assetIssuer: z.string(),
  balance: z.string()
});
export type WalletBalance = z.infer<typeof WalletBalanceSchema>;

/** `GET /wallet`'s response: the merchant's address, provisioning status, and live balances. */
export const WalletResponseSchema = z.object({
  stellarAddress: z.string(),
  provisioned: z.boolean(),
  balances: z.array(WalletBalanceSchema)
});
export type WalletResponse = z.infer<typeof WalletResponseSchema>;

/**
 * `POST /intents/:id/complete`'s request body: the merchant's raw ed25519
 * signature over the intent's tx hash, as returned by Privy's `rawSign`
 * (0x-prefixed hex).
 */
export const CompleteIntentRequestSchema = z.object({
  signature: z.string()
});
export type CompleteIntentRequest = z.infer<typeof CompleteIntentRequestSchema>;

/** `POST /intents/:id/complete`'s response: the confirmed submission's tx hash. */
export const CompleteIntentResponseSchema = z.object({
  txHash: z.string()
});
export type CompleteIntentResponse = z.infer<typeof CompleteIntentResponseSchema>;

// Stellar ed25519 public key: G + 55 base32 chars. Deliberately duplicated
// from `assets.ts`'s private `stellarPublicKey` regex (not exported from
// there) rather than adding a cross-file export for one shared literal —
// both must stay `/^G[A-Z2-7]{55}$/` if either is ever touched.
const STELLAR_PUBLIC_KEY_REGEX = /^G[A-Z2-7]{55}$/;

// A positive decimal string with at most 7 fractional digits, matching
// Stellar classic assets' fixed 7-decimal convention (int64 amounts). No
// leading `.` (must have at least one integer digit); the `> 0` check (zero
// and "0.0000000" rejection) is a separate `.refine` below since a regex
// alone can't express "not all-zero" cleanly.
const DECIMAL_AMOUNT_REGEX = /^\d+(\.\d{1,7})?$/;

// Stellar classic assets store amounts as a signed int64 count of stroops
// (1 unit = 10_000_000 stroops), so the largest representable amount is
// Int64.MAX / 10^7 = 9223372036854775807 / 10000000 = 922337203685.4775807.
// Compared as a BigInt of stroops, not `Number(value) <= 922337203685.4775807`
// -- verified that floating point loses precision exactly at this boundary
// (`Number('922337203685.4775807') === Number('922337203685.4775808')` in
// JS, both rounding to the same double), which would silently ACCEPT an
// amount one stroop over the true ceiling.
const STELLAR_INT64_MAX_STROOPS = 9223372036854775807n;

/**
 * Converts a `DECIMAL_AMOUNT_REGEX`-shaped decimal string to integer
 * stroops, for the int64-ceiling `.refine` below. Only ever called after
 * the regex has already matched, so `whole`/`frac` are always digit-only.
 * Exported for reuse by other amount-bearing schemas/callers outside this
 * package that need the same decimal-to-stroops conversion (e.g. a future
 * `vault_deposit`/`vault_withdraw` request shape).
 */
export function toStroops(decimalAmount: string): bigint {
  // Defaults are unreachable given DECIMAL_AMOUNT_REGEX already matched
  // (split('.') on a regex-guaranteed \d+(\.\d{1,7})? always yields a
  // non-empty first element) -- only here to satisfy strict array-index typing.
  const [whole = '0', frac = ''] = decimalAmount.split('.');
  return BigInt(whole) * 10_000_000n + BigInt(frac.padEnd(7, '0'));
}

/**
 * A positive decimal string with at most 7 fractional digits, capped at
 * Stellar classic assets' int64 amount ceiling — the same amount contract
 * `PaymentRequestSchema` has always enforced, extracted here so other
 * request shapes needing a Stellar amount (e.g. a future vault deposit/
 * withdraw request) can reuse it verbatim instead of re-deriving it.
 */
export const stellarAmountSchema = z
  .string()
  .regex(DECIMAL_AMOUNT_REGEX, 'amount must be a positive decimal string with up to 7 decimal places')
  .refine((value) => Number(value) > 0, 'amount must be greater than 0')
  .refine(
    (value) => toStroops(value) <= STELLAR_INT64_MAX_STROOPS,
    'amount exceeds the maximum representable Stellar amount (922337203685.4775807)'
  );

/**
 * `POST /payments`'s request body: send `amount` of `assetCode` to
 * `destination`. `assetCode` is checked against the asset registry in the
 * service layer (`api/src/modules/payments/service.ts`), not here — this
 * package has no registry access.
 */
export const PaymentRequestSchema = z.object({
  destination: z.string().regex(STELLAR_PUBLIC_KEY_REGEX, 'destination must be a Stellar public key (G...)'),
  amount: stellarAmountSchema,
  assetCode: z.string().min(1)
});
export type PaymentRequest = z.infer<typeof PaymentRequestSchema>;

/** `POST /payments`'s response: a pending, unsigned-by-merchant payment intent awaiting `POST /intents/:id/complete`. */
export const PaymentResponseSchema = z.object({
  intentId: z.string(),
  xdr: z.string(),
  hashHex: z.string()
});
export type PaymentResponse = z.infer<typeof PaymentResponseSchema>;

/**
 * One row of `GET /activity`'s feed. Mirrors the client-relevant columns of
 * the `activity` table (`api/src/db/schema.ts`) — deliberately omits
 * `stellarAddress` (always the requester's own address, never someone
 * else's) and `source`/`externalRef` (internal bookkeeping for reconciling
 * pending rows with completed intents, not meaningful to a client). The
 * nullable fields mirror the table's nullable columns exactly: `direction`/
 * `amount`/`assetCode`/`assetIssuer`/`counterparty`/`txHash` are all
 * nullable in `activity` (e.g. a `'provision'`-type row has no
 * amount/asset/counterparty; a `'pending'`-status row has no `txHash` yet).
 */
export const ActivityItemSchema = z.object({
  id: z.string(),
  type: z.enum(['provision', 'send', 'receive', 'on_ramp', 'off_ramp', 'vault_deposit', 'vault_withdraw']),
  direction: z.enum(['in', 'out']).nullable(),
  amount: z.string().nullable(),
  assetCode: z.string().nullable(),
  assetIssuer: z.string().nullable(),
  counterparty: z.string().nullable(),
  status: z.enum(['pending', 'confirmed', 'failed']),
  txHash: z.string().nullable(),
  createdAt: z.string()
});
export type ActivityItem = z.infer<typeof ActivityItemSchema>;

/**
 * `GET /activity`'s response: a page of the merchant's activity feed,
 * newest first. `nextBefore` is the `createdAt` of the last item when the
 * returned page is full (`items.length === limit`, meaning more rows may
 * exist) — pass it back as the next request's `before` query param to walk
 * further back. It is `null` when the page is not full (the feed is
 * exhausted, or the merchant has no rows at all).
 */
export const ActivityFeedResponseSchema = z.object({
  items: z.array(ActivityItemSchema),
  nextBefore: z.string().nullable()
});
export type ActivityFeedResponse = z.infer<typeof ActivityFeedResponseSchema>;
