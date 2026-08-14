import {Horizon} from '@stellar/stellar-sdk';
import {getNetworkConfig} from './config/networks.js';
import {createDb} from './db/client.js';
import {loadEnv} from './lib/env.js';
import {createHorizonGateway} from './lib/stellar-gateway.js';
import {createDrizzleIndexerRepo, createPoller} from './modules/indexer/poller.js';
import {createDrizzleRampPollerRepo, createRampPoller, type RampPoller} from './modules/indexer/ramp-poller.js';
import {createEtherfuseProvider} from './modules/ramp/etherfuse.js';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Builds the ramp-status poller only when all four `ETHERFUSE_*`
 * credentials are present — unlike `server.ts`, which fails fast at boot
 * when they're missing (`server.ts:34-38`), this worker must still be able
 * to run chain-only (Horizon indexing with no ramp reconciliation) for a
 * deployment that never touches the ramp module, so a missing credential
 * here is a one-line notice, not a startup abort. Mirrors `server.ts`'s own
 * `createEtherfuseProvider` call exactly (same network/asset/JWT wiring) —
 * the two entry points just disagree on how to react to a missing
 * credential, each for its own deployment shape.
 */
function buildRampPoller(env: ReturnType<typeof loadEnv>, db: ReturnType<typeof createDb>['db'], network: ReturnType<typeof getNetworkConfig>): RampPoller | undefined {
  if (!env.ETHERFUSE_API_KEY || !env.ETHERFUSE_JWT_ISSUER || !env.ETHERFUSE_JWT_KID || !env.ETHERFUSE_JWT_PRIVATE_KEY) {
    console.log('[indexer] ETHERFUSE_* credentials not fully set — ramp-status poller disabled, running chain-only');
    return undefined;
  }
  const rampProvider = createEtherfuseProvider({
    apiKey: env.ETHERFUSE_API_KEY,
    apiBaseUrl: network.etherfuse.apiBaseUrl,
    dashboardBaseUrl: network.etherfuse.dashboardBaseUrl,
    blockchain: 'stellar',
    assetId: network.etherfuse.assetId,
    jwtIssuer: env.ETHERFUSE_JWT_ISSUER,
    jwtKid: env.ETHERFUSE_JWT_KID,
    jwtPrivateKeyPem: env.ETHERFUSE_JWT_PRIVATE_KEY
  });
  return createRampPoller({repo: createDrizzleRampPollerRepo(db), provider: rampProvider});
}

/**
 * The indexer worker's process entry: an infinite poll loop, one cycle every
 * `POLL_INTERVAL_MS`. Each cycle runs the Horizon poller (`createPoller`'s
 * `pollOnce`, reconciling `activity` against on-chain payments) then the
 * ramp-status poller (`createRampPoller`'s `pollOnce`, reconciling pending
 * `on_ramp`/`off_ramp` order rows against Etherfuse), each in its own
 * try/catch so a failure in one never skips the other. A SIGINT/SIGTERM sets
 * a stop flag and wakes an in-flight sleep immediately (rather than waiting
 * out the remainder of the interval), so the process exits promptly once the
 * current cycle finishes.
 */
async function main(): Promise<void> {
  const env = loadEnv();
  // Same one-var network selection server.ts uses — the worker must poll the
  // same chain the server submits to.
  const network = getNetworkConfig(env.STELLAR_NETWORK);
  const {db, pool} = createDb(env.DATABASE_URL);
  const gateway = createHorizonGateway(new Horizon.Server(network.horizonUrl));
  const repo = createDrizzleIndexerRepo(db);
  const poller = createPoller({gateway, repo, registry: network.registry});
  const rampPoller = buildRampPoller(env, db, network);

  let stopped = false;
  let wake: (() => void) | undefined;
  const requestStop = (signal: string): void => {
    console.log(`[indexer] received ${signal}, stopping after the current cycle`);
    stopped = true;
    wake?.();
  };
  process.once('SIGINT', () => requestStop('SIGINT'));
  process.once('SIGTERM', () => requestStop('SIGTERM'));

  console.log(`[indexer] starting — poll interval ${env.POLL_INTERVAL_MS}ms`);

  while (!stopped) {
    const startedAt = Date.now();
    try {
      const {merchantCount, recordCount} = await poller.pollOnce();
      console.log(
        `[indexer] cycle done: ${merchantCount} merchant(s) polled, ${recordCount} activity row(s) applied, ${Date.now() - startedAt}ms`
      );
    } catch (err) {
      // A single bad cycle (e.g. a transient Horizon/network error) must not
      // kill the worker — log and retry next interval.
      console.error('[indexer] cycle failed:', err);
    }

    if (rampPoller) {
      try {
        const {updated} = await rampPoller.pollOnce();
        console.log(`[indexer] ramp cycle done: ${updated} order row(s) updated, ${Date.now() - startedAt}ms`);
      } catch (err) {
        // Same resilience stance as the Horizon poller's catch above — kept
        // as its own separate try/catch so a ramp-provider outage never
        // skips (or gets skipped by) the Horizon cycle.
        console.error('[indexer] ramp cycle failed:', err);
      }
    }

    if (stopped) break;
    await Promise.race([
      delay(env.POLL_INTERVAL_MS),
      new Promise<void>((resolve) => {
        wake = resolve;
      })
    ]);
  }

  await pool.end();
  console.log('[indexer] stopped cleanly');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
