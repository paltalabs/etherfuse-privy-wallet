import {AssetRegistry} from '@paltalabs/shared';
import {Keypair, Networks, nativeToScVal, scValToNative, TransactionBuilder, type Transaction, type xdr} from '@stellar/stellar-sdk';
import {describe, expect, it} from 'vitest';
import type {VaultConfig} from '../../config/vaults.js';
import type {SorobanGateway} from '../../lib/soroban-gateway.js';
import {StellarAccountNotFoundError, type StellarAccount, type StellarGateway} from '../../lib/stellar-gateway.js';
import {createDefindexProvider, fromStroops} from './defindex.js';

const NETWORK_PASSPHRASE = Networks.TESTNET;
const VAULT: VaultConfig = {
  address: 'CDTWG3OZERPUCD42KVZQUCOECYWUQ5HHFT6VFRTGKKVW46VSNQ3WOBYF',
  assetCode: 'USDC'
};
const ISSUER = Keypair.random().publicKey();
const REGISTRY = new AssetRegistry([{code: 'USDC', issuer: ISSUER, decimals: 7}]);

function fakeAccount(publicKey: string): StellarAccount {
  return {
    accountId: () => publicKey,
    sequenceNumber: () => '100',
    incrementSequenceNumber: () => {},
    balances: []
  };
}

/** Fake `horizon.loadAccount` (the `Pick<StellarGateway, 'loadAccount'>` dep) over a lookup table; absence rejects like the real gateway's 404 mapping. */
function fakeHorizon(accounts: Record<string, StellarAccount> = {}): Pick<StellarGateway, 'loadAccount'> {
  return {
    async loadAccount(publicKey) {
      const account = accounts[publicKey];
      if (!account) throw new StellarAccountNotFoundError(publicKey);
      return account;
    }
  };
}

/**
 * Records every draft passed to `simulateAndAssemble`/`simulateRead` and lets
 * each call's return value be programmed. `simulateAndAssemble` defaults to
 * returning the draft unchanged (it's already sourced/built by the merchant
 * account — nothing about assembly matters to these tests beyond that).
 */
function fakeSoroban(opts: {simulateReadResults?: xdr.ScVal[]} = {}): SorobanGateway & {
  assembledDrafts: Transaction[];
  readDrafts: Transaction[];
} {
  const assembledDrafts: Transaction[] = [];
  const readDrafts: Transaction[] = [];
  const results = [...(opts.simulateReadResults ?? [])];
  return {
    assembledDrafts,
    readDrafts,
    async simulateAndAssemble(draft) {
      assembledDrafts.push(draft);
      return draft;
    },
    async simulateRead(draft) {
      readDrafts.push(draft);
      const next = results.shift();
      if (!next) throw new Error('fakeSoroban: no more programmed simulateRead results');
      return next;
    },
    async sendAndConfirm() {
      throw new Error('unused in defindex.test.ts: no test here submits a transaction');
    },
    async getContractEvents() {
      throw new Error('unused in defindex.test.ts: no test here polls contract events');
    },
    async getLatestLedger() {
      throw new Error('unused in defindex.test.ts: no test here reads the latest ledger');
    }
  };
}

/** Decode an `invokeHostFunction` operation's contract-call function name + native args. */
function decodeInvocation(tx: Transaction): {functionName: string; args: unknown[]} {
  const op = tx.operations[0];
  if (!op || op.type !== 'invokeHostFunction') throw new Error(`expected an invokeHostFunction operation, got ${op?.type}`);
  const invoke = op.func.invokeContract();
  return {
    functionName: invoke.functionName().toString(),
    args: invoke.args().map((a) => scValToNative(a))
  };
}

