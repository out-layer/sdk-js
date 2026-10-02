/**
 * The owner's inbox: tasks an agent left for its owner, read on a device of
 * the owner's, and the notices among them closed with Got it.
 *
 * Every task is encrypted to the owner's devices. A device is a P-256 key
 * pair; the owner's wallet signs one statement that names its public key,
 * which opens a session on it. The module never holds a wallet key: every
 * signature is asked of the `Signer` the caller passes — in an app on
 * OutLayer custody, the wallet's `sign-message` ({@link walletSigner}).
 *
 * It does not approve tasks. A task that asks something is approved where it
 * is shown first, in the dashboard's inbox.
 *
 * WebCrypto only: the same code runs in Node 22 and in a browser.
 */

import type { OutlayerClient } from './client.js';

const subtle = () => globalThis.crypto.subtle;
const FORMAT = 0x01;
const POINT = 65;
const NONCE = 12;
const CURVE = { name: 'ECDH', namedCurve: 'P-256' } as const;

/** The longest a session lasts, in seconds. */
export const MAX_SESSION_SECONDS = 30 * 24 * 60 * 60;

// ── bytes ───────────────────────────────────────────────────────────────────

const utf8 = (text: string) => new TextEncoder().encode(text);

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

const toBase64Url = (bytes: Uint8Array) =>
  toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function fromBase64Url(text: string): Uint8Array {
  const plain = text.replace(/-/g, '+').replace(/_/g, '/');
  return fromBase64(plain + '='.repeat((4 - (plain.length % 4)) % 4));
}

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return toHex(new Uint8Array(await subtle().digest('SHA-256', bytes as BufferSource)));
}

// ── the device ──────────────────────────────────────────────────────────────

/** A device of the owner's: the key pair tasks are encrypted to. */
export type Device = {
  privateKey: CryptoKey;
  /** The public key as the inbox writes it: `p256:` and the uncompressed point, base64url. */
  pubkey: string;
  point: Uint8Array;
};

/**
 * A new device. Its private key is exportable ({@link exportDevice}): a
 * server keeps it between requests, beside the session, and never hands it
 * to a browser.
 */
export async function newDevice(): Promise<Device> {
  const pair = (await subtle().generateKey(CURVE, true, ['deriveBits'])) as CryptoKeyPair;
  const point = new Uint8Array(await subtle().exportKey('raw', pair.publicKey));
  return { privateKey: pair.privateKey, point, pubkey: `p256:${toBase64Url(point)}` };
}

/** The device's private key as PKCS#8, base64: to keep it, server-side. */
export async function exportDevice(device: Device): Promise<string> {
  return toBase64(new Uint8Array(await subtle().exportKey('pkcs8', device.privateKey)));
}

/** A device kept with {@link exportDevice}. */
export async function importDevice(pkcs8: string): Promise<Device> {
  const privateKey = await subtle().importKey(
    'pkcs8',
    fromBase64(pkcs8) as BufferSource,
    CURVE,
    true,
    ['deriveBits'],
  );
  const jwk = await subtle().exportKey('jwk', privateKey);
  if (!jwk.x || !jwk.y) throw new Error('the key is not a P-256 key');
  const point = concat(new Uint8Array([0x04]), fromBase64Url(jwk.x), fromBase64Url(jwk.y));
  return { privateKey, point, pubkey: `p256:${toBase64Url(point)}` };
}

// ── what the wallet signs ───────────────────────────────────────────────────

