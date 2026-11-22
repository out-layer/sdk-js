/**
 * Sealing an input to a component on OutLayer.
 *
 * A component that declares an encryption key (`"encryption_keys": [{"path":
 * "input"}]`) has an X25519 public key for it. What is sealed to that key is
 * opened only inside a run that holds the key — the component calls `open`
 * (`outlayer:encryption-keys`) — so the input travels and is stored as
 * ciphertext.
 *
 * - {@link getEncryptionPubkey} asks the platform for the key, without a run.
 * - {@link sealTo} seals bytes to it.
 *
 * A key belongs to the caller of the run: seal to the key of the account your
 * calls run as (the payment key's owner over HTTPS). The public key is public,
 * so a sealed input says nothing about who sealed it; and the same caller can
 * send the same sealed bytes again.
 *
 * WebCrypto only (X25519, HKDF-SHA256, AES-256-GCM): the same code runs in
 * Node 20+ and in a current browser (X25519 in WebCrypto: Chromium 133+,
 * Firefox 130+, Safari 17+).
 */

const subtle = () => globalThis.crypto.subtle;

/** The first byte of a sealed message. */
export const SEALED_FORMAT = 0x02;
const KEY_LEN = 32;
const KDF_INFO = new TextEncoder().encode('outlayer:encryption-keys:v1:seal:kdf');

function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) throw new Error('not hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Which key: the one a run of `project`, or a direct run of the build `wasm`, holds. */
export type EncryptionKeyOf = (
  | { project: string; wasm?: never }
  | { wasm: string; project?: never }
) & {
  /** The account the run is started as: the payment key's owner over HTTPS. */
  account: string;
  /** The key's declared path. */
  path: string;
  /** As the manifest declares the key; `signer` when omitted. */
  caller?: 'signer' | 'predecessor';
};

/**
 * The X25519 public key (hex) of a component's encryption key, from
 * `GET /keys/encryption-pubkey`. The same bytes the component's `public-key`
 * call answers inside a run.
 */
export async function getEncryptionPubkey(baseUrl: string, key: EncryptionKeyOf): Promise<string> {
  const query = new URLSearchParams({ account: key.account, path: key.path });
  if (key.project !== undefined) query.set('project', key.project);
  if (key.wasm !== undefined) query.set('wasm', key.wasm);
  if (key.caller) query.set('caller', key.caller);
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/keys/encryption-pubkey?${query}`);
  if (!response.ok)
    throw new Error(`encryption-pubkey ${response.status}: ${await response.text()}`);
  const { pubkey } = (await response.json()) as { pubkey?: unknown };
  if (typeof pubkey !== 'string' || fromHex(pubkey).length !== KEY_LEN) {
    throw new Error('encryption-pubkey: the answer carries no 32-byte key');
  }
  return pubkey;
}

/**
 * Seals with a given key pair. The message key depends on the pair and the
 * recipient alone and the nonce is fixed, so a pair is used for ONE message:
 * {@link sealTo} makes a fresh one each time and is what callers use. Not
 * exported from the package; here for the test that pins the format.
 */
export async function sealWith(
  ephemeral: CryptoKeyPair,
  recipientPublicKeyHex: string,
  plaintext: Uint8Array,
  aad: Uint8Array = new Uint8Array(),
): Promise<Uint8Array> {
  const recipientRaw = fromHex(recipientPublicKeyHex);
  if (recipientRaw.length !== KEY_LEN) throw new Error('the recipient key is not 32 bytes');
  const recipient = await subtle().importKey(
    'raw',
    recipientRaw as BufferSource,
    { name: 'X25519' },
    false,
    [],
  );
  const ephemeralPublic = new Uint8Array(await subtle().exportKey('raw', ephemeral.publicKey));
  const shared = await subtle().deriveBits(
    { name: 'X25519', public: recipient },
    ephemeral.privateKey,
    256,
  );
  const hkdf = await subtle().importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const key = await subtle().deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: concat(KDF_INFO, ephemeralPublic, recipientRaw) as BufferSource,
    },
    hkdf,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );
  // The key is used for this one message, so its nonce is all zeros.
  const sealed = await subtle().encrypt(
    { name: 'AES-GCM', iv: new Uint8Array(12), additionalData: aad as BufferSource },
    key,
    plaintext as BufferSource,
  );
  return concat(Uint8Array.of(SEALED_FORMAT), ephemeralPublic, new Uint8Array(sealed));
}

/**
 * Seals `plaintext` to a component's encryption public key, bound to `aad`
 * (the component passes the same `aad` to `open`). The result is 49 bytes
 * longer than the plaintext; at most 262144 bytes of plaintext.
 */
export async function sealTo(
  recipientPublicKeyHex: string,
  plaintext: Uint8Array,
  aad: Uint8Array = new Uint8Array(),
): Promise<Uint8Array> {
  const ephemeral = (await subtle().generateKey({ name: 'X25519' }, false, [
    'deriveBits',
  ])) as CryptoKeyPair;
  return sealWith(ephemeral, recipientPublicKeyHex, plaintext, aad);
}
