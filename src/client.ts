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
export type IntentsDepositRequest = Schemas['IntentsDepositRequest'];
export type IntentsDepositResponse = Schemas['IntentsDepositResponse'];

export type WithdrawRequest = Schemas['WithdrawRequest'];
export type WithdrawResponse = Schemas['WithdrawResponse'];
export type DryRunResponse = Schemas['DryRunResponse'];

export type SwapRequest = Schemas['SwapRequest'];
export type SwapResponse = Schemas['SwapResponse'];
export type SwapQuoteResponse = Schemas['SwapQuoteResponse'];

export type SignMessageRequest = Schemas['SignMessageRequest'];
export type SignMessageResponse = Schemas['SignMessageResponse'];

export type DepositIntentRequest = Schemas['DepositIntentRequest'];
export type DepositIntentResponse = Schemas['DepositIntentResponse'];
export type DepositStatusResponse = Schemas['DepositStatusResponse'];

export type RequestStatusResponse = Schemas['RequestStatusResponse'];
export type RequestListResponse = Schemas['RequestListResponse'];

export type PolicyResponse = Schemas['PolicyResponse'];
export type PolicyRules = Schemas['PolicyRules'];
export type ApprovalConfig = Schemas['ApprovalConfig'];
export type EncryptPolicyRequest = Schemas['EncryptPolicyRequest'];
export type EncryptPolicyResponse = Schemas['EncryptPolicyResponse'];
export type SignPolicyResponse = Schemas['SignPolicyResponse'];

export type PendingApproval = Schemas['PendingApproval'];
export type PendingApprovalsResponse = Schemas['PendingApprovalsResponse'];
export type Nep413Auth = Schemas['Nep413Auth'];
export type ApproveResponse = Schemas['ApproveResponse'];

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

  reject(approvalId: string, auth: Nep413Auth, reason?: string): Promise<ApproveResponse> {
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

  signMessage(opts: SignMessageRequest): Promise<SignMessageResponse> {
    return runWithRetry(
      () => this.client.POST('/wallet/v1/sign-message', { body: opts }),
      this.retry,
    );
  }

  // ------- Cross-chain deposit (1Click) -------

  /**
   * Create a one-time deposit address on a source chain. Send funds there,
   * then poll {@link getDepositStatus} until `success`.
   */
  createDepositIntent(opts: DepositIntentRequest): Promise<DepositIntentResponse> {
    return runWithRetry(
      () => this.client.POST('/wallet/v1/deposit-intent', { body: opts }),
      this.retry,
    );
  }

  getDepositStatus(intentId: string): Promise<DepositStatusResponse> {
    return runWithRetry(
      () => this.client.GET('/wallet/v1/deposit-status', { params: { query: { id: intentId } } }),
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
  // All routes return 503 confidential_unavailable unless the deployment has
  // ENABLE_CONFIDENTIAL_INTENTS + the confidential partner agreement. See the
  // coordinator's CONFIDENTIAL_INTENTS.md for the mental model and threat model.

  /** SHIELD — move the wallet's public intents balance into the confidential shard. */
  confidentialDeposit(
    opts: ConfidentialShieldRequest & Idempotent,
  ): Promise<ConfidentialOpResponse> {
    const { idempotencyKey, ...body } = opts;
    return runWithRetry(
      () =>
        this.client.POST('/wallet/v1/confidential/deposit', {
          body: body as ConfidentialShieldRequest,
          headers: idempotencyHeader(idempotencyKey),
        }),
      this.retry,
    );
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
   * Cross-chain deposit into the confidential shard (quote only): returns a
   * one-time bridge `deposit_address`. Send funds there out-of-band, then poll
   * getRequest(). The wallet's NEAR address never touches the public side —
   * the most private way to fund a confidential balance.
   */
  confidentialDepositIntent(
    opts: ConfidentialDepositIntentRequest,
  ): Promise<ConfidentialDepositIntentResponse> {
    return runWithRetry(
      () => this.client.POST('/wallet/v1/confidential/deposit-intent', { body: opts }),
      this.retry,
    );
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
