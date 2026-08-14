import {PrivyClient} from '@privy-io/node';

/**
 * Verifies a Privy-issued ACCESS token (the token from the frontend's
 * `getAccessToken()` — NOT Privy's identity token) and resolves the
 * caller's Privy DID. Implementations must reject/throw on any invalid,
 * expired, or malformed token; never resolve with a partial or falsy value.
 */
export interface PrivyAuthVerifier {
  verify(accessToken: string): Promise<{privyDid: string}>;
}

/**
 * Production verifier backed by `@privy-io/node`'s `PrivyClient`.
 *
 * Note: `@privy-io/server-auth` (Privy's older server package name) is
 * deprecated upstream — `npm view @privy-io/server-auth deprecated` returns
 * "This package is deprecated. If you are looking for the latest features
 * and support, use @privy-io/node instead." `@privy-io/node` was already an
 * `api` dependency (`api/package.json:18`, used by
 * `api/scripts/spike-privy-stellar.ts:18,60`), so this wraps that package
 * instead of adding a redundant deprecated one.
 *
 * `PrivyClient`'s constructor takes a single options object
 * (`{appId, appSecret, ...}`), not positional `(appId, appSecret)` args —
 * verified against the installed package's type declarations at
 * `node_modules/.pnpm/@privy-io+node@0.27.0/node_modules/@privy-io/node/public-api/PrivyClient.d.ts`.
 * Token verification lives at `client.utils().auth()`
 * (`.../public-api/services/utils/auth.d.ts`), which exposes both
 * `verifyAccessToken` (current) and a `@deprecated` `verifyAuthToken` alias
 * (`.../lib/auth.d.ts`) — this uses `verifyAccessToken`, matching the
 * requirement to verify ACCESS tokens specifically. Its response shape is
 * `VerifyAccessTokenResponse` with a `user_id: string` field (snake_case,
 * per the SDK's own type, not `userId`) — that field is the DID.
 */
export function createPrivyAuthVerifier(appId: string, appSecret: string): PrivyAuthVerifier {
  const client = new PrivyClient({appId, appSecret});

  return {
    async verify(accessToken: string) {
      const {user_id: privyDid} = await client.utils().auth().verifyAccessToken(accessToken);
      return {privyDid};
    }
  };
}
