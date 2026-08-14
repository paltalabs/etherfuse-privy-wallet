import {z} from 'zod';

// Stellar ed25519 public keys: G + 55 base32 chars.
const stellarPublicKey = z.string().regex(/^G[A-Z2-7]{55}$/, 'must be a Stellar public key');

export const AssetConfigSchema = z.object({
  code: z.string().min(1).max(12),
  issuer: stellarPublicKey,
  decimals: z.number().int().positive()
});

export type AssetConfig = z.infer<typeof AssetConfigSchema>;

export class UnknownAssetError extends Error {
  constructor(code: string) {
    super(`asset not in registry: ${code}`);
    this.name = 'UnknownAssetError';
  }
}

/** The wallet manages ONLY assets listed here — this is the single place a new asset is added. */
export class AssetRegistry {
  private readonly byCode: Map<string, AssetConfig>;

  constructor(assets: AssetConfig[]) {
    this.byCode = new Map(assets.map((a) => [a.code, AssetConfigSchema.parse(a)]));
  }

  get(code: string): AssetConfig {
    const asset = this.byCode.get(code);
    if (!asset) throw new UnknownAssetError(code);
    return asset;
  }

  list(): AssetConfig[] {
    return [...this.byCode.values()];
  }
}
