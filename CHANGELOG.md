# Changelog

All notable changes to `@outlayer/sdk`. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [SemVer](https://semver.org/).

## [Unreleased]

### Changed

- **Breaking.** Agent On-chain custody replaces the binding methods. Added on
  `OutlayerClient`: `getWalletContractKey()`, `putWalletContract(accountId)`
  and `getWalletContract()` (types `WalletContractKeyResponse`,
  `WalletContractResponse`), beside `AgentKey` and `WalletContract`, which run
  a wallet contract's operations under the agent's signature
  (`WalletContractOptions` takes `teePublicKey`: the enclave's half is
  verified before the agent signs its own), and `SetupKey`, `openSetup()` and
  `collectSetup()`, by which the agent opens a setup for its owner and
  collects its key, sealed to a one-time key. Removed:
  `putBinding`, `getBinding`, `deleteBinding`, `bindingBalance`,
  `bindingTransfer`, `getBindingSetup`; the types `PutBindingRequest`,
  `BindingResponse`, `DeleteBindingResponse`, `BindingSetupResponse`,
  `AgentConnectDeniedResponse`; `AgentConnectDeniedError`; `account` on
  `BalanceResponse`; `asset_account_id`, `executor_account_id` and
  `gas_balance` on `AddressResponse`; the request statuses `partially_failed`
  and `cancelled`; the error codes `agent_connect_denied` and
  `binding_not_found`. A `call` of `w_execute_extension` is a
  `PolicyDeniedError` for every wallet.
- **Breaking.** A withdrawal with `memo` is refused (`memo_not_supported`):
  no route delivers a memo or a destination tag. `WithdrawRequest`,
  `SwapRequest` and `IntentsTransferRequest` no longer type-check with a field
  the API does not name, and the API refuses one.
- **Breaking.** A swap's `min_amount_out` is held to the quote's
  `min_amount_out` (the guarantee) instead of its `amount_out` estimate; a
  floor set at a quote's `amount_out` is refused, and one set exactly at an
  earlier quote's `min_amount_out` whenever the fresh quote is a unit worse —
  leave the market room under it. The refusal is a
  `QuoteRefusedError` (`below_min_amount_out`), not a `BadRequestError` with
  code `bad_request`.
- `amount` on `WithdrawRequest` and `amount_in` on `SwapRequest` are optional
  in the types: a request carries one of the two sizes.
- **Breaking.** An amount of a withdrawal, a swap, an intents transfer and
  the confidential operations is decimal digits only: a leading `+`, a leading
  zero or whitespace is refused (`bad_request`).
- Every confidential route answers an unparseable body with `400 bad_request`
  (a `BadRequestError`), as the public routes do.
- A request refused at its quote after the call returned ends `failed` with
  `result.error_code`, the bound and the quote's figure.

### Added

- Exact output: `amount_out` + `max_amount_in` on `withdraw` (cross-chain),
  `swap`, `confidentialWithdraw`, `confidentialSwap` and their dry-runs and
  quotes. The recipient receives exactly `amount_out`; the wallet spends at
  most `max_amount_in`, and 1Click returns what it does not use.
- `min_amount_out` on `withdraw` (cross-chain) and `confidentialWithdraw`.
- `QuoteRefusedError` (`quoted`, `bound`) for `below_min_amount_out` and
  `above_max_amount_in`.
- `withdrawDryRun` on a cross-chain route, `swapQuote` and the confidential
  previews carry the quote's figures as fields (`QuoteFigures`): `amount_in`,
  `min_amount_in`, `amount_out`, `min_amount_out`, `withdraw_fee`,
  `refund_fee`, `amount_in_usd`, `amount_out_usd`. A request's `result.quote`
  is the quote it ran with (`ExecutedQuote`).
- `verifyWebhook({ headers, rawBody, keys, walletIds, toleranceSec })`,
  `createWebhookKeyCache()` and `fetchWebhookKeys()`: check that a webhook is
  OutLayer's and about a wallet you expect, with the network's public Ed25519
  key — the delivery id (a random UUID), the timestamp, the wallet id, the
  event type and the body are signed. The key cache re-reads the list every ten
  minutes, drops a key that left it, and reads at most once a minute for an
  unknown key id. Every webhook carries the signature (`X-Webhook-Id`,
  `X-Webhook-Timestamp`, `X-Webhook-Key-Id`, `X-Webhook-Signature-Ed25519`); a
  wallet's webhook carries no `X-Webhook-Signature`, and an owner's keeps it as
  the owner's HMAC (`inbox.verifyWebhook`).
- `answerWithinSeconds` on every write that waits on a settlement: sends
  `X-Answer-Within`, so the call answers `processing` with a `poll_url` within
  that many seconds instead of outliving your timeout.

### Fixed

- A `200` whose body is `duplicate_idempotency_key` is thrown as a
  `DuplicateRequestError` (`requestId`, `requestType`, `requestStatus`,
  `result`, `pollUrl`, `checks`) instead of being returned as if it were the
  operation's answer.

- **Writes send `X-Idempotency-Key`, the header the coordinator reads.** They
  sent `Idempotency-Key`, which the coordinator ignores, so a retried write ran
  again instead of answering `duplicate_idempotency_key`.
- **The auto-generated `Idempotency-Key` is now the same on every internal
  retry of one operation**, as the README says it is. It was minted inside the
  retried call, so each attempt carried a new key, and a write whose first
  attempt did execute (a lost response, a 5xx after the fact) could execute
  again. Every write method is affected; a key you pass yourself never was.

### Changed

- **Payment checks, limit orders and confidential ops can answer
  `processing`.** The coordinator records every transfer before it leaves and
  settles it after the call when its answer is late or lost; such a call answers
  `processing` with a `poll_url` instead of an error a retry would turn into a
  second payment.
  - `createPaymentCheck` / `batchCreatePaymentChecks`: each check has `status`
    (`unclaimed`, or `creating` + `poll_url`); the `check_key` is always
    returned. A batch that stopped part way carries `error`.
  - `claimPaymentCheck` / `reclaimPaymentCheck` return `request_id` and
    `status` (`processing` + `poll_url`, or the check's new status); `remaining`
    and the timestamp are absent while `processing`. Both take `idempotencyKey`.
  - `createLimitOrder` can return `LimitOrderProcessing` (`status`,
    `order_id`, `poll_url`).
  - Confidential ops can return `status: 'processing'` with `poll_url`.

### Added

- **`inbox`** — the owner's inbox from a server or a page: `newDevice`,
  `exportDevice`/`importDevice` (a server keeps the device's key), `signIn` with
  a `Signer` — `walletSigner(client)` for an OutLayer custody wallet — then
  `listTasks`, `readTask` (the envelope, the hash of the bytes that opened,
  confirm/input/notice), `openFile`, `acknowledge` (Got it on a notice),
  `rejectTask`, `deleteTask`, `mute`, `nameWebhook` and `verifyWebhook`. It
  approves nothing. WebCrypto only. `examples/07-inbox.ts`.

- **Limit orders** — `createLimitOrder`, `getLimitOrder`, `listLimitOrders`,
  `cancelLimitOrder`, `cancelAllLimitOrders`. A swap rested on 1Click at your
  price, funded from the wallet's intents balance; `quantity` is in the base
  asset's smallest units, `price` is quote per one whole base. A thin door onto
  1Click's orders: the request carries its parameters (`recipient`,
  `recipient_type`, …) and the answer is its order — snake_case field names,
  lower-case enumerated values, nothing renamed or left out (`partial_fills`,
  `payouts`, `app_fees`, the fee estimates, `order_type`, `time_in_force`, …);
  `recipient_type` takes all three of 1Click's values (`intents`,
  `confidential_intents`, `destination_chain`). `is_payout_status_final` is
  the only terminal signal; a `pending_cancel` order may still fill a last
  slice. The wallet authorises the order once and the payout happens later
  with no further signature, so it is gated like an exit: the default-DENY
  `limit_order` capability and transaction type, the address rules on
  `recipient`, the amount limits. On a multisig wallet `createLimitOrder`
  resolves to a `LimitOrderPendingApproval` — tell the two apart by `order_id`.
  Freezing a wallet stops new orders but does not cancel resting ones —
  `cancelAllLimitOrders` works on a frozen wallet. Exported types:
  `LimitOrderCreateRequest`, `LimitOrder`, `LimitOrderCreated`,
  `LimitOrderPendingApproval`, `LimitOrderCancelAllResponse`.
- **Robinhood Chain (`hood`)** — an Arbitrum L2, EVM like the rest: it shares
  the wallet's one `0x` address, signs through `/wallet/v1/evm/*`, and bridges
  both ways through 1Click. `withdraw({ chain: 'hood' })` and
  `intentsDepositCrossChain({ chain: 'hood' })` both take it. It does not carry
  USDC, which a deposit intent assumes when `token` is omitted, so name one of
  its tokens (`getTokens()` lists them).
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
