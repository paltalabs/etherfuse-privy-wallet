/** Ramp-provider integer cents (Etherfuse's own convention, `packages/shared/src/ramp.ts`) → display decimal string (2dp). */
export function centsToDecimal(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

/** Stellar 7dp decimal string → trimmed display form (min 2dp). */
export function formatAmount(amount: string): string {
  const [whole, frac = ''] = amount.split('.')
  const trimmed = frac.replace(/0+$/, '')
  return `${whole}.${trimmed.length < 2 ? trimmed.padEnd(2, '0') : trimmed}`
}
