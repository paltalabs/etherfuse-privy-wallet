import {ProvisionResponseSchema, WalletResponseSchema} from '@paltalabs/shared';
import type {FastifyPluginAsync} from 'fastify';
import type {WalletService} from './service.js';

export interface WalletRoutesOptions {
  walletService: WalletService;
}

/**
 * Wallet HTTP surface: `POST /wallet/provision` and `GET /wallet`. Reads
 * `request.privyDid`, so it must be registered against a Fastify instance
 * that already has `authPlugin`'s hook attached (see `app.ts`/`docs/modules/api-auth.md`)
 * — registering it standalone (as `routes.test.ts`'s plugin-level tests do)
 * requires supplying `request.privyDid` some other way.
 */
export const walletRoutes: FastifyPluginAsync<WalletRoutesOptions> = async (app, opts) => {
  app.post('/wallet/provision', async (request) => {
    const result = await opts.walletService.provision(request.privyDid);
    return ProvisionResponseSchema.parse(result);
  });

  app.get('/wallet', async (request) => {
    const result = await opts.walletService.getWallet(request.privyDid);
    return WalletResponseSchema.parse(result);
  });
};
