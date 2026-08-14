import {
  VaultDepositRequestSchema,
  VaultIntentResponseSchema,
  VaultPositionResponseSchema,
  VaultWithdrawRequestSchema
} from '@paltalabs/shared';
import type {FastifyPluginAsync} from 'fastify';
import {AppError} from '../../lib/errors.js';
import type {VaultService} from './service.js';

export interface VaultRoutesOptions {
  vaultService: VaultService;
}

/**
 * Vault HTTP surface: `GET /vault/position`, `POST /vault/deposit`,
 * `POST /vault/withdraw`. Reads `request.privyDid`, so it must be registered
 * against a Fastify instance that already has `authPlugin`'s hook attached
 * (see `app.ts`/`docs/modules/api-auth.md`) — registering it standalone (as
 * `routes.test.ts`'s plugin-level test does) requires supplying
 * `request.privyDid` some other way. Submission of a built deposit/withdraw
 * happens via the generic `POST /intents/:id/complete` endpoint
 * (`docs/modules/api-intents.md`), same as payments/provisioning intents.
 */
export const vaultRoutes: FastifyPluginAsync<VaultRoutesOptions> = async (app, opts) => {
  app.get('/vault/position', async (request) => {
    const result = await opts.vaultService.position(request.privyDid);
    return VaultPositionResponseSchema.parse(result);
  });

  app.post('/vault/deposit', async (request) => {
    // safeParse (not .parse()) deliberately: a raw ZodError thrown here
    // would NOT be an AppError, so app.ts's global error handler would map
    // it to a generic 500 instead of a 400 — mirrors payments/routes.ts's
    // convention.
    const parsed = VaultDepositRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError('invalid_request', 'invalid vault deposit request', 400, {issues: parsed.error.issues});
    }
    const result = await opts.vaultService.deposit(request.privyDid, parsed.data);
    return VaultIntentResponseSchema.parse(result);
  });

  app.post('/vault/withdraw', async (request) => {
    const parsed = VaultWithdrawRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError('invalid_request', 'invalid vault withdraw request', 400, {issues: parsed.error.issues});
    }
    const result = await opts.vaultService.withdraw(request.privyDid, parsed.data);
    return VaultIntentResponseSchema.parse(result);
  });
};
