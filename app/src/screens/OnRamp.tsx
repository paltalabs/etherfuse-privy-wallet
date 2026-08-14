import { PixDetailsRequestSchema, type KycLaunchResponse, type PayinOrderResponse, type PixDetailsRequest } from '@paltalabs/shared'
import { usePrivy } from '@privy-io/react-auth'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState, type FormEvent, type RefObject } from 'react'
import { Link } from 'react-router'
import { ApiError } from '../core/client'
import { centsToDecimal } from '../core/format'
import {
  useCompleteSetup,
  useCreatePayin,
  useKycLaunch,
  useOnboardingStatus,
  usePayinQuote,
  usePayinState,
  useSimulatePayin,
  useStartOnboarding,
} from '../core/hooks/ramp'
import { ASSET_CODE, STELLAR_NETWORK } from '../network'

/** The hosted `/idv` launch form's `grant_type` field — fixed by Etherfuse's own contract, never derived. */
const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:jwt-bearer'

const PIX_KEY_TYPES = PixDetailsRequestSchema.shape.pixKeyType.options

function errorCode(error: unknown): string {
  return error instanceof ApiError ? error.code : 'unknown_error'
}

/**
 * The hidden browser form-POST that actually launches Etherfuse's hosted KYC
 * flow (`docs/evidence/etherfuse-sandbox-findings.md`'s "## Launch JWT"
 * section: `grant_type`/`assertion`/`target`/`return_url` fields, values
 * verbatim from `KycLaunchResponse.launch`). Rendered hidden and submitted
 * via `formRef.current?.submit()` from a click handler ONLY — never from an
 * effect reacting to `launch` arriving, since a `target="_blank"` submission
 * must originate from a synchronous user gesture or popup blockers eat it.
 */
function KycLaunchHiddenForm({
  launch,
  formRef,
}: {
  launch: KycLaunchResponse['launch']
  formRef: RefObject<HTMLFormElement | null>
}) {
  return (
    <form ref={formRef} method="POST" action={launch.actionUrl} target="_blank" hidden>
      <input type="hidden" name="grant_type" value={GRANT_TYPE} readOnly />
      <input type="hidden" name="assertion" value={launch.assertion} readOnly />
      <input type="hidden" name="target" value={launch.target} readOnly />
      <input type="hidden" name="return_url" value={launch.returnUrl} readOnly />
    </form>
  )
}

/** `not_started`: a mini displayName/email form that creates the Etherfuse org and returns launch params in one call. */
function NotStartedCard({
  defaultEmail,
  onStarted,
}: {
  defaultEmail: string
  onStarted: (fields: { displayName: string; email: string }) => void
}) {
  const startOnboarding = useStartOnboarding()
  const [displayName, setDisplayName] = useState('')
  const [email, setEmail] = useState(defaultEmail)
  const [validationError, setValidationError] = useState<string | null>(null)
  const formRef = useRef<HTMLFormElement>(null)

  if (startOnboarding.data) {
    const { launch } = startOnboarding.data
    return (
      <div className="card centered">
        <h1>Account created</h1>
        <p className="muted">Continue to identity verification in the window that opens.</p>
        <KycLaunchHiddenForm launch={launch} formRef={formRef} />
        <button className="btn btn-primary" onClick={() => formRef.current?.submit()}>
          Continue to verification
        </button>
      </div>
    )
  }

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setValidationError(null)
    const fields = { displayName, email }
    startOnboarding.mutate(fields, { onSuccess: () => onStarted(fields) })
  }

  return (
    <form className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }} onSubmit={handleSubmit}>
      <h1>Set up deposits</h1>
      <p className="muted">We'll create your onboarding profile, then take you to identity verification.</p>
      <div className="field">
        <label htmlFor="displayName">Your name</label>
        <input id="displayName" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="email">Email</label>
        <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      {validationError && <p className="error">{validationError}</p>}
      {startOnboarding.isError && <p className="error">{errorCode(startOnboarding.error)}</p>}
      <button className="btn btn-primary" type="submit" disabled={startOnboarding.isPending}>
        {startOnboarding.isPending ? 'Starting…' : 'Get started'}
      </button>
    </form>
  )
}

