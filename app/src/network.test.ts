import { describe, expect, it } from 'vitest'
import { assetCodeFor, explorerTxUrlFor, networkLabelFor, resolveNetwork, STELLAR_NETWORK } from './network'

describe('resolveNetwork', () => {
  it('only the exact string "mainnet" selects mainnet — anything else (unset, typo) falls back to testnet', () => {
    expect(resolveNetwork('mainnet')).toBe('mainnet')
    expect(resolveNetwork('testnet')).toBe('testnet')
    expect(resolveNetwork(undefined)).toBe('testnet')
    expect(resolveNetwork('MAINNET')).toBe('testnet')
    expect(resolveNetwork('')).toBe('testnet')
  })
})

describe('per-network values', () => {
  it('testnet: USDC (Etherfuse settles USDC on both networks) and the testnet explorer segment', () => {
    expect(assetCodeFor('testnet')).toBe('USDC')
    expect(networkLabelFor('testnet')).toBe('Stellar testnet')
    expect(explorerTxUrlFor('testnet', 'abc123')).toBe('https://stellar.expert/explorer/testnet/tx/abc123')
  })

  it('mainnet: USDC and stellar.expert\'s "public" segment (not "mainnet")', () => {
    expect(assetCodeFor('mainnet')).toBe('USDC')
    expect(networkLabelFor('mainnet')).toBe('Stellar mainnet')
    expect(explorerTxUrlFor('mainnet', 'abc123')).toBe('https://stellar.expert/explorer/public/tx/abc123')
  })
})

describe('STELLAR_NETWORK', () => {
  it('defaults to testnet when VITE_STELLAR_NETWORK is unset (the test env)', () => {
    expect(STELLAR_NETWORK).toBe('testnet')
  })
})
