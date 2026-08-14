import {Networks} from '@stellar/stellar-sdk';
import {describe, expect, it} from 'vitest';
import {TESTNET_REGISTRY, MAINNET_REGISTRY} from './assets.js';
import {getNetworkConfig, MAINNET_NETWORK, resolveSorobanRpcUrl, TESTNET_NETWORK} from './networks.js';
import {TESTNET_VAULT} from './vaults.js';

describe('getNetworkConfig', () => {
  it('testnet: pins the values every pre-refactor hardcode used', () => {
    const config = getNetworkConfig('testnet');
    expect(config).toBe(TESTNET_NETWORK);
    expect(config.horizonUrl).toBe('https://horizon-testnet.stellar.org');
    expect(config.networkPassphrase).toBe(Networks.TESTNET);
    expect(config.defaultSorobanRpcUrl).toBe('https://soroban-testnet.stellar.org');
    expect(config.registry).toBe(TESTNET_REGISTRY);
    expect(config.vault).toBe(TESTNET_VAULT);
  });

  it('mainnet: public Horizon/passphrase, USDC registry, no vault, no Soroban default', () => {
    const config = getNetworkConfig('mainnet');
    expect(config).toBe(MAINNET_NETWORK);
    expect(config.horizonUrl).toBe('https://horizon.stellar.org');
    expect(config.networkPassphrase).toBe(Networks.PUBLIC);
    expect(config.defaultSorobanRpcUrl).toBeNull();
    expect(config.registry).toBe(MAINNET_REGISTRY);
    expect(config.vault).toBeNull();
  });

  it('mainnet USDC is pinned to Circle\'s verified issuer', () => {
    expect(MAINNET_REGISTRY.get('USDC').issuer).toBe('GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN');
  });

  it('the etherfuse assetId resolves in its own network registry, for both networks (activity rows and quote bodies must agree)', () => {
    for (const config of [TESTNET_NETWORK, MAINNET_NETWORK]) {
      const [code, issuer] = config.etherfuse.assetId.split(':');
      expect(code).toBeTruthy();
      expect(issuer).toBeTruthy();
      expect(config.registry.get(code as string).issuer).toBe(issuer);
    }
  });

  it('testnet etherfuse config pins the sandbox endpoints and verified testnet USDC asset', () => {
    expect(TESTNET_NETWORK.etherfuse).toEqual({
      apiBaseUrl: 'https://api.sand.etherfuse.com',
      dashboardBaseUrl: 'https://sandbox.etherfuse.com',
      assetId: 'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
    });
  });

  it('mainnet etherfuse config pins the production endpoints and Circle USDC asset', () => {
    expect(MAINNET_NETWORK.etherfuse).toEqual({
      apiBaseUrl: 'https://api.etherfuse.com',
      dashboardBaseUrl: 'https://app.etherfuse.com',
      assetId: 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
    });
  });
});

describe('resolveSorobanRpcUrl', () => {
  it('an explicit URL always wins over the network default', () => {
    expect(resolveSorobanRpcUrl('https://rpc.example.com', TESTNET_NETWORK)).toBe('https://rpc.example.com');
    expect(resolveSorobanRpcUrl('https://rpc.example.com', MAINNET_NETWORK)).toBe('https://rpc.example.com');
  });

  it('falls back to the testnet default when unset', () => {
    expect(resolveSorobanRpcUrl(undefined, TESTNET_NETWORK)).toBe('https://soroban-testnet.stellar.org');
  });

  it('throws on mainnet when unset — there is no public default to fall back to', () => {
    expect(() => resolveSorobanRpcUrl(undefined, MAINNET_NETWORK)).toThrow(/SOROBAN_RPC_URL is required/);
  });
});
