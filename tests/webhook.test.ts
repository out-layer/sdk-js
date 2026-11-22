// `verifyWebhook` accepts what the coordinator signs and nothing else.
//
// The vector is the coordinator's (`src/wallet/webhook_signing.rs`,
// `the_shared_vector_holds`): the same throwaway key, delivery and body must
// give the same signature there and verify here. If either side changes the
// signed bytes, one of the two goes red. The key signs nothing anywhere else.

import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import {
  WEBHOOK_KEYS_MIN_REFETCH_SEC,
  WEBHOOK_KEYS_READ_TIMEOUT_SEC,
  WEBHOOK_KEYS_TTL_SEC,
  WEBHOOK_MAX_TOLERANCE_SEC,
  WEBHOOK_SIGNED_LABEL,
  WEBHOOK_TOLERANCE_SEC,
  type WebhookKey,
  WebhookVerificationError,
  createWebhookKeyCache,
  fetchWebhookKeys,
  verifyWebhook,
} from '../src/webhook.js';
import { server } from './setup.js';

const VECTOR = {
  secretKey: '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
  publicKey: '03a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b8',
  keyId: '56475aa75463474c',
  id: '7f3c2b1a-9d4e-4f60-8a1b-2c3d4e5f6071',
  timestamp: 1_800_000_000,
  walletId: 'owner:alice.near',
  eventType: 'task_created',
  body: '{"note":"line one\\nline two","request_id":"7f3c","status":"success"}',
  signature:
    'e0eaeeaf83de2fa2d05e5247beccb208d6068cb82dcb5f4e436a2e3cad5fb3b561c6bf115d0a3c8b3af2d354923a2cfa58f52a76f92bbdf26afcdaf6469b680f',
};

const KEYS: WebhookKey[] = [
  {
    id: VECTOR.keyId,
    algorithm: 'ed25519',
    public_key: VECTOR.publicKey,
    public_key_near: 'ed25519:FAe4sisG95oZ42w7buUn5qEE4TAnfTTFPiguZUHmhiF',
  },
];

/** The wallets this receiver takes events of. */
const WALLETS = ['owner:alice.near'];

const utf8 = (text: string) => new TextEncoder().encode(text);
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (text: string) =>
  Uint8Array.from(text.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));

