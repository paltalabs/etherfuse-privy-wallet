/**
 * Headless end-to-end proof: drives the REAL HTTP API (buildApp + a live
 * `Fastify#listen`, called over loopback `fetch` — not `app.inject`) against
 * a live Postgres and Stellar testnet, with every dependency wired
 * production-shape EXCEPT authentication.
 *
 * AUTH BOUNDARY (read before touching this file):
 * `server.ts` (the real process entry, `api/src/server.ts:27,29`) always
 * builds `createPrivyAuthVerifier`/`createPrivyUserResolver` against live
 * Privy. This script instead builds two script-LOCAL stand-ins —
 * `createStaticVerifier`/`createStaticPrivyUserResolver` below — gated
 * behind an explicit check run before either is constructed:
 * `NODE_ENV !== 'production'` AND `E2E_BYPASS_DID` is set. Neither type is
 * exported, imported by, or referenced from `server.ts` or any production
 * code path; they exist only in this file. This works with ZERO changes to
 * `app.ts`/`server.ts` because `AppDeps.privyAuth`/`AppDeps.privyUserResolver`
 * are already dependency-injected fields (`api/src/app.ts:30,32`) —
 * `server.ts` just happens to always fill them with the real Privy-backed
 * implementations.
 *
 * WHY THE RESOLVER BYPASS IS NEEDED (not just the auth one): the spike
 * wallet this script signs with (`docs/evidence/spike-keys.secret.json`) was
 * created via `privy.wallets().create({chain_type: 'stellar'})` with no
 * `user_id` (`api/scripts/spike-privy-stellar.ts:105`) — it is an
 * app-owned wallet, not tied to any Privy user. Production's
 * `createPrivyUserResolver` (`api/src/modules/wallet/privy-user.ts:41`)
 * resolves wallets via `client.wallets().list({user_id, ...})`, which can
 * never return an app-owned wallet for ANY user_id/DID — calling
 * `POST /wallet/provision` against the real resolver would 409
 * `no_stellar_wallet` no matter what DID is used. `createStaticPrivyUserResolver`
 * returns the spike wallet unconditionally, regardless of the DID passed in
 * — a safe stand-in ONLY because this script's own `StaticVerifier` is what
 * decides which DID reaches it end-to-end (i.e. this script is the sole
 * caller of the whole authenticated surface for the run's duration).
 *
 * SPONSOR KEY: prefers `SPONSOR_SECRET_KEY` from the repo-root `.env`
 * (`loadEnv()`) if set; the root `.env` in this repo currently leaves it
 * BLANK, so this script falls back to `docs/evidence/spike-keys.secret.json`'s
 * `sponsor` field (gitignored — holds the funded testnet sponsor used by
 * the Privy×Stellar spike and every other evidence run in this repo).
 *
 * SECRECY: this script must never print, log, or write secret key material
 * anywhere. `docs/evidence/api-e2e.md` (written at the end of a successful
 * run) carries only public G-addresses, tx hashes, and activity-feed counts
 * — no DIDs, no Privy wallet ids, no Etherfuse/DeFindex instance ids, no
 * emails (same redaction convention as every other `docs/evidence/*.md`).
 *
 * PAYMENT DESTINATION: the proof payment goes to the registry asset's
 * **issuer** (`TESTNET_REGISTRY`'s `issuer`, `api/src/config/assets.ts:19`
 * — the testnet USDC issuer), not the sponsor's own address. This script
 * never establishes a trustline for any destination it pays to, and a
 * Stellar account (other than the issuer itself) needs an established
 * trustline before it can receive a non-native asset at all — issuer
 * accounts are the one exception, exempt from that requirement for their
 * own asset regardless of its `auth_required` flag. The current testnet
 * USDC issuer's `auth_required` is `false` (`api/src/config/assets.ts`'s
 * own verified comment), so authorization was never the constraint here;
 * the issuer is simply the one destination this script can pay without also
 * standing up a trustline for it. This still proves the same thing the spec
 * calls for — a merchant-signed, sponsor-fee-bumped payment landing on
 * testnet through `POST /payments` -> `POST /intents/:id/complete` — just
 * to a destination that can actually receive it without this script
 * managing a second account's trustline.
 *
 * WORKER: the indexer (`api/src/worker.ts` in production — a genuinely
 * separate process with its own DB pool) is run IN-PROCESS here, sharing
 * this script's single `db`/`pool` — a deliberate simplification for a
 * one-shot proof script, not a production pattern change. `pollOnce()` is
 * invoked directly (`docs/modules/api-indexer.md`), same as `worker.ts`'s
 * loop body, just without its own pool/signal handling.
 *
 * Run: `pnpm --filter @paltalabs/api e2e:api` (needs `docker compose up -d db`
 * + migrations first — see `docs/modules/api.md`'s how-to-run section for the
 * exact `DB_HOST_PORT`/`DATABASE_URL`/`E2E_BYPASS_DID` invocation used for
 * the evidence run).
 */
