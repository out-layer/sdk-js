// What `sealTo` makes is what a component's `open` reads.
//
// The vector is the worker's (`worker/src/encryption_keys/mod.rs`,
// `the_golden_sealed_message_opens`): the same one-time secret, recipient key,
// plaintext and aad must give the same bytes here. If either side changes the
// format, one of the two goes red.

import { describe, expect, it } from 'vitest';
import { SEALED_FORMAT, getEncryptionPubkey, sealTo, sealWith } from '../src/seal.js';

const RECIPIENT = 'd8dab3938ebf11fb0a976ee6464fca1dd8ae1ae2c089eb74f242b8785deead69';
const GOLDEN =
  '02a4e09292b651c278b9772c569f5fa9bb13d906b46ab68c9df9dc2b4409f8a20982e4d1d0f68949731b656844b619291fe1168ba3cbfbff8e236533ad1d';
const utf8 = (text: string) => new TextEncoder().encode(text);
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** An X25519 key pair from 32 secret bytes (PKCS#8, RFC 8410). */
async function pairOf(secret: Uint8Array): Promise<CryptoKeyPair> {
  const pkcs8 = new Uint8Array([
    0x30,
    0x2e,
    0x02,
    0x01,
    0x00,
    0x30,
    0x05,
    0x06,
    0x03,
    0x2b,
    0x65,
    0x6e,
    0x04,
    0x22,
    0x04,
    0x20,
    ...secret,
  ]);
  const privateKey = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'X25519' }, true, [
    'deriveBits',
  ]);
  const jwk = await crypto.subtle.exportKey('jwk', privateKey);
  const publicKey = await crypto.subtle.importKey(
    'jwk',
    { kty: 'OKP', crv: 'X25519', x: jwk.x },
    { name: 'X25519' },
    true,
    [],
  );
  return { privateKey, publicKey };
}

describe('sealing an input', () => {
  it("reproduces the worker's golden sealed message", async () => {
    const ephemeral = await pairOf(new Uint8Array(32).fill(1));
    const sealed = await sealWith(
      ephemeral,
      RECIPIENT,
      utf8('{"q":"hello"}'),
      utf8('outlayer-input'),
    );
    expect(hex(sealed)).toBe(GOLDEN);
  });

  it('makes a fresh message every time, 49 bytes longer than the plaintext', async () => {
    const a = await sealTo(RECIPIENT, utf8('same'));
    const b = await sealTo(RECIPIENT, utf8('same'));
    expect(a[0]).toBe(SEALED_FORMAT);
    expect(a.length).toBe(4 + 49);
    expect(hex(a)).not.toBe(hex(b));
  });

  it('refuses a key that is not 32 bytes', async () => {
    await expect(sealTo('abcd', utf8('x'))).rejects.toThrow('32 bytes');
  });

  it('asks the platform for the key of one caller and path', async () => {
    const asked: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      asked.push(String(url));
      return new Response(JSON.stringify({ pubkey: RECIPIENT }), { status: 200 });
    }) as typeof fetch;
    try {
      const key = await getEncryptionPubkey('https://api.example/', {
        project: 'alice.near/app',
        account: 'bob.near',
        path: 'input',
      });
      expect(key).toBe(RECIPIENT);
      expect(asked).toEqual([
        'https://api.example/keys/encryption-pubkey?account=bob.near&path=input&project=alice.near%2Fapp',
      ]);
    } finally {
      globalThis.fetch = original;
    }
  });
});
