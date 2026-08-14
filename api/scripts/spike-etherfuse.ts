/**
 * Etherfuse sandbox spike: records the real BRL/PIX ↔ Stellar-testnet-USDC
 * ramp lifecycle against https://api.sand.etherfuse.com, as evidence for the
 * ramp module swap. Findings distilled into
 * docs/evidence/etherfuse-sandbox-findings.md.
 *
 * Probes, in step order (each step is a CLI arg — `tsx scripts/spike-etherfuse.ts <step>`):
 *   org           create the personal organization (org id IS the customerId)
 *   kyc           read KYC status (+requirements breakdown)
 *   launch        mint the partner JWT + write a local HTML launch form for /idv
 *   bank          register a BRL/PIX personal bank account (records accepted pixKeyType + status)
 *   wallet        create/fund a testnet keypair, add the USDC trustline, register it (BYO)
 *   assets        GET /ramp/assets?blockchain=stellar (confirm testnet USDC identifier)
 *   onramp-quote  BRL -> USDC quote (records full fee/rate/expiry shape)
 *   onramp-order  create the order — records the BRL deposit payload (spike target #1)
 *   fiat          sandbox-only POST /ramp/order/fiat_received (records accepted body)
 *   order-status  poll GET /ramp/order/{id} through its lifecycle + check Horizon delivery
 *   offramp-quote USDC -> BRL quote
 *   offramp-order order with useAnchor: true — records withdrawAnchorAccount/Memo/MemoType
 *   offramp-pay   build+sign+submit the anchor payment locally, then poll to completion
 *
 * Auth gotcha (per docs): the API key goes in `Authorization` RAW — no
 * `Bearer ` prefix (a Bearer prefix is Etherfuse's documented #1 cause of 401).
 *
 * JWT: minted with node:crypto (RS256 — the sandbox REJECTS ES256, see
 * mintLaunchJwt) so the spike needs no extra dependency. Required claims per
 * docs/guides/jwt-authentication: iss, sub (= org id), aud, scope
 * ('verification' for /idv), jti, email, name, iat, exp (~5 min).
 *
 * State (generated ids, the throwaway testnet secret) persists in
 * scripts/.spike-etherfuse-state.json — gitignored, never committed. The full
 * request/response transcript flushes to .scratch/etherfuse-spike-transcript.md
 * (gitignored) after every call so a mid-run crash still leaves evidence.
 */
import {Asset, Horizon, Keypair, Memo, Networks, Operation, TransactionBuilder} from '@stellar/stellar-sdk';
import {createPrivateKey, createSign, randomUUID} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {loadEnv} from '../src/lib/env.js';

loadEnv(); // side effect: loads repo-root .env into process.env

const BASE = 'https://api.sand.etherfuse.com';
const DASHBOARD = 'https://sandbox.etherfuse.com';
const HORIZON = 'https://horizon-testnet.stellar.org';
const PASSPHRASE = Networks.TESTNET;
// Testnet USDC per docs' Stellar example — the `assets` step confirms it live.
const USDC_ID = 'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const [USDC_CODE, USDC_ISSUER] = USDC_ID.split(':') as [string, string];

const API_KEY = process.env.ETHERFUSE_API_KEY;
if (!API_KEY) throw new Error('ETHERFUSE_API_KEY missing from repo-root .env — refusing to run.');

const STATE_FILE = new URL('./.spike-etherfuse-state.json', import.meta.url).pathname;
const LAUNCH_FILE = new URL('./.spike-etherfuse-launch.html', import.meta.url).pathname;
const TRANSCRIPT_DIR = new URL('../../.scratch/', import.meta.url).pathname;
const TRANSCRIPT_FILE = TRANSCRIPT_DIR + 'etherfuse-spike-transcript.md';

