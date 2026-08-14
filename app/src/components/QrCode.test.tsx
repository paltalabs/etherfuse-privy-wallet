import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { QrCode } from './QrCode'

// This project's vitest.config.ts doesn't set `test.globals: true`, so
// @testing-library/react's auto-cleanup (which checks for a *global*
// `afterEach`) never registers — each test's rendered DOM would otherwise
// leak into the next. Explicit here since this suite renders the same
// alt text ("QR code") across multiple tests.
afterEach(cleanup)

describe('QrCode', () => {
  it('renders an img with a data URL src for the given value', async () => {
    render(<QrCode value="GADDRESSVALUEONE" />)

    const img = await screen.findByAltText('QR code')
    expect(img.getAttribute('src')?.startsWith('data:image/png')).toBe(true)
  })

  it('re-renders with a different src when the value changes', async () => {
    const { rerender } = render(<QrCode value="GADDRESSVALUEONE" />)
    const firstSrc = (await screen.findByAltText('QR code')).getAttribute('src')

    rerender(<QrCode value="GADDRESSVALUETWO" />)

    await waitFor(() => {
      const secondSrc = screen.getByAltText('QR code').getAttribute('src')
      expect(secondSrc).not.toBe(firstSrc)
    })
  })
})
