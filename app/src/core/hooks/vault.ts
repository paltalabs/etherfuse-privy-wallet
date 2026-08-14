import {
  VaultIntentResponseSchema,
  VaultPositionResponseSchema,
  type VaultDepositRequest,
  type VaultWithdrawRequest,
} from '@paltalabs/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCore } from '../context'
import { signAndComplete } from '../signing'

/** The merchant's current DeFindex vault position (shares + underlying-asset value). Zeros for no position, per api-vault's endpoint table. */
export function useVaultPosition() {
  const { client } = useCore()
  return useQuery({
    queryKey: ['vault', 'position'],
    queryFn: () => client.get('/vault/position', VaultPositionResponseSchema),
  })
}

/** Invalidates the vault position, wallet balance, and activity feed — shared by useVaultDeposit/useVaultWithdraw since both move the vault's underlying asset into/out of the vault and write a pending activity row. */
function invalidateVaultQueries(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: ['vault', 'position'] })
  void qc.invalidateQueries({ queryKey: ['wallet'] })
  void qc.invalidateQueries({ queryKey: ['activity'] })
}

/**
 * Deposits into the vault: `POST /vault/deposit` creates the
 * `vault_deposit`-kind signing intent, then `signAndComplete` signs its
 * `hashHex` and completes it — same sign-then-complete convergence
 * `useProvision`/`useSendPayment`/`useCreatePayout` already use
 * (`app/src/core/hooks/wallet.ts`, `payments.ts`, `ramp.ts`).
 *
 * No DeFindex vault is currently deployed on testnet (`TESTNET_VAULT` is
 * `null`, `api/src/config/vaults.ts`, retired alongside the Etherfuse
 * migration) — the vault module's routes aren't registered on this network
 * at all right now, so this mutation currently fails with a 404
 * route-not-found `ApiError`, not the previously-documented 502
 * `simulation_failed` (`docs/modules/api-vault.md`'s Gotchas). Either way
 * the rejection propagates unchanged for the Earn screen to render as a
 * degradation banner, never swallowed or retried into a fake success — see
 * `Earn.tsx`'s `isVaultUnavailable` for the 502-specific banner gate, which
 * this current 404 does not match (flagged there, not fixed here).
 */
export function useVaultDeposit() {
  const { client, signer, walletAddress } = useCore()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (request: VaultDepositRequest) => {
      const intent = await client.post('/vault/deposit', VaultIntentResponseSchema, request)
      if (!signer || !walletAddress) throw new Error('wallet signer unavailable')
      return signAndComplete(client, signer, walletAddress, intent)
    },
    onSuccess: () => invalidateVaultQueries(qc),
  })
}

/** Same shape as `useVaultDeposit`, redeeming vault shares back into the underlying asset via `POST /vault/withdraw`. Same fail-closed 502 behavior applies (see `useVaultDeposit`'s doc comment). */
export function useVaultWithdraw() {
  const { client, signer, walletAddress } = useCore()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (request: VaultWithdrawRequest) => {
      const intent = await client.post('/vault/withdraw', VaultIntentResponseSchema, request)
      if (!signer || !walletAddress) throw new Error('wallet signer unavailable')
      return signAndComplete(client, signer, walletAddress, intent)
    },
    onSuccess: () => invalidateVaultQueries(qc),
  })
}
