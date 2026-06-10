import { errorFromResponse } from './errors.js';
import {
  type ClientOptions,
  DEFAULT_RETRY,
  type FetchClient,
  type RetryConfig,
  type UnauthenticatedOptions,
  makeClient,
  makeUnauthenticatedClient,
  newIdempotencyKey,
  runWithRetry,
} from './http.js';
import type { components } from './types.js';

type Schemas = components['schemas'];

// ---------------------------------------------------------------------------
// Re-exported user-facing types (so consumers don't import paths/components)
// ---------------------------------------------------------------------------

export type Chain = Schemas['Chain'];
export type RequestType = Schemas['RequestType'];
export type RequestStatus = Schemas['RequestStatus'];

export type RegisterRequest = Schemas['RegisterRequest'];
export type RegisterResponse = Schemas['RegisterResponse'];
export type AddressResponse = Schemas['AddressResponse'];
export type BalanceResponse = Schemas['BalanceResponse'];
export type TokensResponse = Schemas['TokensResponse'];

export type CallRequest = Schemas['CallRequest'];
export type CallResponse = Schemas['CallResponse'];
export type TransferRequest = Schemas['TransferRequest'];
export type DeleteRequest = Schemas['DeleteRequest'];
export type DeleteResponse = Schemas['DeleteResponse'];
export type StorageDepositRequest = Schemas['StorageDepositRequest'];
export type StorageDepositResponse = Schemas['StorageDepositResponse'];
export type IntentsDepositRequest = Schemas['IntentsDepositRequest'];
export type IntentsDepositResponse = Schemas['IntentsDepositResponse'];

export type WithdrawRequest = Schemas['WithdrawRequest'];
export type WithdrawResponse = Schemas['WithdrawResponse'];
export type IntentsTransferRequest = Schemas['IntentsTransferRequest'];
export type DryRunResponse = Schemas['DryRunResponse'];

export type SwapRequest = Schemas['SwapRequest'];
export type SwapResponse = Schemas['SwapResponse'];
export type SwapQuoteResponse = Schemas['SwapQuoteResponse'];

export type SignMessageRequest = Schemas['SignMessageRequest'];
export type SignMessageResponse = Schemas['SignMessageResponse'];

export type AuthSignRequest = Schemas['AuthSignRequest'];
export type AuthSignResponse = Schemas['AuthSignResponse'];

export type DepositIntentRequest = Schemas['DepositIntentRequest'];
export type DepositIntentResponse = Schemas['DepositIntentResponse'];
export type DepositStatusResponse = Schemas['DepositStatusResponse'];

export type PaymentCheckCreateRequest = Schemas['PaymentCheckCreateRequest'];
export type PaymentCheckCreateResponse = Schemas['PaymentCheckCreateResponse'];
export type PaymentCheckBatchCreateRequest = Schemas['PaymentCheckBatchCreateRequest'];
export type PaymentCheckBatchCreateResponse = Schemas['PaymentCheckBatchCreateResponse'];
export type PaymentCheckClaimRequest = Schemas['PaymentCheckClaimRequest'];
export type PaymentCheckClaimResponse = Schemas['PaymentCheckClaimResponse'];
export type PaymentCheckReclaimRequest = Schemas['PaymentCheckReclaimRequest'];
export type PaymentCheckReclaimResponse = Schemas['PaymentCheckReclaimResponse'];
export type PaymentCheckStatusResponse = Schemas['PaymentCheckStatusResponse'];
export type PaymentCheckListResponse = Schemas['PaymentCheckListResponse'];
export type PaymentCheckPeekRequest = Schemas['PaymentCheckPeekRequest'];
export type PaymentCheckPeekResponse = Schemas['PaymentCheckPeekResponse'];

export type RequestStatusResponse = Schemas['RequestStatusResponse'];
export type RequestListResponse = Schemas['RequestListResponse'];

export type PolicyResponse = Schemas['PolicyResponse'];
export type PolicyRules = Schemas['PolicyRules'];
export type ApprovalConfig = Schemas['ApprovalConfig'];
export type Capabilities = Schemas['Capabilities'];
export type EncryptPolicyRequest = Schemas['EncryptPolicyRequest'];
export type EncryptPolicyResponse = Schemas['EncryptPolicyResponse'];
export type SignPolicyResponse = Schemas['SignPolicyResponse'];