/**
 * `verifying`: a two-step relaunch. Step 1 fetches fresh launch params
 * (`useKycLaunch`, requires `displayName`/`email` — prefilled from the
 * `not_started` form if the user just filled it in this session, else the
 * Privy account email with an empty name field the user must fill, never
 * invented). Step 2, once launch params are on hand, shows the actual
 * "Open verification" button — kept as a separate click so the browser
 * form-POST can still be triggered synchronously from a user gesture even
 * though fetching the launch params themselves is async.
 */
function VerifyingCard({ prefill }: { prefill: { displayName: string; email: string } }) {
  const kycLaunch = useKycLaunch()
  const [displayName, setDisplayName] = useState(prefill.displayName)
  const [email, setEmail] = useState(prefill.email)
  const formRef = useRef<HTMLFormElement>(null)
  // Frozen at mount via the useState initializer — NOT derived from the live
  // `displayName` state, which this same mini-form's "Your name" input
  // writes to. Recomputing it on every keystroke would flip it false after
  // the first character and unmount the very input the user is typing into
  // (PR review finding: OnRamp.tsx relaunch mini-form unmounted itself
  // mid-interaction). The submit button below still reacts live to
  // `displayName` so it enables once a name is typed.
  const [needsName] = useState(() => prefill.displayName.trim().length === 0)

  function handleRequestLaunch(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    kycLaunch.mutate({ displayName, email })
  }

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <h1>Verification in progress</h1>
      <p className="muted">
        Complete identity verification in the window that opens, then come back here — this page updates
        automatically once it's approved.
      </p>
      {kycLaunch.data ? (
        <>
          <KycLaunchHiddenForm launch={kycLaunch.data.launch} formRef={formRef} />
          <button className="btn btn-primary" onClick={() => formRef.current?.submit()}>
            Open verification
          </button>
        </>
      ) : (
        <form onSubmit={handleRequestLaunch} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {needsName && (
            <>
              <div className="field">
                <label htmlFor="verifyDisplayName">Your name</label>
                <input id="verifyDisplayName" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="verifyEmail">Email</label>
                <input
                  id="verifyEmail"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
            </>
          )}
          <button
            className="btn btn-primary"
            type="submit"
            disabled={kycLaunch.isPending || (needsName && displayName.trim().length === 0)}
          >
            {kycLaunch.isPending ? 'Preparing…' : 'Relaunch verification'}
          </button>
        </form>
      )}
      {kycLaunch.isError && <p className="error">{errorCode(kycLaunch.error)}</p>}
    </div>
  )
}