interface SpikeState {
  orgId?: string;
  /**
   * The org's userInfo.email. The /idv email_confirmation requirement sends a
   * real PIN to this address even in sandbox (only document checks are
   * skipped), so it must be receivable. Seed a real inbox via the
   * SPIKE_ORG_EMAIL env var on the `org` step — it persists here (gitignored)
   * and NEVER goes into committed files or the evidence doc (redact it).
   */
  orgEmail?: string;
  bankTransactionId?: string;
  bankAccountId?: string;
  walletSecret?: string;
  walletPublic?: string;
  walletId?: string;
  onrampQuoteId?: string;
  onrampDestinationAmount?: string;
  onrampOrderId?: string;
  offrampQuoteId?: string;
  offrampSourceAmount?: string;
  offrampOrderId?: string;
  withdrawAnchorAccount?: string;
  withdrawMemo?: string;
  withdrawMemoType?: string;
}

function readState(): SpikeState {
  if (!existsSync(STATE_FILE)) return {};
  return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as SpikeState;
}

function saveState(patch: Partial<SpikeState>): SpikeState {
  const next = {...readState(), ...patch};
  writeFileSync(STATE_FILE, JSON.stringify(next, null, 2));
  return next;
}

const transcript: string[] = existsSync(TRANSCRIPT_FILE)
  ? [readFileSync(TRANSCRIPT_FILE, 'utf8').trimEnd()]
  : [];

function note(line: string): void {
  console.log(line);
  transcript.push(line);
  mkdirSync(TRANSCRIPT_DIR, {recursive: true});
  // Flush after every note so a mid-run crash still leaves partial evidence.
  writeFileSync(TRANSCRIPT_FILE, transcript.join('\n') + '\n');
}

interface EfResult {
  status: number;
  ok: boolean;
  json: unknown;
}

/**
 * Call the Etherfuse sandbox and record the request/response in the
 * transcript. Never throws — 4xx/5xx are data, callers decide how to react.
 * The Authorization header is the RAW key: no `Bearer ` prefix.
 */
async function ef(method: string, path: string, body?: unknown): Promise<EfResult> {
  note(`\n### ${method} ${path}${body === undefined ? '' : `\nRequest body:\n\`\`\`json\n${JSON.stringify(body, null, 2)}\n\`\`\``}`);
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {Authorization: API_KEY as string, 'Content-Type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text.slice(0, 2000) || null;
  }
  note(`→ ${res.status}\n\`\`\`json\n${JSON.stringify(json, null, 2)?.slice(0, 4000)}\n\`\`\``);
  return {status: res.status, ok: res.ok, json};
}

