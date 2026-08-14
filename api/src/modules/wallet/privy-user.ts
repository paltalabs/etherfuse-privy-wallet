import {PrivyClient} from '@privy-io/node';
import {AppError} from '../../lib/errors.js';

/** A merchant's embedded Stellar wallet as known to Privy. */
export interface StellarWalletRef {
  walletId: string;
  address: string;
}

/**
 * Resolves a verified Privy DID to its owner's embedded Stellar wallet.
 * Implementations must reject/throw rather than resolve with a partial or
 * falsy value, matching `PrivyAuthVerifier`'s contract in the `auth` module.
 */
export interface PrivyUserResolver {
  resolveStellarWallet(privyDid: string): Promise<StellarWalletRef>;
}

/**
 * Production resolver backed by `@privy-io/node`'s `PrivyClient`.
 *
 * Uses `client.wallets().list({user_id, chain_type: 'stellar'})` rather than
 * `client.users()._get(userID)` + scanning `linked_accounts` — verified
 * against the installed package's type declarations
 * (`node_modules/.pnpm/@privy-io+node@0.27.0/node_modules/@privy-io/node/resources/wallets/wallets.d.ts:3399-3427`,
 * `WalletListParams.user_id`/`WalletListParams.chain_type`). `list` is
 * inherited unmodified from the base `Wallets` resource onto the public
 * `PrivyWalletsService` (`.../public-api/services/wallets.d.ts`, which
 * overrides other methods like `create`/`rawSign` but not `list`) — same
 * inheritance pattern the auth module documented for `verifyAccessToken`.
 * `'stellar'` is a valid `WalletChainType`/`CurveSigningChainType` member
 * (`.../resources/wallets/wallets.d.ts:423,3210`), matching the chain type
 * the Privy×Stellar testnet spike already creates wallets with
 * (`api/scripts/spike-privy-stellar.ts:105`).
 */
export function createPrivyUserResolver(appId: string, appSecret: string): PrivyUserResolver {
  const client = new PrivyClient({appId, appSecret});

  return {
    async resolveStellarWallet(privyDid: string): Promise<StellarWalletRef> {
      const page = await client.wallets().list({user_id: privyDid, chain_type: 'stellar', limit: 1});
      const wallet = page.data[0];
      if (!wallet) {
        throw new AppError('no_stellar_wallet', 'user has no embedded Stellar wallet yet', 409);
      }
      return {walletId: wallet.id, address: wallet.address};
    }
  };
}
