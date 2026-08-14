import {
  KycLaunchResponseSchema,
  PayinOrderResponseSchema,
  PayinOrderStateResponseSchema,
  PayoutIntentResponseSchema,
  RampOnboardingStatusSchema,
  RampQuoteResponseSchema,
  type OnboardingStartRequest,
  type PayinExecuteRequest,
  type PayinOrderStateResponse,
  type PayinQuoteRequest,
  type PayoutExecuteRequest,
  type PayoutQuoteRequest,
  type PixDetailsRequest,
  type RampOnboardingStatus,
} from '@paltalabs/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import { useCore } from '../context'
import { signAndComplete } from '../signing'

/** Shared poll cadence for both onboarding-status and payin-state background polling. */
const POLL_MS = 5000

/**
 * `useOnboardingStatus`'s `refetchInterval`: poll only while `verifying` —
 * the one status that can flip on its own, from a background provider event
 * (the merchant completing hosted KYC in another tab/window) rather than
 * from the user submitting something in THIS app. Exported as a pure
 * function so the polling rule is unit-testable without fake timers.
 */
export function onboardingRefetchInterval(data: RampOnboardingStatus | undefined): number | false {
  return data?.status === 'verifying' ? POLL_MS : false
}

/** Etherfuse's 4-state onboarding ladder (not_started/verifying/incomplete/ready). */
export function useOnboardingStatus() {
  const { client } = useCore()
  return useQuery({
    queryKey: ['ramp', 'onboarding'],
    queryFn: () => client.get('/ramp/onboarding', RampOnboardingStatusSchema),
    refetchInterval: (query) => onboardingRefetchInterval(query.state.data),
  })
}

/**
 * Starts Etherfuse onboarding: creates the org/customer and returns the
 * hosted KYC launch parameters. Invalidates onboarding status on success —
 * a freshly-created `ramp_customers` row flips `not_started` to `verifying`.
 */
export function useStartOnboarding() {
  const { client } = useCore()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (request: OnboardingStartRequest) =>
      client.post('/ramp/onboarding/start', KycLaunchResponseSchema, request),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['ramp', 'onboarding'] }),
  })
}

/**
 * Re-issues fresh hosted KYC launch parameters — re-entry after a
 * denied/abandoned `/idv` run, or a first launch requested from the
 * `verifying` screen after a reload lost the original launch response.
 * Doesn't itself change onboarding status, so no invalidation.
 */
export function useKycLaunch() {
  const { client } = useCore()
  return useMutation({
    mutationFn: (request: OnboardingStartRequest) =>
      client.post('/ramp/onboarding/kyc-launch', KycLaunchResponseSchema, request),
  })
}

/**
 * Submits the PIX bank-account + Stellar wallet registration step
 * (idempotent/resumable server-side, `docs/modules/api-ramp.md`'s Gotchas).
 * Invalidates onboarding status on success.
 */
export function useCompleteSetup() {
  const { client } = useCore()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (request: PixDetailsRequest) => client.post('/ramp/onboarding', RampOnboardingStatusSchema, request),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['ramp', 'onboarding'] }),
  })
}

/** Quotes a BRL→pix on-ramp deposit for a given BRL amount (integer cents). */
export function usePayinQuote() {
  const { client } = useCore()
  return useMutation({
    mutationFn: (request: PayinQuoteRequest) => client.post('/ramp/payin/quote', RampQuoteResponseSchema, request),
  })
}

/**
 * Executes a previously-quoted pix payin: `{quoteId, amountCents}`, where
 * `amountCents` is the SAME quote's own `receiverAmountCents` echoed back —
 * the server derives no settlement amount of its own
 * (`docs/modules/api-ramp.md`'s Gotchas). The server writes a pending
 * `on_ramp` activity row on success, so this invalidates `['activity']`
 * (mirrors `useSendPayment`'s invalidation) rather than `['ramp', 'onboarding']`.
 */
export function useCreatePayin() {
  const { client } = useCore()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (request: PayinExecuteRequest) => client.post('/ramp/payin', PayinOrderResponseSchema, request),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['activity'] }),
  })
}

/**
 * `usePayinState`'s `refetchInterval`: poll only while `created`/`funded` —
 * the only statuses that can still change without the user doing anything
 * else in this app (the provider confirming the pix transfer, or the
 * testnet-only simulator). Exported as a pure function so the polling rule
 * is unit-testable without fake timers.
 */
export function payinStateRefetchInterval(data: PayinOrderStateResponse | undefined): number | false {
  return data?.status === 'created' || data?.status === 'funded' ? POLL_MS : false
}

/** Polls a payin order's state (`created` → `funded` → `completed`/`failed`/…). */
export function usePayinState(orderId: string) {
  const { client } = useCore()
  return useQuery({
    queryKey: ['ramp', 'payin', orderId],
    queryFn: () => client.get(`/ramp/payin/${orderId}`, PayinOrderStateResponseSchema),
    refetchInterval: (query) => payinStateRefetchInterval(query.state.data),
  })
}

/**
 * Testnet-only sandbox deposit simulator (`POST
 * /ramp/payin/:orderId/simulate`, 404s outright on mainnet before any
 * lookup — `docs/modules/api-ramp.md`'s endpoint table). No request body, no
 * response body (`204`) — `z.void()` matches `createApiClient`'s 204
 * short-circuit (`core/client.ts`). Invalidates the polled payin state so
 * the UI reflects the simulated deposit without waiting for the next poll
 * tick.
 */
export function useSimulatePayin(orderId: string) {
  const { client } = useCore()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => client.post(`/ramp/payin/${orderId}/simulate`, z.void()),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['ramp', 'payin', orderId] }),
  })
}

/** Quotes a settlement-token→BRL Stellar off-ramp withdrawal for a given source-asset amount (integer cents). */
export function usePayoutQuote() {
  const { client } = useCore()
  return useMutation({
    mutationFn: (request: PayoutQuoteRequest) => client.post('/ramp/payout/quote', RampQuoteResponseSchema, request),
  })
}

/**
 * Executes a previously-quoted payout: `{quoteId, amountCents}`, where
 * `amountCents` is the SAME quote's own `senderAmountCents` (the
 * source-asset amount the merchant is sending) echoed back — the server
 * derives no settlement amount of its own, same rationale as
 * `useCreatePayin` (`docs/modules/api-ramp.md`'s Gotchas). `POST
 * /ramp/payout` creates the `'payout'`-kind signing intent, then
 * `signAndComplete` signs its `hashHex` with the merchant's Privy wallet and
 * completes it — same sign-then-complete convergence
 * `useProvision`/`useSendPayment` already use. `onSuccess` invalidates both
 * `['wallet']` (balance changed) and `['activity']` (the server writes a
 * pending `off_ramp` activity row on success).
 */
export function useCreatePayout() {
  const { client, signer, walletAddress } = useCore()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (request: PayoutExecuteRequest) => {
      const intent = await client.post('/ramp/payout', PayoutIntentResponseSchema, request)
      if (!signer || !walletAddress) throw new Error('wallet signer unavailable')
      return signAndComplete(client, signer, walletAddress, intent)
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['wallet'] })
      void qc.invalidateQueries({ queryKey: ['activity'] })
    },
  })
}
