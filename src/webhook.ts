/**
 * Checking that a webhook is OutLayer's.
 *
 * Every webhook OutLayer sends — a wallet's events to the `webhook_url` of
 * its policy, an owner's task events — is signed with the network's Ed25519
 * key. The public keys are served at `GET /wallet/v1/webhook-keys`, so a
 * receiver holds no secret.
 *
 * - {@link createWebhookKeyCache} holds the keys of a network as a receiver
 *   should: read again every ten minutes, a key that left the list dropped,
 *   at most one read a minute however many requests name a key it lacks.
 * - {@link fetchWebhookKeys} reads the list once, for a receiver that keeps
 *   it by a rule of its own.
 * - {@link verifyWebhook} checks one request: the signature, the moment, and
 *   that the event is of a wallet the receiver expects.
 *
 * A signature says OutLayer sent the request. It does not say the event is
 * yours: anyone may name your URL as the webhook of a wallet of their own,
 * and that wallet's events arrive signed. `X-Wallet-Id` says whose event it
 * is, and {@link verifyWebhook} refuses one that is not in `walletIds`.
 *
 * What is signed is six parts joined by a newline, the last being the body
 * exactly as it was received:
 *
 * ```text
 * outlayer-webhook-v1
 * {X-Webhook-Id}
 * {X-Webhook-Timestamp}
 * {X-Wallet-Id}
 * {X-Event-Type}
 * {body}
 * ```
 *
 * WebCrypto only (Ed25519): Node 20+ and a current browser.
 */

import { hexBytes, utf8 } from './custody/bytes.js';
import { type UnauthenticatedOptions, makeUnauthenticatedClient } from './http.js';
import type { components } from './types.js';

/** One public key of `GET /wallet/v1/webhook-keys`. */
export type WebhookKey = components['schemas']['WebhookKey'];

/** The first line of the signed bytes. */
export const WEBHOOK_SIGNED_LABEL = 'outlayer-webhook-v1';

/** How far a request's timestamp may be from the receiver's clock, by default. */
export const WEBHOOK_TOLERANCE_SEC = 300;

/** The most `toleranceSec` may be: beyond an hour the timestamp bounds nothing. */
export const WEBHOOK_MAX_TOLERANCE_SEC = 3600;

/** Why a request was refused. */
export type WebhookRefusal =
  /** A header the signature needs is absent, or holds what it cannot hold. */
  | 'malformed'
  /** `X-Webhook-Key-Id` names no key of `keys`: read the keys again. */
  | 'unknown_key'
  /** The signature does not hold for these headers and this body. */
  | 'bad_signature'
  /** The signature holds, and the event is of a wallet that is not in `walletIds`. */
  | 'unexpected_wallet'
  /** The timestamp is further from now than the tolerance. */
  | 'stale_timestamp';

/** Thrown by {@link verifyWebhook} for a request that is not to be acted on. */
export class WebhookVerificationError extends Error {
  readonly reason: WebhookRefusal;
  constructor(reason: WebhookRefusal, message: string) {
    super(message);
    this.name = 'WebhookVerificationError';
    this.reason = reason;
  }
}

/** A request's headers: a `Headers`, or the object a Node server gives. */
export type WebhookHeaders = Headers | Record<string, string | string[] | undefined>;

export type VerifyWebhookInput = {
  headers: WebhookHeaders;
  /** The body as it was received — not parsed and written again. */
  rawBody: string | Uint8Array;
  /** A {@link createWebhookKeyCache}, or the list of {@link fetchWebhookKeys}. */
  keys: WebhookKeyCache | readonly WebhookKey[];
  /**
   * The `X-Wallet-Id` values this receiver takes events of; at least one.
   * What the header holds depends on the event:
   * - a wallet's events (`approval_needed`, `approval_received`,
   *   `request_completed`, `policy_update_signed`) and a vault's: the
   *   `wallet_id` registration answered;
   * - an owner's task events: `owner:` and the owner's account
   *   (`owner:alice.near`);
   * - `subscription_notification`: the payment key's owner account and its
   *   nonce, `alice.near:3`.
   */
  walletIds: readonly string[];
  /**
   * Seconds the timestamp may differ from now; {@link WEBHOOK_TOLERANCE_SEC}
   * when omitted. Finite, not negative and at most
   * {@link WEBHOOK_MAX_TOLERANCE_SEC} (an hour), or the call throws a
   * `RangeError`.
   */
  toleranceSec?: number;
  /**
   * The receiver's clock, Unix seconds; the system clock when omitted. Finite
   * and not negative, or the call throws a `RangeError`.
   */
  now?: number;
};