import {
  ActivityFeedResponseSchema,
  CompleteIntentResponseSchema,
  PaymentResponseSchema,
  ProvisionResponseSchema,
  WalletResponseSchema,
  type ActivityFeedResponse,
  type ProvisionResponse
} from '@paltalabs/shared';
import {PrivyClient} from '@privy-io/node';
import {Horizon, Keypair, Networks, rpc} from '@stellar/stellar-sdk';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import type {AddressInfo} from 'node:net';
import type {ZodType} from 'zod';
import {buildApp} from '../src/app.js';
import {TESTNET_REGISTRY} from '../src/config/assets.js';
import {resolveSorobanRpcUrl, TESTNET_NETWORK} from '../src/config/networks.js';
import {createDb} from '../src/db/client.js';
import {loadEnv} from '../src/lib/env.js';
import {createSorobanGateway} from '../src/lib/soroban-gateway.js';
import {createHorizonGateway} from '../src/lib/stellar-gateway.js';
import type {PrivyAuthVerifier} from '../src/modules/auth/verifier.js';
import {createDrizzleIndexerRepo, createPoller} from '../src/modules/indexer/poller.js';
import type {RampProvider} from '../src/modules/ramp/provider.js';
import type {PrivyUserResolver, StellarWalletRef} from '../src/modules/wallet/privy-user.js';

const HORIZON_TESTNET_URL = 'https://horizon-testnet.stellar.org';
// Same directory depth as api/scripts/spike-privy-stellar.ts (api/scripts/ ->
// repo root is two levels up) — resolved against this file's own location so
// it works regardless of the invoking process's cwd (pnpm --filter runs
// scripts with cwd = api/, not the repo root).
const EVIDENCE_DIR = new URL('../../docs/evidence/', import.meta.url).pathname;
const KEYS_FILE = EVIDENCE_DIR + 'spike-keys.secret.json';
const EVIDENCE_FILE = EVIDENCE_DIR + 'api-e2e.md';

interface SpikeKeysFile {
  sponsor: string;
  privyWalletId: string;
  privyAddress: string;
}

