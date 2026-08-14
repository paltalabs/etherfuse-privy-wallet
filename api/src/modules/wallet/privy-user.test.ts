import {describe, expect, it, vi} from 'vitest';
import {AppError} from '../../lib/errors.js';

const list = vi.fn();
const wallets = vi.fn(() => ({list}));

// `@privy-io/node` makes real network calls from its constructor-adjacent
// methods; mock it so this test never touches the live Privy API — same
// policy `auth/verifier.test.ts` follows for `PrivyClient`.
vi.mock('@privy-io/node', () => ({
  PrivyClient: vi.fn(() => ({wallets}))
}));

describe('createPrivyUserResolver', () => {
  it('resolves {walletId, address} from the first matching stellar wallet', async () => {
    list.mockResolvedValueOnce({data: [{id: 'wallet-1', address: 'GABC', chain_type: 'stellar'}]});
    const {createPrivyUserResolver} = await import('./privy-user.js');

    const resolver = createPrivyUserResolver('app-id', 'app-secret');
    const result = await resolver.resolveStellarWallet('did:privy:abc123');

    expect(result).toEqual({walletId: 'wallet-1', address: 'GABC'});
    expect(list).toHaveBeenCalledWith({user_id: 'did:privy:abc123', chain_type: 'stellar', limit: 1});
  });

  it('throws AppError("no_stellar_wallet", 409) when the user has no stellar wallet yet', async () => {
    list.mockResolvedValue({data: []});
    const {createPrivyUserResolver} = await import('./privy-user.js');

    const resolver = createPrivyUserResolver('app-id', 'app-secret');

    await expect(resolver.resolveStellarWallet('did:privy:no-wallet')).rejects.toThrow(AppError);
    await expect(resolver.resolveStellarWallet('did:privy:no-wallet')).rejects.toMatchObject({
      code: 'no_stellar_wallet',
      statusCode: 409
    });
  });
});
