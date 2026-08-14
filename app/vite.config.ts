import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Read env vars (VITE_PRIVY_APP_ID, etc.) from the repo-root .env instead of app/.env*
  envDir: fileURLToPath(new URL('..', import.meta.url)),
})