// ---------------------------------------------------------------------------
// JWT (ES256 via node:crypto — JOSE ieee-p1363 signature encoding)

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function mintLaunchJwt(orgId: string): string {
  const issuer = process.env.ETHERFUSE_JWT_ISSUER;
  const pem = process.env.ETHERFUSE_JWT_PRIVATE_KEY;
  const kid = process.env.ETHERFUSE_JWT_KID;
  if (!issuer || !pem || !kid) throw new Error('ETHERFUSE_JWT_ISSUER / ETHERFUSE_JWT_PRIVATE_KEY / ETHERFUSE_JWT_KID missing from .env');
  const now = Math.floor(Date.now() / 1000);
  // Live deviation: the sandbox rejects ES256 outright ("Disallowed signature
  // algorithm: algorithm `ES256` is not one of: RS256") — partner JWTs MUST be
  // RS256/RSA, matching the docs guide's own example. The design's ES256
  // assumption is wrong; recorded in evidence Conclusions.
  const header = {alg: 'RS256', typ: 'JWT', kid};
  // Claims per docs/guides/jwt-authentication (email + name are REQUIRED, not
  // optional): scope 'verification' + target /idv is the hosted-KYC flow.
  const payload = {
    iss: issuer,
    sub: orgId,
    aud: `${BASE}/auth/token`,
    scope: 'verification',
    jti: randomUUID(),
    email: readState().orgEmail ?? 'spike-merchant@example.com',
    name: 'Spike Merchant',
    iat: now,
    exp: now + 5 * 60
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const key = createPrivateKey(pem.replace(/\\n/g, '\n'));
  const signature = createSign('SHA256').update(signingInput).sign(key);
  return `${signingInput}.${b64url(signature)}`;
}

// ---------------------------------------------------------------------------
// Steps

async function stepOrg(): Promise<void> {
  const state = readState();
  const orgId = state.orgId ?? randomUUID();
  const email = process.env.SPIKE_ORG_EMAIL ?? state.orgEmail ?? 'spike-merchant@example.com';
  note(`\n## Org & KYC — ${new Date().toISOString()}`);
  note(`Org/customer id (client-generated, idempotent): \`${orgId}\``);
  const res = await ef('POST', '/ramp/organization', {
    id: orgId,
    displayName: 'Spike Merchant',
    accountType: 'personal',
    userInfo: {email, displayName: 'Spike Merchant'}
  });
  if (res.ok || res.status === 409) saveState({orgId, orgEmail: email});
  else note(`> Organization creation failed — inspect the response above before persisting the id.`);
}

async function stepKyc(): Promise<void> {
  const {orgId} = readState();
  if (!orgId) throw new Error('run `org` first');
  await ef('GET', `/ramp/customer/${orgId}/kyc?requirements=true`);
}

async function stepLaunch(): Promise<void> {
  const {orgId} = readState();
  if (!orgId) throw new Error('run `org` first');
  const jwt = mintLaunchJwt(orgId);
  note(`\n## Launch JWT`);
  note(`Minted RS256 JWT for org \`${orgId}\` — claims: iss=${process.env.ETHERFUSE_JWT_ISSUER}, sub=<org id>, aud=${BASE}/auth/token, scope=verification, jti, email, name, iat, exp(+5m). kid=${process.env.ETHERFUSE_JWT_KID}.`);
  const html = `<!doctype html>
<html><body>
<p>Etherfuse sandbox /idv launch for spike org ${orgId}. Submitting…</p>
<form id="launch" method="POST" action="${DASHBOARD}/auth/launch">
  <input type="hidden" name="grant_type" value="urn:ietf:params:oauth:grant-type:jwt-bearer" />
  <input type="hidden" name="assertion" value="${jwt}" />
  <input type="hidden" name="target" value="/idv" />
  <button type="submit">Launch /idv</button>
</form>
<script>document.getElementById("launch").submit()</script>
</body></html>
`;
  writeFileSync(LAUNCH_FILE, html);
  note(`Launch form written to \`api/scripts/.spike-etherfuse-launch.html\` — open it in a browser (JWT expires in 5 minutes; re-run \`launch\` for a fresh one). Complete /idv with placeholder docs, then re-run \`kyc\` until approved.`);
}

async function stepBank(): Promise<void> {
  const state = readState();
  if (!state.orgId) throw new Error('run `org` first');
  const transactionId = state.bankTransactionId ?? randomUUID();
  saveState({bankTransactionId: transactionId});
  note(`\n## Bank account (BRL/PIX)`);
  // Body shape per the OpenAPI spec: BrlPersonalAccountRequest nests under
  // `account` (ApiCreateBankAccountPayload) — NOT flat. CPF below is the
  // standard valid-checksum test CPF; pixKeyType 'email' is the first probe —
  // a rejection should enumerate the accepted values.
  const res = await ef('POST', `/ramp/customer/${state.orgId}/bank-account`, {
    account: {
      transactionId,
      firstName: 'Spike',
      lastName: 'Merchant',
      cpf: '12345678909',
      pixKey: 'spike-merchant@example.com',
      pixKeyType: 'email'
    }
  });
  if (res.ok) {
    const {bankAccountId} = res.json as {bankAccountId: string};
    saveState({bankAccountId});
  }
  await ef('GET', `/ramp/customer/${state.orgId}/bank-accounts`);
}

async function stepWallet(): Promise<void> {
  const state = readState();
  if (!state.orgId) throw new Error('run `org` first');
  note(`\n## Wallet registration`);

  let secret = state.walletSecret;
  let publicKey = state.walletPublic;
  if (!secret || !publicKey) {
    const pair = Keypair.random();
    secret = pair.secret();
    publicKey = pair.publicKey();
    saveState({walletSecret: secret, walletPublic: publicKey});
    note(`Generated throwaway testnet keypair \`${publicKey}\` (secret persisted in gitignored state file only).`);
  }

  const horizon = new Horizon.Server(HORIZON);
  const funded = await horizon
    .loadAccount(publicKey)
    .then(() => true)
    .catch(() => false);
  if (!funded) {
    const fb = await fetch(`https://friendbot.stellar.org?addr=${publicKey}`);
    note(`Friendbot funding → ${fb.status}`);
  }

  const account = await horizon.loadAccount(publicKey);
  const usdc = new Asset(USDC_CODE, USDC_ISSUER);
  const hasTrustline = account.balances.some((b) => 'asset_code' in b && b.asset_code === USDC_CODE && 'asset_issuer' in b && b.asset_issuer === USDC_ISSUER);
  if (!hasTrustline) {
    const trustTx = new TransactionBuilder(account, {fee: '10000', networkPassphrase: PASSPHRASE})
      .addOperation(Operation.changeTrust({asset: usdc}))
      .setTimeout(300)
      .build();
    trustTx.sign(Keypair.fromSecret(secret));
    const result = await horizon.submitTransaction(trustTx);
    note(`USDC trustline established: [\`${result.hash}\`](https://stellar.expert/explorer/testnet/tx/${result.hash})`);
  } else {
    note(`USDC trustline already present.`);
  }

  // Live deviation: without claimOwnership the wallet stays kycStatus
  // 'not_started' even after the org's KYC approves, and order creation 400s
  // with "Terms and conditions have not been completed for the selected
  // wallet". claimOwnership: true (partner org claims compliance attribution)
  // flips it to 'approved' immediately.
  const res = await ef('POST', `/ramp/customer/${state.orgId}/wallet`, {publicKey, blockchain: 'stellar', claimOwnership: true});
  if (res.ok) {
    const {walletId} = res.json as {walletId: string};
    saveState({walletId});
  }
}

async function stepAssets(): Promise<void> {
  note(`\n## Assets`);
  // Deviation from the docs guide: a bare ?blockchain=stellar 400s with
  // "missing field `currency`", then "missing field `wallet`" — the endpoint
  // requires the fiat currency AND a wallet address.
  const {walletPublic} = readState();
  if (!walletPublic) throw new Error('run `wallet` first');
  await ef('GET', `/ramp/assets?blockchain=stellar&currency=BRL&wallet=${walletPublic}`);
}

async function stepOnrampQuote(): Promise<void> {
  const state = readState();
  if (!state.orgId || !state.walletPublic) throw new Error('run `org` and `wallet` first');
  note(`\n## Onramp quote`);
  const quoteId = randomUUID();
  const res = await ef('POST', '/ramp/quote', {
    quoteId,
    customerId: state.orgId,
    blockchain: 'stellar',
    quoteAssets: {type: 'onramp', sourceAsset: 'BRL', targetAsset: USDC_ID},
    sourceAmount: '100',
    walletAddress: state.walletPublic
  });
  if (res.ok) {
    const {destinationAmount} = res.json as {destinationAmount?: string};
    saveState({onrampQuoteId: quoteId, onrampDestinationAmount: destinationAmount});
    note(`> Quote persisted (\`${quoteId}\`) — expires in 2 minutes, run \`onramp-order\` NOW.`);
  }
}

async function stepOnrampOrder(): Promise<void> {
  const state = readState();
  if (!state.onrampQuoteId || !state.bankAccountId || !state.walletId) throw new Error('run `onramp-quote` (and `bank`/`wallet`) first');
  note(`\n## Onramp order & deposit payload`);
  const orderId = randomUUID();
  const res = await ef('POST', '/ramp/order', {
    orderId,
    quoteId: state.onrampQuoteId,
    bankAccountId: state.bankAccountId,
    cryptoWalletId: state.walletId
  });
  if (res.ok) saveState({onrampOrderId: orderId});
}

async function stepFiat(): Promise<void> {
  const state = readState();
  if (!state.onrampOrderId) throw new Error('run `onramp-order` first');
  note(`\n## Fiat received & settlement`);
  // Sandbox-only deposit simulator. Not in the public OpenAPI spec — the body
  // below is the first probe; a 4xx should reveal the required fields, which
  // this transcript records either way.
  await ef('POST', '/ramp/order/fiat_received', {orderId: state.onrampOrderId});
}

async function pollOrder(orderId: string, terminal: string[]): Promise<string> {
  let lastPayload = '';
  for (let i = 0; i < 24; i++) {
    const res = await ef('GET', `/ramp/order/${orderId}`);
    const status = (res.json as {status?: string} | null)?.status ?? 'unknown';
    const payload = JSON.stringify(res.json);
    if (payload === lastPayload) {
      transcript.pop(); // avoid recording 24 identical payloads
      transcript.pop();
      note(`(poll ${i + 1}: unchanged, status \`${status}\`)`);
    }
    lastPayload = payload;
    if (terminal.includes(status)) return status;
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  return 'timeout';
}

async function stepOrderStatus(): Promise<void> {
  const state = readState();
  if (!state.onrampOrderId || !state.walletPublic) throw new Error('run `onramp-order` first');
  const status = await pollOrder(state.onrampOrderId, ['completed', 'failed', 'refunded', 'canceled']);
  note(`> Final onramp status after polling: \`${status}\``);

  // Delivery mode check: direct payment vs claimable balance.
  const horizon = new Horizon.Server(HORIZON);
  const payments = await horizon.payments().forAccount(state.walletPublic).order('desc').limit(5).call();
  note(`\nHorizon: last payment records for \`${state.walletPublic}\`:\n\`\`\`json\n${JSON.stringify(payments.records.map((r) => ({type: r.type, ...('asset_code' in r ? {asset: (r as {asset_code?: string}).asset_code} : {}), ...('amount' in r ? {amount: (r as {amount?: string}).amount} : {}), tx: r.transaction_hash})), null, 2)}\n\`\`\``);
  const claimable = await horizon.claimableBalances().claimant(state.walletPublic).limit(5).call();
  note(`Horizon: claimable balances for the wallet: ${claimable.records.length === 0 ? 'NONE (delivery was direct)' : JSON.stringify(claimable.records, null, 2).slice(0, 1500)}`);
}

async function stepOfframpQuote(): Promise<void> {
  const state = readState();
  if (!state.orgId || !state.walletPublic) throw new Error('run `org` and `wallet` first');
  note(`\n## Offramp quote`);
  const quoteId = randomUUID();
  const sourceAmount = '10';
  const res = await ef('POST', '/ramp/quote', {
    quoteId,
    customerId: state.orgId,
    blockchain: 'stellar',
    quoteAssets: {type: 'offramp', sourceAsset: USDC_ID, targetAsset: 'BRL'},
    sourceAmount,
    walletAddress: state.walletPublic
  });
  if (res.ok) {
    saveState({offrampQuoteId: quoteId, offrampSourceAmount: sourceAmount});
    note(`> Offramp quote persisted (\`${quoteId}\`) — expires in 2 minutes, run \`offramp-order\` NOW.`);
  }
}

async function stepOfframpOrder(): Promise<void> {
  const state = readState();
  if (!state.offrampQuoteId || !state.bankAccountId || !state.walletId) throw new Error('run `offramp-quote` first');
  note(`\n## Anchor order`);
  const orderId = randomUUID();
  const res = await ef('POST', '/ramp/order', {
    orderId,
    quoteId: state.offrampQuoteId,
    bankAccountId: state.bankAccountId,
    cryptoWalletId: state.walletId,
    useAnchor: true
  });
  if (res.ok) {
    const {offramp} = res.json as {offramp?: {withdrawAnchorAccount?: string; withdrawMemo?: string; withdrawMemoType?: string}};
    saveState({
      offrampOrderId: orderId,
      withdrawAnchorAccount: offramp?.withdrawAnchorAccount,
      withdrawMemo: offramp?.withdrawMemo,
      withdrawMemoType: offramp?.withdrawMemoType
    });
  }
}

async function stepOfframpPay(): Promise<void> {
  const state = readState();
  if (!state.offrampOrderId || !state.withdrawAnchorAccount || !state.withdrawMemo || !state.walletSecret || !state.walletPublic || !state.offrampSourceAmount) {
    throw new Error('run `offramp-order` first (and confirm it returned anchor details)');
  }
  note(`\n## Anchor payment & completion`);

  // Memo encoding is a spike target: the docs say base64, the OpenAPI example
  // looks hex. Decode whichever fits, record which one it was, and require the
  // canonical 32 bytes either way.
  const raw = state.withdrawMemo;
  const memoBytes = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  note(`withdrawMemo \`${raw}\` decoded as ${/^[0-9a-fA-F]{64}$/.test(raw) ? 'hex' : 'base64'} → ${memoBytes.length} bytes (memo type \`${state.withdrawMemoType}\`).`);
  if (memoBytes.length !== 32) {
    note(`> STOP: memo is not 32 bytes — Memo.hash requires exactly 32. Recording and aborting the payment.`);
    return;
  }

  const horizon = new Horizon.Server(HORIZON);
  const account = await horizon.loadAccount(state.walletPublic);
  const tx = new TransactionBuilder(account, {fee: '10000', networkPassphrase: PASSPHRASE})
    .addOperation(
      Operation.payment({
        destination: state.withdrawAnchorAccount,
        asset: new Asset(USDC_CODE, USDC_ISSUER),
        amount: state.offrampSourceAmount
      })
    )
    .addMemo(Memo.hash(memoBytes.toString('hex')))
    .setTimeout(300)
    .build();
  tx.sign(Keypair.fromSecret(state.walletSecret));
  const result = await horizon.submitTransaction(tx);
  note(`Anchor payment submitted: [\`${result.hash}\`](https://stellar.expert/explorer/testnet/tx/${result.hash}) — ${state.offrampSourceAmount} USDC → \`${state.withdrawAnchorAccount}\` with the order's hash memo.`);

  const status = await pollOrder(state.offrampOrderId, ['completed', 'finalized', 'failed', 'refunded', 'canceled']);
  note(`> Final offramp status after polling: \`${status}\``);
}

// ---------------------------------------------------------------------------

const STEPS: Record<string, () => Promise<void>> = {
  org: stepOrg,
  kyc: stepKyc,
  launch: stepLaunch,
  bank: stepBank,
  wallet: stepWallet,
  assets: stepAssets,
  'onramp-quote': stepOnrampQuote,
  'onramp-order': stepOnrampOrder,
  fiat: stepFiat,
  'order-status': stepOrderStatus,
  'offramp-quote': stepOfframpQuote,
  'offramp-order': stepOfframpOrder,
  'offramp-pay': stepOfframpPay
};

const step = process.argv[2];
if (!step || !STEPS[step]) {
  console.error(`Usage: tsx scripts/spike-etherfuse.ts <step>\nSteps: ${Object.keys(STEPS).join(', ')}`);
  process.exit(1);
}

STEPS[step]().catch((err: unknown) => {
  note(`\n> Step \`${step}\` threw: ${String(err).slice(0, 1500)}`);
  process.exit(1);
});