const evidence: string[] = [];
function note(line: string): void {
  console.log(line);
  evidence.push(line);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A verifier that accepts ANY bearer token and always resolves the fixed
 * DID this script was invoked with. See the AUTH BOUNDARY comment at the
 * top of this file — this type is script-local and never touches
 * production code.
 */
function createStaticVerifier(privyDid: string): PrivyAuthVerifier {
  return {
    async verify() {
      return {privyDid};
    }
  };
}

/**
 * A resolver that always returns the same fixed wallet, regardless of the
 * DID passed in. See the "WHY THE RESOLVER BYPASS IS NEEDED" comment at the
 * top of this file — this type is script-local and never touches production
 * code.
 */
function createStaticPrivyUserResolver(wallet: StellarWalletRef): PrivyUserResolver {
  return {
    async resolveStellarWallet() {
      return wallet;
    }
  };
}

/**
 * A `RampProvider` stand-in whose every method throws — this proof never
 * drives any `/ramp/*` route, so `AppDeps.rampProvider` is required only
 * because it's a non-optional `buildApp` dependency, same rationale as
 * `routes.test.ts`'s "unused in ..." fakes across every other module.
 */
function createUnusedRampProvider(): RampProvider {
  const unused = (): never => {
    throw new Error('unused in e2e-api.ts: this proof never drives a /ramp/* route');
  };
  return {
    createOrganization: unused,
    getKycStatus: unused,
    buildKycLaunch: unused,
    registerBankAccount: unused,
    registerWallet: unused,
    createOnrampQuote: unused,
    createOfframpQuote: unused,
    createOnrampOrder: unused,
    createAnchorOfframpOrder: unused,
    getOrder: unused,
    simulateFiatReceived: unused
  };
}

function readSpikeKeys(): SpikeKeysFile {
  if (!existsSync(KEYS_FILE)) {
    throw new Error(
      `${KEYS_FILE} not found — run \`pnpm --filter @paltalabs/api spike:stellar\` first to provision the spike sponsor/merchant fixtures.`
    );
  }
  const raw = JSON.parse(readFileSync(KEYS_FILE, 'utf8')) as Partial<SpikeKeysFile>;
  if (!raw.sponsor || !raw.privyWalletId || !raw.privyAddress) {
    throw new Error(`${KEYS_FILE} is missing sponsor/privyWalletId/privyAddress fields.`);
  }
  return {sponsor: raw.sponsor, privyWalletId: raw.privyWalletId, privyAddress: raw.privyAddress};
}

/** SPONSOR_SECRET_KEY from .env if set (non-blank); else the spike fixture's sponsor secret. Never logged. */
function resolveSponsorKeypair(envSponsorKey: string | undefined, spikeKeys: SpikeKeysFile): Keypair {
  return Keypair.fromSecret(envSponsorKey && envSponsorKey.length > 0 ? envSponsorKey : spikeKeys.sponsor);
}

/** Privy rawSign returns `{encoding: 'hex', signature: '0x...'}` directly (not nested under `.data`) — same shape spike-privy-stellar.ts already verified. */
async function privySign(privy: PrivyClient, walletId: string, hash: string): Promise<string> {
  const res = await privy.wallets().rawSign(walletId, {params: {hash}});
  return res.signature;
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('refusing to run e2e-api.ts with NODE_ENV=production — this script installs an auth bypass.');
  }
  const bypassDid = process.env.E2E_BYPASS_DID;
  if (!bypassDid) {
    throw new Error(
      'E2E_BYPASS_DID must be set explicitly (any did:privy:...-shaped string) — see docs/modules/api.md.'
    );
  }

  const env = loadEnv();
  const spikeKeys = readSpikeKeys();
  const sponsor = resolveSponsorKeypair(env.SPONSOR_SECRET_KEY, spikeKeys);
  const merchantWallet: StellarWalletRef = {walletId: spikeKeys.privyWalletId, address: spikeKeys.privyAddress};
  const networkPassphrase = Networks.TESTNET;

  const {db, pool} = createDb(env.DATABASE_URL);
  const stellarGateway = createHorizonGateway(new Horizon.Server(HORIZON_TESTNET_URL));
  // Testnet-only proof script — pinned to the testnet config regardless of STELLAR_NETWORK.
  const sorobanGateway = createSorobanGateway(new rpc.Server(resolveSorobanRpcUrl(env.SOROBAN_RPC_URL, TESTNET_NETWORK)));
  const privy = new PrivyClient({appId: env.PRIVY_APP_ID, appSecret: env.PRIVY_APP_SECRET});

  const app = buildApp({
    db,
    env,
    privyAuth: createStaticVerifier(bypassDid),
    stellarGateway,
    sorobanGateway,
    privyUserResolver: createStaticPrivyUserResolver(merchantWallet),
    sponsorKeypair: sponsor,
    rampProvider: createUnusedRampProvider(),
    network: TESTNET_NETWORK
  });

  await app.listen({port: 0, host: '127.0.0.1'});
  const {port} = app.server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  const [asset] = TESTNET_REGISTRY.list();
  if (!asset) throw new Error('TESTNET_REGISTRY is empty');

  async function apiRequest<T>(
    method: 'GET' | 'POST',
    path: string,
    schema: ZodType<T>,
    body?: unknown
  ): Promise<T> {
    // Content-Type must be omitted (not just an empty body) for bodiless
    // requests (e.g. POST /wallet/provision) — Fastify's JSON body parser
    // rejects an empty body when the header claims 'application/json'
    // (FST_ERR_CTP_EMPTY_JSON_BODY), which is a raw FastifyError rather than
    // an AppError, so app.ts's global handler maps it to a generic 500
    // instead of the real cause. Found by running this script against the
    // live server and inspecting the raw error via a throwaway onError hook.
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: 'Bearer e2e-script-bypass',
        ...(body !== undefined ? {'content-type': 'application/json'} : {})
      },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const json: unknown = await res.json();
    if (!res.ok) {
      throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(json)}`);
    }
    return schema.parse(json);
  }

  try {
    note(`# API headless end-to-end proof — ${new Date().toISOString()}`);
    note('');
    note(
      '`api/scripts/e2e-api.ts` drove the real HTTP API (buildApp + Fastify#listen, real loopback fetch) against a live Postgres + Stellar testnet, with a script-local auth/wallet-resolver bypass (never in server.ts — see the script header). No secrets or identifiers (DIDs, Privy wallet ids) below — see the script for the redaction rationale.'
    );
    note('');
    note('## Environment');
    note(
      `- Postgres: \`docker compose up -d db\` + \`pnpm --filter @paltalabs/api db:migrate\` (DATABASE_URL=\`${env.DATABASE_URL}\` — local dev credentials, no secret; port overridden via \`DB_HOST_PORT\` in \`docker-compose.yml\` when \`5432\` is already occupied by an unrelated container on this machine).`
    );
    note(
      // Deliberately NOT interpolating the real bypassDid value here — this
      // file must never carry a DID (see the script header's SECRECY note).
      '- Reproduce: `DATABASE_URL=<as above> E2E_BYPASS_DID=<a did:privy:... string — see docs/modules/api.md> pnpm --filter @paltalabs/api e2e:api`.'
    );

    note('');
    note('## Setup');

    note(
      `- Payment destination: the ${asset.code} issuer (\`${asset.issuer}\`) — see the script header's PAYMENT DESTINATION note for why (this script never establishes a trustline for any other destination, and the issuer needs none to receive its own asset).`
    );

    note('');
    note('## Flow');

    // 1. Provision (idempotent — expected to already be on-chain).
    const provisionResult = await apiRequest<ProvisionResponse>(
      'POST',
      '/wallet/provision',
      ProvisionResponseSchema
    );
    let merchantAddress: string;
    if ('provisioned' in provisionResult) {
      merchantAddress = provisionResult.stellarAddress;
      note(`1. \`POST /wallet/provision\` -> already on-chain: \`{provisioned: true, stellarAddress: ${merchantAddress}}\``);
    } else {
      // Defensive fallback: a fresh merchant would come back pending here.
      // Not the expected path for the spike wallet (already provisioned by
      // the Privy×Stellar spike), but handled so the script degrades
      // gracefully instead of crashing if that ever changes.
      note(`1. \`POST /wallet/provision\` -> pending intent, signing + completing it now`);
      const signature = await privySign(privy, merchantWallet.walletId, provisionResult.hashHex);
      const completed = await apiRequest(
        'POST',
        `/intents/${provisionResult.intentId}/complete`,
        CompleteIntentResponseSchema,
        {signature}
      );
      note(`   completed: \`${completed.txHash}\` (https://stellar.expert/explorer/testnet/tx/${completed.txHash})`);
      const reProvision = await apiRequest<ProvisionResponse>(
        'POST',
        '/wallet/provision',
        ProvisionResponseSchema
      );
      if (!('provisioned' in reProvision)) {
        throw new Error('provisioning did not settle to provisioned:true after completing the intent');
      }
      merchantAddress = reProvision.stellarAddress;
    }

    // 2. GET /wallet — live balances.
    const wallet = await apiRequest('GET', '/wallet', WalletResponseSchema);
    note(
      `2. \`GET /wallet\` -> provisioned: ${wallet.provisioned}, balances: ${wallet.balances
        .map((b) => `${b.balance} ${b.assetCode}`)
        .join(', ') || '(none)'}`
    );

    // 3. POST /payments — 1 unit of the registry asset back to its issuer
    // (see the script header's PAYMENT DESTINATION note for why not the
    // sponsor's own address).
    const paymentAmount = '1';
    const paymentDestination = asset.issuer;
    const payment = await apiRequest('POST', '/payments', PaymentResponseSchema, {
      destination: paymentDestination,
      amount: paymentAmount,
      assetCode: asset.code
    });
    note(`3. \`POST /payments\` (${paymentAmount} ${asset.code} -> issuer) -> intent \`${payment.intentId}\``);

    // 4. Sign the returned hash via Privy rawSign (plays the browser's role).
    const signature = await privySign(privy, merchantWallet.walletId, payment.hashHex);
    note(`4. Privy \`rawSign\` over the intent hash -> signature obtained`);

    // 5. POST /intents/:id/complete — submit, sponsor fee-bumped.
    const completed = await apiRequest(
      'POST',
      `/intents/${payment.intentId}/complete`,
      CompleteIntentResponseSchema,
      {signature}
    );
    note(
      `5. \`POST /intents/${payment.intentId}/complete\` -> \`${completed.txHash}\` (https://stellar.expert/explorer/testnet/tx/${completed.txHash})`
    );

    // 5b. Independent verification straight against Horizon — not just
    // trusting this API's own 'submitted' status (same rigor as this repo's
    // other evidence docs, e.g. docs/evidence/etherfuse-sandbox-findings.md,
    // which likewise checks Horizon directly rather than trusting a
    // provider's self-reported status).
    const horizonTx: unknown = await (
      await fetch(`${HORIZON_TESTNET_URL}/transactions/${completed.txHash}`)
    ).json();
    if (
      typeof horizonTx !== 'object' ||
      horizonTx === null ||
      !('successful' in horizonTx) ||
      (horizonTx as {successful: unknown}).successful !== true
    ) {
      throw new Error(`Horizon did not confirm ${completed.txHash} as successful: ${JSON.stringify(horizonTx)}`);
    }
    const {source_account: horizonSource, fee_account: horizonFeeAccount, fee_charged: horizonFee} = horizonTx as unknown as {
      source_account: string;
      fee_account: string;
      fee_charged: string;
    };
    note(
      `   independently verified on Horizon: successful=true, source_account=${horizonSource === merchantWallet.address ? 'merchant' : horizonSource}, fee_account=${horizonFeeAccount === sponsor.publicKey() ? 'sponsor' : horizonFeeAccount}, fee_charged=${horizonFee} stroops`
    );

    // 6. Run the indexer's poll-one-cycle in-process (see script header —
    // shares this script's db/gateway rather than spinning up worker.ts's
    // own pool) and poll GET /activity until the fresh 'send' row is
    // confirmed, proving API + worker + DB integration in one run.
    const indexerRepo = createDrizzleIndexerRepo(db);
    const poller = createPoller({gateway: stellarGateway, repo: indexerRepo, registry: TESTNET_REGISTRY});

    let feed: ActivityFeedResponse | undefined;
    let cycles = 0;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const cycle = await poller.pollOnce();
      cycles += 1;
      feed = await apiRequest('GET', '/activity?limit=50', ActivityFeedResponseSchema);
      const found = feed.items.find(
        (item) =>
          item.type === 'send' &&
          item.status === 'confirmed' &&
          item.counterparty === paymentDestination &&
          item.amount === paymentAmount &&
          item.txHash === completed.txHash
      );
      note(
        `6. indexer \`pollOnce()\` cycle ${cycles}: merchantCount=${cycle.merchantCount}, recordCount=${cycle.recordCount} — activity feed send-row confirmed: ${Boolean(found)}`
      );
      if (found) break;
      await delay(1500);
    }
    if (!feed) throw new Error('never fetched the activity feed');
    const settled = feed.items.some(
      (item) =>
        item.type === 'send' &&
        item.status === 'confirmed' &&
        item.counterparty === paymentDestination &&
        item.amount === paymentAmount &&
        item.txHash === completed.txHash
    );
    if (!settled) {
      throw new Error(`timed out waiting for the confirmed send activity row; last feed: ${JSON.stringify(feed)}`);
    }

    // 7. Summary — also proves API-written rows (this payment) and
    // indexer-populated history (prior receives) share one feed.
    const byType: Record<string, number> = {};
    for (const item of feed.items) {
      const key = `${item.type}:${item.status}`;
      byType[key] = (byType[key] ?? 0) + 1;
    }
    note('');
    note('## Result');
    note(`- Confirmed payment tx: \`${completed.txHash}\``);
    note(`  https://stellar.expert/explorer/testnet/tx/${completed.txHash}`);
    note(`- Activity feed (\`GET /activity?limit=50\`) returned ${feed.items.length} item(s):`);
    for (const [key, count] of Object.entries(byType).sort()) {
      note(`  - ${key}: ${count}`);
    }

    mkdirSync(EVIDENCE_DIR, {recursive: true});
    writeFileSync(EVIDENCE_FILE, evidence.join('\n') + '\n');
    console.log(`\nEvidence written to ${EVIDENCE_FILE}`);
  } finally {
    await app.close();
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
