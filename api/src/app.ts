import cors from '@fastify/cors';
import type {Keypair} from '@stellar/stellar-sdk';
import type {NodePgDatabase} from 'drizzle-orm/node-postgres';
import Fastify, {type FastifyInstance, type FastifyServerOptions} from 'fastify';
import type {NetworkConfig} from './config/networks.js';
import type * as schema from './db/schema.js';
import {AppError} from './lib/errors.js';
import type {SpikeEnv} from './lib/env.js';
import type {SorobanGateway} from './lib/soroban-gateway.js';
import type {StellarGateway} from './lib/stellar-gateway.js';
import {authPlugin} from './modules/auth/plugin.js';
import type {PrivyAuthVerifier} from './modules/auth/verifier.js';
import {historyRoutes} from './modules/history/routes.js';
import {createDrizzleHistoryRepo, createHistoryService} from './modules/history/service.js';
import {intentRoutes} from './modules/intents/routes.js';
import {createDrizzleIntentsRepo, createIntentsService} from './modules/intents/service.js';
import {paymentRoutes} from './modules/payments/routes.js';
import {createDrizzlePaymentsRepo, createPaymentsService} from './modules/payments/service.js';
import type {RampProvider} from './modules/ramp/provider.js';
import {rampRoutes} from './modules/ramp/routes.js';
import {createDrizzleRampRepo, createRampService} from './modules/ramp/service.js';
import {createPayoutSubmitter} from './modules/ramp/submitter.js';
import {createPaymentSubmitter, createProvisionSubmitter, createSorobanSubmitter} from './modules/sponsor/submit.js';
import {createDefindexProvider} from './modules/vault/defindex.js';
import {vaultRoutes} from './modules/vault/routes.js';
import {createDrizzleVaultRepo, createVaultService} from './modules/vault/service.js';
import type {PrivyUserResolver} from './modules/wallet/privy-user.js';
import {walletRoutes} from './modules/wallet/routes.js';
import {createDrizzleWalletRepo, createWalletService} from './modules/wallet/service.js';

/**
 * Dependencies injected into the app so tests can pass fakes instead of a
 * live Postgres pool, real config, a real Privy verifier/user resolver, or
 * a real Horizon connection.
 */
export interface AppDeps {
  db: NodePgDatabase<typeof schema>;
  env: SpikeEnv;
  privyAuth: PrivyAuthVerifier;
  stellarGateway: StellarGateway;
  /** Soroban RPC access for the vault module's tx building/submission — the Soroban-RPC sibling of `stellarGateway`, which only wraps Horizon. */
  sorobanGateway: SorobanGateway;
  privyUserResolver: PrivyUserResolver;
  /** Parsed once at startup (server.ts) from `SPONSOR_SECRET_KEY` — never per-request. */
  sponsorKeypair: Keypair;
  /** The `ramp` module's onboarding/payin provider — `server.ts` constructs the real Etherfuse adapter; tests inject a fake. */
  rampProvider: RampProvider;
  /**
   * The active Stellar network's config (`getNetworkConfig(env.STELLAR_NETWORK)`
   * in `server.ts`; tests pass `TESTNET_NETWORK` or a variant) — the single
   * source for registry/vault/passphrase. When `network.vault` is null (no
   * vault deployed on this network yet), the vault module is skipped
   * entirely: no `/vault/*` routes are registered.
   */
  network: NetworkConfig;
  /**
   * Fastify/pino logger config. Omitted (tests) → logging disabled, keeping
   * test output clean; `server.ts` passes a real config built from
   * `LOG_LEVEL` so request logs and the error handler's warn/error lines
   * actually emit.
   */
  logger?: FastifyServerOptions['logger'];
}

/**
 * Builds (but does not start listening) a Fastify instance: CORS locked to
 * `deps.env.CORS_ORIGIN`, a public `/health` route, an authenticated scope
 * guarded by `authPlugin` (see below), and a global error handler that turns
 * thrown `AppError`s into their typed envelope while never leaking
 * unexpected errors to the client.
 */
