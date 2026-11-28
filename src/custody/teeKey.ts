/**
 * The enclave's key of a wallet contract, held to the keystore's statement.
 *
 * The API carries the TEE's public key of the pair (E) from the keystore to
 * the agent and to the owner's page. An API that put a key of its own there
 * would hold both halves of every wallet contract set up meanwhile. So the
 * keystore states E in a text signed with its registration key — the key the
 * OutLayer keystore DAO approved — and E is used only once that signature
 * verifies and the DAO's `is_keystore_approved` answers `true` for the key.
 * The statement is built here from what the agent knows (its DAO, its owner,
 * its wallet), never taken from the answer.
 */

import type { Network } from '../http.js';
import { base58Bytes, base64Encode, fromHex, utf8 } from './bytes.js';
import { CustodyError } from './errors.js';

/** The first line of {@link teeKeyStatement}. */
export const TEE_KEY_STATEMENT_TAG = 'OUTLAYER_WALLET_CONTRACT_TEE_KEY/V1';

/** The keystore DAO of each network: the contract whose approved keystores sign the statement. */
export const KEYSTORE_DAO_IDS: Record<Network, string> = {
  mainnet: 'dao.outlayer.near',
  testnet: 'dao.outlayer.testnet',
};

/** The NEAR RPC the DAO is read through, by network. */
export const NEAR_RPC_URLS: Record<Network, string> = {
  mainnet: 'https://rpc.mainnet.fastnear.com',
  testnet: 'https://rpc.testnet.fastnear.com',
};

/**
 * What the keystore signs about the TEE's key `teePublicKey` (hex) of the
 * wallet `walletId` in the owner scope `scope`, as a keystore of the DAO
 * `dao`: one field per line, joined by `\n`, with no newline at the end.
 */
export function teeKeyStatement(
  dao: string,
  scope: string,
  walletId: string,
  teePublicKey: string,
): string {
  return [
    TEE_KEY_STATEMENT_TAG,
    `dao:${dao}`,
    `scope:${scope}`,
    `wallet:${walletId}`,
    `tee:${teePublicKey}`,
  ].join('\n');
}

/** What `GET /wallet/v1/contract/key` and the owner's setup view carry about the TEE's key. */
export interface TeeKeyAnswer {
  /** The TEE's Ed25519 public key, in hex. */
  tee_public_key: string;
  /** The owner scope the key is in: `owner:<account>:<generation>`. */
  scope: string;
  /** The keystore's registration key, `ed25519:<base58>`. */
  keystore_public_key: string;
  /** Its Ed25519 signature over {@link teeKeyStatement}, in hex. */
  tee_key_signature: string;
}

/** What {@link verifyTeeKey} holds an answer to. */
export interface TeeKeyExpectation {
  /** The wallet's owner account. */
  owner: string;
  walletId: string;
  /** The keystore DAO's account: `dao.outlayer.near` on mainnet. */
  keystoreDaoId: string;
  /** A NEAR RPC of the DAO's network. */
  rpcUrl: string;
  fetch?: typeof fetch;
}

/**
 * The TEE's public key of `answer`, in hex, once it is the one an approved
 * keystore of `expected.keystoreDaoId` stated for this owner and this wallet.
 * Throws a {@link CustodyError} naming what does not hold.
 */
export async function verifyTeeKey(answer: unknown, expected: TeeKeyExpectation): Promise<string> {
  const { tee_public_key, scope, keystore_public_key, tee_key_signature } = (answer ??
    {}) as Partial<Record<keyof TeeKeyAnswer, unknown>>;
  if (typeof tee_public_key !== 'string' || !/^[0-9a-f]{64}$/.test(tee_public_key)) {
    throw new CustodyError("the TEE's key in the answer is not 32 bytes in lowercase hex");
  }
  const generation =
    typeof scope === 'string' && scope.startsWith(`owner:${expected.owner}:`)
      ? scope.slice(`owner:${expected.owner}:`.length)
      : '';
  if (!/^[1-9][0-9]*$/.test(generation)) {
    throw new CustodyError(
      `the TEE's key is stated for the scope ${JSON.stringify(scope)}, not for an owner scope of ${expected.owner}`,
    );
  }
  const keystoreKey =
    typeof keystore_public_key === 'string' && keystore_public_key.startsWith('ed25519:')
      ? base58Bytes(keystore_public_key.slice('ed25519:'.length))
      : null;
  if (!keystoreKey || keystoreKey.length !== 32) {
    throw new CustodyError("the keystore's key in the answer is not an `ed25519:<base58>` key");
  }
  if (typeof tee_key_signature !== 'string' || !/^[0-9a-f]{128}$/.test(tee_key_signature)) {
    throw new CustodyError(
      "the keystore's signature in the answer is not 64 bytes in lowercase hex",
    );
  }

  const subtle = globalThis.crypto.subtle;
  const key = await subtle.importKey('raw', keystoreKey as BufferSource, 'Ed25519', false, [
    'verify',
  ]);
  const statement = teeKeyStatement(
    expected.keystoreDaoId,
    scope as string,
    expected.walletId,
    tee_public_key,
  );
  const signed = await subtle.verify(
    'Ed25519',
    key,
    fromHex(tee_key_signature, 64) as BufferSource,
    utf8(statement) as BufferSource,
  );
  if (!signed) {
    throw new CustodyError(
      `the keystore's signature does not state this TEE key for ${expected.owner}'s wallet ${expected.walletId} under ${expected.keystoreDaoId}`,
    );
  }

  if (!(await isKeystoreApproved(expected, keystore_public_key as string))) {
    throw new CustodyError(
      `${keystore_public_key} is not a keystore ${expected.keystoreDaoId} approved: the TEE's key it states is not used`,
    );
  }
  return tee_public_key;
}

/** `is_keystore_approved` of the DAO, read at the final block. */
async function isKeystoreApproved(
  expected: TeeKeyExpectation,
  publicKey: string,
): Promise<boolean> {
  const doFetch = expected.fetch ?? globalThis.fetch.bind(globalThis);
  let body: { result?: { result?: number[] }; error?: unknown };
  try {
    const response = await doFetch(expected.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'is_keystore_approved',
        method: 'query',
        params: {
          request_type: 'call_function',
          finality: 'final',
          account_id: expected.keystoreDaoId,
          method_name: 'is_keystore_approved',
          args_base64: base64Encode(utf8(JSON.stringify({ public_key: publicKey }))),
        },
      }),
    });
    body = await response.json();
  } catch (error) {
    throw new CustodyError(
      `${expected.keystoreDaoId} could not be read through the NEAR RPC (${error instanceof Error ? error.message : String(error)}): the TEE's key is not used`,
    );
  }
  const bytes = body.result?.result;
  if (body.error || !Array.isArray(bytes)) {
    throw new CustodyError(
      `${expected.keystoreDaoId} did not answer \`is_keystore_approved\`: the TEE's key is not used`,
    );
  }
  try {
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(bytes))) === true;
  } catch {
    return false;
  }
}
