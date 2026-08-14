import { PaymentRequestSchema } from '@paltalabs/shared'
import { useState, type FormEvent } from 'react'
import { ApiError } from '../core/client'
import { useSendPayment } from '../core/hooks/payments'
import { ASSET_CODE, explorerTxUrl } from '../network'

function errorCode(error: unknown): string {
  return error instanceof ApiError ? error.code : 'unknown_error'
}

export function Send() {
  const [destination, setDestination] = useState('')
  const [amount, setAmount] = useState('')
  const [validationError, setValidationError] = useState<string | null>(null)
  const sendPayment = useSendPayment()

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setValidationError(null)
    const parsed = PaymentRequestSchema.safeParse({ destination, amount, assetCode: ASSET_CODE })
    if (!parsed.success) {
      setValidationError(parsed.error.issues[0]?.message ?? 'invalid input')
      return
    }
    sendPayment.mutate(parsed.data)
  }

  if (sendPayment.isSuccess) {
    return (
      <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <h1>Payment sent</h1>
        <p className="mono">{sendPayment.data.txHash}</p>
        <p>
          <a href={explorerTxUrl(sendPayment.data.txHash)} target="_blank" rel="noreferrer">
            View on Stellar Expert
          </a>
        </p>
        <button className="btn" onClick={() => sendPayment.reset()}>
          Send another
        </button>
      </div>
    )
  }

  return (
    <form className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }} onSubmit={handleSubmit}>
      <h1>Send {ASSET_CODE}</h1>
      <div className="field">
        <label htmlFor="destination">Destination address</label>
        <input
          id="destination"
          value={destination}
          onChange={(e) => setDestination(e.target.value)}
          placeholder="G..."
        />
      </div>
      <div className="field">
        <label htmlFor="amount">Amount</label>
        <input id="amount" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
      </div>
      {validationError && <p className="error">{validationError}</p>}
      {sendPayment.isError && <p className="error">{errorCode(sendPayment.error)}</p>}
      <button className="btn btn-primary" type="submit" disabled={sendPayment.isPending}>
        {sendPayment.isPending ? 'Sending…' : 'Send'}
      </button>
    </form>
  )
}
