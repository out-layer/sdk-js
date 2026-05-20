# Wallet operations

Reference for every wallet method on `OutlayerClient`.

All methods return a `Promise`. All errors are typed subclasses of `OutlayerError` — see [errors.md](errors.md).

## Address derivation

```ts
const { address, public_key } = await client.getAddress('ethereum');
```

Supported chains: `near`, `ethereum`, `solana`, `bitcoin`. The same `wallet_id` always produces the same address per chain (deterministic HMAC-SHA256 inside the TEE).

## Balance

```ts
const { balance, token } = await client.getBalance({ chain: 'near' });
```

- `chain` (default `near`) — currently only NEAR is supported for direct balance reads. Read other chains via the upstream RPC.
- `token` — token ID (`nep141:<contract>`). Omit for native asset.
- `source` — `chain` (default) or `intents` to read the wallet's intents.near balance via `mt_balance_of`.

## Token catalog

```ts
const { tokens } = await client.listTokens();
// [{ id: 'wrap.near', symbol: 'wNEAR', chains: ['near', ...], decimals: 24, defuse_asset_id: 'nep141:wrap.near' }, ...]
```

## Native NEAR transfer

```ts
const result = await client.transfer({
  receiver_id: 'bob.near',
  amount: '1000000000000000000000000', // 1 NEAR in yoctoNEAR
});
```

`chain` defaults to `near`. Other chains currently return `unsupported_chain` — use `withdraw` (gasless via Intents) instead.

## NEAR contract call

```ts
const result = await client.call({
  receiver_id: 'usdt.tether-token.near',
  method_name: 'ft_transfer',
  args: { receiver_id: 'bob.near', amount: '1000000' },
  gas: '30000000000000', // 30 TGas, default
  deposit: '1',          // 1 yoctoNEAR (required for ft_transfer)
});
```

`args` is a JSON object. For non-JSON encodings, pass `args_base64` instead.

`result.status` is `processing` on submission, `success` / `failed` after settlement, or `pending_approval` if the call exceeds policy limits.

## Cross-chain withdraw (gasless, via Intents)

```ts
const result = await client.withdraw({
  chain: 'ethereum',
  to: '0x742d35Cc6634C0532925a3b844Bc9e7595f8b4f5',
  amount: '1000000',
  token: 'nep141:usdt.tether-token.near',
});
```

The wallet must first have the source token deposited in intents.near (see `intentsDeposit` below). No gas is required on either chain — the solver relay covers it, and the cost is folded into the swap rate.

### Simulate before executing

```ts
const dryRun = await client.withdrawDryRun({
  chain: 'ethereum',
  to: '0x742d...',
  amount: '1000000',
  token: 'nep141:usdt.tether-token.near',
});

console.log('Would succeed:', dryRun.would_succeed);
console.log('Estimated fee:', dryRun.estimated_fee, dryRun.fee_token);
console.log('Policy decision:', dryRun.policy_check?.decision);
```

Dry-run runs the full policy + balance check without signing or broadcasting. Use this in interactive UIs to show the user whether their action will succeed.

## Cross-chain swap (1Click)

```ts
// 1. Preview the rate
const quote = await client.swapQuote({
  token_in: 'nep141:wrap.near',
  token_out: 'nep141:usdt.tether-token.near',
  amount_in: '5000000000000000000000000',
});
console.log('Expected output:', quote.amount_out, 'min:', quote.min_amount_out);

// 2. Execute
const result = await client.swap({
  token_in: 'nep141:wrap.near',
  token_out: 'nep141:usdt.tether-token.near',
  amount_in: '5000000000000000000000000',
  min_amount_out: quote.min_amount_out, // slippage guard
});
```

The swap goes through the 1Click solver: quote → deposit to intents.near → mt_transfer → poll for settlement. `result.amount_out` is the actual settled amount.

## Deposit FT into intents.near

```ts
await client.intentsDeposit({
  token: 'wrap.near',
  amount: '5000000000000000000000000',
});
```

Wraps `ft_transfer_call` to `intents.near` with auto storage-deposit if the wallet hasn't registered there yet. Required once per token before swaps or cross-chain withdraws.

## Sign a message (NEP-413)

```ts
const sig = await client.signMessage({
  message: 'login:myapp:1716200000',
  recipient: 'myapp.example',
  format: 'nep413', // default; also accepts 'raw'
});

console.log(sig.signature, sig.public_key);
```

Use this for login flows, off-chain attestations, or any context that needs a signed message tied to the wallet's NEAR identity. The TEE signs; the policy still applies (a frozen wallet cannot sign).

## Async request tracking

Withdraws, swaps, calls, and transfers all return a `request_id`. Settlement may be synchronous (NEAR call) or asynchronous (Intents):

```ts
const result = await client.withdraw({...});

// Poll until done
while (true) {
  const status = await client.getRequest(result.request_id);
  if (status.status === 'success' || status.status === 'failed') break;
  if (status.status === 'pending_approval') {
    console.log('Waiting for approval', status.result);
    break;
  }
  await new Promise(r => setTimeout(r, 2000));
}
```

Or list recent requests:

```ts
const { requests, total } = await client.listRequests({
  type: 'withdraw',
  status: 'success',
  limit: 20,
});
```

## Idempotency

All write methods accept an `idempotencyKey`:

```ts
await client.withdraw({
  chain: 'near',
  to: 'bob.near',
  amount: '...',
  idempotencyKey: 'job-12345',
});
```

If the SDK auto-generates a key (default), it's stable across the SDK's internal retries. For at-least-once delivery from a job queue, pass your own key — calling with the same key returns the original result.