export type PendingApproval = Schemas['PendingApproval'];
export type PendingApprovalsResponse = Schemas['PendingApprovalsResponse'];
export type ApprovalDetail = Schemas['ApprovalDetail'];
export type Nep413Auth = Schemas['Nep413Auth'];
export type ApproveResponse = Schemas['ApproveResponse'];
export type RejectResponse = Schemas['RejectResponse'];

export type AuditEvent = Schemas['AuditEvent'];
export type AuditResponse = Schemas['AuditResponse'];

// === Confidential Intents ===
// Request bodies are structural aliases of their public /intents/* siblings
// (allOf in the spec); the alias just adds documentation. Read-only quotes
// reuse SwapQuoteResponse; async actions return ConfidentialOpResponse.
export type ConfidentialShieldRequest = Schemas['ConfidentialShieldRequest'];
export type ConfidentialUnshieldRequest = Schemas['ConfidentialUnshieldRequest'];
export type ConfidentialWithdrawRequest = Schemas['ConfidentialWithdrawRequest'];
export type ConfidentialTransferRequest = Schemas['ConfidentialTransferRequest'];
export type ConfidentialSwapRequest = Schemas['ConfidentialSwapRequest'];
export type ConfidentialDepositIntentRequest = Schemas['ConfidentialDepositIntentRequest'];
export type ConfidentialDepositIntentResponse = Schemas['ConfidentialDepositIntentResponse'];
export type ConfidentialOpResponse = Schemas['ConfidentialOpResponse'];
export type ConfidentialBalanceResponse = Schemas['ConfidentialBalanceResponse'];
export type ConfidentialBalancesResponse = Schemas['ConfidentialBalancesResponse'];

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

type Idempotent = { idempotencyKey?: string };

function idempotencyHeader(key: string | undefined): Record<string, string> {
  return { 'Idempotency-Key': key ?? newIdempotencyKey() };
}

// ---------------------------------------------------------------------------
// Sub-namespaces
// ---------------------------------------------------------------------------

export class PolicyAPI {
  constructor(
    private readonly client: FetchClient,
    private readonly retry: Required<RetryConfig>,
  ) {}

  get(): Promise<PolicyResponse> {
    return runWithRetry(() => this.client.GET('/wallet/v1/policy'), this.retry);
  }

  encrypt(body: EncryptPolicyRequest): Promise<EncryptPolicyResponse> {
    return runWithRetry(() => this.client.POST('/wallet/v1/encrypt-policy', { body }), this.retry);
  }

  sign(encryptedData: string): Promise<SignPolicyResponse> {
    return runWithRetry(
      () => this.client.POST('/wallet/v1/sign-policy', { body: { encrypted_data: encryptedData } }),
      this.retry,
    );
  }

  invalidateCache(walletId: string): Promise<void> {
    return runWithRetry(
      () => this.client.POST('/wallet/v1/invalidate-cache', { body: { wallet_id: walletId } }),
      this.retry,
    ).then(() => undefined);
  }
}

export class ApprovalsAPI {
  constructor(
    private readonly client: FetchClient,
    private readonly retry: Required<RetryConfig>,
  ) {}

  listPending(): Promise<PendingApprovalsResponse> {
    return runWithRetry(() => this.client.GET('/wallet/v1/pending_approvals'), this.retry);
  }

  /**
   * Fetch one pending approval's detail (public, read-only). Returns the
   * `wallet_pubkey` + `request_hash` an approver must bind into the NEP-413
   * vote message (`approve:{id}:{wallet_pubkey}:{request_hash}`), and the
   * canonical `op` to render. Use before {@link approve} to build the signature.
   */
  detail(approvalId: string): Promise<ApprovalDetail> {
    return runWithRetry(
      () =>
        this.client.GET('/wallet/v1/approval/{id}', {
          params: { path: { id: approvalId } },
        }),
      this.retry,
    );
  }

  approve(approvalId: string, auth: Nep413Auth): Promise<ApproveResponse> {
    return runWithRetry(
      () =>
        this.client.POST('/wallet/v1/approve/{id}', {
          params: { path: { id: approvalId } },
          body: auth,
        }),
      this.retry,
    );
  }

