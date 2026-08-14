/**
 * The DeFindex vault round-trip spike: prove the Privy rawSign + sponsor
 * fee-bump pattern (already proven for a classic payment and a SAC transfer
 * in api/scripts/spike-privy-stellar.ts) against the deployed HodlUSDC
 * testnet vault — deposit, read the resulting position, withdraw — and
 * record the EXACT contract events the vault emits along both txs. A later
 * vault-events indexer is built from this recording, not from guesswork.
 * Writes evidence to docs/evidence/vault-roundtrip.md.
 *
 * This script does NOT create its own fixtures — it reuses the sponsor
 * keypair and Privy merchant wallet already persisted by
 * spike-privy-stellar.ts in docs/evidence/spike-keys.secret.json (the
 * merchant holds ~60 USDC from an earlier sandbox mint).
 *
 * Legs:
 *  0. Precondition: merchant Horizon USDC balance >= 2 USDC.
 *  1. DEPOSIT: merchant rawSign + sponsor fee-bump, invest: false (vault has no strategies).
 *  2. POSITION READ: simulate-only `balance` -> shares, then `get_asset_amounts_per_shares(shares)`.
 *  3. WITHDRAW: same flow, withdraw_shares = all shares from Leg 2.
 *  4. EVENTS: rpcServer.getEvents from the ledger just before the deposit —
 *     every event verbatim-decoded (topics + value). Load-bearing output.
 *  5. ZERO-XLM INVARIANT: merchant XLM balance still 0.
 *  6. DEFINDEX API PROBE: GET /vault/<id>?network=testnet with the configured
 *     API key — purely informational.
 *
 * Secrecy: same discipline as spike-privy-stellar.ts — never print secret
 * key material or the DeFindex API key; console output + evidence carry
 * only public keys, tx hashes, and decoded on-chain values.
 */
import {PrivyClient} from '@privy-io/node';
import {
  Address,
  Contract,
  Horizon,
  Keypair,
  nativeToScVal,
  Networks,
  rpc,
  scValToNative,
  TransactionBuilder,
  xdr
} from '@stellar/stellar-sdk';
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {TESTNET_REGISTRY} from '../src/config/assets.js';
import {resolveSorobanRpcUrl, TESTNET_NETWORK} from '../src/config/networks.js';
import {TESTNET_VAULT, type VaultConfig} from '../src/config/vaults.js';
import {loadEnv} from '../src/lib/env.js';
import {attachRawSignature, txHashHex, wrapFeeBump} from '../src/modules/sponsor/stellar.js';

const HORIZON = 'https://horizon-testnet.stellar.org';
const PASSPHRASE = Networks.TESTNET;
// Adjustment (see spike-privy-stellar.ts:39-46): scripts run with cwd = api/,
// so resolve evidence paths against this file's own location, not a bare
// relative path, so they land under the repo-root docs/evidence/ that
// .gitignore's `docs/evidence/*.secret.json` pattern actually covers.
const EVIDENCE_DIR = new URL('../../docs/evidence/', import.meta.url).pathname;
const KEYS_FILE = EVIDENCE_DIR + 'spike-keys.secret.json';
const EVIDENCE_FILE = EVIDENCE_DIR + 'vault-roundtrip.md';
// Same constant + rationale as api/scripts/spike-privy-stellar.ts:54:
// wrapFeeBump's default 10,000-stroop baseFee is below a Soroban inner tx's
// inclusion fee; buildFeeBumpTransaction rejects that combination
// (spike-privy-stellar.ts:227-230).
const SOROBAN_INVOKE_FEE = '1000000';
// Adjustment: pollTransaction's default is 5 attempts / ~1s apart, too
// impatient for testnet. Poll for up to a minute.
const POLL_ATTEMPTS = 60;
const ONE_USDC = 10_000_000n; // 7 decimals

