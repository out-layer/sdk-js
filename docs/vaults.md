# Vaults (sovereign custody)

By default, a wallet's master key is derived from **OutLayer's shared master**, held inside the keystore TEE. Convenient, zero setup. The trust model is "OutLayer is honest" — if OutLayer shuts down or its keystore DAO loses quorum, your derived keys go with it.

A **vault** replaces that shared master with a **per-customer master** derived via NEAR's MPC network. The customer's parent NEAR account can **permissionlessly recover** the vault — even if OutLayer disappears.

If you don't know whether you need a vault: you probably don't, for v0.1. Vaults are for production deployments where the customer can't or won't trust a third-party operator. They add a one-time setup tax (one atomic NEAR transaction) in exchange for sovereignty.

## What the SDK does and doesn't

**The SDK does:**

- Bind a wallet to an **already-deployed** vault at registration time:
  ```ts
  await OutlayerClient.register({ vaultId: 'vault.alice.near' });
  ```
- Use the per-vault master implicitly for every subsequent operation on the resulting API key — you don't pass `vault_id` again.
- Expose the binding via `client.getAddress(...)`:
  ```ts
  const { vault_id } = await client.getAddress('near'); // vault.alice.near or null
  ```

**The SDK does NOT:**

- Deploy a new vault.
- Initiate or finalize recovery.
- Manage the parent NEAR account or its keys.

Vault deployment requires the customer's own NEAR account to sign a 5-action atomic NEAR transaction. Your NEAR keys should never go through the SDK or OutLayer's infrastructure. That's the entire point of the design.

## How to deploy a vault

Two paths; pick whichever fits your workflow.

### Dashboard (recommended for first time)

1. Open https://outlayer.fastnear.com/vault
2. Connect your NEAR wallet (the account that will be the parent / controller)
3. Click **Deploy vault** — the dashboard builds the atomic transaction and asks your wallet to sign
4. Wait for confirmation (a few seconds)
5. Note your `vault_id` (will look like `vault.<your-account>.near`)

### CLI

```bash
# Install once
npm install -g @outlayer/cli   # or: cargo install outlayer-cli

# Deploy
outlayer vault init my-app
#  ↓
# vault_id: vault.alice.near
```

The CLI does the same atomic deploy as the dashboard but from your terminal — useful for scripted setups.

**Full vault docs**: https://outlayer.fastnear.com/docs/vaults

## Binding a wallet

After the vault is deployed and verified, registering a wallet under it is one call:

```ts
import { OutlayerClient } from '@outlayer/sdk';

const wallet = await OutlayerClient.register({
  vaultId: 'vault.alice.near',
});

console.log(wallet.api_key); // wk_... — bound permanently to vault.alice.near

const client = new OutlayerClient({ apiKey: wallet.api_key });

// All operations use the per-vault master automatically
const addr = await client.getAddress('near');
console.log(addr.vault_id); // 'vault.alice.near'

await client.withdraw({
  chain: 'ethereum',
  to: '0x...',
  amount: '1000000',
  token: 'nep141:usdt.tether-token.near',
});
```

The binding is **permanent for that API key**. To switch vaults, register a new wallet under the new vault.

## Multiple wallets per vault

A single vault can mint many wallets — each with its own API key and derived addresses. Useful for partitioning agents by purpose:

```ts
const trading = await OutlayerClient.register({ vaultId: 'vault.alice.near' });
const ops     = await OutlayerClient.register({ vaultId: 'vault.alice.near' });
const test    = await OutlayerClient.register({ vaultId: 'vault.alice.near' });
// 3 distinct wallets, 3 distinct API keys, all under the same sovereignty root
```

Each wallet's addresses are derived independently (different `wallet_id`) but they all flow through the per-vault master. If the vault recovers, the parent account controls all three.

## Recovery

If you decide to leave OutLayer, the recovery flow is **not in the SDK** — it's a NEAR-side operation by your parent account:

```bash
# Unilateral exit (no DAO involvement)
outlayer vault unilateral-initiate-recovery vault.alice.near
# Wait the configured exit window (24h–30d, set at deploy)
outlayer vault finalize-recovery vault.alice.near
```

After finalize, the parent NEAR account holds a full-access key on the vault. The per-vault master remains deterministically derivable, so you can extract every secret and wallet key on your own.

**Full procedure**: https://outlayer.fastnear.com/docs/vaults#recovery
**Source-of-truth runbook**: [`docs/LEAVING_OUTLAYER.md`](https://github.com/out-layer/near-offshore/blob/main/docs/LEAVING_OUTLAYER.md) in the main repo.

## Checking whether a wallet is vault-bound

```ts
const { vault_id } = await client.getAddress('near');
if (vault_id) {
  console.log(`Wallet uses vault ${vault_id}`);
} else {
  console.log("Wallet uses OutLayer's shared master (no vault)");
}
```

This is read-only and works against any API key — useful for audit dashboards.

## When to use a vault

| Use case | Vault needed? |
|---|---|
| Personal AI agent on mainnet, holding < $1k | No — shared master is fine |
| Trading bot for a treasury, holding $10k–$100k | Maybe — depends on your trust model |
| Production custody for end-users' funds | Yes — your end-users need provable sovereignty |
| Regulated entity (broker, exchange, fund) | Yes — auditors will ask |
| Throwaway script / prototype | No |

A vault adds ~0.1 NEAR of one-time setup cost and ~0.001 NEAR per derive call (cached after first). Not free, but cheap compared to other custody options.
