# Multisig approvals

When a policy has an `approval` config, certain actions queue for human approval instead of executing immediately. This page walks through the full flow: triggering an approval, listing pending ones, signing with NEP-413, and finalizing.

## Trigger condition

A request requires approval if:

- The transaction value exceeds `approval.above_usd`, **or**
- The transaction is below the velocity limits but the policy explicitly says so (e.g., all withdraws to non-whitelisted addresses)

When that happens, the action's response carries `status: 'pending_approval'` and an `approval_id`:

```ts
const result = await client.withdraw({
  chain: 'near',
  to: 'bob.near',
  amount: '50000000000000000000000000', // 50 NEAR — above per-tx limit
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

Approvers sign a NEP-413 message of the form `approve:{approval_id}:{request_hash}` with their NEAR wallet. The signature is sent in the request body — **no API key required** (the signature itself is the auth).

```ts
import { OutlayerClient } from '@outlayer/sdk';
import { signMessage } from 'near-api-js/lib/utils'; // or your preferred signer

// 1. Build the NEP-413 message
const message = `approve:${approval.approval_id}:${requestHashFromApproval(approval)}`;
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
const message = `approve:${approvalId}:${requestHash}`;
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

## Roles

| Role | Approve transactions | Modify policy | Freeze wallet |
|---|---|---|---|
| `admin` | yes | yes (via `admin_quorum`) | yes |
| `signer` | yes | no | no |

Only `admin` accounts can change the policy itself; `signer` accounts can approve in-flight actions but cannot rewrite the rules. Use this to separate operational signers (frequent, lower-stakes) from governance admins (rare, high-stakes).

## Expiration

Pending approvals expire after a default window (currently 24h, surface in `expires_at`). After expiry, the action transitions to `failed` and approvers can no longer sign for it. The agent must re-submit.

## Common patterns

### CFO-approves-large-payouts

```ts
approval: {
  threshold: { required: 1, of: 1 },
  above_usd: 10000,
  approvers: [{ id: 'ed25519:cfo_pubkey', role: 'admin' }],
}
```

One approver, fires for any withdraw above $10k.

### 2-of-3 admin multisig

```ts
approval: {
  threshold: { required: 2, of: 3 },
  approvers: [
    { id: 'ed25519:admin_a', role: 'admin' },
    { id: 'ed25519:admin_b', role: 'admin' },
    { id: 'ed25519:admin_c', role: 'admin' },
  ],
}
```

No `above_usd` — every transaction goes through approval. Use for vault-style wallets where speed isn't critical.

### Bot + human safety net

```ts
rules: { limits: { per_transaction: { '*': '1000000000000000000000000' } } }, // 1 NEAR auto
approval: {
  threshold: { required: 1, of: 2 },
  approvers: [admin1, admin2],
}
```

Bot operates freely up to 1 NEAR per tx; anything bigger needs a human sign-off. Single approver suffices for low-stakes recovery.
