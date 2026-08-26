import type { components } from './types.js';

export type ApiErrorCode = components['schemas']['ErrorCode'];
export type ErrorCode = ApiErrorCode | 'network_error' | 'parse_error';

export type ErrorBody = {
  error?: ApiErrorCode;
  message?: string;
  details?: unknown;
  /** `onchain_tx_failed` only: hash of the broadcast (and reverted) tx. */
  tx_hash?: string;
  /** `onchain_tx_failed` only: raw NEAR execution-failure JSON. */
  failure?: unknown;
  /** `agent_connect_denied` only: the rule class, e.g. `grant_exhausted`. */
  class?: string;
  /** `agent_connect_denied` only: retrying is pointless; the owner must act. */
  terminal?: boolean;
  /** `agent_connect_denied` only: which promise of the decoded request. */
  promise_index?: number | null;
  /** `agent_connect_denied` only: further violations beyond the reported one. */
  additional_violations?: number;
  /** `wallet_busy` only: the request to poll before retrying. */
  in_flight_request_id?: string | null;
  /** `wallet_busy` only: what the holder is doing, e.g. `cross_chain_withdraw`. */
  in_flight_operation?: string | null;
};

export interface OutlayerErrorOptions {
  code: ErrorCode;
  message: string;
  status: number;
  details?: unknown;
}

export class OutlayerError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: unknown;

  constructor(opts: OutlayerErrorOptions) {
    super(opts.message);
    this.name = 'OutlayerError';
    this.code = opts.code;
    this.status = opts.status;
    this.details = opts.details;
  }
}

export class PolicyDeniedError extends OutlayerError {
  constructor(opts: OutlayerErrorOptions) {
    super(opts);
    this.name = 'PolicyDeniedError';
  }
}

export class WalletFrozenError extends OutlayerError {
  constructor(opts: OutlayerErrorOptions) {
    super(opts);
    this.name = 'WalletFrozenError';
  }
}

export class UnauthorizedError extends OutlayerError {
  constructor(opts: OutlayerErrorOptions) {
    super(opts);
    this.name = 'UnauthorizedError';
  }
}

export class RateLimitedError extends OutlayerError {
  constructor(opts: OutlayerErrorOptions) {
    super(opts);
    this.name = 'RateLimitedError';
  }
}

export class NotFoundError extends OutlayerError {
  constructor(opts: OutlayerErrorOptions) {
    super(opts);
    this.name = 'NotFoundError';
  }
}

export class BadRequestError extends OutlayerError {
  constructor(opts: OutlayerErrorOptions) {
    super(opts);
    this.name = 'BadRequestError';
  }
}

/**
 * The transaction was broadcast — it IS on chain (`txHash` is real) — but its
 * execution reverted (contract panic, out of gas). Never retry: re-submitting
 * duplicates an already-recorded transaction. HTTP 422.
 */
export class OnChainTxFailedError extends OutlayerError {
  readonly txHash: string;
  readonly failure: unknown;

  constructor(opts: OutlayerErrorOptions & { txHash?: string | undefined; failure?: unknown }) {
    super(opts);
    this.name = 'OnChainTxFailedError';
    this.txHash = opts.txHash ?? '';
    this.failure = opts.failure;
  }
}

/**
 * The Agent Connect pre-flight refused before signing, so no gas was spent.
 *
 * Read {@link terminal} FIRST. `true` means retrying is pointless and the
 * owner has to act — issue a new grant, re-provision the executor, fund the
 * account, or rewrite the request. `false` means the same request may succeed
 * later untouched (a freeze lifted, recognized wallet code restored). An agent
 * that retries a terminal refusal spins forever while nobody is told.
 */
export class AgentConnectDeniedError extends OutlayerError {
  /** Stable machine class, e.g. `grant_exhausted`, `receiver_not_granted`,
   *  `grant_shape_violation:grant_call_deposit`. */
  readonly class: string;
  readonly terminal: boolean;
  /** Which promise of the decoded request, when the rule is about one. */
  readonly promiseIndex: number | null;
  /** Further violations the same request carries beyond this one. */
  readonly additionalViolations: number;