const env = loadEnv();
const privy = new PrivyClient({appId: env.PRIVY_APP_ID, appSecret: env.PRIVY_APP_SECRET});
const horizon = new Horizon.Server(HORIZON);
// This spike is testnet-only by construction (spike-keys fixtures, TESTNET_VAULT) — pin the testnet config regardless of STELLAR_NETWORK.
const rpcServer = new rpc.Server(resolveSorobanRpcUrl(env.SOROBAN_RPC_URL, TESTNET_NETWORK));
// TESTNET_VAULT can be null when no testnet vault is configured (see
// config/vaults.ts's doc comment). This spike IS the vault round-trip proof,
// so it fails fast with a clear message rather than a raw null-deref if run
// without a configured vault.
if (!TESTNET_VAULT) {
  throw new Error(
    'TESTNET_VAULT is null (no testnet DeFindex vault deployed yet — see api/src/config/vaults.ts). Deploy one for the registry\'s USDC before running this spike.'
  );
}
const vault: VaultConfig = TESTNET_VAULT;
const usdc = TESTNET_REGISTRY.get(vault.assetCode);
const contract = new Contract(vault.address);
const evidence: string[] = [];

function note(line: string): void {
  console.log(line);
  evidence.push(line);
}

function stringify(value: unknown): string {
  return JSON.stringify(value, (_key, val: unknown) => (typeof val === 'bigint' ? val.toString() : val));
}

interface KeysFile {
  sponsor: string;
  privyWalletId: string;
  privyAddress: string;
}

/** This spike reuses the fixtures spike-privy-stellar.ts already created — it never creates its own. */
function readKeysFile(): Partial<KeysFile> {
  if (!existsSync(KEYS_FILE)) return {};
  return JSON.parse(readFileSync(KEYS_FILE, 'utf8')) as Partial<KeysFile>;
}

/** Privy's rawSign returns {encoding: 'hex', signature: '0x...'} directly (not nested under .data). */
async function privySign(walletId: string, hash: string): Promise<string> {
  const res = await privy.wallets().rawSign(walletId, {params: {hash}});
  return res.signature;
}

/** Poll RPC getTransaction until a definitive status; throws on FAILED/NOT_FOUND after exhausting attempts. */
async function awaitRpcSuccess(hash: string, label: string): Promise<void> {
  const result = await rpcServer.pollTransaction(hash, {attempts: POLL_ATTEMPTS});
  if (result.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(`${label} did not reach SUCCESS: ${JSON.stringify(result)}`);
  }
}

/** Build, simulate, assemble, merchant-rawSign, sponsor-fee-bump, send, and poll a vault invocation to SUCCESS. */
async function invokeVault(
  merchant: {id: string; address: string},
  sponsor: Keypair,
  method: string,
  args: xdr.ScVal[],
  label: string
): Promise<string> {
  const account = await horizon.loadAccount(merchant.address);
  const draft = new TransactionBuilder(account, {fee: SOROBAN_INVOKE_FEE, networkPassphrase: PASSPHRASE})
    .addOperation(contract.call(method, ...args))
    .setTimeout(300)
    .build();
  const sim = await rpcServer.simulateTransaction(draft);
  if (!rpc.Api.isSimulationSuccess(sim)) {
    // `sim.error` (when present) is the RPC's own human-readable diagnostic-event
    // log — far more useful for diagnosis than the raw XDR-object JSON dump.
    const detail = 'error' in sim ? sim.error : JSON.stringify(sim);
    throw new Error(`${label} simulation failed: ${detail}`);
  }
  const tx = rpc.assembleTransaction(draft, sim).build();
  attachRawSignature(tx, merchant.address, await privySign(merchant.id, txHashHex(tx)));
  const fb = wrapFeeBump(sponsor, tx, SOROBAN_INVOKE_FEE);
  const res = await rpcServer.sendTransaction(fb);
  note(`- **${label}**: [\`${res.hash}\`](https://stellar.expert/explorer/testnet/tx/${res.hash}) (status ${res.status})`);
  await awaitRpcSuccess(res.hash, label);
  return res.hash;
}

