import type {FastifyReply, FastifyRequest} from 'fastify';
import fp from 'fastify-plugin';
import {AppError} from '../../lib/errors.js';
import type {PrivyAuthVerifier} from './verifier.js';

// Every FastifyRequest gains `privyDid` once it has passed through
// `authPlugin`'s `onRequest` hook. Left as a plain `string` (not
// `string | undefined`): reading it outside an authenticated scope is a
// programmer error to fix at the call site, not a valid state to type
// around.
declare module 'fastify' {
  interface FastifyRequest {
    privyDid: string;
  }
}

const BEARER_PREFIX = 'Bearer ';

export interface AuthPluginOptions {
  verifier: PrivyAuthVerifier;
}

/**
 * Fastify plugin adding an `onRequest` hook that verifies the caller's Privy
 * ACCESS token (`Authorization: Bearer <token>` — the token from the
 * frontend's `getAccessToken()`, NOT Privy's identity token) and sets
 * `request.privyDid` to the verified DID. Auth failures (missing header,
 * malformed header, or a rejecting verifier) all short-circuit as
 * `AppError('unauthorized', ..., 401)`, which `app.ts`'s global error
 * handler serializes to `{code: 'unauthorized', message}`.
 *
 * Wrapped with `fastify-plugin` (`fp`) so registering it does NOT open a new
 * encapsulated child context — its hook and `privyDid` decorator attach
 * directly to whatever instance `.register()`s it. That is what makes it
 * "trivially easy" for later route modules to opt in: registering
 * `authPlugin` once against a scope, then registering any number of
 * sibling route plugins against that SAME scope afterwards, is enough for
 * all of them to inherit the hook (Fastify decorators/hooks are inherited
 * by children of the context that defines them, and `fp` makes that context
 * the scope itself rather than a throwaway child of it). See
 * `docs/modules/api-auth.md` for the exact registration pattern.
 */
export const authPlugin = fp<AuthPluginOptions>(async (app, opts) => {
  app.decorateRequest('privyDid', '');

  app.addHook('onRequest', async (request: FastifyRequest, _reply: FastifyReply) => {
    const header = request.headers.authorization;
    if (!header || !header.startsWith(BEARER_PREFIX)) {
      throw new AppError('unauthorized', 'missing or malformed Authorization header', 401);
    }

    const accessToken = header.slice(BEARER_PREFIX.length);

    try {
      const {privyDid} = await opts.verifier.verify(accessToken);
      request.privyDid = privyDid;
    } catch {
      throw new AppError('unauthorized', 'invalid or expired access token', 401);
    }
  });
});
