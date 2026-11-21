# Multisig approvals

When a policy has an `approval` config, certain actions queue for human approval instead of executing immediately. This page walks through the full flow: triggering an approval, listing pending ones, signing with NEP-413, and finalizing.

## Trigger condition

With an `approval.threshold` in the policy, every operation that moves funds waits for the approvers, except:

- a type listed in `approval.excluded_types`;
- a `transfer`, a `withdraw` or an `intents_transfer` that fits `approval.auto_up_to` — per window (`hourly`, `daily`, `monthly`) and token, the total that may leave without the approvers. The payment runs at once while what the wallet already spent in the token in that window, plus this amount, is at most the entry; the one that would cross it waits. The windows are those of `rules.limits` (the clock hour, the UTC day, the calendar month) and count approved payments too. A token with no entry always waits.

One rule makes an operation wait that would otherwise be refused: under an address whitelist with `rules.addresses.unlisted: 'ask'`, a payment to an address off the list answers `pending_approval` instead of `policy_denied`, however small its amount. Asked about: `transfer`, `withdraw`, `intents_transfer`, `cross_chain_withdraw` (each still held to its type, the limits and, for the last, its capability). Refused either way: `call`, `delete`, `limit_order`, `intents_storage_deposit`, `confidential`.

An approval never raises a limit: an amount above `rules.limits` is refused, approved or not.

When that happens, the action's response carries `status: 'pending_approval'` and an `approval_id`:

```ts
const result = await client.withdraw({
  chain: 'near',
  to: 'bob.near',
  amount: '50000000000000000000000000', // 50 NEAR — past what `auto_up_to` lets through
});

if (result.status === 'pending_approval') {
  console.log(`Approval ${result.approval_id} pending`);
  console.log(`${result.approved}/${result.required} approvals so far`);
}
```

## Listing pending approvals

Each approver fetches their pending queue:

```ts
const { approvals } = await client.approvals.listPending();

for (const a of approvals) {
  console.log(a.approval_id, a.type, a.request_data, `${a.approved}/${a.required}`);
}
```

## Approving

Approvers sign a NEP-413 message of the form `approve:{approval_id}:{wallet_pubkey}:{request_hash}` with their NEAR wallet (`wallet_pubkey` and `request_hash` come from the approval's detail). The signature is sent in the request body — **no API key required** (the signature itself is the auth).

```ts
import { OutlayerClient } from '@outlayer/sdk';
import { signMessage } from 'near-api-js/lib/utils'; // or your preferred signer

// 1. Build the NEP-413 message
const message = `approve:${approval.approval_id}:${approval.wallet_pubkey}:${approval.request_hash}`;
const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');

// 2. Sign with the approver's NEAR key (in browser: use NEAR Wallet Selector; in Node: keystore)
const sig = await approverWallet.signMessage({ message, nonce, recipient: 'outlayer.near' });

// 3. Submit
const response = await client.approvals.approve(approval.approval_id, {
  signature: sig.signature,
  public_key: sig.publicKey,
  account_id: sig.accountId,
  nonce,
});

console.log(response.approved, '/', response.required, 'approvals collected');

if (response.status === 'approved') {
  console.log('Threshold met — action will auto-execute');
}
```

When the approval count reaches `required`, the original action auto-executes. The next `getRequest(approval.request_id)` call returns the actual result.

## Rejecting

Same pattern, with an optional `reason`:

```ts
await client.approvals.reject(approval.approval_id, {
  signature: ...,
  public_key: ...,
  account_id: ...,
  nonce,
}, 'destination not recognized');
```

A single rejection from any approver doesn't immediately kill the request — the policy can configure that behavior. By default, the request stays open until either the threshold is met, all approvers reject, or it expires.

## Browser integration: NEAR Wallet Selector

```ts
import { setupWalletSelector } from '@near-wallet-selector/core';
import { setupMyNearWallet } from '@near-wallet-selector/my-near-wallet';

const selector = await setupWalletSelector({
  network: 'mainnet',
  modules: [setupMyNearWallet()],
});

// User connects their wallet
const wallet = await selector.wallet();

// Sign the NEP-413 message
const message = `approve:${approvalId}:${walletPubkey}:${requestHash}`;
const nonce = ...; // 32 random bytes, base64
const signed = await wallet.signMessage({
  message,
  recipient: 'outlayer.near',
  nonce: Buffer.from(nonce, 'base64'),
});

await client.approvals.approve(approvalId, {
  signature: signed.signature,
  public_key: signed.publicKey,
  account_id: signed.accountId,
  nonce,
});
```

## Who may do what

| Who | Approve operations | Change the policy | Freeze the wallet |
|---|---|---|---|
| The policy's owner — the NEAR account that stored it | only if also listed as an approver | yes; under `approval.locked`, only with the approvers' quorum | yes |
| An approver — any account in `approval.approvers` | yes | votes on a change to a locked policy | no |

All approvers are equal. An approver entry may carry a `role` (`admin`, `signer`); it is a label stored with the policy and nothing reads it — a `signer` votes on a change to a locked policy exactly as an `admin` does. To keep someone out of policy changes, do not list them as an approver of a locked policy.

## Expiration

Pending approvals expire after a default window (currently 24h, surface in `expires_at`). After expiry, the action transitions to `failed` and approvers can no longer sign for it. The agent must re-submit.

## Common patterns

### CFO-approves-large-payouts

```ts
approval: {
  threshold: { required: 1 },
  approvers: [{ id: 'cfo.near', role: 'admin' }],
  auto_up_to: { daily: { 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1': '10000000000' } }, // 10,000 USDC a day
}
```

One approver. Withdrawals run unattended until the day's total reaches 10,000 USDC; each one past that waits.

### 2-of-3 admin multisig

```ts
approval: {
  threshold: { required: 2 },
  approvers: [
    { id: 'admin-a.near', role: 'admin' },
    { id: 'admin-b.near', role: 'admin' },
    { id: 'admin-c.near', role: 'admin' },
  ],
}
```

No `auto_up_to` — every transaction goes through approval. Use for vault-style wallets where speed isn't critical.

### Bot + human safety net

```ts
rules: { limits: { per_transaction: { native: '10000000000000000000000000' } } }, // never more than 10 NEAR at once
approval: {
  threshold: { required: 1 },
  approvers: [admin1, admin2],
  auto_up_to: { daily: { native: '1000000000000000000000000' } }, // 1 NEAR a day unattended
}
```

Bot transfers freely until the day's total reaches 1 NEAR; past that each transfer needs a human sign-off, and nothing above 10 NEAR is signed at all. Single approver suffices for low-stakes recovery.
