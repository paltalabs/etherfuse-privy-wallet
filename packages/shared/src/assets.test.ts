import {describe, expect, it} from 'vitest';
import {AssetConfigSchema, AssetRegistry, UnknownAssetError} from './assets.js';

const USDC = {code: 'USDC', issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5', decimals: 7};

describe('AssetConfigSchema', () => {
  it('accepts a valid asset config', () => {
    expect(AssetConfigSchema.parse(USDC)).toEqual(USDC);
  });
  it('rejects an issuer that is not a Stellar public key', () => {
    expect(() => AssetConfigSchema.parse({...USDC, issuer: 'not-a-key'})).toThrow();
  });
  it('rejects an empty code', () => {
    expect(() => AssetConfigSchema.parse({...USDC, code: ''})).toThrow();
  });
});

describe('AssetRegistry', () => {
  it('returns a registered asset by code', () => {
    const registry = new AssetRegistry([USDC]);
    expect(registry.get('USDC')).toEqual(USDC);
  });
  it('throws UnknownAssetError for unregistered codes', () => {
    const registry = new AssetRegistry([USDC]);
    expect(() => registry.get('DOGE')).toThrow(UnknownAssetError);
  });
  it('lists all registered assets', () => {
    const registry = new AssetRegistry([USDC]);
    expect(registry.list()).toEqual([USDC]);
  });
});