  reject(approvalId: string, auth: Nep413Auth, reason?: string): Promise<RejectResponse> {
    const body = reason !== undefined ? { ...auth, reason } : auth;
    return runWithRetry(
      () =>
        this.client.POST('/wallet/v1/reject/{id}', {
          params: { path: { id: approvalId } },
          body,
        }),
      this.retry,
    );
  }
}

export class AuditAPI {
  constructor(
    private readonly client: FetchClient,
    private readonly retry: Required<RetryConfig>,
  ) {}

  list(opts: { limit?: number; offset?: number } = {}): Promise<AuditResponse> {
    return runWithRetry(
      () => this.client.GET('/wallet/v1/audit', { params: { query: opts } }),
      this.retry,
    );
  }
}

// ---------------------------------------------------------------------------
// Main client
// ---------------------------------------------------------------------------

export class OutlayerClient {
  private readonly client: FetchClient;
  private readonly retry: Required<RetryConfig>;

  readonly policy: PolicyAPI;
  readonly approvals: ApprovalsAPI;
  readonly audit: AuditAPI;

  constructor(opts: ClientOptions) {
    const { client, retry } = makeClient(opts);
    this.client = client;
    this.retry = retry;
    this.policy = new PolicyAPI(client, retry);
    this.approvals = new ApprovalsAPI(client, retry);
    this.audit = new AuditAPI(client, retry);
  }

  // ------- Static factory: register a new wallet (no auth) -------

  /**
   * Register a new wallet and obtain an API key.
   *
   * - Empty call: anonymous wallet on OutLayer's shared master. Convenient, no setup.
   * - With `vaultId`: bind to a deployed customer vault so keys derive through
   *   the per-vault master. Vault binding is permanent.
   * - With `body`: full control — pass any `RegisterRequest` field (e.g., NEP-413
   *   account-binding fields). `vaultId` is merged into `body.vault_id` if not
   *   already set.
   *
   * Vault deployment is NOT done here — use the dashboard
   * (https://outlayer.fastnear.com/vault) or `outlayer vault init` CLI.
   * See docs/vaults.md for the full flow.
   */
  static async register(
    opts: {
      vaultId?: string;
      body?: RegisterRequest;
    } & UnauthenticatedOptions = {},
  ): Promise<RegisterResponse> {
    const client = makeUnauthenticatedClient(opts);
    const body: RegisterRequest = { ...(opts.body ?? {}) };
    if (opts.vaultId !== undefined && body.vault_id === undefined) {
      body.vault_id = opts.vaultId;
    }
    const { data, error, response } = await client.POST('/register', { body });
    if (!response.ok) throw await errorFromResponse(response, error);
    return data as RegisterResponse;
  }

  // ------- Wallet read -------

  getAddress(chain: Chain): Promise<AddressResponse> {
    return runWithRetry(
      () => this.client.GET('/wallet/v1/address', { params: { query: { chain } } }),
      this.retry,
    );
  }

  getBalance(
    opts: { chain?: Chain; token?: string; source?: 'chain' | 'intents' } = {},
  ): Promise<BalanceResponse> {
    return runWithRetry(
      () => this.client.GET('/wallet/v1/balance', { params: { query: opts } }),
      this.retry,
    );
  }

  listTokens(): Promise<TokensResponse> {
    return runWithRetry(() => this.client.GET('/wallet/v1/tokens'), this.retry);
  }

  // ------- Wallet write -------

  call(opts: CallRequest & Idempotent): Promise<CallResponse> {
    const { idempotencyKey, ...body } = opts;
    return runWithRetry(
      () =>
        this.client.POST('/wallet/v1/call', {
          body: body as CallRequest,
          headers: idempotencyHeader(idempotencyKey),
        }),
      this.retry,
    );
  }

  transfer(opts: TransferRequest & Idempotent): Promise<CallResponse> {
    const { idempotencyKey, ...body } = opts;
    return runWithRetry(
      () =>
        this.client.POST('/wallet/v1/transfer', {
          body: body as TransferRequest,
          headers: idempotencyHeader(idempotencyKey),
        }),
      this.retry,
    );
  }

