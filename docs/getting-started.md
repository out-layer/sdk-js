# Getting started

This guide walks through registering a wallet, setting a policy, and performing your first withdrawal. Plan ~10 minutes.

## Prerequisites

- Node 18+ (or Bun, Deno, or a modern browser bundler)
- A NEAR wallet for the **controller** account (the human or DAO that will manage policy and approve large transactions)

## 1. Install

```bash
npm install @outlayer/sdk
```

## 2. Register a wallet

The first step creates a fresh wallet and returns an API key. The key is shown **once** — save it before the response goes out of scope.

```ts
import { OutlayerClient } from '@outlayer/sdk';

const { apiKey, walletId, handoffUrl, nearAccountId } = await OutlayerClient.register();

console.log('API key:', apiKey);
console.log('Wallet ID:', walletId);
console.log('NEAR address:', nearAccountId);
console.log('Set policy at:', handoffUrl);
```

Output looks like:

```
API key:      wk_2a8b1f3c4d5e6789abcdef0123456789
Wallet ID:    9c3c9e10-1c1f-4f5e-9c4a-1d7b9a8f3c20
NEAR address: 9c3c9e101c1f4f5e9c4a1d7b9a8f3c20
Set policy:   https://outlayer.fastnear.com/wallet?api_key=wk_2a8b...
```

The wallet is now active. It has no policy, so all operations are permitted up to the trial limits.

## 3. Set a policy (optional but strongly recommended)

Without a policy, an attacker who steals the API key can drain the wallet. Setting a policy locks the wallet to specific addresses, amounts, and rate limits — even if the key leaks.

### Option A: dashboard (recommended for first time)

Open `handoffUrl` in a browser. Connect your controller NEAR account. Fill in the policy form. The dashboard handles encryption, signing, and the on-chain submission.

### Option B: programmatic

```ts
// Build the policy on the SDK side
const policy = {
  rules: {
    limits: {
      per_transaction: { '*': '10000000000000000000000000' }, // 10 NEAR
      daily: { '*': '100000000000000000000000000' },          // 100 NEAR / day
    },
    addresses: { mode: 'whitelist' as const, list: ['bob.near', 'dex.near'] },
    rate_limit: { max_per_hour: 60 },
  },
};

// 1. Encrypt it via the keystore TEE
const encrypted = await client.policy.encrypt({
  wallet_id: walletId,
  rules: policy.rules,
});

// 2. Get a signature from the keystore (proves key ownership)
const sig = await client.policy.sign(encrypted.encrypted_base64);

// 3. Submit `store_wallet_policy` on-chain (your controller account pays storage)
//    Use near-api-js, near-cli, or your favorite NEAR client to call:
//
//    outlayer.near::store_wallet_policy({
//      wallet_pubkey: encrypted.wallet_pubkey,
//      encrypted_data: encrypted.encrypted_base64,
//      signature: sig.signature_hex,
//    })

// 4. Tell the coordinator to drop its negative-policy cache
await client.policy.invalidateCache(walletId);
```

See [policy.md](policy.md) for the full schema, including multisig configuration.

## 4. Fund the wallet

The wallet is a regular NEAR account. Send funds to its `nearAccountId`. For cross-chain operations (withdraw to Ethereum, etc.) you need to **deposit into intents.near**:

```ts
// Wrap NEAR if you don't have wrapped NEAR yet
await client.call({
  receiver_id: 'wrap.near',
  method_name: 'near_deposit',
  args: {},
  deposit: '5000000000000000000000000', // 5 NEAR
});

// Deposit wrapped NEAR into intents.near
await client.intentsDeposit({
  token: 'wrap.near',
  amount: '5000000000000000000000000',
});
```

Now the wallet has 5 wNEAR sitting in intents.near, ready for cross-chain ops.

## 5. Your first withdraw

```ts
const result = await client.withdraw({
  chain: 'ethereum',
  to: '0x742d35Cc6634C0532925a3b844Bc9e7595f8b4f5',
  amount: '1000000', // 1 USDT (6 decimals)
  token: 'nep141:usdt.tether-token.near',
});

console.log('Status:', result.status);
console.log('Request ID:', result.request_id);
```

If the policy lets it through, `status` is `processing`; poll `getRequest(result.request_id)` for the final status. If it requires approval, `status` is `pending_approval` — see [approvals.md](approvals.md).

## 6. Verify the wallet's behavior

```ts
// Verify the withdraw landed
const req = await client.getRequest(result.request_id);
console.log(req.status, req.result);

// See the full event history
const audit = await client.audit.list({ limit: 10 });
audit.events.forEach((e) => console.log(e.at, e.type, e.details));
```

## What to read next

- [Wallet operations](wallets.md) — the full method reference
- [Policy management](policy.md) — limits, allowlists, time restrictions, multisig
- [Approvals](approvals.md) — wire up the multisig flow
- [Errors](errors.md) — handle `PolicyDeniedError`, `WalletFrozenError`, retries