/** A moment in the sentences the wallet signs: to the second, in UTC. */
function moment(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** The statement the owner's wallet signs to sign a device in. */
export function statement(account: string, devicePubkey: string, validUntil: number): string {
  return `Sign in to OutLayer as ${account}. Device key: ${devicePubkey}. Valid until ${moment(validUntil)}.`;
}

/** An action a session does not do alone: the owner's wallet confirms it. */
export type ConfirmedAction =
  | { withdrawDevice: string }
  | { nameWebhook: string }
  | { removeWebhook: true };

/** The sentence the owner's wallet signs to confirm `action`. Good for ten minutes, once. */
export async function confirmation(
  account: string,
  action: ConfirmedAction,
  at: number,
): Promise<string> {
  let named: string;
  if ('withdrawDevice' in action) named = `withdraw the device ${action.withdrawDevice}`;
  else if ('nameWebhook' in action)
    named = `name the webhook ${await sha256Hex(utf8(action.nameWebhook))}`;
  else named = 'remove the webhook';
  return `Confirm in OutLayer as ${account}: ${named}. At ${moment(at)}.`;
}

/** One NEP-413 signature of the owner's wallet. */
export type Signed = {
  /** The account that signed. */
  accountId: string;
  /** `ed25519:<base58>`. */
  publicKey: string;
  /** Base64, 64 bytes. */
  signature: string;
  /** Base64, 32 bytes. */
  nonce: string;
};

/**
 * Signs `message` for `recipient` (NEP-413) with the owner's wallet. Called
 * from what the owner asked for, never on its own: a sign-in, the naming of
 * a webhook.
 */
export type Signer = (message: string, recipient: string) => Promise<Signed>;

/**
 * The signer of an OutLayer custody wallet: its `sign-message`. An account
 * not yet on chain signs in with it too — its own key is its key. A wallet
 * whose policy limits the recipients of `sign_message` must list the OutLayer
 * contract.
 */
export function walletSigner(client: OutlayerClient): Signer {
  return async (message, recipient) => {
    const signed = await client.signMessage({ message, recipient, format: 'nep413' });
    const { account_id, public_key, signature_base64, nonce } = signed;
    if (!account_id || !public_key || !signature_base64 || !nonce) {
      throw new Error(
        'The wallet answered sign-message without the signature, its key, its nonce or its account.',
      );
    }
    // The base64 form: the inbox reads the signature as 64 bytes of base64,
    // not as the `ed25519:` form beside it.
    return { accountId: account_id, publicKey: public_key, signature: signature_base64, nonce };
  };
}

// ── the API ─────────────────────────────────────────────────────────────────

/** Where the inbox is: `https://api.outlayer.ai` or `https://testnet-api.outlayer.ai`. */
export type InboxBase = { baseUrl: string; fetch?: typeof fetch };

/** A session of a device. */
export type Session = InboxBase & {
  token: string;
  deviceId: string;
  accountId: string;
  /** Unix seconds. */
  validUntil: number;
};

/** A refusal of the inbox: `reason` to branch on, a sentence for a person. */
export class InboxRefused extends Error {
  readonly status: number;
  readonly reason: string;
  readonly terminal: boolean;
  /** Seconds, from `Retry-After`, when the inbox says when to come back. */
  readonly retryAfter: number | null;

  constructor(
    message: string,
    status: number,
    reason: string,
    terminal: boolean,
    retryAfter: number | null,
  ) {
    super(message);
    this.name = 'InboxRefused';
    this.status = status;
    this.reason = reason;
    this.terminal = terminal;
    this.retryAfter = retryAfter;
  }
}

async function ask<T>(
  where: InboxBase,
  path: string,
  init: { method?: string; token?: string; body?: unknown } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  const request: RequestInit = { method: init.method ?? 'GET', headers };
  if (init.body !== undefined) request.body = JSON.stringify(init.body);
  const response = await (where.fetch ?? fetch)(`${where.baseUrl}${path}`, request);
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    const refusal = (parsed ?? {}) as { error?: unknown; reason?: unknown; terminal?: unknown };
    const after = Number(response.headers.get('retry-after'));
    throw new InboxRefused(
      typeof refusal.error === 'string' ? refusal.error : `The inbox answered ${response.status}.`,
      response.status,
      typeof refusal.reason === 'string' ? refusal.reason : 'unknown',
      refusal.terminal === true,
      Number.isFinite(after) && after > 0 ? after : null,
    );
  }
  if (parsed === null)
    throw new InboxRefused(
      'The inbox answered with no JSON.',
      response.status,
      'unknown',
      false,
      null,
    );
  return parsed as T;
}

