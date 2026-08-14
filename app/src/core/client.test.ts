import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { ApiError, createApiClient } from './client'

const okJson = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const errJson = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('createApiClient', () => {
  it('sends bearer token and parses response on GET', async () => {
    const fetchFn = vi.fn().mockResolvedValue(okJson({ hello: 'world' }))
    const client = createApiClient('http://x', async () => 'tok-1', fetchFn)
    const out = await client.get('/thing', z.object({ hello: z.string() }))
    expect(out).toEqual({ hello: 'world' })
    const [url, init] = fetchFn.mock.calls[0]
    expect(url).toBe('http://x/thing')
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer tok-1')
  })

  it('sends content-type and JSON body on POST', async () => {
    const fetchFn = vi.fn().mockResolvedValue(okJson({ hello: 'world' }))
    const client = createApiClient('http://x', async () => 'tok-1', fetchFn)
    const out = await client.post('/thing', z.object({ hello: z.string() }), { a: 1 })
    expect(out).toEqual({ hello: 'world' })
    const [url, init] = fetchFn.mock.calls[0]
    expect(url).toBe('http://x/thing')
    expect(new Headers(init.headers).get('content-type')).toBe('application/json')
    expect(init.body).toBe(JSON.stringify({ a: 1 }))
  })

  it('throws ApiError with status and code on non-2xx with a code body', async () => {
    const fetchFn = vi.fn().mockResolvedValue(errJson({ code: 'not_found' }, 404))
    const client = createApiClient('http://x', async () => 'tok-1', fetchFn)
    await expect(client.get('/thing', z.object({ hello: z.string() }))).rejects.toSatisfy(
      (e) => e instanceof ApiError && e.status === 404 && e.code === 'not_found',
    )
  })

  it('throws ApiError with code unknown_error on non-2xx with an unparseable body', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('not json', { status: 500 }))
    const client = createApiClient('http://x', async () => 'tok-1', fetchFn)
    await expect(client.get('/thing', z.object({ hello: z.string() }))).rejects.toSatisfy(
      (e) => e instanceof ApiError && e.status === 500 && e.code === 'unknown_error',
    )
  })

  it('rejects with a zod error when a 2xx body fails schema parse', async () => {
    const fetchFn = vi.fn().mockResolvedValue(okJson({ nope: 1 }))
    const client = createApiClient('http://x', async () => 'tok-1', fetchFn)
    await expect(client.get('/thing', z.object({ hello: z.string() }))).rejects.toThrow()
  })

  it('returns schema.parse(undefined) for a 204 response without calling res.json()', async () => {
    const res = new Response(null, { status: 204 })
    const jsonSpy = vi.spyOn(res, 'json')
    const fetchFn = vi.fn().mockResolvedValue(res)
    const client = createApiClient('http://x', async () => 'tok-1', fetchFn)
    const out = await client.post('/thing', z.void())
    expect(out).toBeUndefined()
    expect(jsonSpy).not.toHaveBeenCalled()
  })

  it('throws ApiError 401 no_token without calling fetchFn when getToken resolves null', async () => {
    const fetchFn = vi.fn()
    const client = createApiClient('http://x', async () => null, fetchFn)
    await expect(client.get('/thing', z.object({ hello: z.string() }))).rejects.toSatisfy(
      (e) => e instanceof ApiError && e.status === 401 && e.code === 'no_token',
    )
    expect(fetchFn).not.toHaveBeenCalled()
  })
})
