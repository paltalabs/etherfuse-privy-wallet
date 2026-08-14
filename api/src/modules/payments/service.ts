import {UnknownAssetError, type AssetRegistry, type PaymentRequest, type PaymentResponse} from '@paltalabs/shared';
import {Asset, Operation, StrKey, TransactionBuilder} from '@stellar/stellar-sdk';
import {eq, type InferSelectModel} from 'drizzle-orm';
import type {NodePgDatabase} from 'drizzle-orm/node-postgres';
import type * as schema from '../../db/schema.js';
import {activity, intents, merchants} from '../../db/schema.js';
import {AppError} from '../../lib/errors.js';
import {StellarAccountNotFoundError, type StellarGateway} from '../../lib/stellar-gateway.js';
import {txHashHex} from '../sponsor/stellar.js';

export type MerchantRecord = InferSelectModel<typeof merchants>;
export type IntentRecord = InferSelectModel<typeof intents>;

/**
 * The pending 'send' activity row written at payment-creation time —
 * carries the full payment detail (`counterparty`/`amount`/`assetCode`/
 * `assetIssuer`) that `intents/service.ts`'s completion flow never sees.
 * `externalRef` is the created intent's id: `intents/service.ts`'s
 * `recordActivity` matches on it to UPDATE this exact row's `status`/
 * `txHash` in place once the intent completes (or fails), instead of
 * inserting a second row — see `docs/modules/api-intents.md`'s Gotchas.
 */
export interface PendingPaymentActivity {
  stellarAddress: string;
  externalRef: string;
  counterparty: string;
  amount: string;
  assetCode: string;
  assetIssuer: string;
}

/**
 * Persistence boundary for the payments module — deliberately narrower than
 * raw Drizzle access so `service.ts` can be unit-tested with an in-memory
 * fake instead of a live Postgres (`service.test.ts`), mirroring
 * `wallet/service.ts`'s `WalletRepo` and `intents/service.ts`'s
 * `IntentsRepo`. Queries `merchants`/`intents`/`activity` directly —
 * deliberately not routed through `wallet`'s or `intents`'s repo, to keep
 * these sibling modules decoupled (same rationale as `intents`, see
 * `docs/modules/api-intents.md`'s Gotchas).
 */
export interface PaymentsRepo {
  getMerchant(privyDid: string): Promise<MerchantRecord | undefined>;
  createPaymentIntent(input: {privyDid: string; xdr: string; hashHex: string}): Promise<IntentRecord>;
  recordPendingActivity(input: PendingPaymentActivity): Promise<void>;
}

/** Production `PaymentsRepo` backed by Drizzle over the real `merchants`/`intents`/`activity` tables. */
export function createDrizzlePaymentsRepo(db: NodePgDatabase<typeof schema>): PaymentsRepo {
  return {
    async getMerchant(privyDid) {
      const [row] = await db.select().from(merchants).where(eq(merchants.privyDid, privyDid));
      return row;
    },

    async createPaymentIntent({privyDid, xdr, hashHex}) {
      const [row] = await db.insert(intents).values({privyDid, kind: 'payment', xdr, hashHex}).returning();
      if (!row) throw new Error(`intent insert did not return a row for privyDid=${privyDid}`);
      return row;
    },

    async recordPendingActivity(input) {
      await db.insert(activity).values({
        stellarAddress: input.stellarAddress,
        type: 'send',
        direction: 'out',
        amount: input.amount,
        assetCode: input.assetCode,
        assetIssuer: input.assetIssuer,
        counterparty: input.counterparty,
        status: 'pending',
        txHash: null,
        source: 'api',
        externalRef: input.externalRef
      });
    }
  };
}

export interface PaymentsServiceDeps {
  repo: PaymentsRepo;
  stellarGateway: StellarGateway;
  registry: AssetRegistry;
  networkPassphrase: string;
}

