import type { OnboardingStartRequest, PixDetailsRequest } from '@paltalabs/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '../client'
import { CoreProvider } from '../context'
import type { RawHashSigner } from '../signing'
import { useActivity } from './activity'
import {
  onboardingRefetchInterval,
  payinStateRefetchInterval,
  useCompleteSetup,
  useCreatePayin,
  useCreatePayout,
  useKycLaunch,
  useOnboardingStatus,
  usePayinQuote,
  usePayinState,
  usePayoutQuote,
  useSimulatePayin,
  useStartOnboarding,
} from './ramp'
import { useWallet } from './wallet'

function makeWrapper(client: ApiClient, signer: RawHashSigner | null = null, walletAddress: string | null = null) {
  const queryClient = new QueryClient()
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <CoreProvider value={{ client, signer, walletAddress }}>{children}</CoreProvider>
      </QueryClientProvider>
    )
  }
}

const startRequest: OnboardingStartRequest = { displayName: 'Ada Lovelace', email: 'ada@example.com' }

const launchResponse = {
  launch: {
    actionUrl: 'https://sandbox.etherfuse.com/auth/launch',
    assertion: 'eyJhbGciOiJSUzI1NiJ9.payload.signature',
    target: '/idv',
    returnUrl: 'https://app.paltalabs.io/ramp/kyc-return',
  },
}

describe('useOnboardingStatus', () => {
  it('queries GET /ramp/onboarding under the ["ramp","onboarding"] key and resolves the parsed status', async () => {
    const get = vi.fn().mockResolvedValue({ status: 'incomplete' })
    const client = { get, post: vi.fn() } as unknown as ApiClient
    const wrapper = makeWrapper(client)

    const { result } = renderHook(() => useOnboardingStatus(), { wrapper })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(get).toHaveBeenCalledWith('/ramp/onboarding', expect.anything())
    expect(result.current.data).toEqual({ status: 'incomplete' })
  })
})

describe('onboardingRefetchInterval', () => {
  it('polls every 5000ms while verifying', () => {
    expect(onboardingRefetchInterval({ status: 'verifying' })).toBe(5000)
  })

  it.each(['not_started', 'incomplete', 'ready'] as const)('does not poll while %s', (status) => {
    expect(onboardingRefetchInterval({ status })).toBe(false)
  })

  it('does not poll when no data has loaded yet', () => {
    expect(onboardingRefetchInterval(undefined)).toBe(false)
  })
})

describe('useStartOnboarding', () => {
  it('posts displayName/email to /ramp/onboarding/start and resolves the launch payload', async () => {
    const post = vi.fn().mockResolvedValueOnce(launchResponse)
    const client = { get: vi.fn(), post } as unknown as ApiClient
    const wrapper = makeWrapper(client)

    const { result } = renderHook(() => useStartOnboarding(), { wrapper })
    result.current.mutate(startRequest)

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(post).toHaveBeenCalledWith('/ramp/onboarding/start', expect.anything(), startRequest)
    expect(result.current.data).toEqual(launchResponse)
  })

  it('invalidates the ["ramp","onboarding"] query on success, triggering a refetch', async () => {
    const get = vi.fn().mockResolvedValue({ status: 'verifying' })
    const post = vi.fn().mockResolvedValueOnce(launchResponse)
    const client = { get, post } as unknown as ApiClient
    const wrapper = makeWrapper(client)

    const { result } = renderHook(() => ({ status: useOnboardingStatus(), start: useStartOnboarding() }), { wrapper })

    await waitFor(() => expect(result.current.status.isSuccess).toBe(true))
    expect(get).toHaveBeenCalledTimes(1)

    result.current.start.mutate(startRequest)

    await waitFor(() => expect(result.current.start.isSuccess).toBe(true))
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2))
  })
})

describe('useKycLaunch', () => {
  it('posts displayName/email to /ramp/onboarding/kyc-launch and resolves the launch payload', async () => {
    const post = vi.fn().mockResolvedValueOnce(launchResponse)
    const client = { get: vi.fn(), post } as unknown as ApiClient
    const wrapper = makeWrapper(client)

    const { result } = renderHook(() => useKycLaunch(), { wrapper })
    result.current.mutate(startRequest)

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(post).toHaveBeenCalledWith('/ramp/onboarding/kyc-launch', expect.anything(), startRequest)
    expect(result.current.data).toEqual(launchResponse)
  })
})

const pixDetails: PixDetailsRequest = {
  firstName: 'Ada',
  lastName: 'Lovelace',
  cpf: '12345678909',
  pixKey: 'ada@example.com',
  pixKeyType: 'email',
}