function headersOf(over: Record<string, string | undefined> = {}): Record<string, string> {
  const headers: Record<string, string | undefined> = {
    'content-type': 'application/json',
    'x-webhook-id': VECTOR.id,
    'x-webhook-timestamp': String(VECTOR.timestamp),
    'x-webhook-key-id': VECTOR.keyId,
    'x-webhook-signature-ed25519': VECTOR.signature,
    'x-wallet-id': VECTOR.walletId,
    'x-event-type': VECTOR.eventType,
    ...over,
  };
  return Object.fromEntries(
    Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

async function refusal(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (e) {
    expect(e).toBeInstanceOf(WebhookVerificationError);
    return (e as WebhookVerificationError).reason;
  }
  throw new Error('a request that must be refused was accepted');
}

/** An Ed25519 private key from 32 secret bytes (PKCS#8, RFC 8410). */
async function signingKey(secret: Uint8Array): Promise<CryptoKey> {
  const pkcs8 = Uint8Array.from([...unhex('302e020100300506032b657004220420'), ...secret]);
  return crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']);
}

describe('verifyWebhook', () => {
  it('accepts the delivery the coordinator signed', async () => {
    const verified = await verifyWebhook({
      headers: headersOf(),
      rawBody: VECTOR.body,
      keys: KEYS,
      walletIds: WALLETS,
      now: VECTOR.timestamp + 5,
    });
    expect(verified).toEqual({
      id: VECTOR.id,
      timestamp: 1_800_000_000,
      walletId: 'owner:alice.near',
      eventType: 'task_created',
      keyId: VECTOR.keyId,
    });
  });

  it('signs the same bytes the coordinator signs', async () => {
    // The vector's signature, made again here from the secret half: Ed25519 is
    // deterministic, so the same bytes under the same key are the same signature.
    const signed = utf8(
      `${WEBHOOK_SIGNED_LABEL}\n${VECTOR.id}\n${VECTOR.timestamp}\n${VECTOR.walletId}\n${VECTOR.eventType}\n${VECTOR.body}`,
    );
    const key = await signingKey(unhex(VECTOR.secretKey));
    const signature = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key, signed));
    expect(hex(signature)).toBe(VECTOR.signature);
    expect(WEBHOOK_SIGNED_LABEL).toBe('outlayer-webhook-v1');
  });

  it('reads the headers a server gives, in any case, and the body as bytes', async () => {
    const asSent = new Headers({
      'X-Webhook-Id': VECTOR.id,
      'X-Webhook-Timestamp': String(VECTOR.timestamp),
      'X-Webhook-Key-Id': VECTOR.keyId,
      'X-Webhook-Signature-Ed25519': VECTOR.signature.toUpperCase(),
      'X-Wallet-Id': VECTOR.walletId,
      'X-Event-Type': VECTOR.eventType,
    });
    const input = {
      rawBody: utf8(VECTOR.body),
      keys: KEYS,
      walletIds: WALLETS,
      now: VECTOR.timestamp,
    };
    expect((await verifyWebhook({ headers: asSent, ...input })).id).toBe(VECTOR.id);
    const mixedCase = {
      ...headersOf({ 'x-wallet-id': undefined }),
      'X-Wallet-ID': VECTOR.walletId,
    };
    expect((await verifyWebhook({ headers: mixedCase, ...input })).walletId).toBe(VECTOR.walletId);
  });

  it('refuses a stale timestamp, either side of now', async () => {
    const at = (now: number, toleranceSec?: number) =>
      verifyWebhook({
        headers: headersOf(),
        rawBody: VECTOR.body,
        keys: KEYS,
        walletIds: WALLETS,
        now,
        toleranceSec,
      });
    expect(WEBHOOK_TOLERANCE_SEC).toBe(300);
    await expect(at(VECTOR.timestamp + 300)).resolves.toBeTruthy();
    await expect(at(VECTOR.timestamp - 300)).resolves.toBeTruthy();
    expect(await refusal(at(VECTOR.timestamp + 301))).toBe('stale_timestamp');
    expect(await refusal(at(VECTOR.timestamp - 301))).toBe('stale_timestamp');
    // A capture sent again ten minutes later.
    expect(await refusal(at(VECTOR.timestamp + 600))).toBe('stale_timestamp');
    // The tolerance is the receiver's to set.
    await expect(at(VECTOR.timestamp + 600, 900)).resolves.toBeTruthy();
    expect(await refusal(at(VECTOR.timestamp + 30, 10))).toBe('stale_timestamp');
    // Without `now`, the clock is the system's: the vector's moment is not now.
    expect(
      await refusal(
        verifyWebhook({
          headers: headersOf(),
          rawBody: VECTOR.body,
          keys: KEYS,
          walletIds: WALLETS,
        }),
      ),
    ).toBe('stale_timestamp');
  });

  it('refuses a request whose signed part was changed', async () => {
    const withHeaders = (over: Record<string, string>) =>
      verifyWebhook({
        headers: headersOf(over),
        rawBody: VECTOR.body,
        keys: KEYS,
        walletIds: WALLETS,
        now: VECTOR.timestamp,
      });
    // A swapped wallet id: another owner's, and a wallet's.
    expect(await refusal(withHeaders({ 'x-wallet-id': 'owner:bob.near' }))).toBe('bad_signature');
    expect(await refusal(withHeaders({ 'x-wallet-id': 'w_abc123' }))).toBe('bad_signature');
    expect(await refusal(withHeaders({ 'x-event-type': 'task_approved' }))).toBe('bad_signature');
    expect(
      await refusal(withHeaders({ 'x-webhook-id': '7f3c2b1a-9d4e-4f60-8a1b-2c3d4e5f6072' })),
    ).toBe('bad_signature');
    // A timestamp moved to pass the clock no longer carries the signature.
    expect(
      await refusal(
        verifyWebhook({
          headers: headersOf({ 'x-webhook-timestamp': String(VECTOR.timestamp + 600) }),
          rawBody: VECTOR.body,
          keys: KEYS,
          walletIds: WALLETS,
          now: VECTOR.timestamp + 600,
        }),
      ),
    ).toBe('bad_signature');
  });

  it('refuses a tampered body', async () => {
    const withBody = (rawBody: string) =>
      verifyWebhook({
        headers: headersOf(),
        rawBody,
        keys: KEYS,
        walletIds: WALLETS,
        now: VECTOR.timestamp,
      });
    expect(await refusal(withBody(VECTOR.body.replace('success', 'failed!')))).toBe(
      'bad_signature',
    );
    // The same JSON, parsed and written again in another shape, is another body.
    expect(await refusal(withBody(JSON.stringify(JSON.parse(VECTOR.body), null, 1)))).toBe(
      'bad_signature',
    );
    expect(await refusal(withBody(`${VECTOR.body}\n`))).toBe('bad_signature');
    expect(await refusal(withBody(''))).toBe('bad_signature');
  });

  it('refuses a key id that is not among the keys, and a key that is not the signer', async () => {
    const verify = (headers: Record<string, string>, keys: WebhookKey[]) =>
      verifyWebhook({
        headers,
        rawBody: VECTOR.body,
        keys,
        walletIds: WALLETS,
        now: VECTOR.timestamp,
      });
    expect(await refusal(verify(headersOf({ 'x-webhook-key-id': '0000000000000000' }), KEYS))).toBe(
      'unknown_key',
    );
    expect(await refusal(verify(headersOf(), []))).toBe('unknown_key');
    // Another key pair published under the signer's id does not verify.
    const other = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    const otherPublic = hex(new Uint8Array(await crypto.subtle.exportKey('raw', other.publicKey)));
    const renamed: WebhookKey[] = [{ ...KEYS[0], public_key: otherPublic }];
    expect(await refusal(verify(headersOf(), renamed))).toBe('bad_signature');
    // A key of an algorithm this does not know is not a key to verify under.
    expect(await refusal(verify(headersOf(), [{ ...KEYS[0], algorithm: 'ml-dsa-65' }]))).toBe(
      'unknown_key',
    );
    // The signer is found wherever it stands in the list.
    const listed: WebhookKey[] = [
      { ...KEYS[0], id: 'ffffffffffffffff', public_key: otherPublic },
      KEYS[0],
    ];
    await expect(verify(headersOf(), listed)).resolves.toBeTruthy();
  });

  it('refuses a request without its headers, or with a signature that is not one', async () => {
    const verify = (headers: Record<string, string | string[]>) =>
      verifyWebhook({
        headers,
        rawBody: VECTOR.body,
        keys: KEYS,
        walletIds: WALLETS,
        now: VECTOR.timestamp,
      });
    for (const absent of [
      'x-webhook-id',
      'x-webhook-timestamp',
      'x-webhook-key-id',
      'x-webhook-signature-ed25519',
      'x-wallet-id',
      'x-event-type',
    ]) {
      expect(await refusal(verify(headersOf({ [absent]: undefined })))).toBe('malformed');
    }
    expect(await refusal(verify(headersOf({ 'x-webhook-signature-ed25519': 'abcd' })))).toBe(
      'malformed',
    );
    expect(
      await refusal(verify(headersOf({ 'x-webhook-signature-ed25519': 'z'.repeat(128) }))),
    ).toBe('malformed');
    expect(await refusal(verify(headersOf({ 'x-webhook-timestamp': '1800000000.5' })))).toBe(
      'malformed',
    );
    expect(await refusal(verify(headersOf({ 'x-webhook-timestamp': '-1' })))).toBe('malformed');
    // A header sent twice is not one value.
    expect(
      await refusal(verify({ ...headersOf(), 'x-wallet-id': [VECTOR.walletId, 'w_abc123'] })),
    ).toBe('malformed');
    // The owner's HMAC header alone proves nothing here.
    expect(
      await refusal(
        verify({
          'x-webhook-signature': 'ab'.repeat(32),
          'x-wallet-id': VECTOR.walletId,
          'x-event-type': VECTOR.eventType,
        }),
      ),
    ).toBe('malformed');
  });
});

