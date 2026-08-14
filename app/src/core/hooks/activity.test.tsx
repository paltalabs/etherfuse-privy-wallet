import type { ActivityItem } from '@paltalabs/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '../client'
import { CoreProvider } from '../context'
import { useActivity } from './activity'

function makeWrapper(client: ApiClient) {
  const queryClient = new QueryClient()
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <CoreProvider value={{ client, signer: null, walletAddress: null }}>{children}</CoreProvider>
      </QueryClientProvider>
    )
  }
}

const itemOne: ActivityItem = {
  id: 'act-1',
  type: 'send',
  direction: 'out',
  amount: '10.0000000',
  assetCode: 'USDC',
  assetIssuer: 'GISSUER',
  counterparty: 'GDEST',
  status: 'confirmed',
  txHash: 'tx-1',
  createdAt: '2026-07-20T00:00:00.000Z',
}

const itemTwo: ActivityItem = {
  id: 'act-2',
  type: 'provision',
  direction: null,
  amount: null,
  assetCode: null,
  assetIssuer: null,
  counterparty: null,
  status: 'confirmed',
  txHash: null,
  createdAt: '2026-07-19T00:00:00.000Z',
}

describe('useActivity', () => {
  it('stitches two pages together and stops paging once nextBefore is null', async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({ items: [itemOne], nextBefore: itemOne.createdAt })
      .mockResolvedValueOnce({ items: [itemTwo], nextBefore: null })
    const client = { get, post: vi.fn() } as unknown as ApiClient
    const wrapper = makeWrapper(client)

    const { result } = renderHook(() => useActivity(), { wrapper })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(get).toHaveBeenNthCalledWith(1, '/activity', expect.anything())
    expect(result.current.hasNextPage).toBe(true)

    result.current.fetchNextPage()

    await waitFor(() => expect(result.current.data?.pages.length).toBe(2))
    expect(get).toHaveBeenNthCalledWith(2, `/activity?before=${encodeURIComponent(itemOne.createdAt)}`, expect.anything())
    expect(result.current.hasNextPage).toBe(false)
    expect(result.current.data?.pages.flatMap((page) => page.items.map((item) => item.id))).toEqual([
      itemOne.id,
      itemTwo.id,
    ])
  })
})
