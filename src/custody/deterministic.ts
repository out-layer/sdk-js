/**
 * A wallet contract at its deterministic address (NEP-616): `"0s"` + hex of
 * the last 20 bytes of keccak256 of its `StateInit`, which names the published
 * build by its code hash and holds the contract's first state,
 * `State::new(pair)`. The address commits to the build and that whole state:
 * the pair, signatures on, no extension. Held to custody-core's
 * vectors/deterministic.json.
 */

import { keccak_256 } from '@noble/hashes/sha3';
import { concat, fromHex, le, toHex } from './bytes.js';

/** The published two-key wallet contract, by its code hash, hex. */
export const WALLET_CONTRACT_CODE_HASH_HEX = '4b5158b0d1e911e86575ec7aa3cd07d5df23b5aa5572544aa981b5e154eb6771';

/** The two-key contract's default timeout (`State::new`), in seconds. */
const CONTRACT_DEFAULT_TIMEOUT_SECS = 3600n;

/** The Borsh of the two-key contract's `State::new(agent ‖ tee)`. */
export function stateBytes(agentPublicKey: string, teePublicKey: string): Uint8Array {
  return concat(
    Uint8Array.of(1), // signatures on
    le(0n, 4), // subwallet id
    fromHex(agentPublicKey, 32),
    fromHex(teePublicKey, 32),
    le(CONTRACT_DEFAULT_TIMEOUT_SECS, 4),
    le(0n, 8), // last_cleaned_at
    le(0n, 4), // old nonces: none
    le(0n, 4), // current nonces: none
    le(0n, 4), // extensions: none
  );
}

/** The Borsh of `StateInit::V1 { code: CodeHash(build), data: { "": state } }`. */
export function stateInitBytes(
  agentPublicKey: string,
  teePublicKey: string,
  codeHashHex: string = WALLET_CONTRACT_CODE_HASH_HEX,
): Uint8Array {
  const state = stateBytes(agentPublicKey, teePublicKey);
  return concat(Uint8Array.of(0, 0), fromHex(codeHashHex, 32), le(1n, 4), le(0n, 4), le(BigInt(state.length), 4), state);
}

/** The `0s` account of a fresh wallet contract of the pair `(agent, tee)`, keys in hex. */
export function deterministicAccount(
  agentPublicKey: string,
  teePublicKey: string,
  codeHashHex: string = WALLET_CONTRACT_CODE_HASH_HEX,
): string {
  return `0s${toHex(keccak_256(stateInitBytes(agentPublicKey, teePublicKey, codeHashHex)).slice(12))}`;
}
