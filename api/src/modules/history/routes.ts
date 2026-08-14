import {ActivityFeedResponseSchema} from '@paltalabs/shared';
import type {FastifyPluginAsync} from 'fastify';
import {z} from 'zod';
import {AppError} from '../../lib/errors.js';
import type {HistoryService} from './service.js';

export interface HistoryRoutesOptions {
  historyService: HistoryService;
}

// Query-string contract for GET /activity. Kept local to this route (not in
// packages/shared/src/api.ts) — unlike PaymentRequestSchema, there is no
// request body a frontend needs to construct against a shared type; a
// query string is built ad hoc. `limit` defaults to 20 and is capped at
// 100 — over the cap is a 400, not a silent clamp (explicit over implicit
// for anything a caller could get wrong). `before` must be a strict
// ISO-8601 UTC timestamp (zod's `.datetime()`
// default: `offset: false`), matching what `ActivityRecord.createdAt`
// produces via `.toISOString()` (always `Z`-suffixed).
const ActivityQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).optional().default(20),
  before: z.string().datetime().optional()
});

/**
 * History HTTP surface: `GET /activity`. Reads `request.privyDid`, so it
 * must be registered against a Fastify instance that already has
 * `authPlugin`'s hook attached (see `app.ts`/`docs/modules/api-auth.md`) —
 * registering it standalone (as `routes.test.ts`'s plugin-level test does)
 * requires supplying `request.privyDid` some other way.
 */
export const historyRoutes: FastifyPluginAsync<HistoryRoutesOptions> = async (app, opts) => {
  app.get('/activity', async (request) => {
    // safeParse (not .parse()) deliberately: a raw ZodError thrown here
    // would NOT be an AppError, so app.ts's global error handler would map
    // it to a generic 500 instead of a 400 — same rationale as
    // payments/routes.ts's PaymentRequestSchema.safeParse (see its Gotchas
    // in docs/modules/api-payments.md); intents/routes.ts's `.parse()` is a
    // pre-existing gap this route does not repeat.
    const parsed = ActivityQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw new AppError('invalid_request', 'invalid activity query', 400, {issues: parsed.error.issues});
    }

    const {limit, before} = parsed.data;
    const result = await opts.historyService.getFeed(request.privyDid, {
      limit,
      before: before ? new Date(before) : undefined
    });
    return ActivityFeedResponseSchema.parse(result);
  });
};
