import {
  KycLaunchResponseSchema,
  OnboardingStartRequestSchema,
  PayinExecuteRequestSchema,
  PayinOrderResponseSchema,
  PayinOrderStateResponseSchema,
  PayinQuoteRequestSchema,
  PayoutExecuteRequestSchema,
  PayoutIntentResponseSchema,
  PayoutQuoteRequestSchema,
  PixDetailsRequestSchema,
  RampOnboardingStatusSchema,
  RampQuoteResponseSchema
} from '@paltalabs/shared';
import type {FastifyPluginAsync} from 'fastify';
import {AppError} from '../../lib/errors.js';
import type {RampService} from './service.js';

export interface RampRoutesOptions {
  rampService: RampService;
}

/**
 * Ramp onboarding + BRL/PIX payin + anchor-mode payout HTTP surface:
 * `GET /ramp/onboarding`, `POST /ramp/onboarding/start`,
 * `POST /ramp/onboarding/kyc-launch`, `POST /ramp/onboarding`,
 * `POST /ramp/payin/quote`, `POST /ramp/payin`, `GET /ramp/payin/:orderId`,
 * `POST /ramp/payin/:orderId/simulate`, `POST /ramp/payout/quote`,
 * `POST /ramp/payout`. Reads
 * `request.privyDid`, so it must be registered against a Fastify instance
 * that already has `authPlugin`'s hook attached (see
 * `app.ts`/`docs/modules/api-auth.md`) — registering it standalone (as
 * `routes.test.ts`'s plugin-level test does) requires supplying
 * `request.privyDid` some other way.
 *
 * Every `safeParse` below is deliberate (not `.parse()`): a raw ZodError
 * would NOT be an `AppError`, so `app.ts`'s global error handler would map it
 * to a generic 500 instead of a 400 — mirrors `payments/routes.ts`'s and
 * `vault/routes.ts`'s convention.
 */
export const rampRoutes: FastifyPluginAsync<RampRoutesOptions> = async (app, opts) => {
  app.get('/ramp/onboarding', async (request) => {
    const result = await opts.rampService.onboardingStatus(request.privyDid);
    return RampOnboardingStatusSchema.parse(result);
  });

  app.post('/ramp/onboarding/start', async (request) => {
    const parsed = OnboardingStartRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError('invalid_request', 'invalid ramp onboarding start request', 400, {issues: parsed.error.issues});
    }
    const result = await opts.rampService.startOnboarding(request.privyDid, parsed.data);
    return KycLaunchResponseSchema.parse(result);
  });

  // Takes the same body as /start rather than none: the launch JWT's `email`
  // and `name` claims are mandatory, and Etherfuse offers no way to read a
  // personal organization's registered email back, so a re-entry launch has
  // to re-send them. The claims are informational — the address the hosted
  // /idv flow actually confirms is the one the organization was created with
  // — so a client that lies here only affects its own session.
  app.post('/ramp/onboarding/kyc-launch', async (request) => {
    const parsed = OnboardingStartRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError('invalid_request', 'invalid kyc launch request', 400, {issues: parsed.error.issues});
    }
    const result = await opts.rampService.kycLaunch(request.privyDid, parsed.data);
    return KycLaunchResponseSchema.parse(result);
  });

  app.post('/ramp/onboarding', async (request) => {
    const parsed = PixDetailsRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError('invalid_request', 'invalid ramp onboarding request', 400, {issues: parsed.error.issues});
    }
    const result = await opts.rampService.completeSetup(request.privyDid, parsed.data);
    return RampOnboardingStatusSchema.parse(result);
  });

  app.post('/ramp/payin/quote', async (request) => {
    const parsed = PayinQuoteRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError('invalid_request', 'invalid payin quote request', 400, {issues: parsed.error.issues});
    }
    const result = await opts.rampService.payinQuote(request.privyDid, parsed.data);
    return RampQuoteResponseSchema.parse(result);
  });

  // The client echoes the quote's own receiverAmountCents (as amountCents)
  // instead of this route deriving it via a provider read-back — see
  // createPayin's doc comment (service.ts).
  app.post('/ramp/payin', async (request) => {
    const parsed = PayinExecuteRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError('invalid_request', 'invalid payin request', 400, {issues: parsed.error.issues});
    }
    const result = await opts.rampService.createPayin(request.privyDid, parsed.data);
    return PayinOrderResponseSchema.parse(result);
  });

  // `:orderId` is not shape-validated here: the service resolves it against
  // the caller's OWN activity rows, so anything unrecognized — malformed or
  // merely someone else's — comes back as the same 404 `order_not_found`.
  app.get<{Params: {orderId: string}}>('/ramp/payin/:orderId', async (request) => {
    const result = await opts.rampService.getPayinState(request.privyDid, request.params.orderId);
    return PayinOrderStateResponseSchema.parse(result);
  });

  app.post<{Params: {orderId: string}}>('/ramp/payin/:orderId/simulate', async (request, reply) => {
    await opts.rampService.simulatePayin(request.privyDid, request.params.orderId);
    // 204: the sandbox simulator returns nothing worth forwarding — the
    // client polls GET /ramp/payin/:orderId for the resulting state.
    await reply.status(204).send();
  });

  app.post('/ramp/payout/quote', async (request) => {
    const parsed = PayoutQuoteRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError('invalid_request', 'invalid payout quote request', 400, {issues: parsed.error.issues});
    }
    const result = await opts.rampService.payoutQuote(request.privyDid, parsed.data);
    return RampQuoteResponseSchema.parse(result);
  });

  // The client echoes the quote's own sender-side amount (as amountCents)
  // instead of this route deriving it via a provider read-back — same
  // rationale as the payin route above (see createPayout's doc comment,
  // service.ts).
  app.post('/ramp/payout', async (request) => {
    const parsed = PayoutExecuteRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError('invalid_request', 'invalid payout request', 400, {issues: parsed.error.issues});
    }
    const result = await opts.rampService.createPayout(request.privyDid, parsed.data);
    return PayoutIntentResponseSchema.parse(result);
  });
};
