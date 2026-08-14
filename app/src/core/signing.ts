import { CompleteIntentResponseSchema } from '@paltalabs/shared'
import type { ApiClient } from './client'

/**
 * Raw-hash signer contract, wrapping Privy's `useSignRawHash` from
 * `@privy-io/react-auth/extended-chains`. Split out from `context.tsx` so a
 * concrete signing implementation can land later without touching the context shape.
 */
export interface RawHashSigner {
  signRawHash(params: { address: string; chainType: 'stellar'; hash: `0x${string}` }): Promise<{ signature: string }>
}

/** Sign a backend intent's hash with the merchant's Privy wallet and complete it. */
export async function signAndComplete(
  client: ApiClient,
  signer: RawHashSigner,
  walletAddress: string,
  intent: { intentId: string; xdr: string; hashHex: string },
): Promise<{ txHash: string }> {
  const { signature } = await signer.signRawHash({
    address: walletAddress,
    chainType: 'stellar',
    hash: intent.hashHex as `0x${string}`,
  })
  return client.post(`/intents/${intent.intentId}/complete`, CompleteIntentResponseSchema, { signature })
}
