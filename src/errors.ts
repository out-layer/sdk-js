import type { components } from './types.js';

export type ApiErrorCode = components['schemas']['ErrorCode'];
export type ErrorCode = ApiErrorCode | 'network_error' | 'parse_error';

export type ErrorBody = {
  error?: ApiErrorCode;
  message?: string;
  details?: unknown;
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
};

export function makeError(body: ErrorBody, status: number): OutlayerError {
  const code: ErrorCode = body.error ?? 'parse_error';
  const message = body.message ?? `HTTP ${status}`;
  const opts: OutlayerErrorOptions = body.details !== undefined
    ? { code, message, status, details: body.details }
    : { code, message, status };
  const Ctor = codeToCtor[code] ?? OutlayerError;
  return new Ctor(opts);
}

export async function errorFromResponse(response: Response, parsed?: unknown): Promise<OutlayerError> {
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