/**
 * Sign `device` in for `account`: the wallet signs the statement, and the
 * inbox opens a session on the device. `validUntil` is Unix seconds, at most
 * {@link MAX_SESSION_SECONDS} ahead; a day ahead when not named. A session is
 * not extended: sign in again when it ends.
 */
export async function signIn(
  where: InboxBase & { recipient: string },
  signer: Signer,
  account: string,
  device: Device,
  validUntil = Math.floor(Date.now() / 1000) + 24 * 60 * 60,
): Promise<Session> {
  const signed = await signer(statement(account, device.pubkey, validUntil), where.recipient);
  if (signed.accountId !== account)
    throw new Error(`The wallet signed as ${signed.accountId}, not as ${account}.`);
  const opened = await ask<{
    token: string;
    device_id: string;
    account_id: string;
    valid_until: number;
  }>(where, '/inbox/session', {
    method: 'POST',
    body: {
      account_id: account,
      device_pubkey: device.pubkey,
      valid_until: validUntil,
      public_key: signed.publicKey,
      signature: signed.signature,
      nonce: signed.nonce,
    },
  });
  const session: Session = {
    baseUrl: where.baseUrl,
    token: opened.token,
    deviceId: opened.device_id,
    accountId: opened.account_id,
    validUntil: opened.valid_until,
  };
  if (where.fetch) session.fetch = where.fetch;
  return session;
}

/** End the session: this device reads nothing more. */
export async function signOut(session: Session): Promise<void> {
  await ask(session, '/inbox/session', { method: 'DELETE', token: session.token });
}

/** A task as the inbox lists it: ciphertext, and the copy for this device. */
export type ListedTask = {
  id: string;
  project_id: string;
  project_uuid: string;
  preparer: string;
  profile: string;
  vault: string | null;
  kind: 'confirm' | 'input' | 'notice';
  state: string;
  created_at: number;
  expires_at: number;
  run?: string;
  failure_reason?: string;
  reply_pubkey: string | null;
  content: string | null;
  device_copy: string | null;
  locked: boolean;
};

/** The newest tasks of the owner, waiting or closed; `more` when older ones exist and are not listed. */
export async function listTasks(
  session: Session,
  show: 'waiting' | 'closed' = 'waiting',
): Promise<{ tasks: ListedTask[]; more: boolean }> {
  const listed = await ask<{ tasks?: unknown; more?: unknown }>(
    session,
    `/inbox/tasks?show=${show}`,
    { token: session.token },
  );
  if (!Array.isArray(listed.tasks))
    throw new InboxRefused('The inbox answered without a list.', 200, 'unknown', false, null);
  return { tasks: listed.tasks as ListedTask[], more: listed.more === true };
}

/** Got it: close a notice as seen. Nothing is signed and nothing runs; the agent reads it `done`. */
export async function acknowledge(
  session: Session,
  id: string,
): Promise<{ id: string; state: string }> {
  return ask(session, `/inbox/tasks/${encodeURIComponent(id)}/acknowledge`, {
    method: 'POST',
    token: session.token,
  });
}

/** Say no to a task that asks something, with a reason sealed to the task, or none. */
export async function rejectTask(
  session: Session,
  task: ReadTask | ListedTask,
  reason?: string,
): Promise<{ id: string; state: string }> {
  let sealed: string | null = null;
  if (reason) {
    if (!('envelope' in task) || task.envelope.kind === 'notice')
      throw new Error('A reason is sealed to a task that was read and takes an answer.');
    sealed = toBase64(
      await sealTo(
        readPubkey(task.envelope.reply_pubkey),
        'rejection',
        task.envelope.id,
        utf8(reason),
      ),
    );
  }
  const id = 'envelope' in task ? task.envelope.id : task.id;
  return ask(session, `/inbox/tasks/${encodeURIComponent(id)}/reject`, {
    method: 'POST',
    token: session.token,
    body: { reason: sealed },
  });
}