/** `incomplete`: the PIX bank-account + wallet registration form (`PixDetailsRequestSchema`). */
function PixDetailsCard() {
  const completeSetup = useCompleteSetup()
  const [fields, setFields] = useState<PixDetailsRequest>({
    firstName: '',
    lastName: '',
    cpf: '',
    pixKey: '',
    pixKeyType: 'email',
  })
  const [validationError, setValidationError] = useState<string | null>(null)

  function updateField<K extends keyof PixDetailsRequest>(key: K, value: PixDetailsRequest[K]) {
    setFields((prev) => ({ ...prev, [key]: value }))
  }

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setValidationError(null)
    const parsed = PixDetailsRequestSchema.safeParse(fields)
    if (!parsed.success) {
      setValidationError(parsed.error.issues[0]?.message ?? 'invalid input')
      return
    }
    completeSetup.mutate(parsed.data)
  }

  return (
    <form className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }} onSubmit={handleSubmit}>
      <h1>Your pix details</h1>
      <p className="muted">Used to register your BRL bank account and Stellar wallet with the provider.</p>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div className="field">
          <label htmlFor="pixFirstName">First name</label>
          <input id="pixFirstName" value={fields.firstName} onChange={(e) => updateField('firstName', e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="pixLastName">Last name</label>
          <input id="pixLastName" value={fields.lastName} onChange={(e) => updateField('lastName', e.target.value)} />
        </div>
      </div>
      <div className="field">
        <label htmlFor="cpf">CPF</label>
        <input id="cpf" value={fields.cpf} onChange={(e) => updateField('cpf', e.target.value)} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div className="field">
          <label htmlFor="pixKey">Pix key</label>
          <input id="pixKey" value={fields.pixKey} onChange={(e) => updateField('pixKey', e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="pixKeyType">Pix key type</label>
          <select id="pixKeyType" value={fields.pixKeyType} onChange={(e) => updateField('pixKeyType', e.target.value as PixDetailsRequest['pixKeyType'])}>
            {PIX_KEY_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </div>
      </div>
      {validationError && <p className="error">{validationError}</p>}
      {completeSetup.isError && (
        <>
          <p className="error">{errorCode(completeSetup.error)}</p>
          <p className="muted">It's safe to resubmit — setup resumes from wherever it left off.</p>
        </>
      )}
      <button className="btn btn-primary" type="submit" disabled={completeSetup.isPending}>
        {completeSetup.isPending ? 'Submitting…' : 'Submit details'}
      </button>
    </form>
  )
}

/** Converts a decimal-string BRL amount (a text input's value) to integer cents, or `null` if it isn't a positive number. */
function toBrlCents(amount: string): number | null {
  const cents = Math.round(Number(amount) * 100)
  return Number.isFinite(cents) && cents > 0 ? cents : null
}

/** Maps an Etherfuse order status onto this codebase's existing `.badge-*` semantic classes (`index.css`). */
function orderBadgeClass(status: string): 'pending' | 'confirmed' | 'failed' {
  if (status === 'completed' || status === 'finalized') return 'confirmed'
  if (status === 'failed' || status === 'refunded' || status === 'canceled') return 'failed'
  return 'pending'
}

/**
 * The deposit panel for a just-created payin order. The sandbox returns no
 * PIX copy-paste code or QR payload (`docs/evidence/etherfuse-sandbox-findings.md`
 * Conclusions §8) — only `PixDeposit {depositAmount, depositBankName,
 * depositAccountHolder}` — so this renders those plus a status pill polling
 * `usePayinState` (which polls every 5s while `created`/`funded`) and, on
 * testnet only, the sandbox "Simulate deposit" button. Once the polled
 * status reaches `completed`/`finalized`, invalidates `['wallet']` so the
 * merchant's balance is fresh the next time they see it.
 */
function DepositPanel({ order }: { order: PayinOrderResponse }) {
  const qc = useQueryClient()
  const payinState = usePayinState(order.orderId)
  const simulate = useSimulatePayin(order.orderId)
  const status = payinState.data?.status ?? order.status
  const completed = status === 'completed' || status === 'finalized'

  // usePayinState's own query has no onSuccess callback (React Query v5
  // dropped those) — this effect is what actually refreshes the wallet
  // balance once the polled status flips to completed.
  useEffect(() => {
    if (completed) void qc.invalidateQueries({ queryKey: ['wallet'] })
  }, [completed, qc])

  return (
    <div className="card centered">
      <h1>Deposit via pix</h1>
      <p>
        Amount: <strong>{order.deposit.depositAmount} BRL</strong>
      </p>
      <p className="muted">Bank: {order.deposit.depositBankName}</p>
      <p className="muted">Account holder: {order.deposit.depositAccountHolder}</p>
      <p>
        You'll receive{' '}
        <strong>
          {centsToDecimal(order.receiverAmountCents)} {ASSET_CODE}
        </strong>
      </p>
      <span className={`badge badge-${orderBadgeClass(status)}`}>{status}</span>
      {completed ? (
        <p className="muted">Deposit confirmed — your balance has been updated.</p>
      ) : (
        <p className="muted">
          Send the pix transfer using the details above. This updates automatically as the provider confirms it — you
          can also check <Link to="/activity">Activity</Link>.
        </p>
      )}
      {STELLAR_NETWORK === 'testnet' && !completed && (
        <button className="btn" onClick={() => simulate.mutate()} disabled={simulate.isPending}>
          {simulate.isPending ? 'Simulating…' : 'Simulate deposit (testnet)'}
        </button>
      )}
      {simulate.isError && <p className="error">{errorCode(simulate.error)}</p>}
      <Link to="/">Back to wallet</Link>
    </div>
  )
}

/** `ready`: BRL amount → quote (countdown from `expiresAt`) → confirm → deposit panel. */
function ReadyFlow() {
  const [amount, setAmount] = useState('')
  const [validationError, setValidationError] = useState<string | null>(null)
  const quote = usePayinQuote()
  const createPayin = useCreatePayin()
  // Ticks once a second while a quote is on hand, purely to drive the expiry
  // countdown's re-render (the actual expiry check re-reads Date.now() below).
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!quote.data) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [quote.data])

  if (createPayin.isSuccess) {
    return <DepositPanel order={createPayin.data} />
  }

  const quoteData = quote.data
  if (quoteData) {
    const expired = now >= quoteData.expiresAt
    const secondsLeft = Math.max(0, Math.ceil((quoteData.expiresAt - now) / 1000))
    return (
      <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <h1>Confirm quote</h1>
        <p>
          You pay <strong>R$ {centsToDecimal(quoteData.senderAmountCents)}</strong>
        </p>
        <p>
          You receive{' '}
          <strong>
            {centsToDecimal(quoteData.receiverAmountCents)} {ASSET_CODE}
          </strong>
        </p>
        <p className="muted">Fee: R$ {centsToDecimal(quoteData.flatFeeCents)}</p>
        <p className="muted">Rate: {quoteData.commercialQuotation}</p>
        <p className={expired ? 'error' : 'muted'}>
          {expired ? 'Quote expired — get a new one' : `Quote expires in ${secondsLeft}s`}
        </p>
        {createPayin.isError && <p className="error">{errorCode(createPayin.error)}</p>}
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={() => quote.reset()}>
            Back
          </button>
          <button
            className="btn btn-primary"
            disabled={expired || createPayin.isPending}
            onClick={() => createPayin.mutate({ quoteId: quoteData.quoteId, amountCents: quoteData.receiverAmountCents })}
          >
            {createPayin.isPending ? 'Generating…' : 'Confirm deposit'}
          </button>
        </div>
      </div>
    )
  }

  function handleQuote(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setValidationError(null)
    const amountBrlCents = toBrlCents(amount)
    if (amountBrlCents === null) {
      setValidationError('Enter an amount greater than zero')
      return
    }
    quote.mutate({ amountBrlCents })
  }

  return (
    <form className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }} onSubmit={handleQuote}>
      <h1>Add funds</h1>
      <div className="field">
        <label htmlFor="amountBrl">Amount (BRL)</label>
        <input id="amountBrl" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="100.00" />
      </div>
      {validationError && <p className="error">{validationError}</p>}
      {quote.isError && <p className="error">{errorCode(quote.error)}</p>}
      <button className="btn btn-primary" type="submit" disabled={quote.isPending}>
        {quote.isPending ? 'Getting quote…' : 'Get quote'}
      </button>
    </form>
  )
}

export function OnRamp() {
  const status = useOnboardingStatus()
  const { user } = usePrivy()
  const privyEmail = user?.email?.address ?? ''
  // Carries the just-submitted `not_started` form's fields across the
  // not_started -> verifying transition, so `VerifyingCard` can offer a
  // one-click relaunch instead of re-asking for displayName/email.
  const [recentStart, setRecentStart] = useState<{ displayName: string; email: string } | null>(null)

  if (status.isLoading) {
    return (
      <div className="card centered">
        <p>Loading…</p>
      </div>
    )
  }

  if (status.isError) {
    return (
      <div className="card centered">
        <p className="error">{errorCode(status.error)}</p>
      </div>
    )
  }

  if (!status.data) return null

  switch (status.data.status) {
    case 'not_started':
      return <NotStartedCard defaultEmail={privyEmail} onStarted={setRecentStart} />
    case 'verifying':
      return <VerifyingCard prefill={recentStart ?? { displayName: '', email: privyEmail }} />
    case 'incomplete':
      return <PixDetailsCard />
    case 'ready':
      return <ReadyFlow />
  }
}