  /**
   * Irreversibly delete the wallet account, sweeping its **entire** NEAR
   * balance to `beneficiary` (NEAR's native `DeleteAccount`), revoking all API
   * keys, and marking the wallet deleted. The beneficiary cannot be the
   * wallet's own account and the wallet must have a non-zero on-chain balance.
   * On a multisig wallet the response is `status=pending_approval` with an
   * `approval_id` and `request_hash` for the approval flow.
   */
  delete(opts: DeleteRequest & Idempotent): Promise<DeleteResponse> {
    const { idempotencyKey, ...body } = opts;
    return runWithRetry(
      () =>
        this.client.POST('/wallet/v1/delete', {
          body: body as DeleteRequest,
          headers: idempotencyHeader(idempotencyKey),
        }),
      this.retry,
    );
  }

  /**
   * Register storage on a NEP-141 token contract so `accountId` (defaults to
   * the wallet's own NEAR address) can hold that token. Idempotent: returns
   * `already_registered: true` without signing when the account is already
   * registered. The wallet must have NEAR to pay gas when a transaction is
   * required.
   */
  storageDeposit(opts: StorageDepositRequest & Idempotent): Promise<StorageDepositResponse> {
    const { idempotencyKey, ...body } = opts;
    return runWithRetry(
      () =>
        this.client.POST('/wallet/v1/storage-deposit', {
          body: body as StorageDepositRequest,
          headers: idempotencyHeader(idempotencyKey),
        }),
      this.retry,
    );
  }

  intentsDeposit(opts: IntentsDepositRequest & Idempotent): Promise<IntentsDepositResponse> {
    const { idempotencyKey, ...body } = opts;
    return runWithRetry(
      () =>
        this.client.POST('/wallet/v1/intents/deposit', {
          body: body as IntentsDepositRequest,
          headers: idempotencyHeader(idempotencyKey),
        }),
      this.retry,
    );
  }

  withdraw(opts: WithdrawRequest & Idempotent): Promise<WithdrawResponse> {
    const { idempotencyKey, ...body } = opts;
    return runWithRetry(
      () =>
        this.client.POST('/wallet/v1/intents/withdraw', {
          body: body as WithdrawRequest,
          headers: idempotencyHeader(idempotencyKey),
        }),
      this.retry,
    );
  }

  /** Transfer inside NEAR Intents to another account's intents balance — gasless, stays inside the intents pool (not a withdrawal). */
  intentsTransfer(opts: IntentsTransferRequest & Idempotent): Promise<WithdrawResponse> {
    const { idempotencyKey, ...body } = opts;
    return runWithRetry(
      () =>
        this.client.POST('/wallet/v1/intents/transfer', {
          body: body as IntentsTransferRequest,
          headers: idempotencyHeader(idempotencyKey),
        }),
      this.retry,
    );
  }

  withdrawDryRun(opts: WithdrawRequest): Promise<DryRunResponse> {
    return runWithRetry(
      () => this.client.POST('/wallet/v1/intents/withdraw/dry-run', { body: opts }),
      this.retry,
    );
  }

  swap(opts: SwapRequest & Idempotent): Promise<SwapResponse> {
    const { idempotencyKey, ...body } = opts;
    return runWithRetry(
      () =>
        this.client.POST('/wallet/v1/intents/swap', {
          body: body as SwapRequest,
          headers: idempotencyHeader(idempotencyKey),
        }),
      this.retry,
    );
  }

  swapQuote(opts: SwapRequest): Promise<SwapQuoteResponse> {
    return runWithRetry(
      () => this.client.POST('/wallet/v1/intents/swap/quote', { body: opts }),
      this.retry,
    );
  }

  /**
   * Sign a generic NEP-413 message (e.g. dApp login). Gated by the
   * `sign_message` capability (recipient default-DENY allowlist; `intents.*`
   * excluded). `format` is NEP-413 only — `format:"raw"` is rejected; for
   * OutLayer NEAR-key auth use {@link authSign}.
   */
  signMessage(opts: SignMessageRequest): Promise<SignMessageResponse> {
    return runWithRetry(
      () => this.client.POST('/wallet/v1/sign-message', { body: opts }),
      this.retry,
    );
  }

  /**
   * Produce an OutLayer NEAR-key auth signature (Bearer `near:` token,
   * `POST /register`, or `PUT /api-key` from a deterministic wallet's own key).
   *
   * The keystore builds the exact `<prefix>:<seed>:<ts>` challenge with a fresh
   * **server** timestamp and signs it raw ed25519 — you do not supply the
   * timestamp. Send the returned `auth_message` verbatim. `vault_id` is only
   * valid for `purpose: 'bearer'`. Replaces the old
   * `signMessage({ format: 'raw' })`.
   */
  authSign(opts: AuthSignRequest): Promise<AuthSignResponse> {
    return runWithRetry(() => this.client.POST('/wallet/v1/auth-sign', { body: opts }), this.retry);
  }

