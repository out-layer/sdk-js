import createClient, { type Client } from 'openapi-fetch';
import { OutlayerError, errorFromResponse } from './errors.js';
import type { paths } from './types.js';

export type Network = 'mainnet' | 'testnet';

export const NETWORK_BASE_URLS: Record<Network, string> = {
  mainnet: 'https://api.outlayer.ai',
  testnet: 'https://testnet-api.outlayer.ai',
};

export const DEFAULT_BASE_URL = NETWORK_BASE_URLS.mainnet;

export type RetryConfig = {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
};

export type ClientOptions = {
  apiKey: string;
  /**
   * NEAR network to target. Defaults to `mainnet`. NEAR Intents (cross-chain
   * swaps + gasless withdrawals) only work on mainnet — use testnet for the
   * register / policy / sign-message flow while developing.
   */
  network?: Network;
  /** Overrides `network` for self-hosted or staging deployments. */
  baseUrl?: string;
  fetch?: typeof fetch;
  retry?: RetryConfig;
};

export type UnauthenticatedOptions = {
  network?: Network;
  baseUrl?: string;
  fetch?: typeof fetch;
};

function resolveBaseUrl(opts: { network?: Network; baseUrl?: string }): string {
  if (opts.baseUrl) return opts.baseUrl;
  if (opts.network) return NETWORK_BASE_URLS[opts.network];
  return DEFAULT_BASE_URL;
}

export const DEFAULT_RETRY: Required<RetryConfig> = {
  maxAttempts: 3,
  initialDelayMs: 100,
  maxDelayMs: 1600,
};

export type FetchClient = Client<paths, `${string}/${string}`>;

export function makeClient(opts: ClientOptions): {
  client: FetchClient;
  retry: Required<RetryConfig>;
} {
  const init: Parameters<typeof createClient<paths>>[0] = {
    baseUrl: resolveBaseUrl(opts),
    headers: { Authorization: `Bearer ${opts.apiKey}` },
  };
  if (opts.fetch) init.fetch = opts.fetch;
  const client = createClient<paths>(init);
  const retry: Required<RetryConfig> = { ...DEFAULT_RETRY, ...opts.retry };
  return { client, retry };
}

export function makeUnauthenticatedClient(opts: UnauthenticatedOptions = {}): FetchClient {
  const init: Parameters<typeof createClient<paths>>[0] = {
    baseUrl: resolveBaseUrl(opts),
  };
  if (opts.fetch) init.fetch = opts.fetch;
  return createClient<paths>(init);
}

export type FetchCall<T> = () => Promise<{
  data?: T;
  error?: unknown;
  response: Response;
}>;

/**
 * Is this worth asking again?
 *
 * Server faults are, by status. The carve-out is `wallet_busy`: a wallet runs
 * one money-moving operation at a time so its spending limits are counted
 * correctly, and a 409 saying so is the most retryable answer the API gives —
 * it clears the moment the operation in flight finishes. Judged by CODE and not
 * by status, because 409 in general is a conflict you must resolve, not one
 * that resolves itself: `already_approved` and a duplicate idempotency key are
 * the same status and must never be repeated.
 *
 * Retrying is not the only option a caller has here. `WalletBusyError` carries
 * `inFlightRequestId`, which can be polled instead of guessed at — but a client
 * that does nothing special should still not be handed a failure for a
 * condition that ends on its own.
 */
function isRetryable(err: OutlayerError): boolean {
  if (err.status >= 500) return true;
  return err.code === 'wallet_busy';
}

export async function runWithRetry<T>(
  call: FetchCall<T>,
  retry: Required<RetryConfig>,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= retry.maxAttempts; attempt++) {
    try {
      const { data, error, response } = await call();
      if (response.ok) {
        return data as T;
      }
      const err = await errorFromResponse(response, error);
      if (isRetryable(err) && attempt < retry.maxAttempts) {
        lastError = err;
        await sleep(backoff(attempt, retry));
        continue;
      }
      throw err;
    } catch (e) {
      if (e instanceof OutlayerError) throw e;
      lastError = e;
      if (attempt < retry.maxAttempts && isNetworkError(e)) {
        await sleep(backoff(attempt, retry));
        continue;
      }
      throw new OutlayerError({
        code: 'network_error',
        message: e instanceof Error ? e.message : String(e),
        status: 0,
      });
    }
  }
  throw lastError;
}

function backoff(attempt: number, cfg: Required<RetryConfig>): number {
  return Math.min(cfg.maxDelayMs, cfg.initialDelayMs * 2 ** (attempt - 1));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isNetworkError(e: unknown): boolean {
  return e instanceof TypeError;
}

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}
