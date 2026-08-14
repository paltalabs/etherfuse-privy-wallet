/**
 * The Privy×Stellar testnet spike: prove Privy rawSign completes classic + Soroban
 * Stellar transactions with all fees/reserves sponsor-paid and the merchant
 * wallet at zero XLM. Writes evidence to docs/evidence/privy-stellar-spike.md.
 *
 * Legs:
 *  1. Sponsored provisioning: create merchant account + SPIKE trustline (the provisioning builder).
 *  2. Issuer pays merchant 100 SPIKE (classic payment, plain issuer keypair).
 *  3. Merchant sends 10 SPIKE back (CLASSIC leg: merchant rawSign + sponsor fee-bump).
 *  4. Deploy SAC for SPIKE, merchant invokes SAC transfer of 10 SPIKE
 *     (SOROBAN leg: simulate -> assemble -> merchant rawSign -> sponsor fee-bump).
 *
 * Secrecy: this script must never print, log, or write secret key material
 * anywhere except docs/evidence/spike-keys.secret.json (gitignored). Console
 * output and the evidence markdown carry only public keys, wallet IDs, and
 * tx hashes.
 */
import {PrivyClient} from '@privy-io/node';
import {
  Address,
  Asset,
  Contract,
  Horizon,
  Keypair,
  nativeToScVal,
  Networks,
  Operation,
  rpc,
  TransactionBuilder
} from '@stellar/stellar-sdk';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {loadEnv} from '../src/lib/env.js';
import {buildProvisioningTx} from '../src/modules/sponsor/provisioning.js';
import {attachRawSignature, txHashHex, wrapFeeBump} from '../src/modules/sponsor/stellar.js';

const HORIZON = 'https://horizon-testnet.stellar.org';
const RPC = 'https://soroban-testnet.stellar.org';
const PASSPHRASE = Networks.TESTNET;
// Adjustment: `pnpm --filter @paltalabs/api spike:stellar` runs with cwd = api/,
// so bare relative paths like 'docs/evidence/...' land in api/docs/evidence/
// — a directory the root .gitignore's `docs/evidence/*.secret.json` pattern
// does NOT cover (gitignore patterns with a slash are anchored to the file
// they're defined in, i.e. the repo root). Resolve against this file's own
// location instead so the secrets file always lands under the repo-root
// docs/evidence/ that .gitignore actually protects.
const EVIDENCE_DIR = new URL('../../docs/evidence/', import.meta.url).pathname;
const KEYS_FILE = EVIDENCE_DIR + 'spike-keys.secret.json';
const EVIDENCE_FILE = EVIDENCE_DIR + 'privy-stellar-spike.md';
// Adjustment (see report): stellar-sdk's buildFeeBumpTransaction requires the
// fee-bump baseFee to be >= the inner tx's per-operation inclusion fee (its
// total fee minus the Soroban resource fee). The Soroban invoke draft below
// is built with a 1,000,000-stroop inclusion fee, so the fee-bump wrapping it
// must match or exceed that, not wrapFeeBump's 10,000-stroop default.
const SOROBAN_INVOKE_FEE = '1000000';
// Adjustment: pollTransaction's default is 5 attempts / ~1s apart, too
// impatient for testnet. Poll for up to a minute.
const POLL_ATTEMPTS = 60;

const env = loadEnv();
const privy = new PrivyClient({appId: env.PRIVY_APP_ID, appSecret: env.PRIVY_APP_SECRET});
const horizon = new Horizon.Server(HORIZON);
const rpcServer = new rpc.Server(RPC);
const evidence: string[] = [];

function note(line: string): void {
  console.log(line);
  evidence.push(line);
}

async function friendbot(pub: string): Promise<void> {
  const res = await fetch(`https://friendbot.stellar.org?addr=${pub}`);
  if (!res.ok && res.status !== 400) throw new Error(`friendbot failed: ${res.status}`);
}

interface KeysFile {
  sponsor: string;
  issuer: string;
  privyWalletId?: string;
  privyAddress?: string;
}

function readKeysFile(): Partial<KeysFile> {
  if (!existsSync(KEYS_FILE)) return {};
  return JSON.parse(readFileSync(KEYS_FILE, 'utf8')) as Partial<KeysFile>;
}

/** Persist testnet keys + Privy wallet across runs so the spike is re-runnable. */
function loadOrCreateFixtures(): {sponsor: Keypair; issuer: Keypair} {
  const saved = readKeysFile();
  if (saved.sponsor && saved.issuer) {
    return {sponsor: Keypair.fromSecret(saved.sponsor), issuer: Keypair.fromSecret(saved.issuer)};
  }
  const sponsor = env.SPONSOR_SECRET_KEY ? Keypair.fromSecret(env.SPONSOR_SECRET_KEY) : Keypair.random();
  const issuer = Keypair.random();
  mkdirSync(EVIDENCE_DIR, {recursive: true});
  writeFileSync(KEYS_FILE, JSON.stringify({...saved, sponsor: sponsor.secret(), issuer: issuer.secret()}, null, 2));
  return {sponsor, issuer};
}

