# api-history Module

> **Living document.** Read this before modifying the module. Update it in the same change whenever the module's behavior, endpoints, files, or dependencies change.

**Source:** `api/src/modules/history/` (+ `packages/shared/src/api.ts`'s `ActivityItemSchema`/`ActivityFeedResponseSchema`) · **Last verified:** 2026-07-23

## Purpose

The `history` module is `GET /activity`: the merchant's own activity feed (provisioning events plus payment sends/receives), newest first, keyset-paginated on `createdAt`. It resolves the caller's `stellarAddress` from `request.privyDid` via the `merchants` table and reads the denormalized `activity` table (written by both `payments`/`intents` on submission and the indexer on Horizon confirmation — `api/src/db/schema.ts:46-72`). A caller with no `merchants` row yet (never provisioned) gets an empty feed, not an error — mirrors `wallet`'s "provisioning is optional until you act" stance. It is a sibling of `payments`/`wallet`/`intents`, not a dependency of any of them — it queries `merchants`/`activity` directly via its own narrow `HistoryRepo`, the same decoupled-siblings pattern `payments` established (`docs/modules/api-payments.md`'s Purpose).

## Structure

| File | Purpose |
|---|---|
| `service.ts` | `HistoryService` (`getFeed`) + `HistoryRepo` persistence abstraction + `createDrizzleHistoryRepo` (`api/src/modules/history/service.ts`). |
| `service.test.ts` | TDD coverage of `createHistoryService.getFeed` against a fake `HistoryRepo` that replicates the real repo's SQL semantics in-memory — no live Postgres (`api/src/modules/history/service.test.ts`). |
| `routes.ts` | `historyRoutes`, the `FastifyPluginAsync` registering `GET /activity` (`api/src/modules/history/routes.ts`). |
| `routes.test.ts` | Plugin-level tests (standalone Fastify + `historyRoutes` + fake `HistoryService`) and REAL-`buildApp` end-to-end tests proving the authenticated-scope wiring plus the route's own query-validation error envelope (`api/src/modules/history/routes.test.ts`). |
| `../../../packages/shared/src/api.ts` | `ActivityItemSchema`/`ActivityItem` (one feed row), `ActivityFeedResponseSchema`/`ActivityFeedResponse` (`{items, nextBefore}`) — the zod contracts `routes.ts` parses the handler's result through (`packages/shared/src/api.ts:118-144`). |

## Endpoints / Public surface

Registered inside `app.ts`'s authenticated scope (`api/src/app.ts:93-99`) — requires `Authorization: Bearer <Privy access token>` (see `docs/modules/api-auth.md`) and reads `request.privyDid`.

| Method | Path | Query | Response | Notes |
|---|---|---|---|---|
| `GET` | `/activity` | `limit?` (default `20`, max `100`), `before?` (ISO-8601 UTC timestamp) | `200 ActivityFeedResponse` — `{items: ActivityItem[], nextBefore: string \| null}` | `items` are the caller's own `stellarAddress` rows, newest first. `nextBefore` is `items`'s last entry's `createdAt` when the page is full (`items.length === limit`); `null` otherwise (feed exhausted, or the caller has no `merchants` row). Pass `nextBefore` back as the next call's `before` to walk further back. |

### Error responses

| Condition | Status | Body | Notes |
|---|---|---|---|
| No `Authorization` header / verifier rejects | 401 | `{code: 'unauthorized'}` | `authPlugin`'s hook, same as every other authenticated route (`docs/modules/api-auth.md`). |
| `limit` is not a positive integer ≤ 100, or `before` is not a strict ISO-8601 UTC datetime | 400 | `{code: 'invalid_request', details: {issues}}` | Checked entirely in `routes.ts` via `ActivityQuerySchema.safeParse` — never reaches the service (same `safeParse`-not-`.parse()` rationale as `payments/routes.ts`, see Gotchas). `limit` over 100 is a 400, not a silent clamp — explicit over implicit for anything a caller could get wrong. |
| No `merchants` row for the caller | *(not an error)* | `200 {items: [], nextBefore: null}` | Deliberate — see Purpose. `repo.listActivity` is never even called in this case (`service.ts:100-103`). |

## Key methods (`file:line`)

