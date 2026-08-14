/**
 * Base class for errors the API intentionally throws to signal a specific,
 * client-facing failure (validation, not-found, conflict, etc). The global
 * Fastify error handler (see app.ts) recognizes instances of this class and
 * serializes them as `{code, message, details?}` with `statusCode`.
 *
 * Anything thrown that is NOT an AppError is treated as unexpected/internal:
 * the handler responds with a generic 500 and never leaks the original
 * message, stack, or shape to the client (it's server-logged only).
 */
export class AppError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(code: string, message: string, statusCode: number, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}
