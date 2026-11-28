/**
 * NEP-413: what a NEAR wallet signs for `signMessage`, and its check.
 *
 * The signed bytes are SHA-256 of the tag 2^31 + 413 (u32, little-endian)
 * followed by the Borsh payload `{ message: String, nonce: [u8; 32],
 * recipient: String, callbackUrl: Option<String> }`, signed with Ed25519.
 * Byte for byte the coordinator's `verify_nep413_signature`, which every
 * owner's wallet already passes at registration; the tests hold both to one
 * vector.
 */

import { sha256 } from '@noble/hashes/sha256';
import { borshString, concat, le } from './bytes.js';
import { CustodyError } from './errors.js';

/** The NEP-413 tag: 2^31 + 413. */
export const NEP413_TAG = 2 ** 31 + 413;

/** What a wallet's NEP-413 signature is over. */
export interface Nep413Request {
  message: string;
  recipient: string;
  /** 32 bytes. */
  nonce: Uint8Array;
}

/** The 32-byte hash a wallet signs for `request`, with no callback URL. */
export function nep413Hash(request: Nep413Request): Uint8Array {
  if (request.nonce.length !== 32) throw new CustodyError('a NEP-413 nonce is 32 bytes');
  return sha256(
    concat(
      le(BigInt(NEP413_TAG), 4),
      borshString(request.message),
      request.nonce,
      borshString(request.recipient),
      Uint8Array.of(0), // callbackUrl: None
    ),
  );
}

/**
 * Whether `signature` (64 bytes) is the NEP-413 signature of `request` by
 * the Ed25519 key `publicKey` (32 bytes).
 */
export async function verifyNep413(
  publicKey: Uint8Array,
  signature: Uint8Array,
  request: Nep413Request,
): Promise<boolean> {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  const subtle = globalThis.crypto.subtle;
  const key = await subtle.importKey('raw', publicKey as BufferSource, 'Ed25519', false, [
    'verify',
  ]);
  return subtle.verify(
    'Ed25519',
    key,
    signature as BufferSource,
    nep413Hash(request) as BufferSource,
  );
}
