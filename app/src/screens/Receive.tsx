import { useState } from 'react'
import { QrCode } from '../components/QrCode'
import { useCore } from '../core/context'
import { ASSET_CODE, NETWORK_LABEL } from '../network'

export function Receive() {
  const { walletAddress } = useCore()
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)

  async function handleCopy() {
    if (!walletAddress) return
    try {
      await navigator.clipboard.writeText(walletAddress)
      setCopied(true)
      setCopyFailed(false)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopyFailed(true)
      setCopied(false)
      setTimeout(() => setCopyFailed(false), 2000)
    }
  }

  return (
    <div className="card centered">
      <h1>Receive</h1>
      {walletAddress && <QrCode value={walletAddress} />}
      {walletAddress && (
        <p className="mono" title={walletAddress}>
          {`${walletAddress.slice(0, 5)}…${walletAddress.slice(-5)}`}
        </p>
      )}
      <button className="btn" onClick={handleCopy}>
        {copyFailed ? 'Copy failed' : copied ? 'Copied' : 'Copy address'}
      </button>
      <p className="muted">
        This wallet receives {ASSET_CODE} on {NETWORK_LABEL}.
      </p>
    </div>
  )
}