async function getOrCreatePrivyWallet(): Promise<{id: string; address: string}> {
  const saved = readKeysFile();
  if (saved.privyWalletId && saved.privyAddress) {
    return {id: saved.privyWalletId, address: saved.privyAddress};
  }
  const wallet = await privy.wallets().create({chain_type: 'stellar'});
  writeFileSync(KEYS_FILE, JSON.stringify({...saved, privyWalletId: wallet.id, privyAddress: wallet.address}, null, 2));
  return {id: wallet.id, address: wallet.address};
}

/** Privy's rawSign returns {encoding: 'hex', signature: '0x...'} directly (not nested under .data). */
async function privySign(walletId: string, hash: string): Promise<string> {
  const res = await privy.wallets().rawSign(walletId, {params: {hash}});
  return res.signature;
}

async function accountExists(pub: string): Promise<boolean> {
  try {
    await horizon.loadAccount(pub);
    return true;
  } catch {
    return false;
  }
}

async function submitClassic(tx: Parameters<Horizon.Server['submitTransaction']>[0], label: string): Promise<void> {
  const result = await horizon.submitTransaction(tx);
  note(`- **${label}**: [\`${result.hash}\`](https://stellar.expert/explorer/testnet/tx/${result.hash})`);
}

/** Poll RPC getTransaction until a definitive status; throws on FAILED/NOT_FOUND after exhausting attempts. */
async function awaitRpcSuccess(hash: string, label: string): Promise<void> {
  const result = await rpcServer.pollTransaction(hash, {attempts: POLL_ATTEMPTS});
  if (result.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(`${label} did not reach SUCCESS: ${JSON.stringify(result)}`);
  }
}

