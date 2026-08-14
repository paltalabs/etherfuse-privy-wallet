import { usePrivy, type User } from '@privy-io/react-auth'
import { useCreateWallet, useSignRawHash } from '@privy-io/react-auth/extended-chains'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createApiClient } from '../core/client'
import { CoreProvider, type CoreValue } from '../core/context'

const API_BASE_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:3000'

/** Shown when `createWallet` rejects and the caught error has no usable `.message`. */
const WALLET_SETUP_ERROR_FALLBACK = 'Something went wrong setting up your wallet.'

/** Same linked-account detection previously proven in the browser signing spike (`docs/evidence/privy-stellar-spike.md`). */
function findStellarWallet(user: User | null): { address: string } | undefined {
  return user?.linkedAccounts.find((a) => a.type === 'wallet' && 'chainType' in a && a.chainType === 'stellar') as
    | { address: string }
    | undefined
}

/**
 * Gates the whole app behind Privy auth + Stellar wallet provisioning, then
 * hands authenticated screens a memoized `CoreValue` (API client, signer,
 * wallet address) via `CoreProvider`.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const { ready, authenticated, login, user, getAccessToken } = usePrivy()
  const { createWallet } = useCreateWallet()
  const { signRawHash } = useSignRawHash()
  const creatingRef = useRef(false)
  const [provisionError, setProvisionError] = useState<string | null>(null)

  const stellarWallet = findStellarWallet(user)

  // Shared by the auto-provisioning effect below and the "Try again" retry button, so a
  // rejection (transient Privy error, rate limit, network blip) never leaves creatingRef
  // stuck `true` with no in-app way to retry short of a full page reload.
  const provisionWallet = useCallback(() => {
    creatingRef.current = true
    setProvisionError(null)
    createWallet({ chainType: 'stellar' }).catch((err: unknown) => {
      creatingRef.current = false
      setProvisionError(err instanceof Error ? err.message : WALLET_SETUP_ERROR_FALLBACK)
    })
  }, [createWallet])

  // Provisioning is a side effect, so it belongs in an effect, not render — the ref
  // guard additionally protects against StrictMode's dev-mode double-invoke.
  useEffect(() => {
    if (ready && authenticated && !stellarWallet && !creatingRef.current) {
      provisionWallet()
    }
  }, [ready, authenticated, stellarWallet, provisionWallet])

  // getAccessToken's identity isn't guaranteed stable across Privy re-renders;
  // routing calls through a ref means the memoized client below is only ever
  // built once, so React Query never sees a new client identity.
  const getAccessTokenRef = useRef(getAccessToken)
  getAccessTokenRef.current = getAccessToken
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const client = useMemo(() => createApiClient(API_BASE_URL, () => getAccessTokenRef.current()), [])

  const value: CoreValue = useMemo(
    () => ({
      client,
      signer: stellarWallet ? { signRawHash } : null,
      walletAddress: stellarWallet?.address ?? null,
    }),
    [client, signRawHash, stellarWallet],
  )

  if (!ready) {
    return (
      <div className="card centered">
        <p>Loading…</p>
      </div>
    )
  }

  if (!authenticated) {
    return (
      <div className="card centered">
        <h1>Paltalabs</h1>
        <button className="btn btn-primary" onClick={() => login()}>
          Log in
        </button>
      </div>
    )
  }

  if (!stellarWallet) {
    if (provisionError) {
      return (
        <div className="card centered">
          <p className="error">{provisionError}</p>
          <button className="btn btn-primary" onClick={provisionWallet}>
            Try again
          </button>
        </div>
      )
    }
    return (
      <div className="card centered">
        <p>Setting up your wallet…</p>
      </div>
    )
  }

  return <CoreProvider value={value}>{children}</CoreProvider>
}
