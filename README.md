# @outlayer/sdk

TypeScript SDK for **OutLayer Agent Custody** — multi-chain wallets for AI agents with TEE-enforced policy, multisig approvals, and gasless cross-chain transfers via NEAR Intents.

[Docs](docs/) · [Examples](examples/) · [API spec](https://api.outlayer.fastnear.com/docs) · [Source](https://github.com/out-layer/sdk-js)

## Why this SDK

If you've used Steward.fi or similar AI-agent wallet infra, you know the shape: API key in, signed transactions out. OutLayer keeps that shape but moves the trust root:

- **Keys live in a TEE** (Intel Trust Domain Extensions on Phala Cloud). The infrastructure operator cannot extract them.
- **Policy is enforced inside the TEE**, before signing, against an encrypted policy stored on the NEAR blockchain.
- **Sovereign exit** is available: a customer can permissionlessly recover their wallet's master key even if OutLayer shuts down. (Requires opting into the `vault` flow — see the [vault docs](https://outlayer.fastnear.com/docs/vaults).)
- **Multi-chain wallets** (NEAR, Ethereum, Solana, Bitcoin) with deterministic address derivation and gasless cross-chain transfers via NEAR Intents.

## Install

```bash
npm install @outlayer/sdk
```

Requires Node 18+ (uses native `fetch` and `crypto.randomUUID`). Works in the browser, Bun, and Deno with no extra config.

## 60-second quickstart

```ts
import { OutlayerClient } from '@outlayer/sdk';

// 1. Register an anonymous wallet. The API key is shown ONCE — save it.
const { apiKey, walletId, handoffUrl } = await OutlayerClient.register();
console.log('API key:', apiKey);
console.log('Set up policy:', handoffUrl);

// 2. Use the wallet
const client = new OutlayerClient({ apiKey });

const addr = await client.getAddress('near');
console.log('NEAR address:', addr.address);

const balance = await client.getBalance({ chain: 'near' });
console.log('Balance:', balance.balance);

// 3. Withdraw across chains — gasless via NEAR Intents
const result = await client.withdraw({
  chain: 'ethereum',
  to: '0x742d35Cc6634C0532925a3b844Bc9e7595f8b4f5',
  amount: '1000000', // 1 USDT (6 decimals)
  token: 'nep141:usdt.tether-token.near',
});

if (result.status === 'pending_approval') {
  console.log(`Awaiting ${result.required} approvals; ${result.approved} so far.`);
} else {
  console.log('Submitted as request', result.request_id);
}
```

That's the whole flow. The wallet has no policy yet, so withdraws are unrestricted; visit `handoffUrl` in a browser to set spending limits, allowlists, and multisig.

## What's in the SDK

| Surface | What it does |
|---|---|
| `OutlayerClient.register()` | Create a new wallet, get an API key |
| `client.getAddress(chain)` | Derive address for NEAR / Ethereum / Solana / Bitcoin |
| `client.getBalance({...})` | Read on-chain or intents.near balance |
| `client.listTokens()` | Catalog of swap-capable tokens |
| `client.call({...})` | Sign and broadcast a NEAR contract call |
| `client.transfer({...})` | Native chain transfer (currently NEAR-only at the chain layer) |
| `client.withdraw({...})` | Gasless cross-chain withdraw via NEAR Intents |
| `client.withdrawDryRun({...})` | Policy + balance check without execution |
| `client.swap({...})` | Cross-chain swap via 1Click |
| `client.swapQuote({...})` | Price preview without execution |
| `client.intentsDeposit({...})` | Move an on-NEAR FT into intents.near |
| `client.createDepositIntent({...})` | Cross-chain deposit: one-time 1Click address to fund from another chain |
| `client.getDepositStatus(id)` | Poll a cross-chain deposit intent |
| `client.confidential*({...})` | Same operations against the private **confidential shard** — shield / unshield / withdraw / swap / transfer / cross-chain deposit / balance ([see below](#confidential-intents)) |
| `client.signMessage({...})` | NEP-413 or raw message signing (NEAR identity) |
| `client.evmSignTypedData({...})` | Sign EIP-712 v4 typed data with the EVM key — e.g. a Polymarket CLOB order |
| `client.evmSignMessage({...})` | Sign an EIP-191 `personal_sign` message with the EVM key |
| `client.evmSignTransaction({...})` | Sign a raw unsigned EVM tx (you assemble + broadcast; gated by `evm_sign.raw_tx`) |
| `client.getRequest(id)` | Status of an async operation |
| `client.listRequests({...})` | List recent operations |
| `client.policy.*` | Policy lifecycle (encrypt → sign → store) |
| `client.approvals.*` | Multisig approval workflow |
| `client.audit.list({...})` | Event history |

Full reference: [API spec](https://api.outlayer.fastnear.com/docs).

## Confidential Intents

Mirror of the wallet's NEAR Intents operations against the **Defuse confidential
shard** (`intents.far` on a private NEAR shard with no public RPC). Same SDK
shape, same `wk_` API key, no extra signing on your side — just a different
balance shard. Every action is async: it returns a `request_id` you poll with
`client.getRequest(id)` until the status is terminal
(`success` / `failed` / `refunded`).

Routes return `503 confidential_unavailable` unless the deployment has
confidential intents enabled — treat that as "not offered here", not a retryable
error (it surfaces as an `OutlayerError` with `code === 'confidential_unavailable'`).

```ts
// SHIELD — move a public intents balance into the confidential shard.
// Links your wallet on chain (a convenience hop, NOT a private operation).
const shield = await client.confidentialDeposit({
  token: 'nep141:wrap.near',
  amount: '10000000000000000000000', // 0.01 wNEAR
});
// Async: poll client.getRequest(shield.request_id) until status is success / failed / refunded.

// Cross-chain DEPOSIT — fund the confidential balance from Solana USDC.
// The private path: your NEAR wallet never touches the public side.
const intent = await client.confidentialDepositIntent({
  source_asset: 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near',
  amount: '500000', // 0.5 USDC (6 decimals)
});
console.log('Send 0.5 USDC on Solana to:', intent.deposit_address);
// then poll client.getRequest(intent.intent_id) until it settles.
// NB: deposit-intent's poll key is `intent_id` (the action methods return `request_id`).

// Withdraw a confidential balance to a NEAR account as native NEAR
// (chain="near" runs a native_withdraw via 1Click).
await client.confidentialWithdraw({
  chain: 'near',
  to: 'zavodil.near',
  amount: '10000000000000000000000',
  token: 'nep141:wrap.near',
});

// Read your confidential balance(s). Pass a token for one; omit for the full list.
const one = await client.confidentialBalance({ token: 'nep141:wrap.near' });
if (!('balances' in one)) console.log('wNEAR (confidential):', one.balance);

const all = await client.confidentialBalance();
if ('balances' in all) {
  for (const b of all.balances) console.log(b.token, b.balance);
}
```

**Privacy, in one line:** SHIELD / UNSHIELD publicly link your wallet to a
"moved into the shielded pool" event; cross-chain DEPOSIT / WITHDRAW keep your
NEAR wallet invisible on chain. It is a shielded pool, not a mixer — the shard
operator, auditors, and law enforcement with a warrant can still read
confidential state. See the
[full agent integration guide](https://github.com/out-layer/coordinator/blob/main/docs/CONFIDENTIAL_INTENTS.md)
for the mental model, threat model, and privacy recipes.

## Documentation

| Topic | Read this if you want to… |
|---|---|
| [Getting started](docs/getting-started.md) | Register, set a policy, do your first withdraw |
| [Wallet operations](docs/wallets.md) | Send / receive / swap / withdraw — full method reference |
| [Policy management](docs/policy.md) | Configure spending limits, allowlists, time windows, multisig thresholds |
| [Multisig approvals](docs/approvals.md) | Wire up the NEP-413 approval flow |
| [Error handling](docs/errors.md) | Handle `PolicyDeniedError`, `WalletFrozenError`, retries |
| [Vaults (sovereign custody)](docs/vaults.md) | Bind a wallet to a deployed customer vault |
| [Migration from raw HTTP](docs/migration-from-http.md) | Move from `fetch('/wallet/v1/...')` to the SDK |

### Vault custody (advanced)

For production deployments that need **sovereign exit guarantees**, bind a wallet to a customer-owned vault. Vault deployment happens via the [dashboard](https://outlayer.fastnear.com/vault) or `outlayer vault init` CLI (not the SDK — your NEAR keys never touch us). Once deployed, binding is one option:

```ts
const wallet = await OutlayerClient.register({ vaultId: 'vault.alice.near' });
```

See [docs/vaults.md](docs/vaults.md) and https://outlayer.fastnear.com/docs/vaults.

## Examples

Runnable scripts in [`examples/`](examples/):

- `01-register.ts` — register a wallet, derive addresses on 4 chains, check balance
- `02-withdraw.ts` — gasless cross-chain withdraw with dry-run + polling
- `03-multisig.ts` — submit a withdraw that triggers the approval flow
- `04-agent-loop.ts` — minimal autonomous agent that respects policy
- `05-cross-chain-app.ts` — end-to-end DeFi flow: cross-chain login pattern, deposit instructions, swap USDT → NEAR, stake with a validator, gasless withdraw back to Ethereum. CLI with sub-commands (`addresses | balances | buy-near | stake | unstake | withdraw-eth | login-demo`).
- `06-confidential-roundtrip.ts` — confidential shard round-trip: SHIELD → read balance → UNSHIELD, with `503 confidential_unavailable` handling.

Run with:

```bash
npx tsx examples/01-register.ts                                            # no auth needed
OUTLAYER_API_KEY=wk_... npx tsx examples/02-withdraw.ts                    # needs API key
OUTLAYER_API_KEY=wk_... npx tsx examples/05-cross-chain-app.ts addresses   # cross-chain identity
```

## Errors

Every non-2xx response is thrown as a typed subclass of `OutlayerError`:

```ts
import { OutlayerClient, PolicyDeniedError, WalletFrozenError } from '@outlayer/sdk';

try {
  await client.withdraw({ chain: 'near', to: 'bob.near', amount: '100' });
} catch (err) {
  if (err instanceof PolicyDeniedError) {
    console.log('Policy rejected:', err.message);
  } else if (err instanceof WalletFrozenError) {
    console.log('Wallet is frozen by the controller');
  } else {
    throw err;
  }
}
```

See [errors.md](docs/errors.md) for the full list.

## Retry, idempotency, network failures

Transient 5xx and network errors are retried automatically (3 attempts, exponential backoff 100ms → 1.6s). 4xx is not retried — those are deterministic.

Write operations get an auto-generated `Idempotency-Key` per call; retries from the SDK's own retry layer reuse the same key, so repeated calls don't double-spend. To control idempotency yourself (e.g., for at-least-once delivery from a queue):

```ts
await client.withdraw({
  chain: 'near',
  to: 'bob.near',
  amount: '1000000000000000000000000',
  idempotencyKey: 'my-job-id-12345',
});
```

Reusing the same key returns the original result without re-executing.

## Configuration

```ts
const client = new OutlayerClient({
  apiKey: process.env.OUTLAYER_API_KEY!,
  network: 'mainnet',                           // default; or 'testnet'
  baseUrl: 'https://api.outlayer.fastnear.com', // optional, overrides network
  fetch: customFetch,                           // optional, for SSR/proxies
  retry: {
    maxAttempts: 5,
    initialDelayMs: 200,
    maxDelayMs: 4000,
  },
});
```

### Testnet vs mainnet

`network: 'testnet'` targets `https://api.testnet.outlayer.fastnear.com`. Useful for development without spending real funds.

**Important**: NEAR Intents (cross-chain swaps and gasless withdrawals) only work on mainnet. On testnet you can still:
- register a wallet, derive addresses
- read balances, set policy, sign messages
- submit NEAR contract calls
- sign EVM payloads (`evmSignTypedData` / `evmSignMessage` / `evmSignTransaction`) — pure off-chain secp256k1 signing, no intents/mainnet dependency

…but `swap`, `intentsWithdraw`, and `intentsDeposit` will fail at the intents layer.

## Browser usage

Don't ship your API key to a browser. The key has full wallet authority. Either:

1. **Proxy through your backend** — frontend calls your backend, your backend calls OutLayer.
2. **Use a payment key for that single tx** — created via the dashboard, scoped to a specific operation.

The SDK works in browsers, but only with keys you've already gated.

## Versioning

This is `0.1.0-alpha` — expect breaking changes until `0.x` stabilizes around v1. Breaking changes will be documented in [`CHANGELOG.md`](CHANGELOG.md). Pin to a patch version (`0.1.0-alpha.1`) in production until v1.

## Contributing

The OpenAPI spec is the source of truth — when adding endpoints, update [out-layer/api-spec](https://github.com/out-layer/api-spec) first, regenerate types here with `npm run gen`, then add ergonomic wrappers in `src/client.ts`.

```bash
git clone https://github.com/out-layer/sdk-js
cd sdk-js
npm install
npm run gen        # regenerate src/types.ts from spec
npm run typecheck
npm test
npm run build
```

## License

MIT.
