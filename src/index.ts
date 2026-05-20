export {
  OutlayerClient,
  PolicyAPI,
  ApprovalsAPI,
  AuditAPI,
} from './client.js';

export type {
  Chain,
  RequestType,
  RequestStatus,
  RegisterRequest,
  RegisterResponse,
  AddressResponse,
  BalanceResponse,
  TokensResponse,
  CallRequest,
  CallResponse,
  TransferRequest,
  IntentsDepositRequest,
  IntentsDepositResponse,
  WithdrawRequest,
  WithdrawResponse,
  DryRunResponse,
  SwapRequest,
  SwapResponse,
  SwapQuoteResponse,
  SignMessageRequest,
  SignMessageResponse,
  RequestStatusResponse,
  RequestListResponse,
  PolicyResponse,
  PolicyRules,
  ApprovalConfig,
  EncryptPolicyRequest,
  EncryptPolicyResponse,
  SignPolicyResponse,
  PendingApproval,
  PendingApprovalsResponse,
  Nep413Auth,
  ApproveResponse,
  AuditEvent,
  AuditResponse,
} from './client.js';

export {
  OutlayerError,
  PolicyDeniedError,
  WalletFrozenError,
  UnauthorizedError,
  RateLimitedError,
  NotFoundError,
  BadRequestError,
} from './errors.js';

export type { ApiErrorCode, ErrorCode } from './errors.js';

export type { ClientOptions, RetryConfig, UnauthenticatedOptions } from './http.js';
