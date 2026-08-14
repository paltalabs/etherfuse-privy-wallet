# Privy × Stellar spike — 2026-07-23T15:41:10.498Z
- Sponsor: `GCHLXZYVRTY6AVHY434FOGS24LF3J7TY7NYP6XQHKESJZNEO3QAEFFHJ`
- Issuer: `GBQUTGV2P3TL4NBTO2NOC5PQGWRMLMUMU22ADKFB6BL52HFIRALGXCOJ`
- Merchant (Privy wallet `[redacted-privy-wallet-id]`): `GDQPVFW43T5LMFQTOP7Q2H5XCZW47ZPONIEMUUYDC6H2PSSBN6IFDSB5`
- **Leg 1 — sponsored provisioning (create + trustline)**: [`aebbb650d6695d59d4dcd0cf86e27ca5c731ec6fe615cf0d8cdd9c4a058443ce`](https://stellar.expert/explorer/testnet/tx/aebbb650d6695d59d4dcd0cf86e27ca5c731ec6fe615cf0d8cdd9c4a058443ce)
- **Leg 2 — issuer funds merchant (100 SPIKE)**: [`8c5fcaac7c17064089419987f342ee0c82313cae8dec60ff9bcc0709939a0578`](https://stellar.expert/explorer/testnet/tx/8c5fcaac7c17064089419987f342ee0c82313cae8dec60ff9bcc0709939a0578)
- **Leg 3 — classic payment (merchant rawSign, sponsor fee-bump)**: [`ea453da11b7dd959239740db45aa00f04209de68b5e5b93a11b7221be91ed7d5`](https://stellar.expert/explorer/testnet/tx/ea453da11b7dd959239740db45aa00f04209de68b5e5b93a11b7221be91ed7d5)
- **Leg 4a — SAC deploy**: `22df241853eb0abb35d0d7d67cbd786f687f7eb2df5f4f525a7bae31f09d0d7a` (status PENDING)
- SPIKE SAC contract: `CCRQKJFVUDJKI7HDNYQAGHZ7CVGBA376C6EV5F7YUAW7FJABG7GGJ56G`
- **Leg 4b prep — sponsor establishes SPIKE trustline (required as SAC transfer destination)**: [`03d03f07654ec67b7149cf8212b294f1477e8e9937e3dfa77d9d42477dff7e6c`](https://stellar.expert/explorer/testnet/tx/03d03f07654ec67b7149cf8212b294f1477e8e9937e3dfa77d9d42477dff7e6c)
- **Leg 4b — Soroban SAC transfer (merchant rawSign, sponsor fee-bump)**: [`777b1b3c3b19a6d2c0bf9921b14721879838e8abd3d6506ce21b60c03b5052c1`](https://stellar.expert/explorer/testnet/tx/777b1b3c3b19a6d2c0bf9921b14721879838e8abd3d6506ce21b60c03b5052c1) (status PENDING)
- Merchant final XLM balance: `0.0000000` (expected 0.0000000)

## On-chain verification (Horizon, post-run)

`curl -s "https://horizon-testnet.stellar.org/accounts/GDQPVFW43T5LMFQTOP7Q2H5XCZW47ZPONIEMUUYDC6H2PSSBN6IFDSB5"`:

- SPIKE trustline: present, balance `80.0000000` (100 funded − 10 classic payback − 10 SAC transfer), sponsor `GCHLXZYVRTY6AVHY434FOGS24LF3J7TY7NYP6XQHKESJZNEO3QAEFFHJ`.
- Native (XLM) balance: `0.0000000`.
- `num_sponsored`: `3`, not the draft integration notes' expected `2` — this is correct, not a bug: a fresh Stellar account's minimum reserve is 2 base reserves (not 1), so `beginSponsoringFutureReserves`/`createAccount` sponsors both, plus 1 more for the SPIKE trustline = 3 sponsored reserves total. All of them are sponsor-paid; the merchant genuinely holds zero XLM even for its own base account reserve.

## Client-side signing (browser)

Date: 2026-07-23.

Proves the merchant-signed half of the signing requirement client-side: Privy login modal → embedded Stellar wallet created in-browser → `useSignRawHash` produces a signature that verifies against the wallet's own public key, with no backend involved (`app/src/spike/SigningSpike.tsx`).

- Login method: Privy email OTP, `[redacted-login-email]` (automated browser session; OTP read from the login inbox).
- Privy user: `did:privy:[redacted]`.
- Stellar embedded wallet created in-browser: `GCFT36CUX6GBXQMSMQIZI2AAXZGSMB23NHQ3NX2SVKRCUIQZSIOTCDLD`.
- Test hash: `0xc1f9dcd2ad696971e45dc7ba6e67032b7f63ceed22adba621a91bcdfc4d6e462`.
- Signature: `0x4e0e7f2d11f5b8ffc6a9db5aff1c268da8ea0fa3fdc15d618e8b1d7bda8c54d933ecb6e8e53ee53ff6e8fb208fd7386df12959ff228da96ff1bcfb84c186640f`.
- Result displayed on page: **`verified=true`** — `Keypair.fromPublicKey(walletAddress).verify(hashBytes, signatureBytes)` returned `true` in the browser, confirming the embedded wallet's raw-hash signature is valid for its own Stellar public key.
- No console errors or warnings during the run (checked via `browser_console_messages`).
- Screenshot: [`browser-signing-spike.png`](./browser-signing-spike.png).
