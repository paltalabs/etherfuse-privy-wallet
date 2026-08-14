import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '../client'
import { CoreProvider } from '../context'
import type { RawHashSigner } from '../signing'
import { useProvision, useWallet } from './wallet'

function makeWrapper(client: ApiClient, signer: RawHashSigner | null, walletAddress: string | null) {
  const queryClient = new QueryClient()
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <CoreProvider value={{ client, signer, walletAddress }}>{children}</CoreProvider>
      </QueryClientProvider>
    )
  }
}

describe('useProvision', () => {
  it('signs the pending intent branch and resolves with its txHash', async () => {
    const signRawHash = vi.fn().mockResolvedValue({ signature: '0xsig' })
    const post = vi
      .fn()
      .mockResolvedValueOnce({ intentId: 'intent-1', xdr: 'xdr', hashHex: '0xhash' })
      .mockResolvedValueOnce({ txHash: 'tx-1' })
    const client = { get: vi.fn(), post } as unknown as ApiClient
    const wrapper = makeWrapper(client, { signRawHash }, 'GADDR')

    const { result } = renderHook(() => useProvision(), { wrapper })
    result.current.mutate()

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(signRawHash).toHaveBeenCalledWith({ address: 'GADDR', chainType: 'stellar', hash: '0xhash' })
    expect(post).toHaveBeenNthCalledWith(2, '/intents/intent-1/complete', expect.anything(), { signature: '0xsig' })
    expect(result.current.data).toEqual({ txHash: 'tx-1' })
  })

  it('skips signing on the already-provisioned branch', async () => {
    const signRawHash = vi.fn()
    const post = vi.fn().mockResolvedValueOnce({ provisioned: true, stellarAddress: 'GADDR' })
    const client = { get: vi.fn(), post } as unknown as ApiClient
    const wrapper = makeWrapper(client, { signRawHash }, 'GADDR')

    const { result } = renderHook(() => useProvision(), { wrapper })
    result.current.mutate()

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(signRawHash).not.toHaveBeenCalled()
    expect(result.current.data).toEqual({ alreadyProvisioned: true })
  })

  it('invalidates the wallet query on success, triggering a refetch', async () => {
    const signRawHash = vi.fn().mockResolvedValue({ signature: '0xsig' })
    const get = vi.fn().mockResolvedValue({ stellarAddress: 'GADDR', provisioned: true, balances: [] })
    const post = vi.fn().mockResolvedValueOnce({ provisioned: true, stellarAddress: 'GADDR' })
    const client = { get, post } as unknown as ApiClient
    const wrapper = makeWrapper(client, { signRawHash }, 'GADDR')

    const { result } = renderHook(() => ({ wallet: useWallet(), provision: useProvision() }), { wrapper })

    await waitFor(() => expect(result.current.wallet.isSuccess).toBe(true))
    expect(get).toHaveBeenCalledTimes(1)

    result.current.provision.mutate()

    await waitFor(() => expect(result.current.provision.isSuccess).toBe(true))
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2))
  })
})
