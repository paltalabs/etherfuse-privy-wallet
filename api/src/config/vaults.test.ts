import {describe, expect, it} from 'vitest';
import {TESTNET_REGISTRY} from './assets.js';
import {TESTNET_VAULT} from './vaults.js';

describe('TESTNET_VAULT', () => {
  it('pins the deployed HodlUSDC vault address (C..., 56 chars)', () => {
    expect(TESTNET_VAULT?.address).toMatch(/^C[A-Z2-7]{55}$/);
    expect(TESTNET_VAULT?.address).toBe('CCSPCCMFTRBKKVAW6HDFV47EAJ5UA2UYBC5QY2LH6SRBVF5APD6SYTFT');
  });

  it('references a registry asset by code', () => {
    expect(TESTNET_VAULT).not.toBeNull();
    expect(() => TESTNET_REGISTRY.get(TESTNET_VAULT!.assetCode)).not.toThrow();
  });
});
