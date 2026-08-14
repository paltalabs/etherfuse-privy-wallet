# api-auth Module

> **Living document.** Read this before modifying the module. Update it in the same change whenever the module's behavior, exports, files, or dependencies change.

**Source:** `api/src/modules/auth/` · **Last verified:** 2026-07-23 (fix wave: re-verified `app.ts` citations, unchanged behavior)

## Purpose

The `auth` module verifies Privy-issued **access tokens** (the token returned by the frontend's Privy SDK `getAccessToken()` call — explicitly NOT Privy's identity token, which carries different claims and is not accepted here) and establishes an authenticated Fastify scope. Any request that passes verification gets `request.privyDid` set to the caller's Privy DID; requests that fail verification never reach a route handler and get a uniform `401 {code: 'unauthorized'}`.

## Structure

| File | Purpose |
|---|---|
| `verifier.ts` | `PrivyAuthVerifier` interface + `createPrivyAuthVerifier`, the production implementation wrapping `@privy-io/node`'s `PrivyClient` (`api/src/modules/auth/verifier.ts`). |
| `verifier.test.ts` | Unit tests for `createPrivyAuthVerifier` against a mocked `@privy-io/node` module (never calls live Privy) — verifies the `user_id` → `privyDid` mapping and rejection propagation (`api/src/modules/auth/verifier.test.ts`). |
| `plugin.ts` | `authPlugin`, the Fastify plugin adding the `onRequest` auth hook and the `request.privyDid` decoration (`api/src/modules/auth/plugin.ts`). |
| `plugin.test.ts` | Tests for `authPlugin` against a fake `PrivyAuthVerifier` (no real Privy calls): missing header, malformed header, verifier-rejects, and verifier-resolves-sets-`privyDid` (`api/src/modules/auth/plugin.test.ts`). |

## Endpoints / Public surface

_No HTTP endpoints of its own — this module is middleware consumed by `app.ts` and (in later phases) by feature route modules._

| Export | Signature | File:Line | Purpose |
|---|---|---|---|
| `PrivyAuthVerifier` | `interface {verify(accessToken: string): Promise<{privyDid: string}>}` | `api/src/modules/auth/verifier.ts:9-11` | The injectable verifier contract. Tests always supply a fake (`{verify: async () => ({privyDid: '...'})}` or a rejecting one); production code supplies `createPrivyAuthVerifier`'s result. |
| `createPrivyAuthVerifier` | `(appId: string, appSecret: string): PrivyAuthVerifier` | `api/src/modules/auth/verifier.ts:37` | Builds the production verifier: constructs a `PrivyClient({appId, appSecret})` and calls `client.utils().auth().verifyAccessToken(accessToken)`, mapping the response's `user_id` field to `privyDid`. |
| `authPlugin` | `FastifyPluginAsync<AuthPluginOptions>` (via `fastify-plugin`) | `api/src/modules/auth/plugin.ts:43` | Adds `decorateRequest('privyDid', '')` and an `onRequest` hook to whatever Fastify instance registers it. Parses `Authorization: Bearer <token>`, calls `opts.verifier.verify(token)`, sets `request.privyDid` on success. Any failure throws `AppError('unauthorized', ..., 401)`. |
| `AuthPluginOptions` | `interface {verifier: PrivyAuthVerifier}` | `api/src/modules/auth/plugin.ts:19-21` | Options `authPlugin` is registered with, e.g. `app.register(authPlugin, {verifier: deps.privyAuth})`. |
| `FastifyRequest.privyDid` | `string` (module augmentation) | `api/src/modules/auth/plugin.ts:11-15` | Declared via `declare module 'fastify'`. Only meaningful on requests that passed through `authPlugin`'s hook; reading it elsewhere is a programmer error, not a typed optional. |

## Key methods (registration pattern for later route modules)

`authPlugin` is wrapped with `fastify-plugin` (`fp`) specifically so it does **not** open a new encapsulated child context when registered — its hook and decorator attach directly to whatever Fastify instance calls `.register(authPlugin, opts)`. This is the chosen mechanism (a "fastify register with prefix or a decorator" choice) for making the authenticated scope trivially reusable:

`api/src/app.ts:93-99` (inside `buildApp`, `api/src/app.ts:45`; simplified here to the registration shape — the real callback registers `walletRoutes`/`intentRoutes`/`paymentRoutes`/`historyRoutes` too):
```ts
app.register(async (authenticated) => {
  await authenticated.register(authPlugin, {verifier: deps.privyAuth});
  // Future modules add feature routes here, inside this SAME callback, e.g.:
  // await authenticated.register(walletRoutes, {db: deps.db});
});
```