/** Simulate-only contract read — never sends a transaction. */
async function simulateRead(merchantAddress: string, method: string, args: xdr.ScVal[]): Promise<unknown> {
  const account = await horizon.loadAccount(merchantAddress);
  const draft = new TransactionBuilder(account, {fee: SOROBAN_INVOKE_FEE, networkPassphrase: PASSPHRASE})
    .addOperation(contract.call(method, ...args))
    .setTimeout(300)
    .build();
  const sim = await rpcServer.simulateTransaction(draft);
  if (!rpc.Api.isSimulationSuccess(sim) || !sim.result) {
    const detail = 'error' in sim ? sim.error : JSON.stringify(sim);
    throw new Error(`${method} simulation failed: ${detail}`);
  }
  return scValToNative(sim.result.retval);
}

async function main(): Promise<void> {
  const saved = readKeysFile();
  if (!saved.sponsor || !saved.privyWalletId || !saved.privyAddress) {
    throw new Error(
      'docs/evidence/spike-keys.secret.json is missing sponsor/privyWalletId/privyAddress — ' +
        'run `pnpm --filter @paltalabs/api spike:stellar` first to create the shared fixtures.'
    );
  }
  const sponsor = Keypair.fromSecret(saved.sponsor);
  const merchant = {id: saved.privyWalletId, address: saved.privyAddress};

  note(`# DeFindex vault round-trip spike — ${new Date().toISOString()}`);
  note(`- Vault (HodlUSDC): \`${vault.address}\``);
  note(`- Merchant (Privy wallet \`${merchant.id}\`): \`${merchant.address}\``);

  // Leg 0 — precondition: merchant holds enough USDC to deposit.
  const merchantPreAccount = await horizon.loadAccount(merchant.address);
  const usdcBalance = merchantPreAccount.balances.find(
    (b) => 'asset_code' in b && b.asset_code === usdc.code && b.asset_issuer === usdc.issuer
  );
  const usdcAmount = usdcBalance ? Number(usdcBalance.balance) : 0;
  note(`- Leg 0 — merchant USDC balance: \`${usdcAmount}\` (need >= 2)`);
  if (usdcAmount < 2) {
    note('- **ABORTED**: merchant USDC balance is below the 2 USDC precondition.');
    writeFileSync(EVIDENCE_FILE, evidence.join('\n') + '\n');
    throw new Error(`insufficient USDC balance: ${usdcAmount}`);
  }

  // Legs 1-4 (deposit -> position read -> withdraw -> events) are wrapped
  // together: a failure partway through (e.g. Leg 1's simulation rejecting
  // before any tx is ever signed/submitted) must not skip Legs 5-6 or the
  // evidence file — a blocked round-trip is itself a finding worth recording,
  // not a reason to lose everything gathered up to that point.
  let roundTripFailed = false;
  try {
    // Leg 1 — DEPOSIT: 1.0 USDC, invest: false (vault has no strategies attached).
    const startLedger = (await rpcServer.getLatestLedger()).sequence;
    await invokeVault(
      merchant,
      sponsor,
      'deposit',
      [
        nativeToScVal([ONE_USDC], {type: 'i128'}), // amounts_desired: 1.0 USDC
        nativeToScVal([ONE_USDC], {type: 'i128'}), // amounts_min: same (idle-funds vault, no slippage)
        new Address(merchant.address).toScVal(), // from
        nativeToScVal(false, {type: 'bool'}) // invest: false (no strategies)
      ],
      'Leg 1 — DEPOSIT (merchant rawSign, sponsor fee-bump)'
    );

    // Leg 2 — POSITION READ: shares balance, then underlying-asset amounts per shares.
    const shares = (await simulateRead(merchant.address, 'balance', [
      new Address(merchant.address).toScVal()
    ])) as bigint;
    note(`- Leg 2 — merchant vault shares after deposit: \`${shares.toString()}\``);
    const amountsPerShares = await simulateRead(merchant.address, 'get_asset_amounts_per_shares', [
      nativeToScVal(shares, {type: 'i128'})
    ]);
    note(`- Leg 2 — underlying amounts for ${shares.toString()} shares: \`${stringify(amountsPerShares)}\``);

    // Leg 3 — WITHDRAW: everything from Leg 2.
    await invokeVault(
      merchant,
      sponsor,
      'withdraw',
      [
        nativeToScVal(shares, {type: 'i128'}), // withdraw_shares: everything from Leg 2
        nativeToScVal([0n], {type: 'i128'}), // min_amounts_out
        new Address(merchant.address).toScVal()
      ],
      'Leg 3 — WITHDRAW (merchant rawSign, sponsor fee-bump)'
    );

    // Leg 4 — EVENTS: the load-bearing recording for the later vault-events indexer.
    note(`\n## Leg 4 — vault contract events (startLedger ${startLedger})\n`);
    const eventsResponse = await rpcServer.getEvents({
      startLedger,
      filters: [{type: 'contract', contractIds: [vault.address]}],
      limit: 100
    });
    note(`- ${eventsResponse.events.length} event(s) returned`);
    for (const [i, event] of eventsResponse.events.entries()) {
      const topics = event.topic.map((t) => scValToNative(t));
      const value = scValToNative(event.value);
      note(`\n### Event ${i + 1}`);
      note(`- txHash: \`${event.txHash}\``);
      note(`- ledger: ${event.ledger}`);
      note(`- contractId: \`${event.contractId?.contractId() ?? 'n/a'}\``);
      note(`- topics: \`${stringify(topics)}\``);
      note(`- value: \`${stringify(value)}\``);
    }
  } catch (err: unknown) {
    roundTripFailed = true;
    const message = err instanceof Error ? err.message : String(err);
    note('\n- **Legs 1-4 (deposit/position/withdraw/events) BLOCKED** — full diagnostic below:');
    note(`\`\`\`\n${message}\n\`\`\``);
  }

  // Leg 5 — zero-XLM invariant.
  const finalMerchant = await horizon.loadAccount(merchant.address);
  const xlm = finalMerchant.balances.find((b) => b.asset_type === 'native');
  note(`\n- Leg 5 — merchant final XLM balance: \`${xlm?.balance ?? 'n/a'}\` (expected 0.0000000)`);

  // Leg 6 — DeFindex API probe (purely informational; never print the key).
  note('\n## Leg 6 — DeFindex API probe\n');
  const probeUrl = `https://api.defindex.io/vault/${vault.address}?network=testnet`;
  if (!env.DEFINDEX_API_KEY) {
    note('- DEFINDEX_API_KEY not configured; skipped.');
  } else {
    const bearerRes = await fetch(probeUrl, {headers: {Authorization: `Bearer ${env.DEFINDEX_API_KEY}`}});
    const bearerBody = (await bearerRes.text()).slice(0, 300);
    note(`- \`Authorization: Bearer <key>\` -> status ${bearerRes.status}, body (truncated): \`${bearerBody}\``);
    if (bearerRes.ok) {
      note('- Auth scheme confirmed: `Authorization: Bearer`.');
    } else {
      const apiKeyRes = await fetch(probeUrl, {headers: {'x-api-key': env.DEFINDEX_API_KEY}});
      const apiKeyBody = (await apiKeyRes.text()).slice(0, 300);
      note(`- \`x-api-key: <key>\` -> status ${apiKeyRes.status}, body (truncated): \`${apiKeyBody}\``);
      note(`- Auth scheme that worked: ${apiKeyRes.ok ? '\`x-api-key\`' : 'neither — see statuses above'}.`);
    }
  }

  writeFileSync(EVIDENCE_FILE, evidence.join('\n') + '\n');
  note(`\nEvidence written to ${EVIDENCE_FILE}`);

  // Non-zero exit if the round-trip itself didn't complete, even though the
  // evidence above was captured and written successfully.
  if (roundTripFailed) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