/** The headers of a delivery signed here with the vector's key: what OutLayer would send. */
async function signedHeaders(walletId: string, id: string, timestamp: number, body: string) {
  const key = await signingKey(unhex(VECTOR.secretKey));
  const signed = utf8(
    `${WEBHOOK_SIGNED_LABEL}\n${id}\n${timestamp}\n${walletId}\n${VECTOR.eventType}\n${body}`,
  );
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key, signed));
  return headersOf({
    'x-webhook-id': id,
    'x-webhook-timestamp': String(timestamp),
    'x-wallet-id': walletId,
    'x-webhook-signature-ed25519': hex(signature),
  });
}

describe('verifyWebhook: whose event it is', () => {
  const base = { rawBody: VECTOR.body, keys: KEYS, now: VECTOR.timestamp };

  it('refuses an event OutLayer signed for a wallet the receiver does not expect', async () => {
    // Somebody named this receiver's URL as the webhook of an account of their
    // own: the event is genuine, signed, fresh, never seen — and not ours.
    const theirs = await signedHeaders(
      'owner:mallory.near',
      '0b9f7c1e-52d4-4a3b-9c68-1f0e2d3c4b5a',
      VECTOR.timestamp,
      VECTOR.body,
    );
    expect(await refusal(verifyWebhook({ ...base, headers: theirs, walletIds: WALLETS }))).toBe(
      'unexpected_wallet',
    );
    // The same request is accepted by the receiver it is for.
    const verified = await verifyWebhook({
      ...base,
      headers: theirs,
      walletIds: ['owner:mallory.near'],
    });
    expect(verified.walletId).toBe('owner:mallory.near');
    // The vector, at a receiver that expects other wallets.
    expect(
      await refusal(
        verifyWebhook({ ...base, headers: headersOf(), walletIds: ['owner:bob.near', 'w_abc123'] }),
      ),
    ).toBe('unexpected_wallet');
    // A wallet id is matched whole: no prefix, no other case.
    for (const near of ['owner:alice.nea', 'owner:alice.near.', 'OWNER:ALICE.NEAR', 'alice.near']) {
      expect(
        await refusal(verifyWebhook({ ...base, headers: headersOf(), walletIds: [near] })),
      ).toBe('unexpected_wallet');
    }
  });

  it('takes a list of wallets, and the signature is judged before the wallet', async () => {
    const several = ['w_abc123', 'owner:alice.near', 'alice.near:3'];
    expect(
      (await verifyWebhook({ ...base, headers: headersOf(), walletIds: several })).walletId,
    ).toBe('owner:alice.near');
    // A wallet id written into the header to pass the list no longer carries the signature.
    expect(
      await refusal(
        verifyWebhook({
          ...base,
          headers: headersOf({ 'x-wallet-id': 'w_abc123' }),
          walletIds: several,
        }),
      ),
    ).toBe('bad_signature');
  });

  it('throws, and accepts nothing, without a wallet to expect', async () => {
    const without = (walletIds: unknown) =>
      verifyWebhook({ ...base, headers: headersOf(), walletIds: walletIds as string[] });
    for (const bad of [undefined, [], [''], 'owner:alice.near', [42]]) {
      await expect(without(bad)).rejects.toBeInstanceOf(RangeError);
    }
  });
});