export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({logger: deps.logger ?? false});
  const {registry, networkPassphrase, vault} = deps.network;

  app.register(cors, {origin: deps.env.CORS_ORIGIN});

  app.get('/health', async () => ({status: 'ok'}));

  const walletService = createWalletService({
    repo: createDrizzleWalletRepo(deps.db),
    stellarGateway: deps.stellarGateway,
    privyUser: deps.privyUserResolver,
    sponsor: deps.sponsorKeypair,
    registry,
    networkPassphrase
  });

  const intentsService = createIntentsService({
    repo: createDrizzleIntentsRepo(deps.db),
    networkPassphrase,
    // `submitters` is a `Partial<Record<IntentKind, IntentSubmitter>>`
    // precisely so this map can work without every kind (see
    // `docs/modules/api-intents.md`'s Gotchas). Every `IntentKind` is
    // registered now that the ramp module's anchor-mode payout submitter
    // (`createPayoutSubmitter`, `./modules/ramp/submitter.js`) exists —
    // NO `RampProvider` dependency: it fee-bumps the merchant-signed inner
    // tx and submits straight through the same `stellarGateway` classic
    // payments use (see `docs/modules/api-ramp.md`).
    submitters: {
      provision: createProvisionSubmitter(deps.stellarGateway),
      payment: createPaymentSubmitter(deps.sponsorKeypair, deps.stellarGateway),
      vault_deposit: createSorobanSubmitter(deps.sponsorKeypair, deps.sorobanGateway, 'vault_deposit'),
      vault_withdraw: createSorobanSubmitter(deps.sponsorKeypair, deps.sorobanGateway, 'vault_withdraw'),
      payout: createPayoutSubmitter(deps.sponsorKeypair, deps.stellarGateway)
    }
  });

  const paymentsService = createPaymentsService({
    repo: createDrizzlePaymentsRepo(deps.db),
    stellarGateway: deps.stellarGateway,
    registry,
    networkPassphrase
  });

  const historyService = createHistoryService({
    repo: createDrizzleHistoryRepo(deps.db)
  });

  // No vault deployed on this network yet → the whole vault module is
  // skipped (no service, no `/vault/*` routes) rather than wired against a
  // placeholder address that could never simulate successfully.
  const vaultService = vault
    ? createVaultService({
        repo: createDrizzleVaultRepo(deps.db),
        provider: createDefindexProvider({
          soroban: deps.sorobanGateway,
          horizon: deps.stellarGateway,
          vault,
          registry,
          networkPassphrase
        }),
        registry,
        vault
      })
    : null;

  // `NetworkConfig.etherfuse.assetId` is a `CODE:ISSUER` pair
  // (`config/networks.ts`); the ramp module records the CODE on its activity
  // rows and resolves the issuer through the registry. Split (and validated)
  // once at boot rather than per request.
  const [rampAssetCode] = deps.network.etherfuse.assetId.split(':');
  if (!rampAssetCode) {
    throw new Error(`network.etherfuse.assetId must be 'CODE:ISSUER', got ${JSON.stringify(deps.network.etherfuse.assetId)}`);
  }

  const rampService = createRampService({
    repo: createDrizzleRampRepo(deps.db),
    provider: deps.rampProvider,
    // Server-derived — the client never supplies a return URL, so the hosted
    // KYC launch has no open-redirect surface.
    kycReturnUrl: `${deps.env.CORS_ORIGIN}/ramp/kyc-return`,
    registry,
    assetCode: rampAssetCode,
    networkName: deps.network.name,
    // Anchor-mode payout builds its own Stellar payment (Etherfuse hands
    // back only an account + memo, not an unsigned tx) — `createPayout`
    // needs the merchant's live account/sequence number and the network's
    // passphrase, same as `payments/service.ts`'s `createPayment`.
    gateway: deps.stellarGateway,
    networkPassphrase
  });

  // Authenticated scope: everything registered after this point goes through
  // `authPlugin`'s `onRequest` hook. `authPlugin` is wrapped with
  // `fastify-plugin`, so its hook and `request.privyDid` decorator attach
  // directly to `authenticated` (not to a throwaway child of it) — route
  // modules (wallet, intents, payments, history, vault, ramp here) opt in by
  // registering their own routes plugin against this SAME `authenticated`
  // instance. `/health` above, registered directly on `app`, is outside this
  // scope and stays public.
  app.register(async (authenticated) => {
    await authenticated.register(authPlugin, {verifier: deps.privyAuth});
    await authenticated.register(walletRoutes, {walletService});
    await authenticated.register(intentRoutes, {intentsService});
    await authenticated.register(paymentRoutes, {paymentsService});
    await authenticated.register(historyRoutes, {historyService});
    if (vaultService) await authenticated.register(vaultRoutes, {vaultService});
    await authenticated.register(rampRoutes, {rampService});
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      // Expected failures still deserve server-side visibility (a 502 from
      // the ramp provider, a failed simulation) — warn, with the request id.
      request.log.warn(
        {
          code: error.code,
          statusCode: error.statusCode,
          ...(error.details !== undefined ? {details: error.details} : {}),
          // Server-log-only detail: e.g. the ramp service attaches the
          // provider's own error text as `cause`; the client envelope below
          // never includes it.
          ...(error.cause instanceof Error ? {cause: error.cause.message} : {})
        },
        error.message
      );
      reply.status(error.statusCode).send({
        code: error.code,
        message: error.message,
        ...(error.details !== undefined ? {details: error.details} : {})
      });
      return;
    }

    // Unknown/unexpected error: log the real thing server-side only, never
    // serialize it back to the client.
    request.log.error(error);
    reply.status(500).send({code: 'internal_error', message: 'internal error'});
  });

  return app;
}
