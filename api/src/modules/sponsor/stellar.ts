import {FeeBumpTransaction, Keypair, Transaction, TransactionBuilder} from '@stellar/stellar-sdk';

/** Hash a built transaction the way Privy's rawSign expects it: 0x-prefixed hex. */
export function txHashHex(tx: Transaction | FeeBumpTransaction): string {
  return '0x' + tx.hash().toString('hex');
}

/**
 * Attach a raw ed25519 signature (Privy rawSign output, 0x-hex) as a decorated
 * signature. stellar-sdk's addSignature verifies the signature against the tx
 * hash and throws on mismatch — invalid signatures never get attached.
 */
export function attachRawSignature(
  tx: Transaction | FeeBumpTransaction,
  publicKey: string,
  hexSignature: string
): void {
  const raw = Buffer.from(hexSignature.replace(/^0x/, ''), 'hex');
  tx.addSignature(publicKey, raw.toString('base64'));
}

/**
 * Sponsor pays all fees: wrap the (already merchant-signed) inner tx in a
 * fee-bump sourced and signed by the sponsor. Merchant accounts hold zero XLM.
 */
export function wrapFeeBump(
  sponsor: Keypair,
  inner: Transaction,
  baseFee: string = '10000'
): FeeBumpTransaction {
  const fb = TransactionBuilder.buildFeeBumpTransaction(
    sponsor.publicKey(),
    baseFee,
    inner,
    inner.networkPassphrase
  );
  fb.sign(sponsor);
  return fb;
}