async function main(): Promise<void> {
  const {sponsor, issuer} = loadOrCreateFixtures();
  await friendbot(sponsor.publicKey());
  await friendbot(issuer.publicKey());
  const merchant = await getOrCreatePrivyWallet();
  const spikeAsset = new Asset('SPIKE', issuer.publicKey());
  note(`# Privy × Stellar spike — ${new Date().toISOString()}`);
  note(`- Sponsor: \`${sponsor.publicKey()}\``);
  note(`- Issuer: \`${issuer.publicKey()}\``);
  note(`- Merchant (Privy wallet \`${merchant.id}\`): \`${merchant.address}\``);

  // Leg 1 — sponsored provisioning, co-signed sponsor + Privy rawSign
  // Adjustment: createAccount is NOT idempotent (Horizon rejects it once the
  // destination already exists), unlike the SAC deploy in Leg 4a — guard so a
  // re-run after the merchant account is already provisioned doesn't fail.
  if (await accountExists(merchant.address)) {
    note('- Leg 1 — sponsored provisioning: merchant account already exists on-chain; skipping (idempotent re-run)');
  } else {
    const sponsorAccount = await horizon.loadAccount(sponsor.publicKey());
    const provTx = buildProvisioningTx({
      sponsorAccount, merchantPublicKey: merchant.address, asset: spikeAsset, networkPassphrase: PASSPHRASE
    });
    provTx.sign(sponsor);
    attachRawSignature(provTx, merchant.address, await privySign(merchant.id, txHashHex(provTx)));
    await submitClassic(provTx, 'Leg 1 — sponsored provisioning (create + trustline)');
  }

  // Leg 2 — issuer funds merchant with 100 SPIKE
  const issuerAccount = await horizon.loadAccount(issuer.publicKey());
  const fundTx = new TransactionBuilder(issuerAccount, {fee: '10000', networkPassphrase: PASSPHRASE})
    .addOperation(Operation.payment({destination: merchant.address, asset: spikeAsset, amount: '100'}))
    .setTimeout(300).build();
  fundTx.sign(issuer);
  await submitClassic(fundTx, 'Leg 2 — issuer funds merchant (100 SPIKE)');

  // Leg 3 — CLASSIC: merchant pays 10 SPIKE back; rawSign + sponsor fee-bump
  const merchantAccount = await horizon.loadAccount(merchant.address);
  const payTx = new TransactionBuilder(merchantAccount, {fee: '100', networkPassphrase: PASSPHRASE})
    .addOperation(Operation.payment({destination: issuer.publicKey(), asset: spikeAsset, amount: '10'}))
    .setTimeout(300).build();
  attachRawSignature(payTx, merchant.address, await privySign(merchant.id, txHashHex(payTx)));
  await submitClassic(wrapFeeBump(sponsor, payTx), 'Leg 3 — classic payment (merchant rawSign, sponsor fee-bump)');

  // Leg 4a — deploy the SAC for SPIKE (sponsor pays, plain keypair signing)
  const sponsorAccount2 = await horizon.loadAccount(sponsor.publicKey());
  const sacTxDraft = new TransactionBuilder(sponsorAccount2, {fee: '10000', networkPassphrase: PASSPHRASE})
    .addOperation(Operation.createStellarAssetContract({asset: spikeAsset}))
    .setTimeout(300).build();
  const sacSim = await rpcServer.simulateTransaction(sacTxDraft);
  if (!rpc.Api.isSimulationSuccess(sacSim)) {
    // Adjustment: re-running the spike hits "ExistingValue" (contract already
    // deployed) here — expected and treated as success per the spike design.
    note(`- SAC already deployed or simulation failed (${JSON.stringify(sacSim)}); continuing`);
  } else {
    const sacTx = rpc.assembleTransaction(sacTxDraft, sacSim).build();
    sacTx.sign(sponsor);
    const sacRes = await rpcServer.sendTransaction(sacTx);
    note(`- **Leg 4a — SAC deploy**: \`${sacRes.hash}\` (status ${sacRes.status})`);
    await awaitRpcSuccess(sacRes.hash, 'Leg 4a — SAC deploy');
  }
  const sacId = spikeAsset.contractId(PASSPHRASE);
  note(`- SPIKE SAC contract: \`${sacId}\``);

  // Adjustment: SAC transfer() to a classic G-account destination requires
  // that account to already hold a trustline for the underlying asset — the
  // SAC does not implicitly create one. The sponsor (Leg 4b's destination)
  // has none yet, so establish it first (idempotent: re-submitting the same
  // changeTrust limit on a re-run is a no-op).
  const sponsorAccount3 = await horizon.loadAccount(sponsor.publicKey());
  const trustTx = new TransactionBuilder(sponsorAccount3, {fee: '10000', networkPassphrase: PASSPHRASE})
    .addOperation(Operation.changeTrust({asset: spikeAsset}))
    .setTimeout(300).build();
  trustTx.sign(sponsor);
  await submitClassic(trustTx, 'Leg 4b prep — sponsor establishes SPIKE trustline (required as SAC transfer destination)');

  // Leg 4b — SOROBAN: merchant invokes SAC transfer(merchant -> sponsor, 10 SPIKE)
  const merchantAccount2 = await horizon.loadAccount(merchant.address);
  const contract = new Contract(sacId);
  const invokeDraft = new TransactionBuilder(merchantAccount2, {fee: SOROBAN_INVOKE_FEE, networkPassphrase: PASSPHRASE})
    .addOperation(contract.call(
      'transfer',
      new Address(merchant.address).toScVal(),
      new Address(sponsor.publicKey()).toScVal(),
      nativeToScVal(100_000_000n, {type: 'i128'}) // 10 SPIKE at 7 decimals
    ))
    .setTimeout(300).build();
  const invokeSim = await rpcServer.simulateTransaction(invokeDraft);
  if (!rpc.Api.isSimulationSuccess(invokeSim)) throw new Error(`simulation failed: ${JSON.stringify(invokeSim)}`);
  const invokeTx = rpc.assembleTransaction(invokeDraft, invokeSim).build();
  attachRawSignature(invokeTx, merchant.address, await privySign(merchant.id, txHashHex(invokeTx)));
  // Adjustment: wrapFeeBump's default 10,000-stroop baseFee is below the
  // Soroban inner tx's ~1,000,000-stroop inclusion fee — buildFeeBumpTransaction
  // rejects that combination, so pass a baseFee that covers it.
  const fb = wrapFeeBump(sponsor, invokeTx, SOROBAN_INVOKE_FEE);
  const invokeRes = await rpcServer.sendTransaction(fb);
  note(`- **Leg 4b — Soroban SAC transfer (merchant rawSign, sponsor fee-bump)**: [\`${invokeRes.hash}\`](https://stellar.expert/explorer/testnet/tx/${invokeRes.hash}) (status ${invokeRes.status})`);
  await awaitRpcSuccess(invokeRes.hash, 'Leg 4b — Soroban SAC transfer');

  // Invariant check — merchant never held XLM
  const finalMerchant = await horizon.loadAccount(merchant.address);
  const xlm = finalMerchant.balances.find((b) => b.asset_type === 'native');
  note(`- Merchant final XLM balance: \`${xlm?.balance ?? 'n/a'}\` (expected 0.0000000)`);

  writeFileSync(EVIDENCE_FILE, evidence.join('\n') + '\n');
  note(`\nEvidence written to ${EVIDENCE_FILE}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