describe('useCompleteSetup', () => {
  it('posts the pix details to /ramp/onboarding and resolves the new status', async () => {
    const post = vi.fn().mockResolvedValueOnce({ status: 'ready' })
    const client = { get: vi.fn(), post } as unknown as ApiClient
    const wrapper = makeWrapper(client)

    const { result } = renderHook(() => useCompleteSetup(), { wrapper })
    result.current.mutate(pixDetails)

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(post).toHaveBeenCalledWith('/ramp/onboarding', expect.anything(), pixDetails)
    expect(result.current.data).toEqual({ status: 'ready' })
  })

  it('invalidates the ["ramp","onboarding"] query on success, triggering a refetch', async () => {
    const get = vi.fn().mockResolvedValue({ status: 'ready' })
    const post = vi.fn().mockResolvedValueOnce({ status: 'ready' })
    const client = { get, post } as unknown as ApiClient
    const wrapper = makeWrapper(client)

    const { result } = renderHook(() => ({ status: useOnboardingStatus(), complete: useCompleteSetup() }), { wrapper })

    await waitFor(() => expect(result.current.status.isSuccess).toBe(true))
    expect(get).toHaveBeenCalledTimes(1)

    result.current.complete.mutate(pixDetails)

    await waitFor(() => expect(result.current.complete.isSuccess).toBe(true))
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2))
  })
})

const quoteResponse = {
  quoteId: 'quote_test',
  expiresAt: 1_800_000_000_000,
  senderAmountCents: 10000,
  receiverAmountCents: 9800,
  flatFeeCents: 200,
  commercialQuotation: 5.25,
}

describe('usePayinQuote', () => {
  it('posts the BRL amount to /ramp/payin/quote and resolves the quote', async () => {
    const post = vi.fn().mockResolvedValueOnce(quoteResponse)
    const client = { get: vi.fn(), post } as unknown as ApiClient
    const wrapper = makeWrapper(client)

    const { result } = renderHook(() => usePayinQuote(), { wrapper })
    result.current.mutate({ amountBrlCents: 10000 })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(post).toHaveBeenCalledWith('/ramp/payin/quote', expect.anything(), { amountBrlCents: 10000 })
    expect(result.current.data).toEqual(quoteResponse)
  })
})

const payinOrderResponse = {
  orderId: 'order-1',
  status: 'created',
  deposit: { depositAmount: '100', depositBankName: 'PIX', depositAccountHolder: 'Etherfuse' },
  receiverAmountCents: 9800,
}

describe('useCreatePayin', () => {
  it('posts {quoteId, amountCents} (the quote receiverAmountCents echoed back) to /ramp/payin and resolves the order', async () => {
    const post = vi.fn().mockResolvedValueOnce(payinOrderResponse)
    const client = { get: vi.fn(), post } as unknown as ApiClient
    const wrapper = makeWrapper(client)

    const { result } = renderHook(() => useCreatePayin(), { wrapper })
    result.current.mutate({ quoteId: 'quote_test', amountCents: 9800 })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(post).toHaveBeenCalledWith('/ramp/payin', expect.anything(), { quoteId: 'quote_test', amountCents: 9800 })
    expect(result.current.data).toEqual(payinOrderResponse)
  })

  it('invalidates the ["activity"] query on success, triggering a refetch', async () => {
    const get = vi.fn().mockResolvedValue({ items: [], nextBefore: null })
    const post = vi.fn().mockResolvedValueOnce(payinOrderResponse)
    const client = { get, post } as unknown as ApiClient
    const wrapper = makeWrapper(client)

    const { result } = renderHook(() => ({ activity: useActivity(), createPayin: useCreatePayin() }), { wrapper })

    await waitFor(() => expect(result.current.activity.isSuccess).toBe(true))
    expect(get).toHaveBeenCalledTimes(1)

    result.current.createPayin.mutate({ quoteId: 'quote_test', amountCents: 9800 })

    await waitFor(() => expect(result.current.createPayin.isSuccess).toBe(true))
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2))
  })
})

describe('usePayinState', () => {
  it('queries GET /ramp/payin/:orderId under the ["ramp","payin",orderId] key and resolves the parsed state', async () => {
    const get = vi.fn().mockResolvedValue({ orderId: 'order-1', status: 'funded', txHash: null })
    const client = { get, post: vi.fn() } as unknown as ApiClient
    const wrapper = makeWrapper(client)

    const { result } = renderHook(() => usePayinState('order-1'), { wrapper })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(get).toHaveBeenCalledWith('/ramp/payin/order-1', expect.anything())
    expect(result.current.data).toEqual({ orderId: 'order-1', status: 'funded', txHash: null })
  })
})

describe('payinStateRefetchInterval', () => {
  it.each(['created', 'funded'] as const)('polls every 5000ms while %s', (status) => {
    expect(payinStateRefetchInterval({ orderId: 'o', status, txHash: null })).toBe(5000)
  })

  it.each(['completed', 'finalized', 'failed', 'refunded', 'canceled'] as const)('does not poll once %s', (status) => {
    expect(payinStateRefetchInterval({ orderId: 'o', status, txHash: null })).toBe(false)
  })

  it('does not poll when no data has loaded yet', () => {
    expect(payinStateRefetchInterval(undefined)).toBe(false)
  })
})

