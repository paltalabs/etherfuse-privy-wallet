import {CompleteIntentRequestSchema, CompleteIntentResponseSchema} from '@paltalabs/shared';
import type {FastifyPluginAsync} from 'fastify';
import {z} from 'zod';
import {AppError} from '../../lib/errors.js';
import type {IntentsService} from './service.js';

export interface IntentRoutesOptions {
  intentsService: IntentsService;
}

// :id must be a UUID before it ever reaches the service -- a malformed id
// gets the SAME AppError('intent_not_found', ..., 404) that service.ts's
// getOwnedIntent produces for a syntactically-valid-but-nonexistent (or
// wrong-owner) id, so a caller can never distinguish "not shaped like an
// id" from "no such intent" (see docs/modules/api-intents.md's Gotchas).
const IntentIdParamSchema = z.object({id: z.string().uuid()});

/**
 * Intents HTTP surface: `POST /intents/:id/complete`, the generic
 * signing-flow completion endpoint (provision intents today; payment
 * intents reuse the same route once that flow lands). Reads
 * `request.privyDid`, so it must be registered against a Fastify instance
 * that already has `authPlugin`'s hook attached (see
 * `app.ts`/`docs/modules/api-auth.md`) — registering it standalone (as
 * `routes.test.ts`'s plugin-level test does) requires supplying
 * `request.privyDid` some other way.
 */
export const intentRoutes: FastifyPluginAsync<IntentRoutesOptions> = async (app, opts) => {
  app.post<{Params: {id: string}; Body: {signature: string}}>('/intents/:id/complete', async (request) => {
    const params = IntentIdParamSchema.safeParse(request.params);
    if (!params.success) {
      throw new AppError('intent_not_found', 'intent not found', 404);
    }

    // safeParse (not .parse()): a raw ZodError thrown here would NOT be an
    // AppError, so app.ts's global error handler would map it to a generic
    // 500 instead of a 400 -- same rationale as payments/routes.ts's
    // PaymentRequestSchema.safeParse (docs/modules/api-payments.md's Gotchas).
    const body = CompleteIntentRequestSchema.safeParse(request.body);
    if (!body.success) {
      throw new AppError('invalid_request', 'invalid request body', 400, {issues: body.error.issues});
    }

    const result = await opts.intentsService.complete(request.privyDid, params.data.id, body.data.signature);
    return CompleteIntentResponseSchema.parse(result);
  });
};
