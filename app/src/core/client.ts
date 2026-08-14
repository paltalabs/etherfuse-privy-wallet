import type { z } from 'zod'

/** API error with the backend's stable `{code}` token (or a synthesized one). */
export class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string) {
    super(`${status}: ${code}`)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

export interface ApiClient {
  get<T>(path: string, schema: z.ZodType<T>): Promise<T>
  post<T>(path: string, schema: z.ZodType<T>, body?: unknown): Promise<T>
}

/**
 * Thin authenticated fetch wrapper. Every response body is validated through
 * the caller-supplied zod schema from @paltalabs/shared — the client never
 * trusts a raw cast. fetchFn is injectable for tests.
 */
export function createApiClient(
  baseUrl: string,
  getToken: () => Promise<string | null>,
  fetchFn: typeof fetch = fetch,
): ApiClient {
  async function request<T>(method: 'GET' | 'POST', path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
    const token = await getToken()
    if (!token) throw new ApiError(401, 'no_token')
    const res = await fetchFn(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    if (!res.ok) {
      const code = await res
        .json()
        .then((b: unknown) =>
          typeof b === 'object' && b !== null && 'code' in b ? String((b as { code: unknown }).code) : 'unknown_error',
        )
        .catch(() => 'unknown_error')
      throw new ApiError(res.status, code)
    }
    // A 204 has no body — calling res.json() on it throws (empty string isn't
    // valid JSON). Used by e.g. POST /ramp/payin/:orderId/simulate, whose
    // schema is z.void().
    if (res.status === 204) return schema.parse(undefined)
    return schema.parse(await res.json())
  }
  return {
    get: (path, schema) => request('GET', path, schema),
    post: (path, schema, body) => request('POST', path, schema, body),
  }
}
