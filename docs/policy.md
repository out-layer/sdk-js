# Policy management

A wallet without a policy is unrestricted. A wallet with a policy enforces every rule **inside the TEE**, before signing. This means even if the coordinator or the operator's infrastructure is fully compromised, an attacker cannot bypass the rules.

This page covers the policy schema, the on-chain storage flow, and common patterns.

## Schema

```ts
type PolicyRules = {
  limits?: {
    per_transaction?: { [tokenId: string]: string }; // amount in smallest unit
    hourly?:          { [tokenId: string]: string };
    daily?:           { [tokenId: string]: string };
    monthly?:         { [tokenId: string]: string };
  };
  addresses?: {
    mode: 'whitelist' | 'blacklist' | 'none';
    list: string[];
    unlisted?: 'refuse' | 'ask';   // whitelist only: a payment off the list is refused (default) or waits for approval
  };
  transaction_types?: Array<
    | 'transfer'                 // native NEAR
    | 'call'                     // a contract call
    | 'delete'                   // delete the wallet's account
    | 'withdraw'                 // out of NEAR Intents (also spelled 'intents_withdraw')
    | 'intents_transfer'         // inside NEAR Intents
    | 'intents_storage_deposit'  // a token registration paid from the intents balance
    | 'cross_chain_withdraw'     // to another chain; needs its capability too
    | 'swap'                     // also spelled 'intents_swap'; needs its capability too
    | 'limit_order'              // needs its capability too
    | 'payment_check'            // needs its capability too
    | 'confidential'             // needs its capability too
    | 'raw'                      // raw signing; needs its capability too
  >;
  time_restrictions?: {
    timezone?: 'UTC';          // the only zone; any other refuses every operation
    allowed_hours?: [number, number]; // [start, end), hours 0..23 in UTC; [22, 6] wraps midnight
    allowed_days?:  number[];  // 1 = Monday … 7 = Sunday
  };
  rate_limit?: { max_per_hour: number };
};

type ApprovalConfig = {
  threshold: { required: number };               // approvals needed
  approvers: Array<{ id: string; pubkey?: string; role?: 'admin' | 'signer' }>; // id = NEAR account; role is a label, all approvers are equal
  excluded_types?: string[];                     // op types that never wait
  auto_up_to?: {                                 // total that leaves without approval, per window and token
    hourly?:  { [tokenId: string]: string };
    daily?:   { [tokenId: string]: string };
    monthly?: { [tokenId: string]: string };
  };
  locked?: boolean;                              // later policy changes need the approvers' quorum
};
```

`"*"` as a token ID matches all tokens in `limits`; `auto_up_to` names each token and has no `"*"`. Amount strings are in the token's smallest unit — yoctoNEAR for NEAR, satoshis-equivalent for tokens with custom decimals.

## EVM signing capability (`evm_sign`)

EVM signing — `evmSignTypedData` (EIP-712), `evmSignMessage` (EIP-191), and
`evmSignTransaction` (raw tx) — is gated by the `evm_sign` capability:

```ts
type EvmSignCapability = {
  allowed?: boolean; // default false (DENY) under a policy — set true to permit
  raw_tx?:  boolean; // default false — gates evmSignTransaction only
};
```

How `evm_sign` behaves:

- **Default-DENY under a policy.** Like every other fund-moving capability
  (raw_sign, swap, cross_chain_withdraw, …), a policy must explicitly set
  `evm_sign.allowed: true` to permit signing. `sign_message` is the only
  default-allow capability. A wallet with **no policy at all** is unrestricted.
- **`raw_tx` defaults OFF.** With `allowed: true`, base `evm_sign` covers EIP-712
  typed data and EIP-191 messages; signing an arbitrary serialized transaction is
  gated by the separate `raw_tx` sub-flag, which must be explicitly enabled to
  allow `evmSignTransaction`.

`requires_approval` is **not** supported for `evm_sign` — the keystore signs
EVM payloads synchronously and never queues them for multisig.

> **⚠️ An EIP-712 signature is itself fund-moving.** Typed-data structs like
> EIP-3009 `TransferWithAuthorization` (≈ a transfer) and EIP-2612 `Permit`
> (≈ an approval) move funds purely off-chain — anyone holding such a signature can
> relay it on-chain. Granting `evm_sign` therefore grants full authority over the
> wallet's EVM-address float (bounded to whatever you've bridged to that `0x`
> address — the NEAR-intents balance is never exposed to any EVM signature). The
> `raw_tx` kill-switch does **not** contain typed-data drains; this is exactly why
> `evm_sign` is opt-in (default-DENY).

## Storage model

The policy is stored **on-chain in encrypted form**. Only the keystore TEE can decrypt it. The controller (the NEAR account that first set the policy) is recorded on-chain and can update or freeze the wallet without going through any API.

Flow:

```
encrypt (SDK) → sign (SDK) → store_wallet_policy() (NEAR tx by controller) → invalidate cache (SDK)
```

## Setting a policy

