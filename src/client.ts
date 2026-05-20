import type { components } from './types.js';
import {
  type ClientOptions,
  type FetchClient,
  type RetryConfig,
  type UnauthenticatedOptions,
  DEFAULT_RETRY,
  makeClient,
  makeUnauthenticatedClient,
  newIdempotencyKey,
  runWithRetry,
} from './http.js';
import { errorFromResponse } from './errors.js';

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

  static async register(
    opts: { body?: RegisterRequest } & UnauthenticatedOptions = {},
  ): Promise<RegisterResponse> {
    const client = makeUnauthenticatedClient(opts);
    const { data, error, response } = await client.POST('/register', { body: opts.body ?? {} });
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
}
