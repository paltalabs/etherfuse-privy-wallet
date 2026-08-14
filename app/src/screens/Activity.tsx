import type { ActivityItem } from '@paltalabs/shared'
import { ApiError } from '../core/client'
import { formatAmount } from '../core/format'
import { useActivity } from '../core/hooks/activity'
import { explorerTxUrl } from '../network'

const TYPE_LABELS: Record<ActivityItem['type'], string> = {
  provision: 'Wallet activated',
  send: 'Sent',
  receive: 'Received',
  on_ramp: 'Deposit (pix)',
  off_ramp: 'Withdrawal (pix)',
  vault_deposit: 'Moved to earning',
  vault_withdraw: 'Moved from earning',
}

function errorCode(error: unknown): string {
  return error instanceof ApiError ? error.code : 'unknown_error'
}

/** `+`/`-` prefixed display amount, or null for rows with no amount (e.g. `provision`). */
function signedAmount(item: ActivityItem): string | null {
  if (!item.amount || !item.assetCode) return null
  const sign = item.direction === 'out' ? '-' : item.direction === 'in' ? '+' : ''
  return `${sign}${formatAmount(item.amount)} ${item.assetCode}`
}

/** Coarse relative time (minutes/hours/days), falling back to a plain date past a week out. */
function formatRelative(iso: string): string {
  const date = new Date(iso)
  const diffMin = Math.round((Date.now() - date.getTime()) / 60_000)
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHour = Math.round(diffMin / 60)
  if (diffHour < 24) return `${diffHour}h ago`
  const diffDay = Math.round(diffHour / 24)
  if (diffDay < 7) return `${diffDay}d ago`
  return date.toLocaleDateString()
}

function ActivityRow({ item }: { item: ActivityItem }) {
  const amount = signedAmount(item)
  return (
    <div className="card feed-row">
      <div className="feed-row-top">
        <span>{TYPE_LABELS[item.type]}</span>
        <span className={`badge badge-${item.status}`}>{item.status}</span>
      </div>
      {amount && <span className="mono">{amount}</span>}
      <div className="feed-row-top">
        <span className="muted">{formatRelative(item.createdAt)}</span>
        {item.txHash && (
          <a href={explorerTxUrl(item.txHash)} target="_blank" rel="noreferrer">
            View on Stellar Expert
          </a>
        )}
      </div>
    </div>
  )
}

export function Activity() {
  const activity = useActivity()

  if (activity.isLoading) {
    return (
      <div className="card centered">
        <p>Loading…</p>
      </div>
    )
  }

  if (activity.isError) {
    return (
      <div className="card centered">
        <p className="error">{errorCode(activity.error)}</p>
      </div>
    )
  }

  const items = activity.data?.pages.flatMap((page) => page.items) ?? []

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <h1>Activity</h1>
      {items.length === 0 && <p className="muted">No activity yet.</p>}
      {items.map((item) => (
        <ActivityRow key={item.id} item={item} />
      ))}
      {activity.hasNextPage && (
        <button className="btn" onClick={() => activity.fetchNextPage()} disabled={activity.isFetchingNextPage}>
          {activity.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  )
}