  constructor(
    opts: OutlayerErrorOptions & {
      violationClass?: string | undefined;
      terminal?: boolean | undefined;
      promiseIndex?: number | null | undefined;
      additionalViolations?: number | undefined;
    },
  ) {
    super(opts);
    this.name = 'AgentConnectDeniedError';
    this.class = opts.violationClass ?? '';
    // Default TRUE: an unknown refusal is not something to retry blindly.
    this.terminal = opts.terminal ?? true;
    this.promiseIndex = opts.promiseIndex ?? null;
    this.additionalViolations = opts.additionalViolations ?? 0;
  }
}

/**
 * Another money-moving operation holds this wallet. A wallet runs one spend at
 * a time so the spending limits are counted correctly.
 *
 * Poll {@link inFlightRequestId} when it is set. `null` never means the wallet
 * is free — it means there is nothing to poll, and there are two reasons for
 * that: the holder has not written its request row yet (retrying shortly
 * yields an id), or the operation writes no request row at all, as a
 * cross-chain deposit intent does. The id is deliberately withheld until its
 * row exists, because one handed out earlier answers `404` and reads as a
 * request that was lost.
 *
 * {@link inFlightOperation} is set either way, and is the one to branch on: a
 * `transfer` clears in seconds while a `cross_chain_withdraw` can run for
 * minutes.
 */
export class WalletBusyError extends OutlayerError {
  readonly inFlightRequestId: string | null;
  readonly inFlightOperation: string | null;

  constructor(
    opts: OutlayerErrorOptions & {
      inFlightRequestId?: string | null | undefined;
      inFlightOperation?: string | null | undefined;
    },
  ) {
    super(opts);
    this.name = 'WalletBusyError';
    this.inFlightRequestId = opts.inFlightRequestId ?? null;
    this.inFlightOperation = opts.inFlightOperation ?? null;
  }
}

const codeToCtor: Partial<Record<ErrorCode, new (opts: OutlayerErrorOptions) => OutlayerError>> = {
  policy_denied: PolicyDeniedError,
  wallet_frozen: WalletFrozenError,
  missing_auth: UnauthorizedError,
  invalid_api_key: UnauthorizedError,
  timestamp_expired: UnauthorizedError,
  rate_limited: RateLimitedError,
  request_not_found: NotFoundError,
  approval_not_found: NotFoundError,
  bad_request: BadRequestError,
  invalid_address: BadRequestError,
  insufficient_balance: BadRequestError,
  unsupported_chain: BadRequestError,
  unsupported_token: BadRequestError,
  binding_not_found: NotFoundError,
};

export function makeError(body: ErrorBody, status: number): OutlayerError {
  const code: ErrorCode = body.error ?? 'parse_error';
  const message = body.message ?? `HTTP ${status}`;
  const opts: OutlayerErrorOptions =
    body.details !== undefined
      ? { code, message, status, details: body.details }
      : { code, message, status };
  // onchain_tx_failed carries tx_hash + failure at the top level of the body
  // (not under `details`) — surface them on the typed error.
  if (code === 'onchain_tx_failed') {
    return new OnChainTxFailedError({ ...opts, txHash: body.tx_hash, failure: body.failure });
  }
  // Same reason as above: these bodies carry their meaning OUTSIDE `details`,
  // and a client that only sees {code, message} cannot act on `terminal` —
  // which is the one field that decides whether to retry at all.
  if (code === 'agent_connect_denied') {
    return new AgentConnectDeniedError({
      ...opts,
      violationClass: body.class,
      terminal: body.terminal,
      promiseIndex: body.promise_index,
      additionalViolations: body.additional_violations,
    });
  }
  if (code === 'wallet_busy') {
    return new WalletBusyError({
      ...opts,
      inFlightRequestId: body.in_flight_request_id,
      inFlightOperation: body.in_flight_operation,
    });
  }
  const Ctor = codeToCtor[code] ?? OutlayerError;
  return new Ctor(opts);
}

export async function errorFromResponse(
  response: Response,
  parsed?: unknown,
): Promise<OutlayerError> {
  let body: ErrorBody;
  if (parsed && typeof parsed === 'object') {
    body = parsed as ErrorBody;
  } else {
    try {
      body = (await response.clone().json()) as ErrorBody;
    } catch {
      body = { error: 'internal_error', message: response.statusText };
    }
  }
  return makeError(body, response.status);
}
