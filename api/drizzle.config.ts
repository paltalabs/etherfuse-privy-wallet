import {defineConfig} from 'drizzle-kit';
import {loadEnv} from './src/lib/env.js';

const env = loadEnv();

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: env.DATABASE_URL
  }
});
