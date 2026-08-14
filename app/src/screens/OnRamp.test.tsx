import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '../core/client'
import { CoreProvider } from '../core/context'
import { useWallet } from '../core/hooks/wallet'
import { OnRamp } from './OnRamp'

// OnRamp's only Privy dependency is usePrivy()'s `user` (to prefill the
// verifying-state relaunch form's email). Mutable so each test can set it
// before rendering — see app/src/components/Layout.test.tsx for the same
// minimal-mock pattern.
let mockPrivyUser: { email?: { address: string } } | null = null
vi.mock('@privy-io/react-auth', () => ({
  usePrivy: () => ({ user: mockPrivyUser }),
}))

afterEach(() => {
  cleanup()
  mockPrivyUser = null
})

function renderOnRamp(client: ApiClient) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <CoreProvider value={{ client, signer: null, walletAddress: 'GADDR' }}>{children}</CoreProvider>
      </QueryClientProvider>
    </MemoryRouter>
  )
  return render(<OnRamp />, { wrapper })
}

const launchResponse = {
  launch: {
    actionUrl: 'https://sandbox.etherfuse.com/auth/launch',
    assertion: 'eyJhbGciOiJSUzI1NiJ9.payload.signature',
    target: '/idv',
    returnUrl: 'https://app.paltalabs.io/ramp/kyc-return',
  },
}

describe('OnRamp — not_started', () => {
  it('submits the start form and shows a click-triggered launch button pointing at the returned actionUrl', async () => {
    const get = vi.fn().mockResolvedValue({ status: 'not_started' })
    const post = vi.fn().mockResolvedValueOnce(launchResponse)
    const client = { get, post } as unknown as ApiClient

    const { container } = renderOnRamp(client)

    fireEvent.change(await screen.findByLabelText('Your name'), { target: { value: 'Ada Lovelace' } })
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'ada@example.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Get started' }))

    // Mutations resolve asynchronously through React Query's internal
    // retryer — await the resulting UI change before inspecting the spy.
    expect(await screen.findByRole('button', { name: 'Continue to verification' })).toBeDefined()
    expect(post).toHaveBeenCalledWith('/ramp/onboarding/start', expect.anything(), {
      displayName: 'Ada Lovelace',
      email: 'ada@example.com',
    })
    const hiddenForm = container.querySelector('form[action]')
    expect(hiddenForm?.getAttribute('action')).toBe(launchResponse.launch.actionUrl)
    // The launch form is never auto-submitted — target="_blank" popups require a real click.
    expect(hiddenForm?.hasAttribute('hidden')).toBe(true)
  })
})

describe('OnRamp — verifying', () => {
  it('asks for a name (never inventing one) when no Privy email/recent form data is known, then relaunches on click', async () => {
    mockPrivyUser = null
    const get = vi.fn().mockResolvedValue({ status: 'verifying' })
    const post = vi.fn().mockResolvedValueOnce(launchResponse)
    const client = { get, post } as unknown as ApiClient

    renderOnRamp(client)

    expect(await screen.findByLabelText('Your name')).toBeDefined()
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Ada Lovelace' } })
    fireEvent.click(screen.getByRole('button', { name: 'Relaunch verification' }))

    expect(await screen.findByRole('button', { name: 'Open verification' })).toBeDefined()
    expect(post).toHaveBeenCalledWith('/ramp/onboarding/kyc-launch', expect.anything(), {
      displayName: 'Ada Lovelace',
      email: '',
    })
  })

  it('keeps the relaunch name field mounted across keystrokes instead of unmounting after the first character', async () => {
    mockPrivyUser = null
    const get = vi.fn().mockResolvedValue({ status: 'verifying' })
    const post = vi.fn()
    const client = { get, post } as unknown as ApiClient

    renderOnRamp(client)

    expect(await screen.findByLabelText('Your name')).toBeDefined()
    // Per-keystroke, like a real user typing — re-querying via
    // `screen.getByLabelText` (not a cached node reference) each time, so a
    // regression where the field unmounts mid-typing (`needsName` gating its
    // own visibility on the state it writes) fails loudly here instead of
    // silently no-oping on a detached node.
    for (const partial of ['A', 'Ad', 'Ada']) {
      fireEvent.change(screen.getByLabelText('Your name'), { target: { value: partial } })
    }

    expect(screen.getByLabelText('Your name')).toHaveProperty('value', 'Ada')
  })

  it('prefills the relaunch form from the Privy email when no name is known', async () => {
    mockPrivyUser = { email: { address: 'privy@example.com' } }
    const get = vi.fn().mockResolvedValue({ status: 'verifying' })
    const client = { get, post: vi.fn() } as unknown as ApiClient

    renderOnRamp(client)

    expect(await screen.findByLabelText('Email')).toHaveProperty('value', 'privy@example.com')
  })
})