describe('verifyWebhook: its own arguments', () => {
  const good = { headers: headersOf(), rawBody: VECTOR.body, keys: KEYS, walletIds: WALLETS };

  it('throws on a tolerance or a clock that is not a finite, non-negative number', async () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1]) {
      await expect(
        verifyWebhook({ ...good, now: VECTOR.timestamp, toleranceSec: bad }),
      ).rejects.toBeInstanceOf(RangeError);
      await expect(verifyWebhook({ ...good, now: bad })).rejects.toBeInstanceOf(RangeError);
    }
    // An unset variable read as a number, and a number given as text.
    await expect(
      verifyWebhook({ ...good, now: VECTOR.timestamp, toleranceSec: Number(undefined) }),
    ).rejects.toThrow('toleranceSec');
    await expect(
      verifyWebhook({ ...good, now: VECTOR.timestamp, toleranceSec: '300' as unknown as number }),
    ).rejects.toThrow('toleranceSec');
    await expect(verifyWebhook({ ...good, now: Number.NaN })).rejects.toThrow('now');
    // None of them is a refusal of the request: the caller's code is wrong.
    await expect(verifyWebhook({ ...good, now: Number.NaN })).rejects.not.toBeInstanceOf(
      WebhookVerificationError,
    );
    // A tolerance past an hour bounds nothing: milliseconds given for seconds, or a typo.
    expect(WEBHOOK_MAX_TOLERANCE_SEC).toBe(3600);
    await expect(
      verifyWebhook({ ...good, now: VECTOR.timestamp + 3600, toleranceSec: 3600 }),
    ).resolves.toBeTruthy();
    for (const tooLong of [3600.001, 3601, 300_000, 1e15]) {
      const refused = verifyWebhook({ ...good, now: VECTOR.timestamp, toleranceSec: tooLong });
      await expect(refused).rejects.toBeInstanceOf(RangeError);
      await expect(verifyWebhook({ ...good, now: 5e9, toleranceSec: tooLong })).rejects.toThrow(
        'toleranceSec must be at most 3600 seconds',
      );
    }
    // Zero is a tolerance: the timestamp must be this very second.
    await expect(
      verifyWebhook({ ...good, now: VECTOR.timestamp, toleranceSec: 0 }),
    ).resolves.toBeTruthy();
    expect(
      await refusal(verifyWebhook({ ...good, now: VECTOR.timestamp + 1, toleranceSec: 0 })),
    ).toBe('stale_timestamp');
  });

  it('refuses a header sent twice in a Headers object', async () => {
    const twice = new Headers(headersOf());
    twice.append('x-wallet-id', 'owner:alice.near');
    expect(await refusal(verifyWebhook({ ...good, headers: twice, now: VECTOR.timestamp }))).toBe(
      'bad_signature',
    );
  });
});

