import {Account, Asset, Keypair, Networks} from '@stellar/stellar-sdk';
import {describe, expect, it} from 'vitest';
import {buildProvisioningTx} from './provisioning.js';

describe('buildProvisioningTx', () => {
  it('builds sponsor-wrapped account creation with trustline', () => {
    const sponsor = Keypair.random();
    const merchant = Keypair.random();
    const issuer = Keypair.random();
    const asset = new Asset('USDC', issuer.publicKey());

    const tx = buildProvisioningTx({
      sponsorAccount: new Account(sponsor.publicKey(), '0'),
      merchantPublicKey: merchant.publicKey(),
      asset,
      networkPassphrase: Networks.TESTNET
    });

    expect(tx.operations).toHaveLength(4);
    expect(tx.operations.map((o) => o.type)).toEqual([
      'beginSponsoringFutureReserves',
      'createAccount',
      'changeTrust',
      'endSponsoringFutureReserves'
    ]);
    // merchant must be the one trusting the asset and ending sponsorship
    expect(tx.operations[2]!.source).toBe(merchant.publicKey());
    expect(tx.operations[3]!.source).toBe(merchant.publicKey());
    // created with zero XLM — sponsor owns the reserves
    expect((tx.operations[1] as {startingBalance: string}).startingBalance).toBe('0.0000000');
    // pin sponsorship and creation targets to merchant
    expect((tx.operations[0] as {sponsoredId: string}).sponsoredId).toBe(merchant.publicKey());
    expect((tx.operations[1] as {destination: string}).destination).toBe(merchant.publicKey());
    expect(tx.source).toBe(sponsor.publicKey());
  });
});
