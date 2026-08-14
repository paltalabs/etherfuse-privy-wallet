import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '../core/client'
import { CoreProvider } from '../core/context'
import { Layout } from './Layout'

const mockLogout = vi.fn()

// Layout's only Privy dependency is usePrivy()'s `logout`, so a minimal mock is enough —
// no PrivyProvider setup needed for this test.
vi.mock('@privy-io/react-auth', () => ({
  usePrivy: () => ({ logout: mockLogout }),
}))

afterEach(cleanup)

function renderLayout(queryClient: QueryClient) {
  const client = { get: vi.fn(), post: vi.fn() } as unknown as ApiClient
  return render(
    <MemoryRouter initialEntries={['/']}>
      <QueryClientProvider client={queryClient}>
        <CoreProvider value={{ client, signer: null, walletAddress: 'GADDR' }}>
          <Routes>
            <Route element={<Layout />}>
              <Route index element={<div>child route</div>} />
            </Route>
          </Routes>
        </CoreProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  )
}

describe('Layout', () => {
  it('clears the QueryClient cache on logout, before calling Privy logout', () => {
    mockLogout.mockClear()
    const queryClient = new QueryClient()
    // Stand in for a previous merchant's cached responses — every query key in this app
    // (['wallet'], ['activity'], ['ramp','onboarding'], ['vault','position']) is
    // user-agnostic, so this is exactly what a different merchant's next login would
    // otherwise see served synchronously on mount.
    queryClient.setQueryData(['wallet'], { stale: 'previous merchant data' })
    const clearSpy = vi.spyOn(queryClient, 'clear')

    renderLayout(queryClient)

    fireEvent.click(screen.getByRole('button', { name: 'Log out' }))

    expect(clearSpy).toHaveBeenCalledTimes(1)
    expect(queryClient.getQueryData(['wallet'])).toBeUndefined()
    expect(mockLogout).toHaveBeenCalledTimes(1)
  })
})