  // ------- Cross-chain deposit (via 1Click / NEAR Intents) -------

  /**
   * Create a one-time deposit address on a source chain via 1Click / NEAR
   * Intents. Send funds there, then poll {@link getCrossChainDepositStatus}
   * until `success`.
   */
  intentsDepositCrossChain(opts: DepositIntentRequest): Promise<DepositIntentResponse> {
    return runWithRetry(
      () => this.client.POST('/wallet/v1/intents/deposit/cross-chain', { body: opts }),
      this.retry,
    );
  }

  /** Poll a cross-chain deposit's status (lazily refreshed against 1Click). */
  getCrossChainDepositStatus(intentId: string): Promise<DepositStatusResponse> {
    return runWithRetry(
      () =>
        this.client.GET('/wallet/v1/intents/deposit/cross-chain/status', {
          params: { query: { id: intentId } },
        }),
      this.retry,
    );
  }

  /**
   * List this wallet's cross-chain deposits, most recent first. Unlike
   * {@link getCrossChainDepositStatus}, this does NOT lazily refresh in-flight
   * deposits against 1Click — statuses are read as last persisted. `limit` is
   * capped at 100 server-side (default 20).
   */
  listCrossChainDeposits(
    opts: { limit?: number; offset?: number } = {},
  ): Promise<DepositStatusResponse[]> {
    return runWithRetry(
      () =>
        this.client.GET('/wallet/v1/intents/deposit/cross-chain/list', { params: { query: opts } }),
      this.retry,
    );
  }

  /**
   * @deprecated Use {@link intentsDepositCrossChain}. Thin wrapper kept for
   * backward compatibility; delegates to the canonical method.
   */
  createDepositIntent(opts: DepositIntentRequest): Promise<DepositIntentResponse> {
    return this.intentsDepositCrossChain(opts);
  }

  /**
   * @deprecated Use {@link getCrossChainDepositStatus}. Thin wrapper kept for
   * backward compatibility; delegates to the canonical method.
   */
  getDepositStatus(intentId: string): Promise<DepositStatusResponse> {
    return this.getCrossChainDepositStatus(intentId);
  }

  /**
   * @deprecated Use {@link listCrossChainDeposits}. Thin wrapper kept for
   * backward compatibility; delegates to the canonical method.
   */
  listDeposits(opts: { limit?: number; offset?: number } = {}): Promise<DepositStatusResponse[]> {
    return this.listCrossChainDeposits(opts);
  }

  // ------- Payment checks (agent-to-agent gasless payments) -------

  /**
   * Create a payment check: moves intents balance to a fresh ephemeral account
   * and returns its private key as `check_key`. Whoever holds `check_key` can
   * {@link claimPaymentCheck}; the creator can {@link reclaimPaymentCheck}.
   * Gated by the default-DENY `payment_check` capability + per-tx amount cap
   * (NOT multisig). Fund the wallet's intents balance first via
   * {@link intentsDeposit}.
   */
  createPaymentCheck(
    opts: PaymentCheckCreateRequest & Idempotent,
  ): Promise<PaymentCheckCreateResponse> {
    const { idempotencyKey, ...body } = opts;
    return runWithRetry(
      () =>
        this.client.POST('/wallet/v1/payment-check/create', {
          body: body as PaymentCheckCreateRequest,
          headers: idempotencyHeader(idempotencyKey),
        }),
      this.retry,
    );
  }

  /** Create 1-10 payment checks in one call. Same security model as {@link createPaymentCheck}. */
  batchCreatePaymentChecks(
    opts: PaymentCheckBatchCreateRequest & Idempotent,
  ): Promise<PaymentCheckBatchCreateResponse> {
    const { idempotencyKey, ...body } = opts;
    return runWithRetry(
      () =>
        this.client.POST('/wallet/v1/payment-check/batch-create', {
          body: body as PaymentCheckBatchCreateRequest,
          headers: idempotencyHeader(idempotencyKey),
        }),
      this.retry,
    );
  }

