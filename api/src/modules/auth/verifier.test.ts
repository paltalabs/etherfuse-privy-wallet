import {describe, expect, it, vi} from 'vitest';

const verifyAccessToken = vi.fn();
const auth = vi.fn(() => ({verifyAccessToken}));
const utils = vi.fn(() => ({auth}));

// `@privy-io/node` makes real network calls from its constructor-adjacent
// methods; mock it so this test never touches the live Privy API (only the
// fake-verifier path is allowed to run in tests per the auth module's test
// policy — this mocks the SDK boundary, it does not call Privy for real).
vi.mock('@privy-io/node', () => ({
  PrivyClient: vi.fn(() => ({utils}))
}));

describe('createPrivyAuthVerifier', () => {
  it('maps a successful verifyAccessToken response\'s user_id to privyDid', async () => {
    verifyAccessToken.mockResolvedValueOnce({
      app_id: 'app-1',
      issuer: 'privy.io',
      issued_at: 1,
      expiration: 2,
      session_id: 'session-1',
      user_id: 'did:privy:abc123'
    });
    const {createPrivyAuthVerifier} = await import('./verifier.js');

    const verifier = createPrivyAuthVerifier('app-id', 'app-secret');
    const result = await verifier.verify('some-access-token');

    expect(result).toEqual({privyDid: 'did:privy:abc123'});
    expect(verifyAccessToken).toHaveBeenCalledWith('some-access-token');
  });

  it('propagates rejection when the token is invalid', async () => {
    verifyAccessToken.mockRejectedValueOnce(new Error('invalid token'));
    const {createPrivyAuthVerifier} = await import('./verifier.js');

    const verifier = createPrivyAuthVerifier('app-id', 'app-secret');

    await expect(verifier.verify('bad-token')).rejects.toThrow('invalid token');
  });
});