describe('createWebhookKeyCache', () => {
  const OTHER: WebhookKey = {
    id: 'ffffffffffffffff',
    algorithm: 'ed25519',
    public_key: 'ab'.repeat(32),
    public_key_near: 'ed25519:other',
  };

  /** A key list server and a clock, both this test's. */
  function world(listed: WebhookKey[]) {
    const state = { listed, reads: 0, down: false, nowMs: 1_800_000_000_000 };
    const fetchKeys = (async () => {
      state.reads += 1;
      if (state.down) return new Response('{"error":"unavailable"}', { status: 503 });
      return new Response(JSON.stringify({ keys: state.listed }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const cache = createWebhookKeyCache({ fetch: fetchKeys, now: () => state.nowMs });
    const pass = (seconds: number) => {
      state.nowMs += seconds * 1000;
    };
    return { state, cache, pass };
  }
  const verifyWith = (cache: ReturnType<typeof createWebhookKeyCache>, keyId?: string) =>
    verifyWebhook({
      headers: headersOf(keyId ? { 'x-webhook-key-id': keyId } : {}),
      rawBody: VECTOR.body,
      keys: cache,
      walletIds: WALLETS,
      now: VECTOR.timestamp,
    });

  it('reads the list once, and again when it is ten minutes old', async () => {
    const { state, cache, pass } = world(KEYS);
    expect(WEBHOOK_KEYS_TTL_SEC).toBe(600);
    expect(WEBHOOK_KEYS_MIN_REFETCH_SEC).toBe(60);
    expect(await cache.get()).toEqual(KEYS);
    for (let i = 0; i < 50; i++) await cache.get(VECTOR.keyId);
    expect(state.reads).toBe(1);
    pass(599);
    await cache.get(VECTOR.keyId);
    expect(state.reads).toBe(1);
    pass(1);
    await cache.get(VECTOR.keyId);
    expect(state.reads).toBe(2);
    pass(600);
    await verifyWith(cache);
    expect(state.reads).toBe(3);
  });

  it('drops a key that left the list at the next read', async () => {
    const { state, cache, pass } = world(KEYS);
    await expect(verifyWith(cache)).resolves.toBeTruthy();
    // The key is taken out of webhook-keys; another is listed.
    state.listed = [OTHER];
    pass(599);
    await expect(verifyWith(cache)).resolves.toBeTruthy();
    pass(1);
    expect(await refusal(verifyWith(cache))).toBe('unknown_key');
    expect(await cache.get()).toEqual([OTHER]);
    // And stays dropped, with no read per request.
    const reads = state.reads;
    for (let i = 0; i < 20; i++) expect(await refusal(verifyWith(cache))).toBe('unknown_key');
    expect(state.reads).toBe(reads);
  });

  it('reads at most once a minute for key ids it does not hold', async () => {
    const { state, cache, pass } = world(KEYS);
    await cache.get();
    expect(state.reads).toBe(1);
    // A flood of requests naming keys nobody published, inside the first minute.
    for (let i = 0; i < 200; i++) {
      expect(await refusal(verifyWith(cache, i.toString(16).padStart(16, '0')))).toBe(
        'unknown_key',
      );
    }
    expect(state.reads).toBe(1);
    // Past the minute, one read; then the floor again.
    pass(60);
    for (let i = 0; i < 200; i++) await cache.get(`unknown-${i}`);
    expect(state.reads).toBe(2);
    // Ten minutes of the flood: one read a minute, never more.
    for (let minute = 0; minute < 10; minute++) {
      pass(60);
      for (let i = 0; i < 50; i++) await cache.get(`unknown-${minute}-${i}`);
    }
    expect(state.reads).toBe(12);
    // Genuine webhooks verified throughout.
    await expect(verifyWith(cache)).resolves.toBeTruthy();
  });

  it('learns a newly published key from the request that names it', async () => {
    const { state, cache, pass } = world([OTHER]);
    await cache.get();
    pass(60);
    state.listed = [OTHER, ...KEYS];
    await expect(verifyWith(cache)).resolves.toBeTruthy();
    expect(state.reads).toBe(2);
  });

  it('fails closed when the list cannot be read and none read recently is held', async () => {
    const { state, cache, pass } = world(KEYS);
    state.down = true;
    // Nothing held at all.
    await expect(cache.get()).rejects.toThrow('could not be read');
    await expect(verifyWith(cache)).rejects.toThrow('could not be read');
    await expect(verifyWith(cache)).rejects.not.toBeInstanceOf(WebhookVerificationError);
    // No read per failed request either.
    expect(state.reads).toBe(1);
    pass(60);
    state.down = false;
    await expect(verifyWith(cache)).resolves.toBeTruthy();
    expect(state.reads).toBe(2);
    // The API goes away: the list held serves until it is ten minutes old…
    state.down = true;
    pass(599);
    await expect(verifyWith(cache)).resolves.toBeTruthy();
    expect(state.reads).toBe(2);
    // …and then nothing verifies, with one attempt a minute.
    pass(1);
    await expect(verifyWith(cache)).rejects.toThrow('could not be read');
    await expect(verifyWith(cache)).rejects.toThrow('could not be read');
    expect(state.reads).toBe(3);
    pass(60);
    state.down = false;
    await expect(verifyWith(cache)).resolves.toBeTruthy();
    expect(state.reads).toBe(4);
  });

  it('makes one read for requests that arrive together', async () => {
    const { state, cache } = world(KEYS);
    const all = await Promise.all(Array.from({ length: 25 }, () => verifyWith(cache)));
    expect(all).toHaveLength(25);
    expect(state.reads).toBe(1);
  });

  it('treats a clock that went back as a list too old to use', async () => {
    const { state, cache, pass } = world(KEYS);
    await expect(verifyWith(cache)).resolves.toBeTruthy();
    expect(state.reads).toBe(1);
    // The clock is set back an hour, and the key leaves the list.
    pass(-3600);
    state.listed = [OTHER];
    expect(await refusal(verifyWith(cache))).toBe('unknown_key');
    expect(state.reads).toBe(2);
    expect(await cache.get()).toEqual([OTHER]);
    // From the new moment the cache keeps time as before.
    pass(599);
    await cache.get();
    expect(state.reads).toBe(2);
    pass(1);
    await cache.get();
    expect(state.reads).toBe(3);
    // Back again with the API away: the list held is not used, and the floor
    // counted from a later moment does not hold the read off.
    state.down = true;
    pass(-7200);
    await expect(cache.get()).rejects.toThrow('could not be read');
    expect(state.reads).toBe(4);
    await expect(cache.get()).rejects.toThrow('could not be read');
    expect(state.reads).toBe(4);
  });

  it('gives a read that hangs a bounded time, and fails closed after it', async () => {
    let reads = 0;
    let aborted = 0;
    let nowMs = 1_800_000_000_000;
    let hang = true;
    const fetchKeys = ((input: Request) => {
      reads += 1;
      if (!hang) return Promise.resolve(new Response(JSON.stringify({ keys: KEYS })));
      // Never answers; says so when it is told to stop.
      input.signal?.addEventListener('abort', () => {
        aborted += 1;
      });
      return new Promise<Response>(() => undefined);
    }) as unknown as typeof fetch;
    const cache = createWebhookKeyCache({
      fetch: fetchKeys,
      now: () => nowMs,
      readTimeoutSec: 0.05,
    });
    const started = Date.now();
    // Five requests wait on the one read, and all are let go together.
    const waiting = await Promise.allSettled(Array.from({ length: 5 }, () => verifyWith(cache)));
    expect(Date.now() - started).toBeLessThan(2000);
    expect(waiting.every((w) => w.status === 'rejected')).toBe(true);
    expect(reads).toBe(1);
    expect(aborted).toBe(1);
    // A timed-out read is a failed read: the floor holds the next one off.
    await expect(verifyWith(cache)).rejects.toThrow('could not be read');
    expect(reads).toBe(1);
    nowMs += 60_000;
    hang = false;
    await expect(verifyWith(cache)).resolves.toBeTruthy();
    expect(reads).toBe(2);
    // With a list held, a hung re-read for an unknown id costs the timeout, not more.
    hang = true;
    nowMs += 60_000;
    expect(await refusal(verifyWith(cache, '0000000000000000'))).toBe('unknown_key');
    await expect(verifyWith(cache)).resolves.toBeTruthy();
    expect(reads).toBe(3);
    expect(WEBHOOK_KEYS_READ_TIMEOUT_SEC).toBe(5);
  });

  it('takes a key list only when every key in it is whole', async () => {
    const answers = (keys: unknown) => {
      let reads = 0;
      const fetchKeys = (async () => {
        reads += 1;
        return new Response(JSON.stringify({ keys }));
      }) as typeof fetch;
      return { cache: createWebhookKeyCache({ fetch: fetchKeys }), reads: () => reads, fetchKeys };
    };
    for (const bad of [
      [null],
      [],
      'keys',
      [KEYS[0], null],
      [{ ...KEYS[0], id: 7 }],
      [{ ...KEYS[0], id: '' }],
      [{ ...KEYS[0], public_key: 'abcd' }],
      [{ ...KEYS[0], public_key: 'z'.repeat(64) }],
      [{ id: KEYS[0].id, algorithm: 'ed25519' }],
      [{ ...KEYS[0], algorithm: undefined }],
    ]) {
      const { cache, reads, fetchKeys } = answers(bad);
      await expect(fetchWebhookKeys({ fetch: fetchKeys })).rejects.toThrow(
        'webhook-keys: the answer',
      );
      // The cache holds nothing of it, and says the list could not be read.
      await expect(cache.get(KEYS[0].id)).rejects.toThrow('could not be read');
      await expect(verifyWith(cache)).rejects.toThrow('could not be read');
      // One read by hand above, one by the cache; the second request waits out the floor.
      expect(reads()).toBe(2);
    }
    // A key of an algorithm this does not know is a key, and verifies nothing here.
    const future = {
      id: 'aaaaaaaaaaaaaaaa',
      algorithm: 'ml-dsa-65',
      public_key: 'long',
      public_key_near: '',
    };
    const { cache } = answers([future, KEYS[0]]);
    expect(await cache.get()).toHaveLength(2);
    await expect(verifyWith(cache)).resolves.toBeTruthy();
    // A list handed over by hand with a hole in it refuses, and does not throw a TypeError.
    expect(
      await refusal(
        verifyWebhook({
          headers: headersOf(),
          rawBody: VECTOR.body,
          keys: [null as unknown as WebhookKey],
          walletIds: WALLETS,
          now: VECTOR.timestamp,
        }),
      ),
    ).toBe('unknown_key');
  });

  it('refuses options that make a cache that cannot work', () => {
    for (const ttlSec of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createWebhookKeyCache({ ttlSec })).toThrow(RangeError);
    }
    for (const minRefetchSec of [-1, Number.NaN, Number.POSITIVE_INFINITY, 601]) {
      expect(() => createWebhookKeyCache({ minRefetchSec })).toThrow(RangeError);
    }
    expect(() => createWebhookKeyCache({ ttlSec: 30 })).toThrow(
      'minRefetchSec must not be more than ttlSec',
    );
    for (const readTimeoutSec of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createWebhookKeyCache({ readTimeoutSec })).toThrow(RangeError);
    }
    expect(() => createWebhookKeyCache({ ttlSec: 0 })).toThrow('ttlSec must be more than zero');
    // The edges that do work.
    expect(() => createWebhookKeyCache({ ttlSec: 60 })).not.toThrow();
    expect(() => createWebhookKeyCache({ ttlSec: 30, minRefetchSec: 0 })).not.toThrow();
  });
});

describe('fetchWebhookKeys', () => {
  it('reads the keys of the network asked for, with no API key', async () => {
    const asked: { url: string; authorization: string | null }[] = [];
    const answer = ({ request }: { request: Request }) => {
      asked.push({ url: request.url, authorization: request.headers.get('authorization') });
      return HttpResponse.json({ keys: KEYS });
    };
    server.use(
      http.get('https://api.outlayer.ai/wallet/v1/webhook-keys', answer),
      http.get('https://testnet-api.outlayer.ai/wallet/v1/webhook-keys', answer),
    );
    expect(await fetchWebhookKeys()).toEqual(KEYS);
    expect(await fetchWebhookKeys({ network: 'testnet' })).toEqual(KEYS);
    expect(asked).toEqual([
      { url: 'https://api.outlayer.ai/wallet/v1/webhook-keys', authorization: null },
      { url: 'https://testnet-api.outlayer.ai/wallet/v1/webhook-keys', authorization: null },
    ]);
    // What it answers is what `verifyWebhook` takes.
    const keys = await fetchWebhookKeys();
    await expect(
      verifyWebhook({
        headers: headersOf(),
        rawBody: VECTOR.body,
        keys,
        walletIds: WALLETS,
        now: VECTOR.timestamp,
      }),
    ).resolves.toBeTruthy();
  });

  it('throws when the answer is not a list of keys', async () => {
    server.use(
      http.get('https://api.outlayer.ai/wallet/v1/webhook-keys', () =>
        HttpResponse.json({ keys: [] }),
      ),
    );
    await expect(fetchWebhookKeys()).rejects.toThrow('no key');
    server.use(
      http.get('https://api.outlayer.ai/wallet/v1/webhook-keys', () =>
        HttpResponse.json({ error: 'rate_limited' }, { status: 429 }),
      ),
    );
    await expect(fetchWebhookKeys()).rejects.toThrow('429');
  });
});