  /**
   * Claim a payment check into this wallet's intents balance using its
   * `check_key`. Signed by the ephemeral key (not the keystore). Omit `amount`
   * for a full claim or pass a partial amount in minimal units.
   */
  claimPaymentCheck(opts: PaymentCheckClaimRequest): Promise<PaymentCheckClaimResponse> {
    return runWithRetry(
      () => this.client.POST('/wallet/v1/payment-check/claim', { body: opts }),
      this.retry,
    );
  }

  /**
   * Reclaim a payment check this wallet created (by `check_id`) back to its own
   * intents balance — cancel an unclaimed check. Omit `amount` for a full
   * reclaim or pass a partial amount.
   */
  reclaimPaymentCheck(opts: PaymentCheckReclaimRequest): Promise<PaymentCheckReclaimResponse> {
    return runWithRetry(
      () => this.client.POST('/wallet/v1/payment-check/reclaim', { body: opts }),
      this.retry,
    );
  }

  /** Get a payment check's lifecycle status by `check_id` (creator-scoped). */
  getPaymentCheckStatus(checkId: string): Promise<PaymentCheckStatusResponse> {
    return runWithRetry(
      () =>
        this.client.GET('/wallet/v1/payment-check/status', {
          params: { query: { check_id: checkId } },
        }),
      this.retry,
    );
  }

  /**
   * List payment checks this wallet created, most recent first. Optional
   * `status` filter accepts stored statuses plus the virtual `expired`. `limit`
   * is capped at 100 server-side (default 50).
   */
  listPaymentChecks(
    opts: { status?: string; limit?: number; offset?: number } = {},
  ): Promise<PaymentCheckListResponse> {
    return runWithRetry(
      () => this.client.GET('/wallet/v1/payment-check/list', { params: { query: opts } }),
      this.retry,
    );
  }

  /**
   * Inspect a payment check by its `check_key` without claiming — returns the
   * live on-chain balance plus stored metadata. Use before
   * {@link claimPaymentCheck} to see what a key is worth.
   */
  peekPaymentCheck(opts: PaymentCheckPeekRequest): Promise<PaymentCheckPeekResponse> {
    return runWithRetry(
      () => this.client.POST('/wallet/v1/payment-check/peek', { body: opts }),
      this.retry,
    );
  }

  // ------- Async request tracking -------

  getRequest(id: string): Promise<RequestStatusResponse> {
    return runWithRetry(
      () => this.client.GET('/wallet/v1/requests/{id}', { params: { path: { id } } }),
      this.retry,
    );
  }

  listRequests(
    opts: { type?: RequestType; status?: RequestStatus; limit?: number; offset?: number } = {},
  ): Promise<RequestListResponse> {
    return runWithRetry(
      () => this.client.GET('/wallet/v1/requests', { params: { query: opts } }),
      this.retry,
    );
  }

  // ------- Confidential Intents (Defuse confidential shard) -------
  //
  // Operate on the confidential shard (`intents.far` on a private NEAR shard,
  // no public RPC). Mirror the public /intents/* methods in shape — same
  // wk_ API key, no extra signing. Async actions return a `request_id` to poll
  // via getRequest(); read-only quotes return immediately.
  //
  // All routes return 503 service_unavailable unless the deployment has
  // ENABLE_CONFIDENTIAL_INTENTS + the confidential partner agreement. See the
  // coordinator's CONFIDENTIAL_INTENTS.md for the mental model and threat model.

  /** SHIELD — move the wallet's public intents balance into the confidential shard. */
  confidentialShield(
    opts: ConfidentialShieldRequest & Idempotent,
  ): Promise<ConfidentialOpResponse> {
    const { idempotencyKey, ...body } = opts;
    return runWithRetry(
      () =>
        this.client.POST('/wallet/v1/confidential/shield', {
          body: body as ConfidentialShieldRequest,
          headers: idempotencyHeader(idempotencyKey),
        }),
      this.retry,
    );
  }

  /**
   * @deprecated Use {@link confidentialShield}. Thin wrapper kept for backward
   * compatibility; delegates to the canonical method.
   */
  confidentialDeposit(
    opts: ConfidentialShieldRequest & Idempotent,
  ): Promise<ConfidentialOpResponse> {
    return this.confidentialShield(opts);
  }