describe('fromStroops', () => {
  it('converts whole stroops to a 7dp decimal string', () => {
    expect(fromStroops(15_000_000n)).toBe('1.5000000');
  });

  it('converts zero to a zero-padded decimal string', () => {
    expect(fromStroops(0n)).toBe('0.0000000');
  });

  it('preserves full precision for values above Number.MAX_SAFE_INTEGER', () => {
    // Int64.MAX stroops (the ceiling `toStroops`'/`stellarAmountSchema`'s
    // refine enforces, packages/shared/src/api.ts:91) is
    // 9223372036854775807n, well past Number.MAX_SAFE_INTEGER
    // (9007199254740991) -- if this were converted through `Number()` at any
    // point, JS float rounding would silently corrupt the result.
    expect(9223372036854775807n > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(fromStroops(9223372036854775807n)).toBe('922337203685.4775807');
  });
});

describe('createDefindexProvider.buildDepositTx', () => {
  it('encodes deposit(amounts_desired, amounts_min, from, invest=false) and assembles it sourced by the merchant', async () => {
    const merchant = Keypair.random();
    const soroban = fakeSoroban();
    const provider = createDefindexProvider({
      soroban,
      horizon: fakeHorizon({[merchant.publicKey()]: fakeAccount(merchant.publicKey())}),
      vault: VAULT,
      registry: REGISTRY,
      networkPassphrase: NETWORK_PASSPHRASE
    });

    const result = await provider.buildDepositTx(merchant.publicKey(), '1.5');

    expect(soroban.assembledDrafts).toHaveLength(1);
    const {functionName, args} = decodeInvocation(soroban.assembledDrafts[0]!);
    expect(functionName).toBe('deposit');
    expect(args).toEqual([[15_000_000n], [15_000_000n], merchant.publicKey(), false]);

    // The returned XDR round-trips to a tx sourced by the merchant, not the vault or a sponsor.
    const decoded = TransactionBuilder.fromXDR(result.xdr, NETWORK_PASSPHRASE) as Transaction;
    expect(decoded.source).toBe(merchant.publicKey());
    expect(result.hashHex).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('propagates StellarAccountNotFoundError for an unprovisioned merchant', async () => {
    const merchant = Keypair.random();
    const provider = createDefindexProvider({
      soroban: fakeSoroban(),
      horizon: fakeHorizon(),
      vault: VAULT,
      registry: REGISTRY,
      networkPassphrase: NETWORK_PASSPHRASE
    });

    await expect(provider.buildDepositTx(merchant.publicKey(), '1')).rejects.toBeInstanceOf(StellarAccountNotFoundError);
  });
});

describe('createDefindexProvider.buildWithdrawTx', () => {
  it('encodes withdraw(withdraw_shares, min_amounts_out=[0], from) and assembles it sourced by the merchant', async () => {
    const merchant = Keypair.random();
    const soroban = fakeSoroban();
    const provider = createDefindexProvider({
      soroban,
      horizon: fakeHorizon({[merchant.publicKey()]: fakeAccount(merchant.publicKey())}),
      vault: VAULT,
      registry: REGISTRY,
      networkPassphrase: NETWORK_PASSPHRASE
    });

    const result = await provider.buildWithdrawTx(merchant.publicKey(), '2.5');

    expect(soroban.assembledDrafts).toHaveLength(1);
    const {functionName, args} = decodeInvocation(soroban.assembledDrafts[0]!);
    expect(functionName).toBe('withdraw');
    expect(args).toEqual([25_000_000n, [0n], merchant.publicKey()]);

    const decoded = TransactionBuilder.fromXDR(result.xdr, NETWORK_PASSPHRASE) as Transaction;
    expect(decoded.source).toBe(merchant.publicKey());
    expect(result.hashHex).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe('createDefindexProvider.getPosition', () => {
  it('returns zeros for an unprovisioned merchant (StellarAccountNotFoundError)', async () => {
    const merchant = Keypair.random();
    const provider = createDefindexProvider({
      soroban: fakeSoroban(),
      horizon: fakeHorizon(),
      vault: VAULT,
      registry: REGISTRY,
      networkPassphrase: NETWORK_PASSPHRASE
    });

    const position = await provider.getPosition(merchant.publicKey());

    expect(position).toEqual({shares: '0.0000000', underlyingBalance: '0.0000000'});
  });

  it('short-circuits to zeros on a zero-shares balance without a second simulation', async () => {
    const merchant = Keypair.random();
    const soroban = fakeSoroban({simulateReadResults: [nativeToScVal(0n, {type: 'i128'})]});
    const provider = createDefindexProvider({
      soroban,
      horizon: fakeHorizon({[merchant.publicKey()]: fakeAccount(merchant.publicKey())}),
      vault: VAULT,
      registry: REGISTRY,
      networkPassphrase: NETWORK_PASSPHRASE
    });

    const position = await provider.getPosition(merchant.publicKey());

    expect(position).toEqual({shares: '0.0000000', underlyingBalance: '0.0000000'});
    expect(soroban.readDrafts).toHaveLength(1);
    const {functionName, args} = decodeInvocation(soroban.readDrafts[0]!);
    expect(functionName).toBe('balance');
    expect(args).toEqual([merchant.publicKey()]);
  });

  it('reads shares then underlying-asset amounts for a non-zero balance', async () => {
    const merchant = Keypair.random();
    const soroban = fakeSoroban({
      simulateReadResults: [
        nativeToScVal(15_000_000n, {type: 'i128'}), // balance -> 1.5 shares
        nativeToScVal([14_800_000n], {type: 'i128'}) // get_asset_amounts_per_shares -> Vec<i128>, [0] is the underlying amount
      ]
    });
    const provider = createDefindexProvider({
      soroban,
      horizon: fakeHorizon({[merchant.publicKey()]: fakeAccount(merchant.publicKey())}),
      vault: VAULT,
      registry: REGISTRY,
      networkPassphrase: NETWORK_PASSPHRASE
    });

    const position = await provider.getPosition(merchant.publicKey());

    expect(position).toEqual({shares: '1.5000000', underlyingBalance: '1.4800000'});
    expect(soroban.readDrafts).toHaveLength(2);
    const second = decodeInvocation(soroban.readDrafts[1]!);
    expect(second.functionName).toBe('get_asset_amounts_per_shares');
    expect(second.args).toEqual([15_000_000n]);
  });
});