describe('useSimulatePayin', () => {
  it('posts to /ramp/payin/:orderId/simulate with no body', async () => {
    const post = vi.fn().mockResolvedValueOnce(undefined)
    const client = { get: vi.fn(), post } as unknown as ApiClient
    const wrapper = makeWrapper(client)

    const { result } = renderHook(() => useSimulatePayin('order-1'), { wrapper })
    result.current.mutate()

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(post).toHaveBeenCalledWith('/ramp/payin/order-1/simulate', expect.anything())
    expect(post.mock.calls[0]).toHaveLength(2) // no body argument passed through
  })

  it('invalidates the ["ramp","payin",orderId] query on success, triggering a refetch', async () => {
    const get = vi.fn().mockResolvedValue({ orderId: 'order-1', status: 'funded', txHash: null })
    const post = vi.fn().mockResolvedValueOnce(undefined)
    const client = { get, post } as unknown as ApiClient
    const wrapper = makeWrapper(client)

    const { result } = renderHook(() => ({ state: usePayinState('order-1'), simulate: useSimulatePayin('order-1') }), {
      wrapper,
    })

    await waitFor(() => expect(result.current.state.isSuccess).toBe(true))
    expect(get).toHaveBeenCalledTimes(1)

    result.current.simulate.mutate()

    await waitFor(() => expect(result.current.simulate.isSuccess).toBe(true))
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2))
  })
})

const payoutQuoteResponse = {
  quoteId: 'payout_quote_test',
  expiresAt: 1_800_000_000_000,
  senderAmountCents: 10000,
  receiverAmountCents: 9800,
  flatFeeCents: 200,
  commercialQuotation: 5.25,
}

describe('usePayoutQuote', () => {
  it('posts the source-asset amount to /ramp/payout/quote and resolves the quote', async () => {
    const post = vi.fn().mockResolvedValueOnce(payoutQuoteResponse)
    const client = { get: vi.fn(), post } as unknown as ApiClient
    const wrapper = makeWrapper(client)

    const { result } = renderHook(() => usePayoutQuote(), { wrapper })
    result.current.mutate({ amountCents: 10000 })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(post).toHaveBeenCalledWith('/ramp/payout/quote', expect.anything(), { amountCents: 10000 })
    expect(result.current.data).toEqual(payoutQuoteResponse)
  })
})

describe('useCreatePayout', () => {
  it('posts {quoteId, amountCents} (the quote senderAmountCents echoed back), signs the returned hashHex, completes it, and resolves the txHash', async () => {
    const signRawHash = vi.fn().mockResolvedValue({ signature: '0xsig' })
    const post = vi
      .fn()
      .mockResolvedValueOnce({ intentId: 'intent-payout-1', xdr: 'xdr', hashHex: '0xhash' })
      .mockResolvedValueOnce({ txHash: 'tx-payout-1' })
    const client = { get: vi.fn(), post } as unknown as ApiClient
    const wrapper = makeWrapper(client, { signRawHash }, 'GADDR')

    const { result } = renderHook(() => useCreatePayout(), { wrapper })
    result.current.mutate({ quoteId: 'quote_test', amountCents: 10000 })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(post).toHaveBeenNthCalledWith(1, '/ramp/payout', expect.anything(), { quoteId: 'quote_test', amountCents: 10000 })
    expect(signRawHash).toHaveBeenCalledWith({ address: 'GADDR', chainType: 'stellar', hash: '0xhash' })
    expect(post).toHaveBeenNthCalledWith(2, '/intents/intent-payout-1/complete', expect.anything(), {
      signature: '0xsig',
    })
    expect(result.current.data).toEqual({ txHash: 'tx-payout-1' })
  })

  it('invalidates the ["wallet"] and ["activity"] queries on success, triggering refetches', async () => {
    const signRawHash = vi.fn().mockResolvedValue({ signature: '0xsig' })
    const get = vi.fn().mockImplementation((path: string) =>
      path === '/wallet'
        ? Promise.resolve({ stellarAddress: 'GADDR', provisioned: true, balances: [] })
        : Promise.resolve({ items: [], nextBefore: null }),
    )
    const post = vi
      .fn()
      .mockResolvedValueOnce({ intentId: 'intent-payout-1', xdr: 'xdr', hashHex: '0xhash' })
      .mockResolvedValueOnce({ txHash: 'tx-payout-1' })
    const client = { get, post } as unknown as ApiClient
    const wrapper = makeWrapper(client, { signRawHash }, 'GADDR')

    const { result } = renderHook(
      () => ({ wallet: useWallet(), activity: useActivity(), createPayout: useCreatePayout() }),
      { wrapper },
    )

    await waitFor(() => expect(result.current.wallet.isSuccess).toBe(true))
    await waitFor(() => expect(result.current.activity.isSuccess).toBe(true))
    expect(get).toHaveBeenCalledTimes(2)

    result.current.createPayout.mutate({ quoteId: 'quote_test', amountCents: 10000 })

    await waitFor(() => expect(result.current.createPayout.isSuccess).toBe(true))
    await waitFor(() => expect(get).toHaveBeenCalledTimes(4))
  })
})