  /** UNSHIELD — move the confidential balance back to the public intents balance. */
  confidentialUnshield(
    opts: ConfidentialUnshieldRequest & Idempotent,
  ): Promise<ConfidentialOpResponse> {
    const { idempotencyKey, ...body } = opts;
    return runWithRetry(
      () =>
        this.client.POST('/wallet/v1/confidential/unshield', {
          body: body as ConfidentialUnshieldRequest,
          headers: idempotencyHeader(idempotencyKey),
        }),
      this.retry,
    );
  }

  /**
   * Withdraw a confidential balance to an external chain. `chain="near"`
   * delivers native NEAR to the named account via 1Click's `native_withdraw`
   * (use {@link confidentialUnshield} to return funds to your own public balance).
   */
  confidentialWithdraw(
    opts: ConfidentialWithdrawRequest & Idempotent,
  ): Promise<ConfidentialOpResponse> {
    const { idempotencyKey, ...body } = opts;
    return runWithRetry(
      () =>
        this.client.POST('/wallet/v1/confidential/withdraw', {
          body: body as ConfidentialWithdrawRequest,
          headers: idempotencyHeader(idempotencyKey),
        }),
      this.retry,
    );
  }

  /** Quote a confidential withdraw without signing or submitting. Read-only. */
  confidentialWithdrawDryRun(opts: ConfidentialWithdrawRequest): Promise<SwapQuoteResponse> {
    return runWithRetry(
      () => this.client.POST('/wallet/v1/confidential/withdraw/dry-run', { body: opts }),
      this.retry,
    );
  }

  /** Private transfer to another account's confidential balance — no public-chain trace. */
  confidentialTransfer(
    opts: ConfidentialTransferRequest & Idempotent,
  ): Promise<ConfidentialOpResponse> {
    const { idempotencyKey, ...body } = opts;
    return runWithRetry(
      () =>
        this.client.POST('/wallet/v1/confidential/transfer', {
          body: body as ConfidentialTransferRequest,
          headers: idempotencyHeader(idempotencyKey),
        }),
      this.retry,
    );
  }

  /** Swap between two distinct assets inside the confidential shard. */
  confidentialSwap(opts: ConfidentialSwapRequest & Idempotent): Promise<ConfidentialOpResponse> {
    const { idempotencyKey, ...body } = opts;
    return runWithRetry(
      () =>
        this.client.POST('/wallet/v1/confidential/swap', {
          body: body as ConfidentialSwapRequest,
          headers: idempotencyHeader(idempotencyKey),
        }),
      this.retry,
    );
  }

  /** Quote a confidential swap without executing. Read-only. */
  confidentialSwapQuote(opts: ConfidentialSwapRequest): Promise<SwapQuoteResponse> {
    return runWithRetry(
      () => this.client.POST('/wallet/v1/confidential/swap/quote', { body: opts }),
      this.retry,
    );
  }

  /**
   * Cross-chain deposit into the confidential shard (quote only) via 1Click /
   * NEAR Intents: returns a one-time `deposit_address`. Send funds there
   * out-of-band, then poll getRequest(). The wallet's NEAR address never
   * touches the public side — the most private way to fund a confidential
   * balance.
   */
  confidentialDepositCrossChain(
    opts: ConfidentialDepositIntentRequest,
  ): Promise<ConfidentialDepositIntentResponse> {
    return runWithRetry(
      () => this.client.POST('/wallet/v1/confidential/deposit/cross-chain', { body: opts }),
      this.retry,
    );
  }

  /**
   * @deprecated Use {@link confidentialDepositCrossChain}. Thin wrapper kept
   * for backward compatibility; delegates to the canonical method.
   */
  confidentialDepositIntent(
    opts: ConfidentialDepositIntentRequest,
  ): Promise<ConfidentialDepositIntentResponse> {
    return this.confidentialDepositCrossChain(opts);
  }

  /**
   * Read confidential balance(s) from the private shard.
   * - Pass `{ token }` to get a single balance ({@link ConfidentialBalanceResponse}).
   * - Omit to get the full list ({@link ConfidentialBalancesResponse}).
   *
   * Narrow on `'balances' in result` to discriminate the union.
   */
  confidentialBalance(
    opts: { token?: string } = {},
  ): Promise<ConfidentialBalanceResponse | ConfidentialBalancesResponse> {
    return runWithRetry(
      () => this.client.GET('/wallet/v1/confidential/balance', { params: { query: opts } }),
      this.retry,
    );
  }
}
