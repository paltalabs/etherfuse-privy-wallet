import { useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { ApiError } from '../core/client'
import { centsToDecimal } from '../core/format'
import { useCreatePayout, useOnboardingStatus, usePayoutQuote } from '../core/hooks/ramp'
import { ASSET_CODE, explorerTxUrl } from '../network'

function errorCode(error: unknown): string {
  return error instanceof ApiError ? error.code : 'unknown_error'
}

/** Converts a decimal-string asset amount (a `type="number"` input's value, `ASSET_CODE`-denominated) to integer cents, or `null` if it isn't a positive number. */
function toAssetCents(amount: string): number | null {
  const cents = Math.round(Number(amount) * 100)
  return Number.isFinite(cents) && cents > 0 ? cents : null
}

/**
 * The signed-payout success panel. Deliberately honest about what "success"
 * means here: the merchant's on-chain payment was submitted and accepted —
 * NOT that the BRL fiat leg has settled. Etherfuse's sandbox anchor orders
 * observed sitting at `funded` (payment detected, fiat not yet paid out)
 * indefinitely with no deadline after which it can be assumed settled
 * (`docs/evidence/etherfuse-sandbox-findings.md`'s "## Anchor payment &
 * completion" section) — so this never promises same-session fiat
 * settlement; the Activity feed is where the merchant tracks the eventual
 * on-chain confirmation.
 */
function PayoutSuccess({ txHash }: { txHash: string }) {
  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <h1>Payment submitted</h1>
      <p className="muted">
        Your withdrawal payment was submitted on-chain. Track its confirmation in Activity — the bank transfer follows
        once the provider processes it, which can take a while.
      </p>
      <p className="mono">{txHash}</p>
      <p>
        <a href={explorerTxUrl(txHash)} target="_blank" rel="noreferrer">
          View on Stellar Expert
        </a>
      </p>
      <p>
        <Link to="/activity">Track in Activity</Link>
      </p>
    </div>
  )
}

/** The quote → confirm → sign phase, only reachable once onboarding is `ready`. */
function PayoutFlow() {
  const [amount, setAmount] = useState('')
  const [validationError, setValidationError] = useState<string | null>(null)
  const quote = usePayoutQuote()
  const createPayout = useCreatePayout()
  // Ticks once a second while a quote is on hand, purely to drive the expiry
  // countdown's re-render (the actual expiry check re-reads Date.now() below)
  // — same pattern as OnRamp.tsx's PayinFlow.
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!quote.data) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [quote.data])

  if (createPayout.isSuccess) {
    return <PayoutSuccess txHash={createPayout.data.txHash} />
  }

  const quoteData = quote.data
  if (quoteData) {
    const expired = now >= quoteData.expiresAt
    const secondsLeft = Math.max(0, Math.ceil((quoteData.expiresAt - now) / 1000))
    return (
      <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <h1>Confirm withdrawal</h1>
        <p>
          You send <strong>{centsToDecimal(quoteData.senderAmountCents)} {ASSET_CODE}</strong>
        </p>
        <p>
          You receive <strong>R$ {centsToDecimal(quoteData.receiverAmountCents)}</strong>
        </p>
        <p className="muted">Fee: {centsToDecimal(quoteData.flatFeeCents)} {ASSET_CODE}</p>
        <p className="muted">Rate: {quoteData.commercialQuotation}</p>
        <p className={expired ? 'error' : 'muted'}>
          {expired ? 'Quote expired — get a new one' : `Quote expires in ${secondsLeft}s`}
        </p>
        <p className="muted">
          You'll approve a transaction moving {ASSET_CODE} to the provider; the bank transfer follows.
        </p>
        {createPayout.isError && <p className="error">{errorCode(createPayout.error)}</p>}
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={() => quote.reset()}>
            Back
          </button>
          <button
            className="btn btn-primary"
            disabled={expired || createPayout.isPending}
            onClick={() =>
              createPayout.mutate({ quoteId: quoteData.quoteId, amountCents: quoteData.senderAmountCents })
            }
          >
            {createPayout.isPending ? 'Confirming…' : 'Confirm withdrawal'}
          </button>
        </div>
      </div>
    )
  }

  function handleQuote(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setValidationError(null)
    const amountCents = toAssetCents(amount)
    if (amountCents === null) {
      setValidationError('Enter an amount greater than zero')
      return
    }
    quote.mutate({ amountCents })
  }

  return (
    <form className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }} onSubmit={handleQuote}>
      <h1>Withdraw to bank (pix)</h1>
      <div className="field">
        <label htmlFor="amountAsset">Amount ({ASSET_CODE})</label>
        <input id="amountAsset" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="10.00" />
      </div>
      {validationError && <p className="error">{validationError}</p>}
      {quote.isError && <p className="error">{errorCode(quote.error)}</p>}
      <button className="btn btn-primary" type="submit" disabled={quote.isPending}>
        {quote.isPending ? 'Getting quote…' : 'Get quote'}
      </button>
    </form>
  )
}

export function OffRamp() {
  const status = useOnboardingStatus()

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

  if (status.data.status !== 'ready') {
    return (
      <div className="card centered">
        <h1>Complete on-ramp setup first</h1>
        <p className="muted">Withdrawals require finishing onboarding.</p>
        <Link to="/onramp">Go to on-ramp setup</Link>
      </div>
    )
  }

  return <PayoutFlow />
}
