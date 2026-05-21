# Changelog

All notable changes to `@outlayer/sdk`. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [SemVer](https://semver.org/).

## [Unreleased]

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
