import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { useActivity } from './activity'
import type { ApiClient } from '../client'
import { ApiError } from '../client'
import { CoreProvider } from '../context'
import type { RawHashSigner } from '../signing'
import { useVaultDeposit, useVaultPosition, useVaultWithdraw } from './vault'
import { useWallet } from './wallet'

function makeWrapper(client: ApiClient, signer: RawHashSigner | null = null, walletAddress: string | null = null) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <CoreProvider value={{ client, signer, walletAddress }}>{children}</CoreProvider>
      </QueryClientProvider>
    )
  }
}

const positionResponse = {
  shares: '10.0000000',
  underlyingBalance: '10.5000000',
  assetCode: 'USDC',
  assetIssuer: 'GISSUER',
}

describe('useVaultPosition', () => {
  it('queries GET /vault/position under the ["vault","position"] key and parses the position response', async () => {
    const get = vi.fn().mockResolvedValue(positionResponse)
    const client = { get, post: vi.fn() } as unknown as ApiClient
    const wrapper = makeWrapper(client)

    const { result } = renderHook(() => useVaultPosition(), { wrapper })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(get).toHaveBeenCalledWith('/vault/position', expect.anything())
    expect(result.current.data).toEqual(positionResponse)
  })
})

describe('useVaultDeposit', () => {
  it('signs the returned intent hashHex verbatim, completes it, and resolves the txHash', async () => {
    const signRawHash = vi.fn().mockResolvedValue({ signature: '0xsig' })
    const post = vi
      .fn()
      .mockResolvedValueOnce({ intentId: 'intent-deposit-1', xdr: 'xdr', hashHex: '0xhash' })
      .mockResolvedValueOnce({ txHash: 'tx-deposit-1' })
    const client = { get: vi.fn(), post } as unknown as ApiClient
    const wrapper = makeWrapper(client, { signRawHash }, 'GADDR')

    const { result } = renderHook(() => useVaultDeposit(), { wrapper })
    result.current.mutate({ amount: '10.0000000' })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(post).toHaveBeenNthCalledWith(1, '/vault/deposit', expect.anything(), { amount: '10.0000000' })
    expect(signRawHash).toHaveBeenCalledWith({ address: 'GADDR', chainType: 'stellar', hash: '0xhash' })
    expect(post).toHaveBeenNthCalledWith(2, '/intents/intent-deposit-1/complete', expect.anything(), {
      signature: '0xsig',
    })
    expect(result.current.data).toEqual({ txHash: 'tx-deposit-1' })
  })

  it('invalidates the ["vault","position"], ["wallet"], and ["activity"] queries on success', async () => {
    const signRawHash = vi.fn().mockResolvedValue({ signature: '0xsig' })
    const get = vi.fn().mockImplementation((path: string) => {
      if (path === '/wallet') return Promise.resolve({ stellarAddress: 'GADDR', provisioned: true, balances: [] })
      if (path === '/vault/position') return Promise.resolve(positionResponse)
      return Promise.resolve({ items: [], nextBefore: null })
    })
    const post = vi
      .fn()
      .mockResolvedValueOnce({ intentId: 'intent-deposit-1', xdr: 'xdr', hashHex: '0xhash' })
      .mockResolvedValueOnce({ txHash: 'tx-deposit-1' })
    const client = { get, post } as unknown as ApiClient
    const wrapper = makeWrapper(client, { signRawHash }, 'GADDR')

    const { result } = renderHook(
      () => ({
        wallet: useWallet(),
        activity: useActivity(),
        position: useVaultPosition(),
        deposit: useVaultDeposit(),
      }),
      { wrapper },
    )

    await waitFor(() => expect(result.current.wallet.isSuccess).toBe(true))
    await waitFor(() => expect(result.current.activity.isSuccess).toBe(true))
    await waitFor(() => expect(result.current.position.isSuccess).toBe(true))
    expect(get).toHaveBeenCalledTimes(3)

    result.current.deposit.mutate({ amount: '10.0000000' })

    await waitFor(() => expect(result.current.deposit.isSuccess).toBe(true))
    await waitFor(() => expect(get).toHaveBeenCalledTimes(6))
  })

  it('surfaces a 502 simulation_failed ApiError from the vault outage rather than swallowing it', async () => {
    const signRawHash = vi.fn()
    const post = vi.fn().mockRejectedValueOnce(new ApiError(502, 'simulation_failed'))
    const client = { get: vi.fn(), post } as unknown as ApiClient
    const wrapper = makeWrapper(client, { signRawHash }, 'GADDR')

    const { result } = renderHook(() => useVaultDeposit(), { wrapper })
    result.current.mutate({ amount: '10.0000000' })

    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error).toBeInstanceOf(ApiError)
    expect((result.current.error as ApiError).status).toBe(502)
    expect((result.current.error as ApiError).code).toBe('simulation_failed')
    expect(signRawHash).not.toHaveBeenCalled()
  })
})

