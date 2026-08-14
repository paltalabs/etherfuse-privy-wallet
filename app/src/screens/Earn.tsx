import { VaultDepositRequestSchema, VaultWithdrawRequestSchema } from '@paltalabs/shared'
import { useState, type FormEvent, type ReactNode } from 'react'
import { ApiError } from '../core/client'
import { formatAmount } from '../core/format'
import { useVaultDeposit, useVaultPosition, useVaultWithdraw } from '../core/hooks/vault'
import { ASSET_CODE, explorerTxUrl } from '../network'

function errorCode(error: unknown): string {
  return error instanceof ApiError ? error.code : 'unknown_error'
}

// A live deposit/withdraw simulation failing on testnet surfaces as a
// fixed, sanitized 502 `simulation_failed` token — vault/service.ts's
// runProviderCall maps ANY Soroban simulation failure (deposit, withdraw,
// or the position read) to this same code, never forwarding the raw RPC
// diagnostic to the client (api/src/modules/vault/service.ts).
function isVaultUnavailable(error: unknown): boolean {
  return error instanceof ApiError && error.status === 502 && error.code === 'simulation_failed'
}

const VAULT_UNAVAILABLE_MESSAGE =
  "Earning deposits are temporarily unavailable — the vault can't accept this asset until its balance is authorized by the asset's issuer. Your funds have not moved."

/** Renders the fail-closed degradation banner for a known vault outage, or the raw error code for anything else. */
function MutationFeedback({ error }: { error: unknown }) {
  if (isVaultUnavailable(error)) {
    return <p className="info">{VAULT_UNAVAILABLE_MESSAGE}</p>
  }
  return <p className="error">{errorCode(error)}</p>
}

function SuccessPanel({ title, txHash, onReset, resetLabel }: { title: string; txHash: string; onReset: () => void; resetLabel: string }) {
  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <h1>{title}</h1>
      <p className="mono">{txHash}</p>
      <p>
        <a href={explorerTxUrl(txHash)} target="_blank" rel="noreferrer">
          View on Stellar Expert
        </a>
      </p>
      <button className="btn" onClick={onReset}>
        {resetLabel}
      </button>
    </div>
  )
}

/** The merchant's current vault position: underlying-asset headline, share count, asset code. Failure is contained here — it never blocks the deposit/withdraw forms below it. */
function PositionCard() {
  const position = useVaultPosition()

  let body: ReactNode
  if (position.isLoading) {
    body = <p>Loading…</p>
  } else if (position.isError || !position.data) {
    body = <p className="error">{errorCode(position.error)}</p>
  } else {
    body = (
      <>
        <h1>
          {formatAmount(position.data.underlyingBalance)} {position.data.assetCode}
        </h1>
        <p className="muted">{formatAmount(position.data.shares)} shares</p>
      </>
    )
  }

  return (
    <div className="card">
      <p className="muted">Earning position</p>
      {body}
    </div>
  )
}

function DepositForm() {
  const [amount, setAmount] = useState('')
  const [validationError, setValidationError] = useState<string | null>(null)
  const deposit = useVaultDeposit()

  if (deposit.isSuccess) {
    return <SuccessPanel title="Deposit submitted" txHash={deposit.data.txHash} onReset={() => deposit.reset()} resetLabel="Deposit more" />
  }

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setValidationError(null)
    const parsed = VaultDepositRequestSchema.safeParse({ amount })
    if (!parsed.success) {
      setValidationError(parsed.error.issues[0]?.message ?? 'invalid input')
      return
    }
    deposit.mutate(parsed.data)
  }

  return (
    <form className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }} onSubmit={handleSubmit}>
      <h1>Deposit</h1>
      <div className="field">
        <label htmlFor="depositAmount">Amount ({ASSET_CODE})</label>
        <input id="depositAmount" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="10.00" />
      </div>
      {validationError && <p className="error">{validationError}</p>}
      {deposit.isError && <MutationFeedback error={deposit.error} />}
      <button className="btn btn-primary" type="submit" disabled={deposit.isPending}>
        {deposit.isPending ? 'Depositing…' : 'Deposit'}
      </button>
    </form>
  )
}

function WithdrawForm() {
  const [shares, setShares] = useState('')
  const [validationError, setValidationError] = useState<string | null>(null)
  const withdraw = useVaultWithdraw()

  if (withdraw.isSuccess) {
    return (
      <SuccessPanel title="Withdrawal submitted" txHash={withdraw.data.txHash} onReset={() => withdraw.reset()} resetLabel="Withdraw more" />
    )
  }

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setValidationError(null)
    const parsed = VaultWithdrawRequestSchema.safeParse({ shares })
    if (!parsed.success) {
      setValidationError(parsed.error.issues[0]?.message ?? 'invalid input')
      return
    }
    withdraw.mutate(parsed.data)
  }

  return (
    <form className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }} onSubmit={handleSubmit}>
      <h1>Withdraw</h1>
      <div className="field">
        <label htmlFor="withdrawShares">Shares</label>
        <input id="withdrawShares" value={shares} onChange={(e) => setShares(e.target.value)} placeholder="10.00" />
      </div>
      {validationError && <p className="error">{validationError}</p>}
      {withdraw.isError && <MutationFeedback error={withdraw.error} />}
      <button className="btn btn-primary" type="submit" disabled={withdraw.isPending}>
        {withdraw.isPending ? 'Withdrawing…' : 'Withdraw'}
      </button>
    </form>
  )
}

export function Earn() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <PositionCard />
      <DepositForm />
      <WithdrawForm />
    </div>
  )
}
