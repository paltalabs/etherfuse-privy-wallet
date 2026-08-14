import {config} from 'dotenv';
import {z} from 'zod';

// Credentials live in the repo-ROOT .env, not api/.env — the api workspace has
// no .env of its own. env.ts sits at api/src/lib/env.ts, so three levels up
// (lib -> src -> api) lands at the repo root.
config({path: new URL('../../../.env', import.meta.url).pathname});

const EnvSchema = z.object({
  PRIVY_APP_ID: z.string().min(1),
  PRIVY_APP_SECRET: z.string().min(1),
  // Etherfuse ramp credentials. All four are optional in the schema for the
  // same spike-script-compatibility reason as SPONSOR_SECRET_KEY below;
  // server.ts fail-fasts on any missing one at boot.
  ETHERFUSE_API_KEY: z.string().min(1).optional(),
  // Must equal the Issuer URL registered in the Etherfuse dashboard's
  // Partner JWT section, and match a `kid` in the JWKS registered there.
  ETHERFUSE_JWT_ISSUER: z.string().min(1).optional(),
  ETHERFUSE_JWT_KID: z.string().min(1).optional(),
  // RSA (RS256) PKCS8 PEM — the sandbox rejects ES256
  // (docs/evidence/etherfuse-sandbox-findings.md "## Launch JWT").
  // `\n`-escaped newlines are accepted (etherfuse.ts unescapes them).
  ETHERFUSE_JWT_PRIVATE_KEY: z.string().min(1).optional(),
  DEFINDEX_API_KEY: z.string().min(1).optional(),
  // Left optional (not made required): api/scripts/spike-privy-stellar.ts
  // generates a random sponsor key via `Keypair.random()` when this is
  // absent, so a hard-required schema would break that script's zero-config
  // first run. Revisit once the spike script is retired.
  SPONSOR_SECRET_KEY: z.string().regex(/^S[A-Z2-7]{55}$/).optional(),
  // Postgres connection string. Defaults to the docker-compose `db` service
  // credentials so local dev works with zero .env setup.
  DATABASE_URL: z.string().min(1).default('postgres://paltalabs:paltalabs@localhost:5432/paltalabs'),
  // Fastify server port (server not wired up yet — reserved for it).
  PORT: z.coerce.number().int().positive().default(3000),
  // Allowed CORS origin for the frontend dev server (Vite's default port).
  CORS_ORIGIN: z.string().min(1).default('http://localhost:5173'),
  // Indexer worker's poll interval (ms) — how often worker.ts checks Horizon
  // for new payments per provisioned merchant. Not read by the HTTP server.
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  // Pino log level for the HTTP server (server.ts). 'debug' surfaces
  // request/response detail during development; 'silent' turns logging off.
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  // Which Stellar network the whole stack runs against — selects the
  // NetworkConfig (src/config/networks.ts): Horizon URL, passphrase, asset
  // registry, vault, and the Etherfuse endpoints/asset all follow from this
  // one var.
  STELLAR_NETWORK: z.enum(['testnet', 'mainnet']).default('testnet'),
  // Soroban RPC endpoint used for vault contract invocations (simulate/assemble/
  // sendTransaction) — separate from Horizon, which only serves classic-ledger
  // data. Optional: resolveSorobanRpcUrl falls back to the network's default
  // (testnet has one; mainnet has no free public RPC, so there it's required).
  SOROBAN_RPC_URL: z.string().url().optional()
});

export type SpikeEnv = z.infer<typeof EnvSchema>;

/**
 * Load and validate spike credentials from the repo-root `.env`.
 *
 * Adjustment: a key present in `.env` but left blank (e.g. `SPONSOR_SECRET_KEY=`,
 * unset until the script generates and persists one) loads as `''`, not
 * `undefined` — which fails the optional fields' `min(1)`/regex checks. Blank
 * strings are treated as unset before validation.
 */
export function loadEnv(): SpikeEnv {
  const withBlanksUnset = Object.fromEntries(
    Object.entries(process.env).map(([key, value]) => [key, value === '' ? undefined : value])
  );
  return EnvSchema.parse(withBlanksUnset);
}