| Export | Signature | File:Line | Purpose |
|---|---|---|---|
| `createHistoryService` | `(deps: HistoryServiceDeps): HistoryService` | `api/src/modules/history/service.ts:95` | Builds `{getFeed}` from an injected `repo`. No Stellar gateway / registry dep — this module never touches Horizon, only Postgres. |
| `HistoryService.getFeed` | `(privyDid: string, query: HistoryFeedQuery): Promise<ActivityFeedResponse>` | `api/src/modules/history/service.ts:58,65,95,99` | Merchant lookup (empty feed short-circuit if none) → `repo.listActivity` → map rows to `ActivityItem` → compute `nextBefore` from whether the page is full. |
| `HistoryRepo` | `interface` | `api/src/modules/history/service.ts:16-26` | `getMerchant`/`listActivity` — the persistence boundary `service.test.ts` fakes in-memory. |
| `createDrizzleHistoryRepo` | `(db: NodePgDatabase<typeof schema>): HistoryRepo` | `api/src/modules/history/service.ts:29` | The only production `HistoryRepo`: `getMerchant` selects by `merchants.privyDid`; `listActivity` runs `WHERE stellarAddress = ... [AND createdAt < before] ORDER BY createdAt DESC LIMIT limit` (`service.ts:37-44`) — no secondary sort key, see Gotchas. |
| `toActivityItem` | `(row: ActivityRecord): ActivityItem` | `api/src/modules/history/service.ts:74-87` | Maps a raw `activity` row to the client shape: drops `stellarAddress` (always the requester's own), `source`/`externalRef` (internal reconciliation bookkeeping, `db/schema.ts:64-65`), converts `createdAt` to an ISO string via `.toISOString()`. |
| `historyRoutes` | `FastifyPluginAsync<HistoryRoutesOptions>` | `api/src/modules/history/routes.ts:32` | Registers `GET /activity`; `ActivityQuerySchema.safeParse(request.query)` so a validation failure becomes `AppError('invalid_request', ..., 400)` instead of an uncaught `ZodError`. |
| `ActivityQuerySchema` | `z.object({limit, before})` (local to `routes.ts`, not shared) | `api/src/modules/history/routes.ts:20-23` | `limit`: `z.coerce.number().int().positive().max(100).optional().default(20)` — coerces the querystring's string value to a number, rejects non-numeric/zero/negative/non-integer/`>100`. `before`: `z.string().datetime().optional()` — strict ISO-8601 UTC (`offset: false`, zod's default), matching what `Date.prototype.toISOString()` produces. |
| `ActivityItemSchema` / `ActivityItem` | `z.object({id, type, direction, amount, assetCode, assetIssuer, counterparty, status, txHash, createdAt})` / inferred type | `packages/shared/src/api.ts:118-130` | Mirrors the `activity` table's client-relevant columns exactly (nullable fields stay nullable) minus `stellarAddress`/`source`/`externalRef`. |
| `ActivityFeedResponseSchema` / `ActivityFeedResponse` | `z.object({items: z.array(ActivityItemSchema), nextBefore: z.string().nullable()})` / inferred type | `packages/shared/src/api.ts:140-144` | `GET /activity`'s response contract. |

## Dependencies

- `drizzle-orm` — `and`/`desc`/`eq`/`lt`, `InferSelectModel` (`service.ts:2`).
- `../../db/schema.ts` (`merchants`, `activity`) — the two tables this module reads; never writes (feed rows are written by `payments`/`intents`/the indexer, not here).
- `../../lib/errors.ts` (`AppError`) — the 400 response in the table above.
- `@paltalabs/shared` — `ActivityFeedResponseSchema` and its inferred types (`ActivityItem`/`ActivityFeedResponse`).
- `zod` — `ActivityQuerySchema`, local to `routes.ts`.
- `fastify` (`FastifyPluginAsync`) — `routes.ts`.

## Gotchas & invariants