/** What a verified request says of itself. */
export type VerifiedWebhook = {
  /**
   * The delivery's id: a random UUID, the same on every attempt of one
   * delivery. Remember it to drop a repeat.
   */
  id: string;
  /** Unix seconds at the moment the attempt was signed. */
  timestamp: number;
  /** The wallet the event is of; `owner:{account}` on an owner's event. */
  walletId: string;
  eventType: string;
  /** The id of the key that signed. */
  keyId: string;
};

const subtle = () => globalThis.crypto.subtle;
function fromHex(hex: string, bytes: number): Uint8Array | null {
  const out = hexBytes(hex);
  return out !== null && out.length === bytes ? out : null;
}

/**
 * One header's value, whatever the case of its name; `null` when absent. A
 * header sent twice is `null` in the object form; a `Headers` joins the two
 * values into one, which then verifies as nothing.
 */
function header(headers: WebhookHeaders, name: string): string | null {
  if (typeof Headers !== 'undefined' && headers instanceof Headers) return headers.get(name);
  const wanted = name.toLowerCase();
  let found: string | null = null;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted || value === undefined) continue;
    if (found !== null || Array.isArray(value)) return null;
    found = value;
  }
  return found;
}

/**
 * The keys webhooks of a network are verified under, from
 * `GET /wallet/v1/webhook-keys`. No API key is needed. `network` is `mainnet`
 * when omitted: a testnet webhook is signed with the testnet key. Throws when
 * the answer is not a list of keys, each whole; `signal` ends the read early.
 */
export async function fetchWebhookKeys(
  opts: UnauthenticatedOptions = {},
  signal?: AbortSignal,
): Promise<WebhookKey[]> {
  const client = makeUnauthenticatedClient(opts);
  const { data, response } = await client.GET('/wallet/v1/webhook-keys', signal ? { signal } : {});
  if (!response.ok) throw new Error(`webhook-keys ${response.status}`);
  const keys: unknown = data?.keys;
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new Error('webhook-keys: the answer carries no key');
  }
  if (!keys.every(isWebhookKey)) {
    throw new Error('webhook-keys: the answer is not a list of keys');
  }
  return keys;
}

/** A key as the list holds one; an Ed25519 key's public half is 32 bytes of hex. */
function isWebhookKey(key: unknown): key is WebhookKey {
  if (typeof key !== 'object' || key === null) return false;
  const { id, algorithm, public_key } = key as Record<string, unknown>;
  if (typeof id !== 'string' || id === '' || typeof algorithm !== 'string') return false;
  if (typeof public_key !== 'string') return false;
  return algorithm !== 'ed25519' || fromHex(public_key, 32) !== null;
}

