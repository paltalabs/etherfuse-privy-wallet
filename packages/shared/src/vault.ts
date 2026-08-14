import {z} from 'zod';
import {stellarAmountSchema} from './api.js';

/** POST /vault/deposit and /vault/withdraw responses reuse the intent-created shape. */
export const VaultIntentResponseSchema = z.object({intentId: z.string(), xdr: z.string(), hashHex: z.string()});
export type VaultIntentResponse = z.infer<typeof VaultIntentResponseSchema>;

export const VaultDepositRequestSchema = z.object({amount: stellarAmountSchema});
export type VaultDepositRequest = z.infer<typeof VaultDepositRequestSchema>;

/** shares uses the same 7-dp positive-decimal grammar as asset amounts. */
export const VaultWithdrawRequestSchema = z.object({shares: stellarAmountSchema});
export type VaultWithdrawRequest = z.infer<typeof VaultWithdrawRequestSchema>;

export const VaultPositionResponseSchema = z.object({
  shares: z.string(),
  underlyingBalance: z.string(),
  assetCode: z.string(),
  assetIssuer: z.string()
});
export type VaultPositionResponse = z.infer<typeof VaultPositionResponseSchema>;
