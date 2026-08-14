import {index, jsonb, pgTable, text, timestamp, uuid} from 'drizzle-orm/pg-core';

/**
 * A merchant's wallet record: one row per Privy-authenticated merchant,
 * keyed by their Privy DID. `provisionedAt` stays null until the sponsor's
 * on-chain account-creation + trustline transaction is confirmed.
 */
export const merchants = pgTable('merchants', {
  privyDid: text('privy_did').primaryKey(),
  privyWalletId: text('privy_wallet_id').notNull(),
  stellarAddress: text('stellar_address').notNull().unique(),
  provisionedAt: timestamp('provisioned_at', {withTimezone: true}),
  createdAt: timestamp('created_at', {withTimezone: true}).defaultNow().notNull()
});

/**
 * A signing intent: a transaction built server-side and handed to the
 * merchant's Privy wallet for raw-signature signing, tracked from
 * construction through submission result.
 *
 * `status`'s `'submitting'` value is a short-lived claim state: `intents/service.ts`'s
 * `complete()` atomically transitions `'pending'` -> `'submitting'` (a
 * `WHERE status = 'pending'` compare-and-swap) immediately before calling
 * the Stellar gateway, so two concurrent completions of the same intent
 * can't both submit — the loser's claim affects zero rows and it responds
 * 409 instead. This column is plain `text` with no DB-level enum
 * constraint (verified above — no `pgEnum`/check constraint), so this
 * value is enforced by application code only (`intents/service.ts`,
 * `docs/modules/api-intents.md`), not by Postgres.
 */
export const intents = pgTable('intents', {
  id: uuid('id').primaryKey().defaultRandom(),
  privyDid: text('privy_did')
    .notNull()
    .references(() => merchants.privyDid),
  // Widened beyond 'provision' | 'payment' to unblock the payout/vault
  // submission strategies (`intents/service.ts`'s `IntentSubmitter` map) --
  // plain text, no DB-level enum constraint, so widening this union is a
  // type-only change with no migration.
  kind: text('kind').notNull().$type<'provision' | 'payment' | 'payout' | 'vault_deposit' | 'vault_withdraw'>(),
  xdr: text('xdr').notNull(),
  hashHex: text('hash_hex').notNull(),
  status: text('status').notNull().default('pending').$type<'pending' | 'submitting' | 'submitted' | 'failed'>(),
  resultTxHash: text('result_tx_hash'),
  error: text('error'),
  // Kind-specific side-channel data an `IntentSubmitter` (or, for
  // `activityExternalRef`, `intents/service.ts`'s `complete()` itself) needs
  // beyond the stored XDR. `quoteId` is reserved for a future ramp-provider
  // integration that needs to re-reference a quote at authorize time;
  // `orderId` is the Etherfuse anchor-mode payout's side-channel --
  // `ramp/service.ts`'s `createPayout` stamps the anchor order's own id here
  // so a reconciliation pass can later match this intent back to its order
  // (`ramp/service.ts`'s `createPayoutIntent`).
  //
  // `activityExternalRef` is a GENERIC, KIND-AGNOSTIC field (not
  // payout-specific, despite `createPayout` being its only writer today):
  // when set, it means the intent's pending `activity` row was tagged with a
  // DIFFERENT `externalRef` than this intent's own id -- so `complete()`
  // (`intents/service.ts`) writes that row's `txHash` on success/failure but
  // deliberately does NOT confirm/fail its `status` itself. That row does
  // NOT stay pending forever, though: `indexer/poller.ts`'s Horizon-payments
  // poller confirms the ON-CHAIN leg the moment it next sees the matching
  // (txHash, stellarAddress) payment -- the SAME cross-type-dedupe mechanism
  // (`RAMP_OWNER_TYPE`) that confirms every other pending activity row this
  // codebase writes. `ramp/service.ts`'s `createPayout` sets it to the SAME
  // `'order:<orderId>'` key `recordPendingPayoutActivity`'s `externalRef`
  // uses -- not so a reconciler owns the happy-path confirm (the indexer
  // already does, same as any `'send'`), but so a FUTURE order-status
  // reconciler can still find and act on a row that's STILL pending because
  // Etherfuse refunded/canceled the anchor order before any matching payment
  // ever landed on-chain (`docs/modules/api-ramp.md`'s payout Gotchas). See
  // `docs/modules/api-intents.md`'s Gotchas for the full contract.
  //
  // Nullable and unused by the 'provision'/'payment' submitters today; this
  // is the one column in this table that actually needs a migration (jsonb,
  // not text) -- `activityExternalRef`'s own addition is a type-only
  // follow-up needing no further migration (still `jsonb`).
  metadata: jsonb('metadata').$type<{quoteId?: string; orderId?: string; activityExternalRef?: string}>(),
  createdAt: timestamp('created_at', {withTimezone: true}).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', {withTimezone: true}).defaultNow().notNull()
});

/**
 * A denormalized activity feed row — provisioning events plus payment
 * sends/receives — written by both the API (on submission) and the
 * indexer (on confirmation from Horizon).
 */
export const activity = pgTable(
  'activity',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    stellarAddress: text('stellar_address').notNull(),
    // Widened beyond 'provision' | 'send' | 'receive' for the payout/vault
    // intent kinds' activity rows. 'on_ramp' is written by
    // ramp/service.ts's createPayin (recordPendingActivity, pending);
    // 'off_ramp' by ramp/service.ts's createPayout
    // (recordPendingPayoutActivity, pending) and by the 'payout'-kind
    // IntentSubmitter's completion write via intents/service.ts's complete()
    // (confirmed/failed, activityType 'off_ramp' -- ramp/submitter.ts:28).
    // Plain text, no DB enum constraint -- widening is type-only, no
    // migration needed.
    type: text('type').notNull().$type<'provision' | 'send' | 'receive' | 'on_ramp' | 'off_ramp' | 'vault_deposit' | 'vault_withdraw'>(),
    direction: text('direction').$type<'in' | 'out'>(),
    amount: text('amount'),
    assetCode: text('asset_code'),
    assetIssuer: text('asset_issuer'),
    counterparty: text('counterparty'),
    status: text('status').notNull().$type<'pending' | 'confirmed' | 'failed'>(),
    txHash: text('tx_hash'),
    source: text('source').notNull().$type<'api' | 'indexer'>(),
    externalRef: text('external_ref'),
    createdAt: timestamp('created_at', {withTimezone: true}).defaultNow().notNull()
  },
  (table) => [
    index('activity_stellar_address_idx').on(table.stellarAddress),
    index('activity_tx_hash_idx').on(table.txHash)
  ]
);

/**
 * Generic sync-cursor store — one row per external stream being polled
 * (e.g. `horizon-payments:<address>`), so pollers resume where they left
 * off across restarts.
 */
export const cursors = pgTable('cursors', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', {withTimezone: true}).defaultNow().notNull()
});

/**
 * One merchant's ramp-provider onboarding state. Row exists from customer
 * creation onward; wallet/bank ids are filled as each idempotent onboarding
 * step completes (POST /ramp/onboarding is resumable).
 */
export const rampCustomers = pgTable('ramp_customers', {
  privyDid: text('privy_did').primaryKey().references(() => merchants.privyDid),
  provider: text('provider').notNull().default('etherfuse'),
  customerId: text('customer_id').notNull(),
  blockchainWalletId: text('blockchain_wallet_id'),
  bankAccountId: text('bank_account_id'),
  createdAt: timestamp('created_at', {withTimezone: true}).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', {withTimezone: true}).defaultNow().notNull()
});