/** Seconds, as an argument may hold them: finite and not negative. */
function seconds(name: string, value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite number of seconds, not negative`);
  }
  return value;
}

/** The keys of a network, held as a receiver should hold them. */
export type WebhookKeyCache = {
  /**
   * The keys now. Reads the list when none is held or the one held is older
   * than the time to live, and — at most once in the floor — when `keyId` is
   * not among the keys held. What is read replaces what was held. Throws when
   * the list cannot be read and none younger than the time to live is held.
   */
  get(keyId?: string): Promise<readonly WebhookKey[]>;
};

export type WebhookKeyCacheOptions = UnauthenticatedOptions & {
  /** Seconds a list is used before it is read again; 600 when omitted. More than zero. */
  ttlSec?: number;
  /**
   * The fewest seconds between two reads of the list; 60 when omitted. Not
   * more than `ttlSec`: a floor longer than the list's life leaves a time
   * when the list is too old to use and may not be read.
   */
  minRefetchSec?: number;
  /**
   * The most seconds one read of the list may take; 5 when omitted. A read
   * that takes longer is a read that failed.
   */
  readTimeoutSec?: number;
  /** The clock, Unix milliseconds; `Date.now` when omitted. */
  now?: () => number;
};

/** How long a key list is used before it is read again, by default. */
export const WEBHOOK_KEYS_TTL_SEC = 600;
/** The fewest seconds between two reads of the key list, by default. */
export const WEBHOOK_KEYS_MIN_REFETCH_SEC = 60;
/** The most seconds one read of the key list may take, by default. */
export const WEBHOOK_KEYS_READ_TIMEOUT_SEC = 5;

/** Seconds of an option that must be more than none. */
function positiveSeconds(name: string, value: number): number {
  if (seconds(name, value) === 0) throw new RangeError(`${name} must be more than zero`);
  return value;
}

/** `promise`, or a rejection once `ms` have passed; `abort` is told of the latter. */
function within<T>(promise: Promise<T>, ms: number, abort: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      abort();
      reject(new Error(`webhook-keys did not answer in ${ms / 1000} s`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * The webhook keys of a network, kept current.
 *
 * - The list is read again once it is `ttlSec` old, and what is read REPLACES
 *   what was held: a key that left `webhook-keys` verifies nothing after the
 *   next read.
 * - A request that names a key not in the list causes a read — a new key may
 *   have been published — but no more often than every `minRefetchSec`,
 *   whoever sends such requests and however many. The same floor holds
 *   between any two reads.
 * - A read takes `readTimeoutSec` at most; one that takes longer has failed,
 *   and requests waiting on it wait no longer.
 * - When the list cannot be read and none younger than `ttlSec` is held,
 *   `get` throws: the receiver answers an error, and the delivery is tried
 *   again.
 * - A clock that went back since the list was read makes the list too old to
 *   use, and a read due: time that cannot be measured is not time that has
 *   not passed.
 *
 * One cache per network, made once and shared by every request. Throws a
 * `RangeError` for options that are not such times.
 */
export function createWebhookKeyCache(opts: WebhookKeyCacheOptions = {}): WebhookKeyCache {
  const ttlMs = positiveSeconds('ttlSec', opts.ttlSec ?? WEBHOOK_KEYS_TTL_SEC) * 1000;
  const floorMs =
    seconds('minRefetchSec', opts.minRefetchSec ?? WEBHOOK_KEYS_MIN_REFETCH_SEC) * 1000;
  if (floorMs > ttlMs) throw new RangeError('minRefetchSec must not be more than ttlSec');
  const timeoutMs =
    positiveSeconds('readTimeoutSec', opts.readTimeoutSec ?? WEBHOOK_KEYS_READ_TIMEOUT_SEC) * 1000;
  const clock = opts.now ?? Date.now;
  let held: readonly WebhookKey[] | null = null;
  let heldAt = 0;
  let triedAt: number | null = null;
  let reading: Promise<void> | null = null;

  /** Whether `ms` have passed since `at`; a clock that went back has passed them. */
  const passed = (at: number, ms: number) => {
    const elapsed = clock() - at;
    return elapsed < 0 || elapsed >= ms;
  };

  const read = (): Promise<void> => {
    if (reading === null) {
      triedAt = clock();
      const stop = new AbortController();
      reading = within(fetchWebhookKeys(opts, stop.signal), timeoutMs, () => stop.abort())
        .then((keys) => {
          held = keys;
          heldAt = clock();
        })
        .finally(() => {
          reading = null;
        });
    }
    return reading;
  };

  return {
    async get(keyId?: string): Promise<readonly WebhookKey[]> {
      const fresh = () => held !== null && !passed(heldAt, ttlMs);
      const lacks = keyId !== undefined && !(held ?? []).some((k) => k.id === keyId);
      const mayRead = reading !== null || triedAt === null || passed(triedAt, floorMs);
      if ((!fresh() || lacks) && mayRead) {
        // A failed read leaves a list that is still fresh in use.
        await read().catch(() => undefined);
      }
      if (held === null || !fresh()) {
        throw new Error('webhook-keys could not be read, and no list read recently is held');
      }
      return held;
    },
  };
}

/**
 * Is this request a webhook OutLayer signed, of a wallet this receiver
 * expects, and of this moment?
 *
 * Answers what the request says of itself; throws a
 * {@link WebhookVerificationError} otherwise, and a request that throws is not
 * to be acted on. The wallet id and the event type in the answer are the
 * signed ones, and the wallet id is one of `walletIds`.
 *
 * The timestamp bounds how long a captured request can be sent again: the
 * tolerance, five minutes by default. Inside that time the same request
 * verifies again, and this function keeps no state: remember the `id` of what
 * you accepted for as long as the tolerance, and drop a second request with
 * the same id.
 *
 * Throws a `RangeError` — not a refusal of the request — when `walletIds` is
 * empty, `toleranceSec` or `now` is not a finite, non-negative number, or
 * `toleranceSec` is more than {@link WEBHOOK_MAX_TOLERANCE_SEC}, and
 * the error of the key cache when the keys cannot be read.
 */
export async function verifyWebhook(input: VerifyWebhookInput): Promise<VerifiedWebhook> {
  const refuse = (reason: WebhookRefusal, message: string) =>
    new WebhookVerificationError(reason, message);
  const { headers, rawBody } = input;
  const tolerance = seconds('toleranceSec', input.toleranceSec ?? WEBHOOK_TOLERANCE_SEC);
  if (tolerance > WEBHOOK_MAX_TOLERANCE_SEC) {
    throw new RangeError(`toleranceSec must be at most ${WEBHOOK_MAX_TOLERANCE_SEC} seconds`);
  }
  const now = seconds('now', input.now ?? Math.floor(Date.now() / 1000));
  const walletIds = input.walletIds;
  if (
    !Array.isArray(walletIds) ||
    walletIds.length === 0 ||
    walletIds.some((id) => typeof id !== 'string' || id === '')
  ) {
    throw new RangeError('walletIds must name at least one X-Wallet-Id this receiver expects');
  }

  const id = header(headers, 'x-webhook-id');
  const timestampText = header(headers, 'x-webhook-timestamp');
  const keyId = header(headers, 'x-webhook-key-id');
  const signatureHex = header(headers, 'x-webhook-signature-ed25519');
  const walletId = header(headers, 'x-wallet-id');
  const eventType = header(headers, 'x-event-type');
  if (
    id === null ||
    timestampText === null ||
    keyId === null ||
    signatureHex === null ||
    walletId === null ||
    eventType === null
  ) {
    throw refuse('malformed', 'a header the signature needs is absent');
  }
  if (!/^[0-9]{1,15}$/.test(timestampText)) {
    throw refuse('malformed', 'X-Webhook-Timestamp is not Unix seconds');
  }
  const signature = fromHex(signatureHex, 64);
  if (signature === null) {
    throw refuse('malformed', 'X-Webhook-Signature-Ed25519 is not 64 bytes of hex');
  }

  const keys = Array.isArray(input.keys)
    ? (input.keys as readonly WebhookKey[])
    : await (input.keys as WebhookKeyCache).get(keyId);
  const key = keys.find((k) => k?.id === keyId && k.algorithm === 'ed25519');
  if (!key) throw refuse('unknown_key', `no ed25519 key with the id ${keyId} among the keys given`);
  const publicBytes = fromHex(key.public_key, 32);
  if (publicBytes === null) throw refuse('unknown_key', `the key ${keyId} is not 32 bytes of hex`);

  const body = typeof rawBody === 'string' ? utf8(rawBody) : rawBody;
  const head = utf8(
    `${WEBHOOK_SIGNED_LABEL}\n${id}\n${timestampText}\n${walletId}\n${eventType}\n`,
  );
  const signed = new Uint8Array(head.length + body.length);
  signed.set(head, 0);
  signed.set(body, head.length);

  const publicKey = await subtle().importKey(
    'raw',
    publicBytes as BufferSource,
    { name: 'Ed25519' },
    false,
    ['verify'],
  );
  const holds = await subtle().verify(
    { name: 'Ed25519' },
    publicKey,
    signature as BufferSource,
    signed as BufferSource,
  );
  if (!holds) throw refuse('bad_signature', 'the signature does not hold');

  // The wallet id and the timestamp are judged after the signature: only
  // signed ones mean anything.
  if (!walletIds.includes(walletId)) {
    throw refuse(
      'unexpected_wallet',
      'OutLayer signed this event, and it is of a wallet this receiver does not expect',
    );
  }
  const timestamp = Number(timestampText);
  if (Math.abs(now - timestamp) > tolerance) {
    throw refuse(
      'stale_timestamp',
      `the timestamp is ${Math.abs(now - timestamp)} s from now; ${tolerance} s is the most`,
    );
  }
  return { id, timestamp, walletId, eventType, keyId };
}
