import { PrivyProvider } from '@privy-io/react-auth'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Buffer } from 'buffer'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import App from './App.tsx'
import './index.css'

globalThis.Buffer = Buffer

const queryClient = new QueryClient()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <PrivyProvider
          appId={import.meta.env.VITE_PRIVY_APP_ID as string}
          config={{
            loginMethods: ['google', 'email'],
            // @privy-io/react-auth@3.35.2 nests createOnLogin per ethereum/solana chain (the
            // top-level `createOnLogin` is stale for this version); we create the stellar wallet
            // manually via useCreateWallet, so both are left off.
            embeddedWallets: { ethereum: { createOnLogin: 'off' }, solana: { createOnLogin: 'off' } },
          }}
        >
          <App />
        </PrivyProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
)
