import {Account, Asset, Operation, Transaction, TransactionBuilder} from '@stellar/stellar-sdk';

export interface ProvisioningParams {
  /** Sponsor account loaded from Horizon/RPC (provides sequence number). */
  sponsorAccount: Account;
  merchantPublicKey: string;
  asset: Asset;
  networkPassphrase: string;
}

/**
 * One-shot merchant provisioning: sponsor creates the account and pays the
 * reserves for it and its trustline. Merchant holds zero XLM from day one.
 * The returned tx must be signed by the sponsor AND the merchant (rawSign).
 */
export function buildProvisioningTx(params: ProvisioningParams): Transaction {
  const {sponsorAccount, merchantPublicKey, asset, networkPassphrase} = params;
  return new TransactionBuilder(sponsorAccount, {fee: '10000', networkPassphrase})
    .addOperation(Operation.beginSponsoringFutureReserves({sponsoredId: merchantPublicKey}))
    .addOperation(Operation.createAccount({destination: merchantPublicKey, startingBalance: '0'}))
    .addOperation(Operation.changeTrust({asset, source: merchantPublicKey}))
    .addOperation(Operation.endSponsoringFutureReserves({source: merchantPublicKey}))
    .setTimeout(300)
    .build();
}