Because `authPlugin` is `fp`-wrapped, its hook/decorator end up living on `authenticated` itself (not on a throwaway child scope). Any route plugin registered against that same `authenticated` instance — in this same callback or in a later one, as long as it targets `authenticated` and not the root `app` — inherits `request.privyDid` and the auth hook automatically through Fastify's normal parent→child decorator/hook inheritance. `/health`, registered directly on the root `app` in `api/src/app.ts:50`, is outside this scope and stays public.

**For a future wallet/payments/history route module:** export a `FastifyPluginAsync` from that module and register it inside the same `authenticated` callback in `app.ts` — no per-module auth wiring needed.

## Dependencies

- `@privy-io/node` (`api/package.json:18`) — Privy's current server SDK. `PrivyClient` constructor and `verifyAccessToken` verified against the installed package's type declarations (`node_modules/.pnpm/@privy-io+node@0.27.0/node_modules/@privy-io/node/public-api/PrivyClient.d.ts` and `.../public-api/services/utils/auth.d.ts`).
- `fastify-plugin` (`api/package.json:23`, new dependency added for this module) — used to make `authPlugin`'s hook/decorator escape its own registration's encapsulation boundary and attach to the parent scope instead.
- `../../lib/errors.ts` — `AppError`, reused for the uniform `401 {code: 'unauthorized'}` shape via `app.ts`'s existing global error handler.

## Gotchas & invariants

- **`@privy-io/server-auth` (Privy's older server package name) is deprecated upstream** — `npm view @privy-io/server-auth deprecated` → "This package is deprecated. If you are looking for the latest features and support, use @privy-io/node instead." `@privy-io/node` was already an `api` dependency (used by `api/scripts/spike-privy-stellar.ts:18,60`), so `verifier.ts` wraps that instead of adding a redundant deprecated package. No `@privy-io/server-auth` code exists anywhere in this repo.
- **`PrivyClient`'s constructor takes a single options object, not positional args** — `new PrivyClient({appId, appSecret})`, not `new PrivyClient(appId, appSecret)`. Verified directly against the installed package's `.d.ts` (`@privy-io/node@0.27.0`).
- **Method used is `verifyAccessToken`, not `verifyAuthToken`.** Both exist on `client.utils().auth()`, but `verifyAuthToken` is marked `@deprecated` in the package's own types (in favor of `verifyAccessToken`) and its response type is aliased to the same shape anyway. This module always uses the non-deprecated one.
- **The DID field is `user_id` (snake_case), not `userId`.** `VerifyAccessTokenResponse.user_id` (`node_modules/.pnpm/@privy-io+node@0.27.0/node_modules/@privy-io/node/lib/auth.d.ts`) is destructured directly into `privyDid` in `verifier.ts`.
- **This module only verifies ACCESS tokens.** `PrivyClient` also exposes `verifyIdentityToken` (different claims, different purpose — proving identity at login, not authorizing an API call) — deliberately not used here. Callers must send the token from the frontend's `getAccessToken()`, not any identity/ID token.
- **`decorateRequest('privyDid', '')`'s default value (`''`) is never a valid observed value** in practice — the `onRequest` hook always either sets a real DID or throws before the route handler runs. The empty-string default exists only to satisfy Fastify's `decorateRequest` API, which requires a default.
- **Every auth failure mode collapses to the same `{code: 'unauthorized'}` shape** (missing header, malformed header, and a rejecting verifier all throw the same `AppError` code) — the response body deliberately does not distinguish *why* auth failed, to avoid giving callers a token-validation oracle.

## Testing

- `api/src/modules/auth/verifier.test.ts` (2 tests): mocks `@privy-io/node` via `vi.mock` — never calls live Privy. Verifies `createPrivyAuthVerifier` maps `verifyAccessToken`'s `user_id` to `privyDid`, and that a rejected `verifyAccessToken` call propagates as a rejection.
- `api/src/modules/auth/plugin.test.ts` (4 tests): builds a standalone Fastify instance with `authPlugin` + a fake `PrivyAuthVerifier` + one protected test route, covering: missing header, malformed header (no `Bearer` prefix), verifier rejects, verifier resolves and the route handler observes `request.privyDid`.
- `api/src/app.test.ts`: unchanged behavior, updated only to satisfy `AppDeps.privyAuth` now being required (a fake verifier that is never exercised, since no test there hits an authenticated route). Its existing `GET /health returns {status: 'ok'}` test is the coverage for "`/health` stays public with no auth."
- Run `pnpm --filter @paltalabs/api test` to execute all tests (32 passed across the whole workspace as of 2026-07-23, including the new 6 here).
