# Changelog

All notable changes to `@outlayer/sdk`. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [SemVer](https://semver.org/).

## [Unreleased]

### Added

- **EVM signing (v1)** — 3 new methods on `OutlayerClient` that sign with the
  wallet's EVM (secp256k1) key, the single `0x` address shared across all EVM
  chains: `evmSignTypedData` (EIP-712 v4 — e.g. a Polymarket CLOB order),
  `evmSignMessage` (EIP-191 `personal_sign`), and `evmSignTransaction` (raw
  unsigned tx). All are pure off-chain signing — the keystore keccak256-hashes
  and signs, returning a 65-byte `0x`-hex signature (`r‖s‖v`, `v ∈ {27,28}`,
  low-s); it never assembles, prices, nonces, or broadcasts a transaction. You
  build and broadcast EVM transactions yourself (for EIP-1559, `yParity = v − 27`).
- `GET /wallet/v1/address` now serves all EVM chains (`ethereum`, `polygon`,
  `base`, `arbitrum`, `optimism`, `bsc`, `avalanche`, plus aliases `eth` / `pol` /
  `matic` / `arb` / `op` / `avax`), returning one shared secp256k1 address. Solana
  stays gated; account delete stays NEAR-only.
- Spec: `POST /wallet/v1/evm/{sign-typed-data,sign-message,sign-transaction}`.
- Exported types: `EvmSignTypedDataRequest`, `EvmSignMessageRequest`,
  `EvmSignTransactionRequest`, `EvmSignResponse`.
- New policy capability `evm_sign` — **default-DENY under a policy** (set
  `allowed:true` to permit; a wallet with no policy is unrestricted;
  `sign_message` is the only default-allow capability), with a `raw_tx` sub-flag
  (**default-OFF**) gating raw-tx signing. `requires_approval` is not supported.
  CAVEAT: an EIP-712 signature is itself fund-moving (EIP-3009 ≈ transfer,
  EIP-2612 ≈ approve), so `evm_sign` grants full authority over the EVM address's
  float — bounded to what you bridge there; the NEAR-intents balance is never
  exposed. See [docs/policy.md](docs/policy.md).

## [0.1.0-alpha.4] — 2026-06-02

### Added

- **Confidential Intents** — 9 new methods on `OutlayerClient`, mirroring the
  public `/intents/*` surface against the Defuse confidential shard
  (`intents.far` on a private NEAR shard with no public RPC):
  `confidentialDeposit` (SHIELD), `confidentialUnshield`, `confidentialWithdraw`,
  `confidentialWithdrawDryRun`, `confidentialTransfer`, `confidentialSwap`,
  `confidentialSwapQuote`, `confidentialDepositIntent`, and `confidentialBalance`.
  Action methods are async (return a `request_id` to poll via `getRequest`);
  dry-run / quote / balance are read-only. See the README's *Confidential
  Intents* section and the coordinator's
  [CONFIDENTIAL_INTENTS.md](https://github.com/out-layer/coordinator/blob/main/docs/CONFIDENTIAL_INTENTS.md)
  for the mental model and threat model.
- Spec: `POST /wallet/v1/confidential/{deposit,unshield,withdraw,withdraw/dry-run,transfer,swap,swap/quote,deposit-intent}`
  and `GET /wallet/v1/confidential/balance`.
- Exported types: `ConfidentialShieldRequest`, `ConfidentialUnshieldRequest`,
  `ConfidentialWithdrawRequest`, `ConfidentialTransferRequest`,
  `ConfidentialSwapRequest`, `ConfidentialDepositIntentRequest`,
  `ConfidentialDepositIntentResponse`, `ConfidentialOpResponse`,
  `ConfidentialBalanceResponse`, `ConfidentialBalancesResponse`. Read-only
  quotes reuse `SwapQuoteResponse`. The `503 confidential_unavailable` /
  `502 confidential_jwt_expired` upstream errors surface as `OutlayerError`
  with the matching `code`.
- 22 new tests covering all 9 methods (happy path, idempotency, query
  forwarding, union narrowing, and 503/502/403/400 error mapping).

## [0.1.0-alpha.3] — 2026-05-21

### Added

- `client.createDepositIntent({ chain, amount, token })` — cross-chain deposit
  via NEAR Intents 1Click. Returns a one-time deposit address on the source
  chain (Ethereum, Solana, Base, Arbitrum, …).
- `client.getDepositStatus(intentId)` — poll a deposit intent until `success`.
- Spec: `POST /wallet/v1/deposit-intent`, `GET /wallet/v1/deposit-status`,
  plus `DepositIntentRequest` / `DepositIntentResponse` / `DepositStatusResponse`.

## [0.1.0-alpha.2] — 2026-05-20

### Added

- `network` option on `ClientOptions` and `UnauthenticatedOptions` — pass
  `'mainnet'` (default) or `'testnet'` instead of writing the base URL by hand.
  `baseUrl` still overrides if both are supplied. NEAR Intents (cross-chain
  swaps + gasless withdrawals) only work on mainnet; use testnet for
  register / policy / sign-message during development.
- Exported `Network` type and `NETWORK_BASE_URLS` constant.
- 4 new tests covering network selection (total: 56).

## [0.1.0-alpha.1] — 2026-05-20

Initial alpha release.

### Added

- `OutlayerClient` with full wallet API coverage:
  - Multi-chain address derivation (NEAR, Ethereum, Solana, Bitcoin)
  - Native NEAR transfer, contract call, balance
  - Cross-chain gasless withdraw / swap / deposit via NEAR Intents
  - Dry-run + quote endpoints for pre-execution simulation
  - NEP-413 message signing
  - Async request tracking
- `client.policy.*` — encrypt, sign, invalidate cache
- `client.approvals.*` — listPending, approve, reject with NEP-413 auth
- `client.audit.list({...})` — full event history
- Typed error hierarchy: `OutlayerError`, `PolicyDeniedError`, `WalletFrozenError`, `UnauthorizedError`, `RateLimitedError`, `NotFoundError`, `BadRequestError`
- Auto-generated `Idempotency-Key` on writes, stable across SDK-internal retries
- Configurable retry with exponential backoff (3 attempts default, 5xx + network errors only)
- Generated TypeScript types from [out-layer/api-spec](https://github.com/out-layer/api-spec) OpenAPI 3.1 source

### Known limitations

- Vault flow (sovereign per-customer custody) is not yet wrapped — use the dashboard or CLI.
- Native `transfer` and `getBalance` are NEAR-only at the chain layer (cross-chain uses Intents).
- ElizaOS / LangChain plugins are not yet published.
- No browser-side helpers for NEAR Wallet Selector integration — see [docs/approvals.md](docs/approvals.md) for the manual recipe.
