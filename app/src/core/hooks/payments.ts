import { PaymentResponseSchema, type PaymentRequest } from '@paltalabs/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useCore } from '../context'
import { signAndComplete } from '../signing'

/** Create + sign + complete a payment intent, resolving to the confirmed submission's txHash. */
export function useSendPayment() {
  const { client, signer, walletAddress } = useCore()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (request: PaymentRequest) => {
      const res = await client.post('/payments', PaymentResponseSchema, request)
      if (!signer || !walletAddress) throw new Error('wallet signer unavailable')
      return signAndComplete(client, signer, walletAddress, res)
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['wallet'] })
      void qc.invalidateQueries({ queryKey: ['activity'] })
    },
  })
}
