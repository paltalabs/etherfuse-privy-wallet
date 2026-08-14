import {Account, BASE_FEE, Keypair, Networks, Operation, TransactionBuilder} from '@stellar/stellar-sdk';
import {describe, expect, it} from 'vitest';
import {attachRawSignature, txHashHex, wrapFeeBump} from './stellar.js';

function dummyTx(sourceKp: Keypair) {
  const source = new Account(sourceKp.publicKey(), '0');
  return new TransactionBuilder(source, {fee: BASE_FEE, networkPassphrase: Networks.TESTNET})
    .addOperation(Operation.manageData({name: 'spike', value: 'v'}))
    .setTimeout(300)
    .build();
}

describe('txHashHex', () => {
  it('returns the 0x-prefixed hex of the transaction hash', () => {
    const kp = Keypair.random();
    const tx = dummyTx(kp);
    expect(txHashHex(tx)).toBe('0x' + tx.hash().toString('hex'));
    expect(txHashHex(tx)).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe('attachRawSignature', () => {
  it('attaches a privy-style raw hex signature as a valid decorated signature', () => {
    const kp = Keypair.random();
    const tx = dummyTx(kp);
    // simulate Privy rawSign: raw ed25519 over the tx hash, hex-encoded with 0x prefix
    const hexSig = '0x' + kp.sign(tx.hash()).toString('hex');
    attachRawSignature(tx, kp.publicKey(), hexSig);
    expect(tx.signatures).toHaveLength(1);
  });

  it('rejects a signature from the wrong key', () => {
    const kp = Keypair.random();
    const wrong = Keypair.random();
    const tx = dummyTx(kp);
    const hexSig = '0x' + wrong.sign(tx.hash()).toString('hex');
    expect(() => attachRawSignature(tx, kp.publicKey(), hexSig)).toThrow();
  });
});

describe('wrapFeeBump', () => {
  it('wraps an inner tx with the sponsor as fee source, signed by sponsor', () => {
    const merchant = Keypair.random();
    const sponsor = Keypair.random();
    const inner = dummyTx(merchant);
    const hexSig = '0x' + merchant.sign(inner.hash()).toString('hex');
    attachRawSignature(inner, merchant.publicKey(), hexSig);

    const fb = wrapFeeBump(sponsor, inner);
    expect(fb.feeSource).toBe(sponsor.publicKey());
    expect(fb.signatures).toHaveLength(1);
    expect(sponsor.verify(fb.hash(), fb.signatures[0]!.signature())).toBe(true);
  });
});
