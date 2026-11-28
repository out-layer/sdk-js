import { fromHex, toHex } from '../src/custody.js';
import { teeKeyStatement } from '../src/custody/teeKey.js';
import STATEMENT from './fixtures/custody/tee_key_statement_vector.json';

/** The keystore of the vector (a test-only key): the statement it signs for `tee`. */
export async function statedTeeKey(tee: string, owner: string, walletId: string, generation = 1) {
  const scope = `owner:${owner}:${generation}`;
  const pkcs8 = fromHex(`302e020100300506032b657004220420${STATEMENT.secret_seed}`, 48);
  const key = await globalThis.crypto.subtle.importKey(
    'pkcs8',
    pkcs8 as BufferSource,
    'Ed25519',
    false,
    ['sign'],
  );
  const statement = new TextEncoder().encode(teeKeyStatement(STATEMENT.dao, scope, walletId, tee));
  const signature = await globalThis.crypto.subtle.sign('Ed25519', key, statement);
  return {
    tee_public_key: tee,
    scope,
    keystore_public_key: STATEMENT.public_key,
    tee_key_signature: toHex(new Uint8Array(signature)),
  };
}

/** The NEAR RPC's answer to a view that returns `value`. */
export function daoAnswers(value: unknown): Response {
  const bytes = Array.from(new TextEncoder().encode(JSON.stringify(value)));
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 'x',
      result: { result: bytes, logs: [], block_height: 1 },
    }),
  );
}
