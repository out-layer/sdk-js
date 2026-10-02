// The inbox module against the platform's own vectors and sentences: the
// golden vectors are made by the worker's host (`worker/src/tasks/crypto.rs`,
// `print_fresh_golden_vectors`), the same file the dashboard's tests read.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  type Device,
  InboxRefused,
  type ListedTask,
  type Session,
  type Signer,
  acknowledge,
  confirmation,
  exportDevice,
  importDevice,
  isEnvelope,
  listTasks,
  nameWebhook,
  newDevice,
  readTask,
  signIn,
  statement,
  verifyWebhook,
} from '../src/inbox.js';

const GOLDEN = JSON.parse(
  readFileSync(new URL('./fixtures/inbox-golden.json', import.meta.url), 'utf8'),
);
const subtle = globalThis.crypto.subtle;
const fromHex = (hex: string) =>
  new Uint8Array(hex.match(/../g)!.map((b) => Number.parseInt(b, 16)));
const toBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const BASE = 'https://inbox.invalid';

/** The device of the golden vectors: the scalar 01 02 … 20, as PKCS#8. */
const GOLDEN_DEVICE_PKCS8 =
  '308141020100301306072a8648ce3d020106082a8648ce3d030107042730250201010420' +
  '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20';

/** `document` as the host lists it for `device`: content under a fresh key, the key sealed to the device. */
async function listed(
  device: Device,
  document: Uint8Array,
  over: Partial<ListedTask> = {},
): Promise<ListedTask> {
  const id = over.id ?? 'run-0';
  const contentKey = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const key = await subtle.importKey('raw', contentKey, 'AES-GCM', false, ['encrypt']);
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(
    await subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: new TextEncoder().encode(id) },
      key,
      document,
    ),
  );
  const ephemeral = (await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, [
    'deriveBits',
  ])) as CryptoKeyPair;
  const ephemeralPoint = new Uint8Array(await subtle.exportKey('raw', ephemeral.publicKey));
  const theirs = await subtle.importKey(
    'raw',
    device.point,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const shared = await subtle.deriveBits(
    { name: 'ECDH', public: theirs },
    ephemeral.privateKey,
    256,
  );
  const ikm = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const wrap = await subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array([...ephemeralPoint, ...device.point]),
      info: new TextEncoder().encode(`outlayer-task:v1:device-copy:${id}`),
    },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );
  const wrapNonce = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const wrapped = new Uint8Array(
    await subtle.encrypt({ name: 'AES-GCM', iv: wrapNonce }, wrap, contentKey),
  );
  return {
    id,
    project_id: 'connectors.outlayer.near/gmail',
    project_uuid: 'p0000000000000001',
    preparer: 'agent.near',
    profile: 'gmail',
    vault: null,
    kind: 'notice',
    state: 'open',
    created_at: 1,
    expires_at: 2,
    reply_pubkey: null,
    content: toBase64(new Uint8Array([0x01, ...nonce, ...sealed])),
    device_copy: toBase64(new Uint8Array([0x01, ...ephemeralPoint, ...wrapNonce, ...wrapped])),
    locked: false,
    ...over,
  };
}

