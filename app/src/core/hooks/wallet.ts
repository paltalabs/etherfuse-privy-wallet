import { ProvisionResponseSchema, WalletResponseSchema } from '@paltalabs/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCore } from '../context'
import { signAndComplete } from '../signing'

export function useWallet() {
  const { client } = useCore()
  return useQuery({ queryKey: ['wallet'], queryFn: () => client.get('/wallet', WalletResponseSchema) })
}

/** Provision the merchant account. Handles both response branches: signs the pending intent, or no-ops when already provisioned. */
export function useProvision() {
  const { client, signer, walletAddress } = useCore()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      const res = await client.post('/wallet/provision', ProvisionResponseSchema)
      if ('provisioned' in res) return { alreadyProvisioned: true as const }
      if (!signer || !walletAddress) throw new Error('wallet signer unavailable')
      return signAndComplete(client, signer, walletAddress, res)
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['wallet'] }),
  })
}
