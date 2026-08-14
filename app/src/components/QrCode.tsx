import QRCode from 'qrcode'
import { useEffect, useState } from 'react'

/**
 * Renders `value` as a QR code image. Resolves the data URL asynchronously
 * (qrcode's toDataURL returns a Promise) so the image only appears once
 * encoding succeeds; a rejected encode renders nothing, leaving callers free
 * to show the raw value as a fallback (e.g. the address text on Receive).
 */
export function QrCode({ value, size = 240 }: { value: string; size?: number }) {
  const [src, setSrc] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setSrc(null)
    QRCode.toDataURL(value, { width: size, margin: 1 })
      .then((dataUrl) => {
        if (!cancelled) setSrc(dataUrl)
      })
      .catch(() => {
        if (!cancelled) setSrc(null)
      })
    return () => {
      cancelled = true
    }
  }, [value, size])

  if (!src) return null
  return <img alt="QR code" src={src} />
}
