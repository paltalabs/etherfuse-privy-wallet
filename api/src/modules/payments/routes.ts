import {PaymentRequestSchema, PaymentResponseSchema} from '@paltalabs/shared';
import type {FastifyPluginAsync} from 'fastify';
import {AppError} from '../../lib/errors.js';
import type {PaymentsService} from './service.js';

export interface PaymentRoutesOptions {
  paymentsService: PaymentsService;
}

/**
 * Payments HTTP surface: `POST /payments`. Reads `request.privyDid`, so it
 * must be registered against a Fastify instance that already has
 * `authPlugin`'s hook attached (see `app.ts`/`docs/modules/api-auth.md`) —
 * registering it standalone (as `routes.test.ts`'s plugin-level test does)
 * requires supplying `request.privyDid` some other way. Submission of the
 * built payment happens via the generic `POST /intents/:id/complete`
 * endpoint (`docs/modules/api-intents.md`), same as provisioning intents.
 */
export const paymentRoutes: FastifyPluginAsync<PaymentRoutesOptions> = async (app, opts) => {
  app.post('/payments', async (request) => {
    // safeParse (not .parse()) deliberately: a raw ZodError thrown here
    // would NOT be an AppError, so app.ts's global error handler would map
    // it to a generic 500 instead of a 400 — no other route in this codebase
    // validates a request body yet, so there's no precedent/shared helper
    // for this translation. Kept local to this route rather than promoted
    // to a shared utility (single call site, out of scope to generalize).
    const parsed = PaymentRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError('invalid_request', 'invalid payment request', 400, {issues: parsed.error.issues});
    }
    const result = await opts.paymentsService.createPayment(request.privyDid, parsed.data);
    return PaymentResponseSchema.parse(result);
  });
};
