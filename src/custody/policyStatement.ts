/**
 * A policy's ciphertext, held to the keystore's statement.
 *
 * The owner signs a policy's ciphertext into `store_wallet_policy` and reads a
 * stored policy back, both through the API, and can decrypt neither. An API
 * that swapped the ciphertext, or answered another plaintext for it, would
 * have the owner store or trust a policy they never saw. So the keystore
 * states, in a text signed with its registration key — the key the OutLayer
 * keystore DAO approved — which plaintext a ciphertext encrypts, for which
 * wallet. The statement is built here from the caller's own values (its DAO,
 * its wallet's key, the bytes it holds), never taken from the answer.
 */

import { sha256 } from '@noble/hashes/sha256';
import { base58Bytes, base64Decode, base64Encode, fromHex, toHex, utf8 } from './bytes.js';
import { CustodyError } from './errors.js';
import { isKeystoreApproved } from './teeKey.js';

/** The first line of {@link policyStatement}. */
export const POLICY_STATEMENT_TAG = 'OUTLAYER_WALLET_POLICY/V1';

/**
 * What the keystore signs about a policy: that the ciphertext whose SHA-256
 * is `blobSha256` encrypts exactly the bytes whose SHA-256 is `policySha256`
 * (both in hex), as the policy of the wallet the contract stores as
 * `walletPubkey` (`ed25519:<hex>`), said by a keystore of the DAO `dao`. One
 * field per line, joined by `\n`, with no newline at the end.
 */
export function policyStatement(
  dao: string,
  walletPubkey: string,
  blobSha256: string,
  policySha256: string,
): string {
  return [
    POLICY_STATEMENT_TAG,
    `dao:${dao}`,
    `wallet:${walletPubkey}`,
    `blob:${blobSha256}`,
    `policy:${policySha256}`,
  ].join('\n');
}

/** What `encrypt-policy` and `open-policy` carry with a policy's ciphertext. */
export interface PolicyStatementAnswer {
  /** The plaintext the ciphertext encrypts, byte for byte. */
  policy_json: string;
  /** The keystore's registration key, `ed25519:<base58>`. */
  keystore_public_key: string;
  /** Its Ed25519 signature over {@link policyStatement}, in hex. */
  policy_statement_signature: string;
}

/** What {@link verifyPolicyStatement} holds an answer to: the caller's own values. */
export interface PolicyStatementExpectation {
  /** The wallet's key as the contract stores it: `ed25519:<hex>`. */
  walletPubkey: string;
  /**
   * The ciphertext, base64: the bytes that go into `store_wallet_policy`, or
   * `encrypted_data` of the caller's own `get_wallet_policy` view call.
   */
  encryptedData: string;
  /** The keystore DAO's account: `dao.outlayer.near` on mainnet. */
  keystoreDaoId: string;
  /** A NEAR RPC of the DAO's network. */
  rpcUrl: string;
  fetch?: typeof fetch;
}

/**
 * The plaintext of `expected.encryptedData`, once an approved keystore of
 * `expected.keystoreDaoId` stated that this ciphertext encrypts it for this
 * wallet. Throws a {@link CustodyError} naming what does not hold.
 *
 * What it returns is the text to read the policy from. Whether that policy
 * is the one the caller asked to store is the caller's to check, on this
 * text, before the ciphertext is signed into a transaction.
 */
export async function verifyPolicyStatement(
  answer: unknown,
  expected: PolicyStatementExpectation,
): Promise<string> {
  const { policy_json, keystore_public_key, policy_statement_signature } = (answer ??
    {}) as Partial<Record<keyof PolicyStatementAnswer, unknown>>;
  if (!/^ed25519:[0-9a-f]{64}$/.test(expected.walletPubkey)) {
    throw new CustodyError("the wallet's key is not `ed25519:` and 32 bytes in lowercase hex");
  }
  let blob: Uint8Array;
  try {
    blob = base64Decode(expected.encryptedData);
  } catch {
    throw new CustodyError('the encrypted policy is not base64');
  }
  // One spelling of the bytes: what is hashed here is what the contract is given.
  if (blob.length === 0 || base64Encode(blob) !== expected.encryptedData) {
    throw new CustodyError('the encrypted policy is not plain base64');
  }
  if (typeof policy_json !== 'string') {
    throw new CustodyError('the answer carries no plaintext of the policy');
  }
  const keystoreKey =
    typeof keystore_public_key === 'string' && keystore_public_key.startsWith('ed25519:')
      ? base58Bytes(keystore_public_key.slice('ed25519:'.length))
      : null;
  if (!keystoreKey || keystoreKey.length !== 32) {
    throw new CustodyError("the keystore's key in the answer is not an `ed25519:<base58>` key");
  }
  if (
    typeof policy_statement_signature !== 'string' ||
    !/^[0-9a-f]{128}$/.test(policy_statement_signature)
  ) {
    throw new CustodyError(
      "the keystore's signature in the answer is not 64 bytes in lowercase hex",
    );
  }

  const subtle = globalThis.crypto.subtle;
  const key = await subtle.importKey('raw', keystoreKey as BufferSource, 'Ed25519', false, [
    'verify',
  ]);
  const statement = policyStatement(
    expected.keystoreDaoId,
    expected.walletPubkey,
    toHex(sha256(blob)),
    toHex(sha256(utf8(policy_json))),
  );
  const signed = await subtle.verify(
    'Ed25519',
    key,
    fromHex(policy_statement_signature, 64) as BufferSource,
    utf8(statement) as BufferSource,
  );
  if (!signed) {
    throw new CustodyError(
      `the keystore's signature does not state this plaintext for this ciphertext and the wallet ${expected.walletPubkey} under ${expected.keystoreDaoId}`,
    );
  }
  if (
    !(await isKeystoreApproved(expected, keystore_public_key as string, 'the policy is not used'))
  ) {
    throw new CustodyError(
      `${keystore_public_key} is not a keystore ${expected.keystoreDaoId} approved: the policy it states is not used`,
    );
  }
  return policy_json;
}
