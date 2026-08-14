import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, type ApiClient } from '../core/client'
import { CoreProvider } from '../core/context'
import { Dashboard } from './Dashboard'

// This project's vitest.config.ts doesn't set `test.globals: true`, so
// @testing-library/react's auto-cleanup (which checks for a *global*
// `afterEach`) never registers — each test's rendered DOM would otherwise
// leak into the next. Explicit here since several tests below render the
// same "10.50 USDC" text (app/src/components/QrCode.test.tsx's same gotcha).
afterEach(cleanup)

function renderDashboard(client: ApiClient) {
  // retry: false — without it, a rejected query retries with exponential
  // backoff before settling into isError, which blows past findByText's
  // default 1s timeout in the error-path tests below.
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <CoreProvider value={{ client, signer: null, walletAddress: 'GADDR' }}>{children}</CoreProvider>
      </QueryClientProvider>
    </MemoryRouter>
  )
  return render(<Dashboard />, { wrapper })
}

describe('Dashboard', () => {
  it('shows the activation card when GET /wallet 404s with merchant_not_found (never provisioned)', async () => {
    // GET /wallet throws this for a brand-new merchant who has never called
    // POST /wallet/provision (docs/modules/api-wallet.md's endpoint table) —
    // this is the true first-login state, not a generic error.
    const get = vi.fn().mockRejectedValue(new ApiError(404, 'merchant_not_found'))
    const client = { get, post: vi.fn() } as unknown as ApiClient

    renderDashboard(client)

    expect(await screen.findByRole('button', { name: 'Activate wallet' })).toBeDefined()
  })

  it('shows a generic error box for any other wallet-query failure', async () => {
    const get = vi.fn().mockRejectedValue(new ApiError(500, 'internal_error'))
    const client = { get, post: vi.fn() } as unknown as ApiClient

    renderDashboard(client)

    expect(await screen.findByText('internal_error')).toBeDefined()
  })

  it('shows the USDC balance and quick links once provisioned', async () => {
    // Path-aware: BalanceCard's EarningCard also mounts useVaultPosition(),
    // which hits the same fake `get` under /vault/position — give it a
    // shape distinct from /wallet's so a bug conflating the two responses
    // would fail loudly instead of silently reading undefined fields.
    const get = vi.fn().mockImplementation((path: string) => {
      if (path === '/wallet') {
        return Promise.resolve({
          stellarAddress: 'GADDR',
          provisioned: true,
          balances: [{ assetCode: 'USDC', assetIssuer: 'GISSUER', balance: '10.5000000' }],
        })
      }
      return Promise.resolve({ shares: '0', underlyingBalance: '0', assetCode: 'USDC', assetIssuer: 'GISSUER' })
    })
    const client = { get, post: vi.fn() } as unknown as ApiClient

    renderDashboard(client)

    expect(await screen.findByText('10.50 USDC')).toBeDefined()
    expect(screen.getByRole('link', { name: 'Send' }).getAttribute('href')).toBe('/send')
  })

  it("shows the vault position's underlying balance in the Earning card once it loads", async () => {
    const get = vi.fn().mockImplementation((path: string) => {
      if (path === '/wallet') {
        return Promise.resolve({
          stellarAddress: 'GADDR',
          provisioned: true,
          balances: [{ assetCode: 'USDC', assetIssuer: 'GISSUER', balance: '10.5000000' }],
        })
      }
      return Promise.resolve({ shares: '2.0000000', underlyingBalance: '2.2500000', assetCode: 'USDC', assetIssuer: 'GISSUER' })
    })
    const client = { get, post: vi.fn() } as unknown as ApiClient

    renderDashboard(client)

    expect(await screen.findByText('2.25 USDC')).toBeDefined()
  })

  it('shows "—" in the Earning card when the vault position query fails, without breaking the rest of the Dashboard', async () => {
    const get = vi.fn().mockImplementation((path: string) => {
      if (path === '/wallet') {
        return Promise.resolve({
          stellarAddress: 'GADDR',
          provisioned: true,
          balances: [{ assetCode: 'USDC', assetIssuer: 'GISSUER', balance: '10.5000000' }],
        })
      }
      return Promise.reject(new ApiError(502, 'simulation_failed'))
    })
    const client = { get, post: vi.fn() } as unknown as ApiClient

    renderDashboard(client)

    // The USDC balance card and Send link render normally...
    expect(await screen.findByText('10.50 USDC')).toBeDefined()
    expect(screen.getByRole('link', { name: 'Send' }).getAttribute('href')).toBe('/send')
    // ...while the Earning card falls back to "—" instead of surfacing the vault outage.
    expect(await screen.findByText('—')).toBeDefined()
  })
})
