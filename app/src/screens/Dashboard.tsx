import type { WalletResponse } from '@paltalabs/shared'
import { Link } from 'react-router'
import { ApiError } from '../core/client'
import { formatAmount } from '../core/format'
import { useVaultPosition } from '../core/hooks/vault'
import { useProvision, useWallet } from '../core/hooks/wallet'
import { ASSET_CODE } from '../network'

function errorCode(error: unknown): string {
  return error instanceof ApiError ? error.code : 'unknown_error'
}

/** First-time setup card: creates the merchant's sponsored Stellar account + asset trustline. */
function ActivateCard() {
  const provision = useProvision()
  return (
    <div className="card centered">
      <h1>Activate your wallet</h1>
      <p className="muted">
        One-time setup creates your sponsored Stellar account and {ASSET_CODE} trustline — no fees, no funding
        required.
      </p>
      <button className="btn btn-primary" onClick={() => provision.mutate()} disabled={provision.isPending}>
        {provision.isPending ? 'Activating…' : 'Activate wallet'}
      </button>
      {provision.isError && <p className="error">{errorCode(provision.error)}</p>}
    </div>
  )
}

// The vault position read can fail on its own (e.g. the vault outage
// documented in docs/modules/api-vault.md's Gotchas) — that failure must
// stay contained to this card and never take down the rest of the
// Dashboard, so it renders "—" for both the loading and error states
// rather than propagating a rejected query upward.
function EarningCard() {
  const position = useVaultPosition()
  const label = position.isSuccess ? `${formatAmount(position.data.underlyingBalance)} ${position.data.assetCode}` : '—'
  return (
    <div className="card">
      <p className="muted">Earning</p>
      <h1>{label}</h1>
    </div>
  )
}

function BalanceCard({ wallet }: { wallet: WalletResponse }) {
  const asset = wallet.balances.find((b) => b.assetCode === ASSET_CODE)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="card">
        <p className="muted">{ASSET_CODE} balance</p>
        <h1>
          {asset ? formatAmount(asset.balance) : '0.00'} {ASSET_CODE}
        </h1>
      </div>
      <EarningCard />
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Link className="btn btn-primary" to="/send">
          Send
        </Link>
        <Link className="btn" to="/receive">
          Receive
        </Link>
        <Link className="btn" to="/onramp">
          Add funds
        </Link>
      </div>
    </div>
  )
}

export function Dashboard() {
  const wallet = useWallet()

  if (wallet.isLoading) {
    return (
      <div className="card centered">
        <p>Loading…</p>
      </div>
    )
  }

  if (wallet.isError) {
    // GET /wallet 404s with merchant_not_found when POST /wallet/provision has
    // never been called for this DID yet (docs/modules/api-wallet.md's
    // endpoint table) — the true first-time-login state, not a real error.
    // Route it to the same activation card as an explicit provisioned:false.
    if (wallet.error instanceof ApiError && wallet.error.code === 'merchant_not_found') {
      return <ActivateCard />
    }
    return (
      <div className="card centered">
        <p className="error">{errorCode(wallet.error)}</p>
      </div>
    )
  }

  if (!wallet.data) return null

  return wallet.data.provisioned ? <BalanceCard wallet={wallet.data} /> : <ActivateCard />
}