/** A fetch that answers `respond`, and the requests it was asked. */
function stub(respond: (url: string, init: RequestInit) => Response) {
  const calls: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string | undefined;
  }[] = [];
  const fetch = (async (url: string, init: RequestInit = {}) => {
    calls.push({
      url,
      method: init.method ?? 'GET',
      headers: { ...(init.headers as Record<string, string>) },
      body: init.body as string | undefined,
    });
    return respond(url, init);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('the device', () => {
  it("kept and taken back is the same key, and the golden device is the host's", async () => {
    const golden = await importDevice(toBase64(fromHex(GOLDEN_DEVICE_PKCS8)));
    expect(golden.pubkey).toBe(GOLDEN.device_pubkey);
    const made = await newDevice();
    const again = await importDevice(await exportDevice(made));
    expect(again.pubkey).toBe(made.pubkey);
    // What is sealed to the device opens with the device taken back.
    const read = await readTask(
      again,
      await listed(made, new TextEncoder().encode(GOLDEN.notice_envelope)),
      'owner.near',
    );
    expect(read.hash).toBe(GOLDEN.notice_hash);
  });

  it('opens what the host sealed for it, and nothing sealed for another', async () => {
    const golden = await importDevice(toBase64(fromHex(GOLDEN_DEVICE_PKCS8)));
    const task = {
      ...(await listed(golden, new Uint8Array(1))),
      device_copy: toBase64(fromHex(GOLDEN.device_copy)),
      content: toBase64(fromHex(GOLDEN.content)),
    };
    // The host's copy and content open; the document is not an envelope, and is refused as one.
    await expect(readTask(golden, task, 'owner.near')).rejects.toThrow('what opened is not a task');
    await expect(readTask(await newDevice(), task, 'owner.near')).rejects.toThrow(
      'decryption failed',
    );
  });
});

describe('a task read', () => {
  it("the host's notice is an envelope, and its hash is of its bytes", async () => {
    const device = await newDevice();
    const read = await readTask(
      device,
      await listed(device, new TextEncoder().encode(GOLDEN.notice_envelope)),
      'owner.near',
    );
    expect(read.envelope.kind).toBe('notice');
    expect(read.hash).toBe(GOLDEN.notice_hash);
    expect(read.document).toBe(GOLDEN.notice_envelope);
    expect(read.envelope.display.title).toBe('Send an email');
  });

  it('is the task listed, for the owner, or is not read', async () => {
    const device = await newDevice();
    const document = new TextEncoder().encode(GOLDEN.notice_envelope);
    await expect(readTask(device, await listed(device, document), 'mallory.near')).rejects.toThrow(
      'not the task listed',
    );
    await expect(
      readTask(device, await listed(device, document, { preparer: 'other.near' }), 'owner.near'),
    ).rejects.toThrow('not the task listed');
    await expect(
      readTask(device, { ...(await listed(device, document)), device_copy: null }, 'owner.near'),
    ).rejects.toThrow('locked');
  });

  it('a notice names no operation and no reply key, and a task that takes an answer names both', () => {
    const notice = JSON.parse(GOLDEN.notice_envelope);
    expect(isEnvelope(notice)).toBe(true);
    expect(
      isEnvelope({ ...notice, answer_by: { operation: 'confirm', supplies: 'nothing' } }),
    ).toBe(false);
    expect(isEnvelope({ ...notice, reply_pubkey: GOLDEN.reply_pubkey })).toBe(false);
    const asking = {
      ...notice,
      kind: 'confirm',
      answer_by: { operation: 'confirm', supplies: 'nothing' },
      reply_pubkey: GOLDEN.reply_pubkey,
    };
    expect(isEnvelope(asking)).toBe(true);
    const { reply_pubkey: _, ...unkeyed } = asking;
    expect(isEnvelope(unkeyed)).toBe(false);
    expect(isEnvelope({ ...notice, kind: 'approve' })).toBe(false);
    expect(isEnvelope({ ...notice, v: 2 })).toBe(false);
  });
});

describe('the sentences the wallet signs', () => {
  // The host's own (`src/owner_tasks/confirmation.rs`, `session.rs`); the
  // webhook is named by the SHA-256 of `https://example.com/h`.
  it("are the host's, word for word", async () => {
    expect(statement('alice.near', 'p256:abc', 1_793_275_200)).toBe(
      'Sign in to OutLayer as alice.near. Device key: p256:abc. Valid until 2026-10-29T12:00:00Z.',
    );
    expect(
      await confirmation(
        'alice.near',
        { withdrawDevice: '0b9c1a52-7c1e-4a53-9c58-2f0c8f6f3b11' },
        1_793_275_200,
      ),
    ).toBe(
      'Confirm in OutLayer as alice.near: withdraw the device 0b9c1a52-7c1e-4a53-9c58-2f0c8f6f3b11. At 2026-10-29T12:00:00Z.',
    );
    expect(
      await confirmation('alice.near', { nameWebhook: 'https://example.com/h' }, 1_793_275_200),
    ).toBe(
      'Confirm in OutLayer as alice.near: name the webhook ab5fdede49e491dcad66eeea73603675ccc760552ad0619837748c9827d0167f. At 2026-10-29T12:00:00Z.',
    );
    expect(await confirmation('alice.near', { removeWebhook: true }, 1_793_275_200)).toBe(
      'Confirm in OutLayer as alice.near: remove the webhook. At 2026-10-29T12:00:00Z.',
    );
  });
});

describe('the API', () => {
  const signer: Signer = async (message, recipient) => {
    signed.push({ message, recipient });
    return { accountId: 'abc123', publicKey: 'ed25519:key', signature: 'c2ln', nonce: 'bm9uY2U=' };
  };
  const signed: { message: string; recipient: string }[] = [];

  it('signs a device in with the statement the wallet signed, and no bearer', async () => {
    const device = await newDevice();
    const { fetch, calls } = stub(() =>
      json(200, {
        token: 'os_t',
        device_id: 'd-1',
        account_id: 'abc123',
        valid_until: 1_790_000_000,
      }),
    );
    const session = await signIn(
      { baseUrl: BASE, fetch, recipient: 'outlayer.testnet' },
      signer,
      'abc123',
      device,
      1_790_000_000,
    );
    expect(session).toMatchObject({
      token: 'os_t',
      deviceId: 'd-1',
      accountId: 'abc123',
      validUntil: 1_790_000_000,
    });
    expect(signed.at(-1)).toEqual({
      message: statement('abc123', device.pubkey, 1_790_000_000),
      recipient: 'outlayer.testnet',
    });
    expect(calls[0].url).toBe(`${BASE}/inbox/session`);
    expect(calls[0].headers.Authorization).toBeUndefined();
    expect(JSON.parse(calls[0].body!)).toEqual({
      account_id: 'abc123',
      device_pubkey: device.pubkey,
      valid_until: 1_790_000_000,
      public_key: 'ed25519:key',
      signature: 'c2ln',
      nonce: 'bm9uY2U=',
    });
    // A wallet that signed as another account opens nothing.
    await expect(
      signIn(
        { baseUrl: BASE, fetch, recipient: 'outlayer.testnet' },
        signer,
        'someone.near',
        device,
      ),
    ).rejects.toThrow('signed as abc123');
    expect(calls).toHaveLength(1);
  });

  it("Got it posts to the notice's route with the bearer and no body", async () => {
    const { fetch, calls } = stub(() => json(200, { id: 'a/b', state: 'done' }));
    const session: Session = {
      baseUrl: BASE,
      fetch,
      token: 'os_t',
      deviceId: 'd',
      accountId: 'abc123',
      validUntil: 0,
    };
    expect(await acknowledge(session, 'a/b')).toEqual({ id: 'a/b', state: 'done' });
    expect(calls[0]).toMatchObject({
      url: `${BASE}/inbox/tasks/a%2Fb/acknowledge`,
      method: 'POST',
      body: undefined,
    });
    expect(calls[0].headers).toEqual({ Authorization: 'Bearer os_t' });
  });

  it('a refusal is a refusal, never an empty inbox', async () => {
    const refused = stub(() =>
      json(503, { error: 'Come back later.', reason: 'upstream_unavailable', terminal: false }),
    );
    const session: Session = {
      baseUrl: BASE,
      fetch: refused.fetch,
      token: 'os_t',
      deviceId: 'd',
      accountId: 'abc123',
      validUntil: 0,
    };
    const error = await listTasks(session).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InboxRefused);
    expect(error).toMatchObject({ status: 503, reason: 'upstream_unavailable', terminal: false });
    const listless = stub(() => json(200, { more: false }));
    await expect(listTasks({ ...session, fetch: listless.fetch })).rejects.toThrow(
      'without a list',
    );
  });

  it("names a webhook with the wallet's confirmation and hands the secret back", async () => {
    const { fetch, calls } = stub(() =>
      json(200, { url: 'https://example.com/h', set_here: true, secret: 'whs_1' }),
    );
    const session = {
      baseUrl: BASE,
      fetch,
      token: 'os_t',
      deviceId: 'd',
      accountId: 'abc123',
      validUntil: 0,
      recipient: 'outlayer.testnet',
    };
    expect(await nameWebhook(session, 'https://example.com/h', signer)).toBe('whs_1');
    const body = JSON.parse(calls[0].body!);
    expect(calls[0]).toMatchObject({ url: `${BASE}/inbox/webhook`, method: 'PUT' });
    expect(body.url).toBe('https://example.com/h');
    expect(signed.at(-1)!.message).toBe(
      await confirmation('abc123', { nameWebhook: 'https://example.com/h' }, body.confirmation.at),
    );
  });
});

describe('a webhook', () => {
  it('verifies the body it was signed over, and no other', async () => {
    const body = '{"type":"task_created","task_id":"run-0","kind":"notice"}';
    const key = await subtle.importKey(
      'raw',
      new TextEncoder().encode('whs_secret'),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const signature = Buffer.from(
      await subtle.sign('HMAC', key, new TextEncoder().encode(body)),
    ).toString('hex');
    expect(await verifyWebhook(body, signature, 'whs_secret')).toBe(true);
    expect(await verifyWebhook(body, signature.toUpperCase(), 'whs_secret')).toBe(true);
    expect(await verifyWebhook(body.replace('notice', 'noticf'), signature, 'whs_secret')).toBe(
      false,
    );
    expect(await verifyWebhook(body, signature, 'whs_other')).toBe(false);
    expect(await verifyWebhook(body, null, 'whs_secret')).toBe(false);
    expect(await verifyWebhook(body, signature.slice(1), 'whs_secret')).toBe(false);
  });
});
