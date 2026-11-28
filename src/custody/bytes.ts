/**
 * Bytes and their text forms: UTF-8, hex, base64, and the Borsh pieces the
 * custody formats are built from. The one definition of each for the package.
 */

import { CustodyError } from './errors.js';

/** The UTF-8 bytes of `text`. */
export const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/** `parts` one after another. */
export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Whether `a` and `b` are the same bytes. Not constant-time: for public values. */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/** Lowercase hex of `bytes`. */
export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The bytes of `text`, hex in either case; `null` on any other text. */
export function hexBytes(text: string): Uint8Array | null {
  if (text.length % 2 !== 0 || /[^0-9a-fA-F]/.test(text)) return null;
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(text.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/** `length` bytes from strict lowercase hex; throws on any other text. */
export function fromHex(text: string, length: number): Uint8Array {
  if (text.length !== 2 * length || !/^[0-9a-f]*$/.test(text)) {
    throw new CustodyError(`expected ${length} bytes in lowercase hex`);
  }
  return hexBytes(text) as Uint8Array;
}

/** The bytes of standard base64; throws on text `atob` does not take. */
export function base64Decode(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

/** Standard base64 of `bytes`, padded. */
export function base64Encode(bytes: Uint8Array): string {
  // in pieces: an argument list has a limit a large input would pass
  let binary = '';
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return btoa(binary);
}

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** The bytes of base58 text (the alphabet NEAR writes keys in); `null` on any other text. */
export function base58Bytes(text: string): Uint8Array | null {
  let value = 0n;
  for (const char of text) {
    const digit = BASE58.indexOf(char);
    if (digit < 0) return null;
    value = value * 58n + BigInt(digit);
  }
  const out: number[] = [];
  for (; value > 0n; value >>= 8n) out.unshift(Number(value & 0xffn));
  for (const char of text) {
    if (char !== '1') break;
    out.unshift(0);
  }
  return Uint8Array.from(out);
}

/** Base58 text of `bytes`, in the alphabet NEAR writes keys in. */
export function base58Encode(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  let out = '';
  for (; value > 0n; value /= 58n) out = BASE58[Number(value % 58n)] + out;
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = `1${out}`;
  }
  return out;
}

/** `value` in `bytes` bytes, little-endian. */
export function le(value: bigint, bytes: number): Uint8Array {
  const out = new Uint8Array(bytes);
  let rest = value;
  for (let i = 0; i < bytes; i++) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
}

/** Borsh `Vec<u8>`: a 4-byte length, then the bytes. */
export function borshBytes(bytes: Uint8Array): Uint8Array {
  return concat(le(BigInt(bytes.length), 4), bytes);
}

/** Borsh `String`: a 4-byte length, then the UTF-8 bytes. */
export function borshString(text: string): Uint8Array {
  return borshBytes(utf8(text));
}