describe('useVaultWithdraw', () => {
  it('signs the returned intent hashHex verbatim, completes it, and resolves the txHash', async () => {
    const signRawHash = vi.fn().mockResolvedValue({ signature: '0xsig' })
    const post = vi
      .fn()
      .mockResolvedValueOnce({ intentId: 'intent-withdraw-1', xdr: 'xdr', hashHex: '0xhash' })
      .mockResolvedValueOnce({ txHash: 'tx-withdraw-1' })
    const client = { get: vi.fn(), post } as unknown as ApiClient
    const wrapper = makeWrapper(client, { signRawHash }, 'GADDR')

    const { result } = renderHook(() => useVaultWithdraw(), { wrapper })
    result.current.mutate({ shares: '5.0000000' })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(post).toHaveBeenNthCalledWith(1, '/vault/withdraw', expect.anything(), { shares: '5.0000000' })
    expect(signRawHash).toHaveBeenCalledWith({ address: 'GADDR', chainType: 'stellar', hash: '0xhash' })
    expect(post).toHaveBeenNthCalledWith(2, '/intents/intent-withdraw-1/complete', expect.anything(), {
      signature: '0xsig',
    })
    expect(result.current.data).toEqual({ txHash: 'tx-withdraw-1' })
  })

  it('invalidates the ["vault","position"], ["wallet"], and ["activity"] queries on success', async () => {
    const signRawHash = vi.fn().mockResolvedValue({ signature: '0xsig' })
    const get = vi.fn().mockImplementation((path: string) => {
      if (path === '/wallet') return Promise.resolve({ stellarAddress: 'GADDR', provisioned: true, balances: [] })
      if (path === '/vault/position') return Promise.resolve(positionResponse)
      return Promise.resolve({ items: [], nextBefore: null })
    })
    const post = vi
      .fn()
      .mockResolvedValueOnce({ intentId: 'intent-withdraw-1', xdr: 'xdr', hashHex: '0xhash' })
      .mockResolvedValueOnce({ txHash: 'tx-withdraw-1' })
    const client = { get, post } as unknown as ApiClient
    const wrapper = makeWrapper(client, { signRawHash }, 'GADDR')

    const { result } = renderHook(
      () => ({
        wallet: useWallet(),
        activity: useActivity(),
        position: useVaultPosition(),
        withdraw: useVaultWithdraw(),
      }),
      { wrapper },
    )

    await waitFor(() => expect(result.current.wallet.isSuccess).toBe(true))
    await waitFor(() => expect(result.current.activity.isSuccess).toBe(true))
    await waitFor(() => expect(result.current.position.isSuccess).toBe(true))
    expect(get).toHaveBeenCalledTimes(3)

    result.current.withdraw.mutate({ shares: '5.0000000' })

    await waitFor(() => expect(result.current.withdraw.isSuccess).toBe(true))
    await waitFor(() => expect(get).toHaveBeenCalledTimes(6))
  })

  it('surfaces a 502 simulation_failed ApiError from the vault outage rather than swallowing it', async () => {
    const signRawHash = vi.fn()
    const post = vi.fn().mockRejectedValueOnce(new ApiError(502, 'simulation_failed'))
    const client = { get: vi.fn(), post } as unknown as ApiClient
    const wrapper = makeWrapper(client, { signRawHash }, 'GADDR')

    const { result } = renderHook(() => useVaultWithdraw(), { wrapper })
    result.current.mutate({ shares: '5.0000000' })

    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error).toBeInstanceOf(ApiError)
    expect((result.current.error as ApiError).status).toBe(502)
    expect((result.current.error as ApiError).code).toBe('simulation_failed')
    expect(signRawHash).not.toHaveBeenCalled()
  })
})