- **Ties on `createdAt` at a page boundary can silently skip rows — a known, accepted MVP limitation.** `listActivity` orders by `createdAt DESC` alone (`service.ts:43`), with no secondary/compound sort key (e.g. `id`). If two or more rows share the *exact* same `createdAt` timestamp and that timestamp falls exactly at a page boundary (the cursor value), a `WHERE createdAt < before` filter on the next page excludes ALL rows at that timestamp — including any that weren't returned in the previous page (a strict `<` can never re-include a boundary value, whichever rows happened to land in the prior page's `LIMIT` first). Postgres `timestamp with time zone` has microsecond precision, so this requires two `activity` rows inserted at the literal same microsecond, which is rare in practice (each row is written by a single sequential API/indexer call) — acceptable for MVP. A compound cursor (`(createdAt, id) < (beforeCreatedAt, beforeId)`) would close the gap but is deliberately NOT built now, out of scope for this module's current spec.
- **`nextBefore` is a heuristic, not a certainty — "page full" does not guarantee more rows exist.** `getFeed` sets `nextBefore` whenever `items.length === limit` (`service.ts:110-111`), even if the feed happens to end exactly on a page boundary. The very next call with that `before` will simply return `{items: [], nextBefore: null}` — an extra round-trip, not a bug. No `COUNT`/lookahead row is used to avoid a second query per page.
- **`safeParse`, not `.parse()`, in `routes.ts`** — a raw thrown `ZodError` is NOT an `AppError`, so `app.ts`'s global error handler (`api/src/app.ts:101-115`) would map it to a generic `500` instead of a `400`. Same rationale, same fix shape as `payments/routes.ts` (`docs/modules/api-payments.md`'s Gotchas) — deliberately NOT the `intents/routes.ts` `.parse()` pattern, which is a known pre-existing gap left out of scope here.
- **`limit` over 100 is a 400, not a silent clamp.** The spec left both options open; this module chose explicit rejection (`z.coerce.number().int().positive().max(100)`, `routes.ts:21`) to match `payments`' existing convention of surfacing every client-input problem as a typed 400 rather than silently reinterpreting the request.
- **`ActivityQuerySchema` lives in `routes.ts`, not `packages/shared/src/api.ts`** — unlike `PaymentRequestSchema`, there's no request *body* shape a frontend needs to import and construct against; a query string (`?limit=5&before=...`) is built ad hoc from primitives. Only the *response* contracts (`ActivityItemSchema`/`ActivityFeedResponseSchema`) are shared, per this module's explicit scope.
- **No live-Postgres integration test exists for this module** (same convention as `payments`/`wallet`/`intents` — see `docs/modules/api-payments.md`'s Gotchas). `service.test.ts` uses a fake `HistoryRepo` that replicates the real repo's filter/sort/limit semantics in plain JS; `routes.test.ts`'s REAL-`buildApp` tests are deliberately limited to paths that never touch the DB (401; the two `invalid_request` 400s, both of which throw before `opts.historyService.getFeed` is ever called). The business-logic assertions this module's spec asks for — empty feed for an unprovisioned merchant, newest-first ordering, the two-page `before`-cursor pagination walk — live in `service.test.ts` against the fake repo instead of literally through `buildApp`, since `AppDeps` has no mechanism to inject a fake repo underneath a real Drizzle-backed service (same reason none of this codebase's other modules test their DB-backed paths through `buildApp` either).

## Testing

- `api/src/modules/history/service.test.ts` (6 tests): empty feed (not an error) for a caller with no `merchants` row, and `repo.listActivity` never called in that case; rows returned newest-first regardless of insertion order, mapped to the exact `ActivityItem` shape; only the caller's own `stellarAddress` rows are returned; `nextBefore` set to the last item's `createdAt` when the page is full; a full two-page walk via `before`, asserting `repo.listActivity` receives the exact `Date` cursor and the second (partial) page's `nextBefore` is `null`.
- `api/src/modules/history/routes.test.ts` (9 tests): five standalone-plugin tests (`historyRoutes` on a bare Fastify instance, `request.privyDid` stubbed via a test-only hook, fake `HistoryService`) — no-query-params calls `getFeed` with `{limit: 20, before: undefined}`; `?limit=5&before=<iso>` passes a parsed `Date`; the service's result round-trips through `ActivityFeedResponseSchema`; `limit=101` and `limit=0` and a malformed `before` each 400 without ever calling the service. Four REAL-`buildApp` tests: `401 {code: 'unauthorized'}` with no `Authorization` header; `limit=101` and a malformed `before` each → `400 {code: 'invalid_request'}` without touching the db.
- Run `pnpm --filter @paltalabs/api test` to execute all tests (102 passed across the whole workspace as of 2026-07-23, including the new 15 here — 6 service + 9 routes), `pnpm --filter @paltalabs/shared test` for the shared schema tests (`ActivityItemSchema`/`ActivityFeedResponseSchema` coverage lives there, `packages/shared/src/api.test.ts` — see `docs/modules/shared.md`), `pnpm -r typecheck` for both workspaces.