export interface PaymentsService {
  /**
   * Build and store a pending payment intent: an unsigned classic payment
   * tx (merchant is the source, live sequence number from Horizon) plus a
   * pending 'send' activity row. The sponsor signs nothing here — the
   * merchant must co-sign via Privy `rawSign` and submit through
   * `POST /intents/:id/complete`, which wraps the merchant-signed tx in a
   * sponsor-paid fee-bump (`docs/modules/api-intents.md`).
   */
  createPayment(privyDid: string, request: PaymentRequest): Promise<PaymentResponse>;
}

/**
 * The payments module's business logic: validated `PaymentRequest` in,
 * a pending signing-flow intent out. Decoupled from Postgres/Horizon via
 * `deps`, mirroring `wallet`/`intents`'s `createXxxService` shape.
 */
export function createPaymentsService(deps: PaymentsServiceDeps): PaymentsService {
  const {repo, stellarGateway, registry, networkPassphrase} = deps;

  return {
    async createPayment(privyDid, request) {
      // Registry membership: PaymentRequestSchema only shape-validates
      // assetCode (a non-empty string) — this package has the registry, so
      // the "is it actually a supported asset" check lives here.
      let assetConfig;
      try {
        assetConfig = registry.get(request.assetCode);
      } catch (err) {
        if (err instanceof UnknownAssetError) {
          throw new AppError('unknown_asset', `asset not supported: ${request.assetCode}`, 400);
        }
        throw err;
      }

      // PaymentRequestSchema only regex-checks destination's SHAPE (G + 55
      // base32 chars) -- it can't validate the embedded CRC16 checksum. A
      // shape-valid but bad-checksum string would otherwise reach
      // stellar-sdk's Operation.payment builder below and throw a raw,
      // non-AppError error there, which app.ts's error handler maps to a
      // generic 500 instead of a 400.
      if (!StrKey.isValidEd25519PublicKey(request.destination)) {
        throw new AppError('invalid_request', 'destination is not a valid Stellar public key', 400);
      }

      const merchant = await repo.getMerchant(privyDid);
      if (!merchant) {
        throw new AppError('merchant_not_found', 'call POST /wallet/provision first', 404);
      }

      if (request.destination === merchant.stellarAddress) {
        throw new AppError('self_payment', 'cannot send a payment to your own address', 400);
      }

      // Live sequence number for the tx source (the merchant). A merchant
      // whose account doesn't exist on-chain yet (provisioning intent still
      // pending/unsubmitted) can't source ANY transaction — surface that as
      // a distinct, actionable error rather than letting the raw
      // StellarAccountNotFoundError escape as a generic 500.
      let merchantAccount;
      try {
        merchantAccount = await stellarGateway.loadAccount(merchant.stellarAddress);
      } catch (err) {
        if (err instanceof StellarAccountNotFoundError) {
          throw new AppError(
            'merchant_not_provisioned',
            'complete wallet provisioning before sending a payment',
            409
          );
        }
        throw err;
      }

      const asset = new Asset(assetConfig.code, assetConfig.issuer);
      const tx = new TransactionBuilder(merchantAccount, {fee: '100', networkPassphrase})
        .addOperation(Operation.payment({destination: request.destination, asset, amount: request.amount}))
        .setTimeout(300)
        .build();
      // Deliberately UNSIGNED: the merchant is the tx source and must sign
      // via Privy rawSign before submission (POST /intents/:id/complete).
      // A destination with no trustline for this asset is not checked here
      // — Horizon rejects it at submit time (op_no_trust); see
      // sponsor/submit.ts's sanitizedReason for how that surfaces.
      const hashHex = txHashHex(tx);
      const xdr = tx.toXDR();

      const created = await repo.createPaymentIntent({privyDid, xdr, hashHex});
      // Pending activity row, tagged with this intent's id so the
      // completion flow updates it in place instead of inserting a second
      // row (see PendingPaymentActivity's doc comment).
      await repo.recordPendingActivity({
        stellarAddress: merchant.stellarAddress,
        externalRef: created.id,
        counterparty: request.destination,
        amount: request.amount,
        assetCode: assetConfig.code,
        assetIssuer: assetConfig.issuer
      });

      return {intentId: created.id, xdr: created.xdr, hashHex: created.hashHex};
    }
  };
}
