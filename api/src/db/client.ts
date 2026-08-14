import type {NodePgDatabase} from 'drizzle-orm/node-postgres';
import {drizzle} from 'drizzle-orm/node-postgres';
import {Pool} from 'pg';
import * as schema from './schema.js';

/**
 * Creates a fresh Drizzle db handle + its underlying pg Pool for the given
 * connection string. Deliberately no module-level singleton: callers (the
 * Fastify server, scripts, tests) each construct and own their instance so
 * lifecycle (e.g. `pool.end()`) stays explicit and testable.
 */
export function createDb(databaseUrl: string): {db: NodePgDatabase<typeof schema>; pool: Pool} {
  const pool = new Pool({connectionString: databaseUrl});
  const db = drizzle(pool, {schema});
  return {db, pool};
}
