# Error handling

Every non-2xx response from the API is thrown as a typed subclass of `OutlayerError`. This page covers the hierarchy, the common cases, and the SDK's retry semantics.

## Error class hierarchy

```
OutlayerError                          // base class
├── PolicyDeniedError                  // code: 'policy_denied'
├── WalletFrozenError                  // code: 'wallet_frozen'
├── UnauthorizedError                  // codes: 'missing_auth', 'invalid_api_key', 'timestamp_expired'
├── RateLimitedError                   // code: 'rate_limited'
├── NotFoundError                      // codes: 'request_not_found', 'approval_not_found'
└── BadRequestError                    // codes: 'bad_request', 'invalid_address', 'insufficient_balance', 'unsupported_chain', 'unsupported_token'
```

Every error has:

```ts
class OutlayerError extends Error {
  readonly code: ErrorCode;          // discriminant
  readonly status: number;           // HTTP status
  readonly message: string;          // human-readable
  readonly details: unknown;         // structured context if the API returns it
}
```

## Pattern 1: `instanceof` for known cases

```ts
import { OutlayerClient, PolicyDeniedError, WalletFrozenError, RateLimitedError } from '@outlayer/sdk';

try {
  await client.withdraw({ chain: 'near', to: 'bob.near', amount: '...' });
} catch (err) {
  if (err instanceof WalletFrozenError) {
    // Stop trying. The controller has frozen the wallet.
    notifyOperator('Wallet frozen — escalating');
    return;
  }
  if (err instanceof PolicyDeniedError) {
    // The policy rejected this specific action. Caller's mistake.
    console.error('Action exceeds policy:', err.message);
    return;
  }
  if (err instanceof RateLimitedError) {
    // Back off and try later
    await sleep(60_000);
    return;
  }
  throw err;
}
```

## Pattern 2: discriminate on `err.code`

If you prefer a single switch:

```ts
try {
  await client.withdraw({...});
} catch (err) {
  if (!(err instanceof OutlayerError)) throw err;
  switch (err.code) {
    case 'policy_denied':       return handlePolicyViolation(err);
    case 'wallet_frozen':       return notifyFrozen();
    case 'rate_limited':        return scheduleRetryIn(60_000);
    case 'insufficient_balance':return topUp();
    case 'network_error':       return; // already retried — give up
    default: throw err;
  }
}
```

## Pattern 3: structured logging

Every error has `code`, `status`, `message`, and `details`. Log them all:

```ts
catch (err) {
  if (err instanceof OutlayerError) {
    logger.warn({
      code: err.code,
      status: err.status,
      message: err.message,
      details: err.details,
    }, 'outlayer call failed');
  }
  throw err;
}
```

## Retry semantics

The SDK retries automatically on:

- **5xx responses** — 3 attempts, exponential backoff 100ms → 200ms → 400ms (configurable)
- **Network errors** (`TypeError` from `fetch`) — same backoff

The SDK does **NOT** retry on:

- **4xx responses** — these are deterministic (policy_denied, invalid_address, etc.). Retrying won't help.
- **Rate limits (429)** — the server tells you when to come back; respect it.

Configure per-client:

```ts
const client = new OutlayerClient({
  apiKey,
  retry: {
    maxAttempts: 5,
    initialDelayMs: 200,
    maxDelayMs: 4000,
  },
});
```

To disable retries entirely:

```ts
const client = new OutlayerClient({
  apiKey,
  retry: { maxAttempts: 1 },
});
```

## Idempotency under retry

Write operations get an auto-generated `Idempotency-Key` that's **stable across the SDK's internal retries**. So if a withdraw times out and the SDK retries, the server sees the same key and returns the same result (or rejects with `duplicate_idempotency_key` if the original is in-flight).

If you're the one handling retries (e.g., from a job queue), pass your own key to make at-least-once delivery safe:

```ts
await client.withdraw({
  chain: 'near',
  to: 'bob.near',
  amount: '...',
  idempotencyKey: jobId, // your stable job ID
});
```

## Special case: `pending_approval` is not an error

When a request triggers the approval threshold, the response is:

```ts
{ status: 'pending_approval', request_id: '...', approval_id: '...', required: 2, approved: 0 }
```

This is **not an error** — the action is queued, not rejected. Check `result.status` before assuming success:

```ts
const result = await client.withdraw({...});
switch (result.status) {
  case 'processing':       /* in-flight */ break;
  case 'success':          /* done */      break;
  case 'pending_approval': /* multisig */  break;
  case 'failed':           /* settled with error */ break;
  default: throw new Error(`unexpected status: ${result.status}`);
}
```

## All error codes reference

| Code | HTTP | When |
|------|------|------|
| `missing_auth` | 401 | No `Authorization` header |
| `invalid_api_key` | 401 | Key not found or revoked |
| `timestamp_expired` | 401 | Signed-message timestamp too old |
| `wallet_frozen` | 403 | Controller froze the wallet on-chain |
| `policy_denied` | 403 | Action violates a policy rule |
| `not_approver` | 403 | Caller's NEAR account is not in the approvers list |
| `insufficient_balance` | 400 | Not enough funds for the requested amount + fees |
| `invalid_address` | 400 | Bad destination address format |
| `unsupported_chain` | 400 | Chain not implemented (e.g., direct `transfer` to non-NEAR) |
| `unsupported_token` | 400 | Token not in the catalog |
| `bad_request` | 400 | Schema validation failure or other client mistake |
| `request_not_found` | 404 | No `wallet_request` with that ID |
| `approval_not_found` | 404 | No pending approval with that ID |
| `rate_limited` | 429 | Too many requests |
| `duplicate_idempotency_key` | 200 | Returns the original result; not an error |
| `internal_error` | 500 | Server error |
| `network_error` | — | SDK-side: network failure after retries exhausted |
| `parse_error` | — | SDK-side: response body wasn't valid JSON |