```ts
import { OutlayerClient } from '@outlayer/sdk';
import { connect, keyStores } from 'near-api-js';

const client = new OutlayerClient({ apiKey });

// 1. Encrypt the policy
const encrypted = await client.policy.encrypt({
  wallet_id: walletId,
  rules: {
    limits: {
      per_transaction: { '*': '10000000000000000000000000' }, // 10 NEAR
      daily: { '*': '100000000000000000000000000' },          // 100 NEAR/day
    },
    addresses: { mode: 'whitelist', list: ['bob.near', 'dex.near'] },
    rate_limit: { max_per_hour: 60 },
  },
});
// → { encrypted_base64, wallet_pubkey }

// 2. Sign it (keystore signs SHA256(encrypted) with the wallet's key)
const sig = await client.policy.sign(encrypted.encrypted_base64);
// → { signature_hex, public_key_hex }

// 3. Submit on-chain (your controller account, via near-api-js)
const near = await connect({ networkId: 'mainnet', keyStore: ... });
const account = await near.account('controller.near');
await account.functionCall({
  contractId: 'outlayer.near',
  methodName: 'store_wallet_policy',
  args: {
    wallet_pubkey: encrypted.wallet_pubkey,
    encrypted_data: encrypted.encrypted_base64,
    signature: sig.signature_hex,
  },
  attachedDeposit: '50000000000000000000000', // 0.05 NEAR storage deposit
});

// 4. Tell the coordinator to drop its no-policy cache
await client.policy.invalidateCache(walletId);
```

The SDK does steps 1, 2, and 4. Step 3 is intentionally outside the SDK — it's a NEAR transaction by the controller, signed by their wallet, and the SDK should not need access to the controller's keys.

## Reading the current policy

```ts
const { rules, approval, frozen, usage } = await client.policy.get();

// `usage` shows current accumulated spending against velocity limits:
// { daily: { '*': '45000000000000000000000000' } } means 45 NEAR spent today
```

Useful for showing the user how close they are to their limits.

## Updating a policy

Same flow as setting — `store_wallet_policy` overwrites the existing entry, as long as the call comes from the original `owner` (the first account that set the policy).

## Freezing a wallet (emergency stop)

`freeze_wallet` is a direct on-chain call by the controller. **No API key needed** — even if the API key is compromised, the controller can freeze the wallet by signing a NEAR transaction:

```ts
// From the controller's NEAR account:
await account.functionCall({
  contractId: 'outlayer.near',
  methodName: 'freeze_wallet',
  args: { wallet_pubkey: encrypted.wallet_pubkey },
});
```

On the next operation, the keystore reads fresh policy from chain, sees `frozen: true`, and rejects. Unfreezing is the inverse (`unfreeze_wallet`).

## Multisig (approval workflows)

To require human approval once the day's payments pass an amount:

```ts
await client.policy.encrypt({
  wallet_id: walletId,
  rules: { limits: { daily: { 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1': '5000000000' } } }, // never more than 5,000 USDC a day
  approval: {
    threshold: { required: 2 },
    approvers: [
      { id: 'alice.near', role: 'admin' },
      { id: 'bob.near',   role: 'signer' },
      { id: 'carol.near', role: 'signer' },
    ],
    auto_up_to: { daily: { 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1': '1000000000' } }, // 1,000 USDC a day unattended
  },
});
```

Withdrawals run unattended until the day's total reaches 1,000 USDC; each one past that queues for two approvals, and nothing past 5,000 USDC a day is signed. Without `auto_up_to`, every operation that moves funds queues. See [approvals.md](approvals.md) for the approve/reject flow.

## Common patterns

### Trading-bot wallet

```ts
rules: {
  limits: {
    per_transaction: { '*': '5000000000000000000000000' },
    daily: { '*': '50000000000000000000000000' },
  },
  addresses: { mode: 'whitelist', list: ['intents.near', 'wrap.near'] },
  transaction_types: ['call', 'swap'],
}
```

Bot can only interact with intents.near and wrap.near; can't transfer to arbitrary addresses; daily ceiling caps blast radius.

### Treasury wallet with human gate

```ts
rules: {
  rate_limit: { max_per_hour: 10 },
  addresses: { mode: 'whitelist', list: ['approved-vendor-1.near', 'approved-vendor-2.near'] },
},
approval: {
  threshold: { required: 2 },
  approvers: [admin1, admin2, admin3],
  auto_up_to: { daily: { 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1': '5000000000' } }, // 5,000 USDC a day
}
```

Payouts to the two vendors go through until the day's total reaches 5,000 USDC; each one past that waits for 2 of the 3 admins.

### Time-restricted (business hours only)

```ts
rules: {
  time_restrictions: {
    timezone: 'UTC',
    allowed_hours: [14, 22],       // 14:00 up to 22:00 UTC — nine to five in New York in winter
    allowed_days: [1, 2, 3, 4, 5], // Mon–Fri
  },
}
```

Wallet refuses every operation outside those hours. The hours are UTC and do not follow daylight saving; a list of more than two hours, or another time zone, is unreadable and refuses everything.
