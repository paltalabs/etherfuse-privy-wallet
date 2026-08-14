import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from './client'
import { signAndComplete, type RawHashSigner } from './signing'

describe('signAndComplete', () => {
  it('signs the intent hash verbatim and posts the resulting signature to complete it', async () => {
    const signRawHash = vi.fn().mockResolvedValue({ signature: '0xsignature' })
    const signer: RawHashSigner = { signRawHash }
    const post = vi.fn().mockResolvedValue({ txHash: 'deadbeef' })
    const client = { get: vi.fn(), post } as unknown as ApiClient

    const result = await signAndComplete(client, signer, 'GWALLETADDRESS', {
      intentId: 'intent-1',
      xdr: 'AAAAAgAAAAA=',
      hashHex: '0xdeadbeef',
    })

    expect(signRawHash).toHaveBeenCalledWith({
      address: 'GWALLETADDRESS',
      chainType: 'stellar',
      hash: '0xdeadbeef',
    })
    expect(post).toHaveBeenCalledWith('/intents/intent-1/complete', expect.anything(), {
      signature: '0xsignature',
    })
    expect(result).toEqual({ txHash: 'deadbeef' })
  })

  it('propagates a signRawHash rejection without calling complete', async () => {
    const signRawHash = vi.fn().mockRejectedValue(new Error('user rejected'))
    const signer: RawHashSigner = { signRawHash }
    const post = vi.fn()
    const client = { get: vi.fn(), post } as unknown as ApiClient

    await expect(
      signAndComplete(client, signer, 'GWALLETADDRESS', {
        intentId: 'intent-1',
        xdr: 'AAAAAgAAAAA=',
        hashHex: '0xdeadbeef',
      }),
    ).rejects.toThrow('user rejected')
    expect(post).not.toHaveBeenCalled()
  })
})