/** Delete a task, in any state. */
export async function deleteTask(session: Session, id: string): Promise<{ deleted: number }> {
  return ask(session, `/inbox/tasks/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    token: session.token,
  });
}

/** Mute an agent (an account) or a project (its uuid); with `deleteWaiting`, its waiting tasks go too. */
export async function mute(
  session: Session,
  who: { subject_is: 'agent' | 'project'; subject: string },
  deleteWaiting = true,
): Promise<{ deleted: number }> {
  return ask(session, '/inbox/mutes', {
    method: 'POST',
    token: session.token,
    body: { ...who, delete_waiting: deleteWaiting },
  });
}

/**
 * Name the URL the owner's task events are POSTed to. The wallet confirms it
 * (one signature over the sentence that names the URL's hash). Answers the
 * secret the events are signed with — told this once: keep it where
 * {@link verifyWebhook} reads it. One URL per owner: this one replaces any
 * other.
 */
export async function nameWebhook(
  session: Session & { recipient: string },
  url: string,
  signer: Signer,
): Promise<string> {
  const at = Math.floor(Date.now() / 1000);
  const signed = await signer(
    await confirmation(session.accountId, { nameWebhook: url }, at),
    session.recipient,
  );
  if (signed.accountId !== session.accountId)
    throw new Error(`The wallet signed as ${signed.accountId}, not as ${session.accountId}.`);
  const named = await ask<{ secret?: string }>(session, '/inbox/webhook', {
    method: 'PUT',
    token: session.token,
    body: {
      url,
      confirmation: {
        at,
        public_key: signed.publicKey,
        signature: signed.signature,
        nonce: signed.nonce,
      },
    },
  });
  if (typeof named.secret !== 'string')
    throw new Error('The inbox named the URL and told no secret.');
  return named.secret;
}

/**
 * Is `body` an event of the owner's, as the inbox signed it? `signature` is
 * the `X-Webhook-Signature` header: the HMAC-SHA256 of the body, hex, under
 * the secret. Compared in constant time. A body that is not the bytes
 * received — parsed and written again — does not verify.
 */
export async function verifyWebhook(
  body: string | Uint8Array,
  signature: string | null,
  secret: string,
): Promise<boolean> {
  if (!signature || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const key = await subtle().importKey(
    'raw',
    utf8(secret) as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const bytes = typeof body === 'string' ? utf8(body) : body;
  const expected = toHex(new Uint8Array(await subtle().sign('HMAC', key, bytes as BufferSource)));
  const given = signature.toLowerCase();
  let differs = 0;
  for (let i = 0; i < expected.length; i += 1)
    differs |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return differs === 0;
}

// ── reading a task ──────────────────────────────────────────────────────────

export type TaskField = {
  kind: 'money' | 'account' | 'address' | 'text' | 'long_text' | 'list';
  label: string;
  values: string[];
  /** The project's words, or the agent's. */
  written_by: 'project' | 'agent';
};

export type FileNote = { content_type: string; name: string; sha256: string; size: number };

type EnvelopeOfAnyKind = {
  build: string;
  created_at: number;
  display: { title: string; fields: TaskField[] };
  expires_at: number;
  files: FileNote[];
  id: string;
  owner: string;
  policy_hash: string;
  preparer: string;
  profile: string;
  project: string;
  project_uuid: string;
  state_hash: string;
  thread: string;
  v: number;
};

/** A task that asks the owner something: it names its operation and its reply key. */
export type AskingEnvelope = EnvelopeOfAnyKind & {
  kind: 'confirm' | 'input';
  answer_by: { operation: string; supplies: 'nothing' | 'text' | 'file' };
  reply_pubkey: string;
};

/** A notice: it tells the owner something and asks nothing. */
export type NoticeEnvelope = EnvelopeOfAnyKind & { kind: 'notice' };

/** What a task shows, as the platform sealed it: one canonical JSON document. */
export type Envelope = AskingEnvelope | NoticeEnvelope;

/** A task read on this device. */
export type ReadTask = {
  envelope: Envelope;
  /** The document as it opened: the bytes the hash is of. */
  document: string;
  /** SHA-256, hex, of the document: what an approval names. */
  hash: string;
  contentKey: Uint8Array;
};

const FIELD_KINDS: readonly string[] = ['money', 'account', 'address', 'text', 'long_text', 'list'];
const text = (value: unknown): value is string => typeof value === 'string';

/** Is `value` an envelope, member for member, with its kind and what it holds in agreement? */
export function isEnvelope(value: unknown): value is Envelope {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;
  const display = e.display as Record<string, unknown> | undefined;
  if (
    typeof display !== 'object' ||
    display === null ||
    !text(display.title) ||
    !Array.isArray(display.fields)
  )
    return false;
  const fields = display.fields.every((f) => {
    if (typeof f !== 'object' || f === null) return false;
    const field = f as Record<string, unknown>;
    return (
      text(field.label) &&
      text(field.kind) &&
      FIELD_KINDS.includes(field.kind) &&
      (field.written_by === 'project' || field.written_by === 'agent') &&
      Array.isArray(field.values) &&
      field.values.every(text)
    );
  });
  const files =
    Array.isArray(e.files) &&
    e.files.every((f) => {
      if (typeof f !== 'object' || f === null) return false;
      const file = f as Record<string, unknown>;
      return (
        text(file.name) &&
        text(file.content_type) &&
        text(file.sha256) &&
        /^[0-9a-f]{64}$/.test(file.sha256) &&
        typeof file.size === 'number' &&
        Number.isSafeInteger(file.size) &&
        file.size >= 0
      );
    });
  const answerBy = e.answer_by as Record<string, unknown> | undefined;
  const asking =
    (e.kind === 'confirm' || e.kind === 'input') &&
    typeof answerBy === 'object' &&
    answerBy !== null &&
    text(answerBy.operation) &&
    (answerBy.supplies === 'nothing' ||
      answerBy.supplies === 'text' ||
      answerBy.supplies === 'file') &&
    text(e.reply_pubkey);
  const notice = e.kind === 'notice' && !('answer_by' in e) && !('reply_pubkey' in e);
  return (
    fields &&
    files &&
    (asking || notice) &&
    [
      e.id,
      e.owner,
      e.preparer,
      e.profile,
      e.project,
      e.project_uuid,
      e.thread,
      e.policy_hash,
      e.state_hash,
    ].every(text) &&
    text(e.build) &&
    /^[0-9a-f]{64}$/.test(e.build) &&
    typeof e.created_at === 'number' &&
    typeof e.expires_at === 'number' &&
    e.v === 1
  );
}

/** A public key as the inbox writes it, read back as its point. */
export function readPubkey(written: string): Uint8Array {
  if (!written.startsWith('p256:')) throw new Error('the key is not written `p256:…`');
  const point = fromBase64Url(written.slice(5));
  if (point.length !== POINT || point[0] !== 0x04)
    throw new Error('the key is not an uncompressed point of 65 bytes');
  return point;
}

async function eciesKey(
  privateKey: CryptoKey,
  theirPoint: Uint8Array,
  ephemeralPoint: Uint8Array,
  recipientPoint: Uint8Array,
  purpose: string,
  task: string,
  usage: KeyUsage,
): Promise<CryptoKey> {
  const theirs = await subtle().importKey('raw', theirPoint as BufferSource, CURVE, false, []);
  const shared = await subtle().deriveBits({ name: 'ECDH', public: theirs }, privateKey, 256);
  const ikm = await subtle().importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return subtle().deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: concat(ephemeralPoint, recipientPoint) as BufferSource,
      info: utf8(`outlayer-task:v1:${purpose}:${task}`) as BufferSource,
    },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage],
  );
}

async function openFrom(
  device: Device,
  purpose: string,
  task: string,
  blob: Uint8Array,
): Promise<Uint8Array> {
  if (blob.length < 1 + POINT + NONCE + 16 || blob[0] !== FORMAT)
    throw new Error('decryption failed');
  const ephemeral = blob.slice(1, 1 + POINT);
  try {
    const key = await eciesKey(
      device.privateKey,
      ephemeral,
      ephemeral,
      device.point,
      purpose,
      task,
      'decrypt',
    );
    const nonce = blob.slice(1 + POINT, 1 + POINT + NONCE);
    return new Uint8Array(
      await subtle().decrypt(
        { name: 'AES-GCM', iv: nonce as BufferSource },
        key,
        blob.slice(1 + POINT + NONCE) as BufferSource,
      ),
    );
  } catch {
    throw new Error('decryption failed');
  }
}

async function sealTo(
  recipientPoint: Uint8Array,
  purpose: string,
  task: string,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const ephemeral = (await subtle().generateKey(CURVE, false, ['deriveBits'])) as CryptoKeyPair;
  const ephemeralPoint = new Uint8Array(await subtle().exportKey('raw', ephemeral.publicKey));
  const key = await eciesKey(
    ephemeral.privateKey,
    recipientPoint,
    ephemeralPoint,
    recipientPoint,
    purpose,
    task,
    'encrypt',
  );
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(NONCE));
  const sealed = new Uint8Array(
    await subtle().encrypt({ name: 'AES-GCM', iv: nonce }, key, plaintext as BufferSource),
  );
  return concat(new Uint8Array([FORMAT]), ephemeralPoint, nonce, sealed);
}

async function openUnder(
  contentKey: Uint8Array,
  bound: string,
  blob: Uint8Array,
): Promise<Uint8Array> {
  if (blob.length < 1 + NONCE + 16 || blob[0] !== FORMAT) throw new Error('decryption failed');
  try {
    const key = await subtle().importKey('raw', contentKey as BufferSource, 'AES-GCM', false, [
      'decrypt',
    ]);
    return new Uint8Array(
      await subtle().decrypt(
        {
          name: 'AES-GCM',
          iv: blob.slice(1, 1 + NONCE) as BufferSource,
          additionalData: utf8(bound) as BufferSource,
        },
        key,
        blob.slice(1 + NONCE) as BufferSource,
      ),
    );
  } catch {
    throw new Error('decryption failed');
  }
}

/**
 * Read a listed task on this device: the envelope, and the hash of the
 * bytes that opened. Throws when the task is locked here (it arrived before
 * this device signed in: the owner's `tasks_unlock` writes its copy), when
 * it does not open, or when what opened is not the task listed for `owner`.
 */
export async function readTask(device: Device, task: ListedTask, owner: string): Promise<ReadTask> {
  if (task.device_copy === null || task.content === null)
    throw new Error('the task is locked on this device');
  const contentKey = await openFrom(device, 'device-copy', task.id, fromBase64(task.device_copy));
  const document = await openUnder(contentKey, task.id, fromBase64(task.content));
  let envelope: unknown;
  try {
    envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(document));
  } catch {
    throw new Error('what opened is not a task');
  }
  if (!isEnvelope(envelope)) throw new Error('what opened is not a task');
  const same =
    envelope.id === task.id &&
    envelope.owner === owner &&
    envelope.project === task.project_id &&
    envelope.preparer === task.preparer;
  if (!same) throw new Error('the task that opened is not the task listed');
  return {
    envelope,
    document: new TextDecoder().decode(document),
    hash: await sha256Hex(document),
    contentKey,
  };
}

/** The file at `at` of a task read here, held to what the envelope says of it. */
export async function openFile(session: Session, task: ReadTask, at: number): Promise<Uint8Array> {
  const note = task.envelope.files[at];
  if (!note) throw new Error(`the task names no file ${at}`);
  const { ciphertext } = await ask<{ ciphertext: string }>(
    session,
    `/inbox/tasks/${encodeURIComponent(task.envelope.id)}/files/${at}`,
    { token: session.token },
  );
  const bytes = await openUnder(
    task.contentKey,
    `${task.envelope.id}:file:${at}`,
    fromBase64(ciphertext),
  );
  if (bytes.length !== note.size || (await sha256Hex(bytes)) !== note.sha256) {
    throw new Error('the file that opened is not the file the task names');
  }
  return bytes;
}
