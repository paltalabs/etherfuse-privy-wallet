import { createContext, useContext, type ReactNode } from 'react'
import type { ApiClient } from './client'
import type { RawHashSigner } from './signing'

export interface CoreValue {
  client: ApiClient
  /** null until the Privy stellar wallet exists (AuthGate guarantees it for screens). */
  signer: RawHashSigner | null
  walletAddress: string | null
}

const CoreContext = createContext<CoreValue | null>(null)

export function CoreProvider({ value, children }: { value: CoreValue; children: ReactNode }) {
  return <CoreContext.Provider value={value}>{children}</CoreContext.Provider>
}

export function useCore(): CoreValue {
  const ctx = useContext(CoreContext)
  if (!ctx) throw new Error('useCore must be used inside CoreProvider')
  return ctx
}
