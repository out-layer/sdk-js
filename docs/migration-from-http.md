# Migration from raw HTTP

If you've been calling the OutLayer API directly with `fetch`, here's the equivalent SDK code. The behavior is the same — the SDK just adds typing, retries, idempotency, and typed errors.

## Register

**Before:**

```ts
const res = await fetch('https://api.outlayer.fastnear.com/register', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({}),
});
const { api_key, wallet_id, near_account_id } = await res.json();
```

**After:**

```ts
const { apiKey, walletId, nearAccountId } = await OutlayerClient.register();
```

## Address

**Before:**

```ts
const res = await fetch(
  'https://api.outlayer.fastnear.com/wallet/v1/address?chain=near',
  { headers: { Authorization: `Bearer ${apiKey}` } },
);
const { address } = await res.json();
```

**After:**

```ts
const { address } = await client.getAddress('near');
```

## Withdraw

**Before:**

```ts
const idempotencyKey = crypto.randomUUID();
const res = await fetch('https://api.outlayer.fastnear.com/wallet/v1/intents/withdraw', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'Idempotency-Key': idempotencyKey,
  },
  body: JSON.stringify({
    chain: 'ethereum',
    to: '0x...',
    amount: '1000000',
    token: 'nep141:usdt.tether-token.near',
  }),
});

if (!res.ok) {
  const err = await res.json();
  if (err.error === 'policy_denied') { /* handle */ }
  throw new Error(err.message);
}
const result = await res.json();
```

**After:**

```ts
try {
  const result = await client.withdraw({
    chain: 'ethereum',
    to: '0x...',
    amount: '1000000',
    token: 'nep141:usdt.tether-token.near',
  });
} catch (err) {
  if (err instanceof PolicyDeniedError) { /* handle */ }
  throw err;
}
```

The SDK auto-generates the idempotency key (or accepts your own via `idempotencyKey: ...`), wraps the policy errors into typed classes, and retries on 5xx automatically.

## Approvals (NEP-413 signature)

**Before:** you had to construct the request body manually.

**After:**

```ts
await client.approvals.approve(approvalId, {
  signature, public_key, account_id, nonce,
});
```

## Polling a request

**Before:**

```ts
while (true) {
  const res = await fetch(`.../wallet/v1/requests/${requestId}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const s = await res.json();
  if (s.status === 'success' || s.status === 'failed') break;
  await new Promise(r => setTimeout(r, 2000));
}
```

**After:**

```ts
while (true) {
  const s = await client.getRequest(requestId);
  if (s.status === 'success' || s.status === 'failed') break;
  await new Promise(r => setTimeout(r, 2000));
}
```

(The SDK doesn't add polling helpers — that's intentional. Polling logic depends on your timeout budget and error semantics, which differ per use case.)

## What the SDK adds, even for trivial calls

- **Type-safe request/response** — your IDE auto-completes fields.
- **Automatic Idempotency-Key on writes** — safe to retry from your own code.
- **Internal retries on 5xx + network errors** — exponential backoff, configurable.
- **Typed errors** — `instanceof PolicyDeniedError` instead of string matching `err.error === 'policy_denied'`.
- **Browser + Node + Bun + Deno** — uses standard `fetch`, no Node-specific deps.

For trivial GETs the SDK is a wash; for writes with policy errors, retries, and idempotency, the SDK saves real boilerplate.
