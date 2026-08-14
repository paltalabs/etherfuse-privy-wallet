import {Horizon, Keypair, rpc} from '@stellar/stellar-sdk';
import {buildApp} from './app.js';
import {getNetworkConfig, resolveSorobanRpcUrl} from './config/networks.js';
import {createDb} from './db/client.js';
import {loadEnv} from './lib/env.js';
import {createSorobanGateway} from './lib/soroban-gateway.js';
import {createHorizonGateway} from './lib/stellar-gateway.js';
import {createPrivyAuthVerifier} from './modules/auth/verifier.js';
import {createEtherfuseProvider} from './modules/ramp/etherfuse.js';
import {createPrivyUserResolver} from './modules/wallet/privy-user.js';

async function main(): Promise<void> {
  const env = loadEnv();
  // Everything network-specific (Horizon URL, passphrase, registry, vault,
  // Etherfuse endpoints/asset) follows from this one selection.
  const network = getNetworkConfig(env.STELLAR_NETWORK);

  // SPONSOR_SECRET_KEY stays optional in the env schema so spike scripts can
  // generate a throwaway key on first run, but the running server always
  // needs a real sponsor key to pay fees/reserves — fail fast instead of
  // booting into a broken state.
  if (!env.SPONSOR_SECRET_KEY) {
    throw new Error(
      'SPONSOR_SECRET_KEY is required to start the server (it is optional in the env schema only for spike-script compatibility).'
    );
  }

  // The ETHERFUSE_* credentials stay optional in the env schema for the same
  // spike-script-compatibility reason as SPONSOR_SECRET_KEY above, but the
  // running server needs all four to talk to the ramp provider (the three JWT
  // ones sign the hosted-KYC launch assertion, which is unrecoverable at
  // request time if misconfigured) — fail fast instead of booting into a
  // broken state.
  if (!env.ETHERFUSE_API_KEY || !env.ETHERFUSE_JWT_ISSUER || !env.ETHERFUSE_JWT_KID || !env.ETHERFUSE_JWT_PRIVATE_KEY) {
    throw new Error(
      'ETHERFUSE_API_KEY, ETHERFUSE_JWT_ISSUER, ETHERFUSE_JWT_KID and ETHERFUSE_JWT_PRIVATE_KEY are required to start the server (they are optional in the env schema only for spike-script compatibility).'
    );
  }

  const {db} = createDb(env.DATABASE_URL);
  const privyAuth = createPrivyAuthVerifier(env.PRIVY_APP_ID, env.PRIVY_APP_SECRET);
  const stellarGateway = createHorizonGateway(new Horizon.Server(network.horizonUrl));
  // Fails fast here on mainnet when SOROBAN_RPC_URL is unset (no public
  // default exists) — even though a vault-less network never invokes it,
  // requiring it unconditionally keeps AppDeps simple and boot deterministic.
  const sorobanGateway = createSorobanGateway(new rpc.Server(resolveSorobanRpcUrl(env.SOROBAN_RPC_URL, network)));
  const privyUserResolver = createPrivyUserResolver(env.PRIVY_APP_ID, env.PRIVY_APP_SECRET);
  // Parsed once here (never per-request) — SPONSOR_SECRET_KEY's presence was
  // already enforced above.
  const sponsorKeypair = Keypair.fromSecret(env.SPONSOR_SECRET_KEY);
  // The ETHERFUSE_* credentials' presence was already enforced above.
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

  const app = buildApp({
    db,
    env,
    privyAuth,
    stellarGateway,
    sorobanGateway,
    privyUserResolver,
    sponsorKeypair,
    rampProvider,
    network,
    logger: {
      level: env.LOG_LEVEL,
      // Human-readable lines when attached to a dev terminal; plain JSON
      // (pino's native format, machine-ingestable) when piped or deployed.
      ...(process.stdout.isTTY
        ? {transport: {target: 'pino-pretty', options: {translateTime: 'HH:MM:ss', ignore: 'pid,hostname'}}}
        : {})
    }
  });

  app.log.info({network: network.name, port: env.PORT}, 'starting api server');

  await app.listen({port: env.PORT});
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