describe('OnRamp — incomplete', () => {
  it('submits the pix details form to POST /ramp/onboarding', async () => {
    const get = vi.fn().mockResolvedValue({ status: 'incomplete' })
    const post = vi.fn().mockResolvedValueOnce({ status: 'ready' })
    const client = { get, post } as unknown as ApiClient

    renderOnRamp(client)

    fireEvent.change(await screen.findByLabelText('First name'), { target: { value: 'Ana' } })
    fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Souza' } })
    fireEvent.change(screen.getByLabelText('CPF'), { target: { value: '12345678909' } })
    fireEvent.change(screen.getByLabelText('Pix key'), { target: { value: 'ana@example.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Submit details' }))

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/ramp/onboarding', expect.anything(), {
        firstName: 'Ana',
        lastName: 'Souza',
        cpf: '12345678909',
        pixKey: 'ana@example.com',
        pixKeyType: 'email',
      }),
    )
  })
})

describe('OnRamp — ready', () => {
  it('quotes, confirms (echoing the quote receiverAmountCents), and shows the deposit panel with status + testnet simulate button', async () => {
    const quoteResponse = {
      quoteId: 'quote_test',
      expiresAt: Date.now() + 120_000,
      senderAmountCents: 10000,
      receiverAmountCents: 1962,
      flatFeeCents: 200,
      commercialQuotation: 5.25,
    }
    const payinOrderResponse = {
      orderId: 'order-1',
      status: 'created',
      deposit: { depositAmount: '100', depositBankName: 'PIX', depositAccountHolder: 'Etherfuse' },
      receiverAmountCents: 1962,
    }
    const get = vi.fn().mockImplementation((path: string) => {
      if (path === '/ramp/onboarding') return Promise.resolve({ status: 'ready' })
      return Promise.resolve({ orderId: 'order-1', status: 'created', txHash: null })
    })
    const post = vi.fn().mockImplementation((path: string) => {
      if (path === '/ramp/payin/quote') return Promise.resolve(quoteResponse)
      if (path === '/ramp/payin') return Promise.resolve(payinOrderResponse)
      throw new Error(`unexpected post ${path}`)
    })
    const client = { get, post } as unknown as ApiClient

    renderOnRamp(client)

    fireEvent.change(await screen.findByLabelText('Amount (BRL)'), { target: { value: '100' } })
    fireEvent.click(screen.getByRole('button', { name: 'Get quote' }))

    expect(await screen.findByRole('button', { name: 'Confirm deposit' })).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm deposit' }))

    expect(await screen.findByText('100 BRL')).toBeDefined()
    expect(post).toHaveBeenCalledWith('/ramp/payin', expect.anything(), {
      quoteId: 'quote_test',
      amountCents: 1962, // the quote's own receiverAmountCents, echoed back
    })
    expect(screen.getByText('created')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Simulate deposit (testnet)' })).toBeDefined()
  })

  it('invalidates the wallet balance once the polled payin status reaches completed', async () => {
    const quoteResponse = {
      quoteId: 'quote_test',
      expiresAt: Date.now() + 120_000,
      senderAmountCents: 10000,
      receiverAmountCents: 1962,
      flatFeeCents: 200,
      commercialQuotation: 5.25,
    }
    const payinOrderResponse = {
      orderId: 'order-1',
      status: 'created',
      deposit: { depositAmount: '100', depositBankName: 'PIX', depositAccountHolder: 'Etherfuse' },
      receiverAmountCents: 1962,
    }
    const get = vi.fn().mockImplementation((path: string) => {
      if (path === '/ramp/onboarding') return Promise.resolve({ status: 'ready' })
      if (path === '/wallet') return Promise.resolve({ stellarAddress: 'GADDR', provisioned: true, balances: [] })
      // usePayinState — already completed on the very first poll.
      return Promise.resolve({ orderId: 'order-1', status: 'completed', txHash: 'tx-1' })
    })
    const post = vi.fn().mockImplementation((path: string) => {
      if (path === '/ramp/payin/quote') return Promise.resolve(quoteResponse)
      if (path === '/ramp/payin') return Promise.resolve(payinOrderResponse)
      throw new Error(`unexpected post ${path}`)
    })
    const client = { get, post } as unknown as ApiClient

    function WalletProbe() {
      useWallet()
      return null
    }
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <CoreProvider value={{ client, signer: null, walletAddress: 'GADDR' }}>
            <WalletProbe />
            <OnRamp />
          </CoreProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    )

    fireEvent.change(await screen.findByLabelText('Amount (BRL)'), { target: { value: '100' } })
    fireEvent.click(screen.getByRole('button', { name: 'Get quote' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm deposit' }))

    await screen.findByText('Deposit confirmed — your balance has been updated.')
    await waitFor(() => expect(get.mock.calls.filter(([path]) => path === '/wallet')).toHaveLength(2))
  })
})
