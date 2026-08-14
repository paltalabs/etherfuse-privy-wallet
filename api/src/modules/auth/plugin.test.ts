import Fastify from 'fastify';
import {describe, expect, it} from 'vitest';
import {AppError} from '../../lib/errors.js';
import {authPlugin} from './plugin.js';
import type {PrivyAuthVerifier} from './verifier.js';

/**
 * Builds a minimal Fastify instance carrying the same AppError -> {code,
 * message} translation `app.ts`'s `setErrorHandler` performs (duplicated
 * here, not imported, so this test exercises `authPlugin` in isolation from
 * `buildApp`/`app.ts`), with `authPlugin` wrapping one protected test route.
 */
function buildTestApp(verifier: PrivyAuthVerifier) {
  const app = Fastify();

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      reply.status(error.statusCode).send({code: error.code, message: error.message});
      return;
    }
    reply.status(500).send({code: 'internal_error', message: 'internal error'});
  });

  app.register(async (authenticated) => {
    await authenticated.register(authPlugin, {verifier});
    authenticated.get('/protected', async (request) => ({privyDid: request.privyDid}));
  });

  return app;
}

describe('authPlugin', () => {
  it('returns 401 {code: "unauthorized"} when the Authorization header is missing', async () => {
    const app = buildTestApp({
      verify: async () => ({privyDid: 'did:privy:should-not-be-reached'})
    });

    const res = await app.inject({method: 'GET', url: '/protected'});

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({code: 'unauthorized'});
  });

  it('returns 401 {code: "unauthorized"} when the header is malformed (no Bearer prefix)', async () => {
    const app = buildTestApp({
      verify: async () => ({privyDid: 'did:privy:should-not-be-reached'})
    });

    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: {authorization: 'Basic sometoken'}
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({code: 'unauthorized'});
  });

  it('returns 401 {code: "unauthorized"} when the verifier rejects the token', async () => {
    const app = buildTestApp({
      verify: async () => {
        throw new Error('token expired');
      }
    });

    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: {authorization: 'Bearer bad-token'}
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({code: 'unauthorized'});
  });

  it('sets request.privyDid from the verifier and lets the route handler see it', async () => {
    const app = buildTestApp({
      verify: async (accessToken) => {
        expect(accessToken).toBe('good-token');
        return {privyDid: 'did:privy:abc123'};
      }
    });

    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: {authorization: 'Bearer good-token'}
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({privyDid: 'did:privy:abc123'});
  });
});
