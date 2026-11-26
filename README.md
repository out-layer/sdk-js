# @outlayer/sdk

TypeScript SDK for **OutLayer Agent Custody** — multi-chain wallets for AI agents with TEE-enforced policy, multisig approvals, and gasless cross-chain transfers via NEAR Intents.

[Docs](docs/) · [Examples](examples/) · [API spec](https://api.outlayer.ai/docs) · [Source](https://github.com/out-layer/sdk-js)

## Why this SDK

If you've used Steward.fi or similar AI-agent wallet infra, you know the shape: API key in, signed transactions out. OutLayer keeps that shape but moves the trust root:

- **Keys live in a TEE** (Intel Trust Domain Extensions). The infrastructure operator cannot extract them.
- **Policy is enforced inside the TEE**, before signing, against an encrypted policy stored on the NEAR blockchain.
- **Sovereign exit** is available: a wallet's owner can permissionlessly leave with its keys even if OutLayer shuts down. Two ways: the **owner exit** — a NEAR account registers once, the agent asks for the wallet with `OutlayerClient.createExitLink()`, no contract to deploy — and a **vault** of your own, which takes the secrets out too. See [leaving OutLayer](https://app.outlayer.ai/docs/leaving).
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
| `client.getAddress(chain, subPath?)` | Derive address for NEAR / EVM (incl. HyperEVM) / Solana; `subPath` = an EVM sub-key |
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
| `client.claimTrialKey()` | The wallet's trial: a nonce-0 payment key for connector calls in its first week |
| `client.redeemSponsorCode(code)` | Redeem a sponsor code (`spn_…`): a subscription on the nonce-0 key, paid by the sponsor |
| `client.getPaymentKey()` | The nonce-0 key derived again — send it as `X-Payment-Key`; nothing to store |
| `client.getWalletContractKey()` / `client.putWalletContract(account)` / `client.getWalletContract()` | On-chain custody: name the wallet contract of a wallet ([see below](#on-chain-custody)) |
| `AgentKey` / `WalletContract` | On-chain custody: run the wallet contract's operations under the agent's own signature |
| `client.getRequest(id)` | Status of an async operation |
| `client.listRequests({...})` | List recent operations |
| `client.policy.*` | Policy lifecycle (encrypt → sign → store) |
| `client.approvals.*` | Multisig approval workflow |
| `client.audit.list({...})` | Event history |
| `createWebhookKeyCache()` / `verifyWebhook({...})` | Check that a webhook is OutLayer's and about your wallet — Ed25519, no secret ([see below](#verifying-webhooks)) |

Full reference: [API spec](https://api.outlayer.ai/docs).

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

## On-chain custody

An agent with on-chain custody keeps its main balance in a **wallet contract**:
a NEAR account that runs the two-key variant of the NEAR Intents wallet
contract. The wallet contract executes a request only under two signatures,
one by the agent's own Ed25519 key and one by a key in OutLayer's enclave,
which signs only an operation the owner's policy allows.

The wallet behind `OutlayerClient` keeps its key in the enclave (TEE custody).
The two serve different needs, and an agent with on-chain custody uses both:
the wallet contract holds the main balance, and the wallet is the separate
account where the agent keeps what it works with and which pays the gas of
relaying. What on-chain custody adds is that the chain itself requires both
signatures for every move out of the wallet contract. What it costs is a NEAR
transaction and its gas per move, and a signature made on the agent's side.

### Setting it up

For a wallet with an owner. The agent opens a setup and hands its owner a
link; the owner installs the wallet contract on the page behind it and leaves
the agent its key.

```ts
import { collectSetup, openSetup } from '@outlayer/sdk';

const options = { apiKey: process.env.OUTLAYER_API_KEY! };
const setup = await openSetup(options);
// Give setup.url to the wallet's owner. Keep setup.key in memory.

const collected = await collectSetup(options, setup.key);
// null while the owner has not finished; then:
// { account, key, seed }: the wallet contract's account, the agent's key,
// and its 32-byte seed.
```

`seed` is the agent's secret: store it where the agent keeps its secrets, and
make the key again with `AgentKey.fromSeed(seed)`. The key comes from one
signature of the owner's own key, so the owner can derive it again.

`collectSetup` refuses a key that is not the agent's key in the contract's
pair. `client.getWalletContract()` reads the account and that public key back;
it throws `NotFoundError` for a wallet with no wallet contract.
`client.getWalletContractKey()` and `client.putWalletContract(account)` are
the same steps for an owner who installs the contract without the page.

### Running an operation

The operation routes take no API key. `WalletContract` signs every request
with the agent's key.

```ts
import { AgentKey, WalletContract } from '@outlayer/sdk';

const contract = new WalletContract({
  account: 'trader.alice.near', // the wallet contract's account
  key,
  teePublicKey: tee_public_key, // verify the enclave's half before signing
  // baseUrl: 'https://testnet-api.outlayer.ai',
});

const op = { kind: 'transfer', to: 'bob.near', amount: '1000000000000000000000000' } as const;
const state = await contract.run('pay-1', op);

if (state.status === 'pending_approval') {
  // The policy asks for approvers: they vote on state.approval_id.
  // An approval starts nothing. After they voted, ask again under the same id:
  await contract.run('pay-1', op);
}
```

`run(id, op)` asks for the operation under an id of the agent's choice (1 to
64 letters, digits, `-`, `_`). When the answer is `awaiting_signature` it
checks that the returned request is the operation that was asked for, from
this wallet contract (`messageIsFor`); with `teePublicKey` it verifies the
enclave's half; then it signs the agent's half, last, and relays. It returns
where the operation stands:

| `status` | Meaning |
|---|---|
| `pending_approval` | Waits for approvers (`approval_id`). Call `run` again with the same id and the same operation after they voted. |
| `success` / `failed` | The outcome on chain (`tx_hash`, `result`). |
| `relayed` | The transaction was sent and its outcome is not recorded yet; `contract.get(id)` settles it. |
| `closed` | Ended with nothing sent, for `reason`: the vote did not end in approval, or a prepared request was not relayed within an hour. |

Asking again under the same id continues the same operation; the same id with
another operation is refused. Usage against the policy's limits is counted
when the request is prepared, and it is not given back. `ask`, `relay` and
`get` are the steps of `run`, for an agent that drives them itself.

An operation is one of six kinds. Amounts are decimal strings in the smallest
unit; a token is its id inside NEAR Intents (`nep141:<account>`).

| `kind` | Fields | What it does |
|---|---|---|
| `transfer` | `to`, `amount` | Sends NEAR from the wallet contract |
| `call` | `to`, `method`, `args_base64`, `gas`, `deposit` | A function call from the wallet contract |
| `withdraw` | `to`, `amount`, `token` | A NEP-141 token out of NEAR Intents to a NEAR account |
| `intents_transfer` | `to`, `amount`, `token` | A token to another account inside NEAR Intents |
| `swap` | `token_in`, `amount_in`, `token_out`, `min_out` | A swap through 1Click; the output arrives in the wallet contract's balance inside NEAR Intents |
| `cross_chain_withdraw` | `to`, `amount`, `token`, `chain` | A withdrawal to another chain through 1Click |

For a swap and a withdrawal to another chain the state carries `quote` (what
1Click quoted) and, once the input was sent, `route_status` on a read.

A refusal is a `CustodyError`: one of the API's, with its `code` and `status`
(`policy_denied`, `wallet_frozen`, `wallet_busy`, `below_min_amount_out`, …),
or one of the client's own checks, with neither: the returned request is not
the operation that was asked for, or the enclave's half does not verify. In
both of the latter cases nothing was signed.

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

For production deployments that need **sovereign exit guarantees**, bind a wallet to a customer-owned vault. Vault deployment happens via the [dashboard](https://app.outlayer.ai/vault) or `outlayer vault init` CLI (not the SDK — your NEAR keys never touch us). Once deployed, binding is one option:

```ts
const wallet = await OutlayerClient.register({ vaultId: 'vault.alice.near' });
```

See [docs/vaults.md](docs/vaults.md) and https://app.outlayer.ai/docs/vaults.

## Examples

Runnable scripts in [`examples/`](examples/):

- `01-register.ts` — register a wallet, derive addresses on 4 chains, check balance
- `02-withdraw.ts` — gasless cross-chain withdraw with dry-run + polling
- `03-multisig.ts` — submit a withdraw that triggers the approval flow
- `04-agent-loop.ts` — minimal autonomous agent that respects policy
- `05-cross-chain-app.ts` — end-to-end DeFi flow: cross-chain login pattern, deposit instructions, swap USDT → NEAR, stake with a validator, gasless withdraw back to Ethereum. CLI with sub-commands (`addresses | balances | buy-near | stake | unstake | withdraw-eth | login-demo`).
- `06-confidential-roundtrip.ts` — confidential shard round-trip: SHIELD → read balance → UNSHIELD, with `503 confidential_unavailable` handling.
- `07-inbox.ts` — the owner's inbox from a server: sign a device in with the custody wallet, read the tasks the owner's agents left, close the notices with Got it.

Run with:

```bash
npx tsx examples/01-register.ts                                            # no auth needed
OUTLAYER_API_KEY=wk_... npx tsx examples/02-withdraw.ts                    # needs API key
OUTLAYER_API_KEY=wk_... npx tsx examples/05-cross-chain-app.ts addresses   # cross-chain identity
```

## The owner's inbox

`inbox` reads the tasks an agent left for its owner — confirmations, inputs and
notices — on a device of the owner's, and closes the notices with Got it. Every
task is encrypted to the owner's devices; a device is a P-256 key pair the
owner's wallet signs in with one NEP-413 statement. The module holds no wallet
key: each signature is asked of a `Signer`, which for an OutLayer custody
wallet is its `sign-message` (`inbox.walletSigner(client)`). It does not
approve tasks: a task that asks something is approved where it is shown first.

```ts
import { OutlayerClient, inbox } from '@outlayer/sdk';

const signer = inbox.walletSigner(new OutlayerClient({ apiKey, network: 'testnet' }));
const device = await inbox.newDevice();            // keep inbox.exportDevice(device) server-side
const session = await inbox.signIn(
  { baseUrl: 'https://testnet-api.outlayer.ai', recipient: 'outlayer.testnet' },
  signer, accountId, device,                       // a day, by default; 30 days at most
);
for (const listed of (await inbox.listTasks(session)).tasks) {
  const task = await inbox.readTask(device, listed, accountId);
  if (task.envelope.kind === 'notice') await inbox.acknowledge(session, listed.id);
}
```

To be told of new tasks at a URL instead of asking: `inbox.nameWebhook(session,
url, signer)` answers the owner's secret, once. Check each delivery with
`verifyWebhook` and `walletIds: ['owner:' + accountId]`
([Verifying webhooks](#verifying-webhooks)); an owner's event also carries the
owner's own HMAC, a second check:
`inbox.verifyWebhook(rawBody, request.headers.get('x-webhook-signature'),
secret)`. One URL per owner — naming one replaces any other. A delivery says who
asked whom, of what kind and when, and nothing of what the task shows: read the
task to show it. A custody account never sent NEAR signs in too; a wallet whose
policy lists the recipients of `sign_message` must list the OutLayer contract.

## Verifying webhooks

Every webhook OutLayer sends — a wallet's events to the `webhook_url` of its
policy (`request_completed`, `approval_needed`, …) and an owner's task events —
is signed with the network's Ed25519 key. The public keys are served without
authentication, so the receiver holds no secret.

A signature says OutLayer sent the request. It does not say the event is
yours: anyone may name your URL as the webhook of a wallet of their own, and
that wallet's events arrive correctly signed. `X-Wallet-Id` says whose event it
is, so `verifyWebhook` takes the wallet ids you expect and refuses any other.

```ts
import { createWebhookKeyCache, verifyWebhook, WebhookVerificationError } from '@outlayer/sdk';

const keys = createWebhookKeyCache({ network: 'mainnet' });  // one per network, made once
const walletIds = [myWalletId];                              // or `owner:${myAccount}` for task events
const seen = new Map<string, number>();                      // delivery id → when it was taken

async function onWebhook(request: Request): Promise<Response> {
  const rawBody = await request.text();                      // the bytes received, not re-serialized JSON
  let event: Awaited<ReturnType<typeof verifyWebhook>>;
  try {
    event = await verifyWebhook({ headers: request.headers, rawBody, keys, walletIds });
  } catch (e) {
    if (e instanceof WebhookVerificationError) return new Response('not verified', { status: 401 });
    return new Response('keys unavailable', { status: 503 }); // the delivery is tried again
  }
  const now = Date.now();
  for (const [id, at] of seen) if (now - at > 300_000) seen.delete(id);
  if (seen.has(event.id)) return new Response('ok');         // a retry, or a capture sent again
  seen.set(event.id, now);
  // event.walletId is one of walletIds; JSON.parse(rawBody) is the payload.
  return new Response('ok');
}
```

`walletIds` holds the `X-Wallet-Id` values you take events of:

| Events | `X-Wallet-Id` |
|---|---|
| A wallet's: `approval_needed`, `approval_received`, `request_completed`, `policy_update_signed`; a vault's | the `wallet_id` registration answered |
| An owner's task events (`inbox.nameWebhook`) | `owner:` and the owner's account — `owner:alice.near` |
| `subscription_notification` | the payment key's owner account and nonce — `alice.near:3` |

The signature covers the delivery id, the timestamp, `X-Wallet-Id`,
`X-Event-Type` and the body:

```text
outlayer-webhook-v1\n{X-Webhook-Id}\n{X-Webhook-Timestamp}\n{X-Wallet-Id}\n{X-Event-Type}\n{body}
```

| Header | Value |
|---|---|
| `X-Webhook-Id` | The delivery's id: a random UUID, the same on each of its attempts (three at most) |
| `X-Webhook-Timestamp` | Unix seconds at the moment of the attempt |
| `X-Webhook-Key-Id` | Which key of `GET /wallet/v1/webhook-keys` signed |
| `X-Webhook-Signature-Ed25519` | The signature, hex |
| `X-Wallet-Id`, `X-Event-Type` | Whose event it is, and the event |

`verifyWebhook({ headers, rawBody, keys, walletIds, toleranceSec?, now? })`
answers `{ id, timestamp, walletId, eventType, keyId }` or throws a
`WebhookVerificationError` whose `reason` is `malformed`, `unknown_key`,
`bad_signature`, `unexpected_wallet` or `stale_timestamp`. A timestamp more
than `toleranceSec` (300 by default) from the receiver's clock is stale; that
bounds how long a captured request can be sent again. Inside that time the same
request verifies again and `verifyWebhook` keeps no state: remembering the ids
already taken, for as long as the tolerance, is the receiver's, as above. An
empty `walletIds`, a `toleranceSec` or `now` that is not a finite,
non-negative number, or a `toleranceSec` above 3600 throws a `RangeError`
instead of accepting anything.

`createWebhookKeyCache({ network?, baseUrl?, ttlSec?, minRefetchSec?, readTimeoutSec? })` holds
the keys the way a receiver should:

- it reads the list again once it is ten minutes old (`ttlSec`), and what it
  reads replaces what it held, so a key that left `webhook-keys` verifies
  nothing after the next read;
- a request naming a key it does not hold makes it read the list — a new key
  may have been published — but at most once a minute (`minRefetchSec`),
  however many such requests arrive: the key id is read before any signature
  is checked, so anyone can send one;
- a read takes five seconds at most (`readTimeoutSec`); a longer one has
  failed, and nothing waits on it further;
- when the list cannot be read and none read in the last ten minutes is held,
  `get()` — and `verifyWebhook` with it — throws: answer an error, and the
  delivery is tried again.

`keys` may also be a plain list from `fetchWebhookKeys()`, for a receiver that
holds the keys by the same three rules itself. Keys are per network — a testnet
webhook verifies under `createWebhookKeyCache({ network: 'testnet' })`. A
webhook is a signal: where money depends on it, read the request with
`client.getRequest(id)` before acting.

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

Write operations get an auto-generated `X-Idempotency-Key` per call; retries from the SDK's own retry layer reuse the same key, so repeated calls don't double-spend. A key the server has seen answers `duplicate_idempotency_key`, thrown as a `DuplicateRequestError` carrying the request it belongs to (`requestId`, `requestStatus`, `pollUrl`; for a payment-check create, `checks` with each `check_key`, `null` when asked with another API key than the one that created it). This is what the SDK's own retry throws when the first attempt did run and the retry meets its key: catch it, take `requestId`, and poll `pollUrl` until the status is terminal — nothing ran twice. Pass `answerWithinSeconds` to be answered `processing` within that many seconds of the request's arrival instead of waiting the server's full wait (up to 80 s). To control idempotency yourself (e.g., for at-least-once delivery from a queue):

```ts
await client.withdraw({
  chain: 'near',
  to: 'bob.near',
  amount: '1000000000000000000000000',
  idempotencyKey: 'my-job-id-12345',
});
```

Reusing the same key does not re-execute, and does not return the stored result either: the call resolves with `{ error: 'duplicate_idempotency_key', message: 'Request already processed: <request_id>' }` — a pointer. Read the outcome with `getRequest(request_id)`.

## Configuration

```ts
const client = new OutlayerClient({
  apiKey: process.env.OUTLAYER_API_KEY!,
  network: 'mainnet',                           // default; or 'testnet'
  baseUrl: 'https://api.outlayer.ai', // optional, overrides network
  fetch: customFetch,                           // optional, for SSR/proxies
  retry: {
    maxAttempts: 5,
    initialDelayMs: 200,
    maxDelayMs: 4000,
  },
});
```

### Testnet vs mainnet

`network: 'testnet'` targets `https://testnet-api.outlayer.ai`. Useful for development without spending real funds.

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
