import { describe, expect, it } from 'vitest'
import { centsToDecimal, formatAmount } from './format'

describe('centsToDecimal', () => {
  it('formats whole cents as a 2dp decimal string', () => {
    expect(centsToDecimal(123456)).toBe('1234.56')
  })

  it('pads small cent amounts to 2dp', () => {
    expect(centsToDecimal(5)).toBe('0.05')
  })
})

describe('formatAmount', () => {
  it('trims trailing zeros beyond 2dp', () => {
    expect(formatAmount('10.5000000')).toBe('10.50')
  })

  it('never trims below 2dp', () => {
    expect(formatAmount('0.0000001')).toBe('0.0000001')
  })
})
