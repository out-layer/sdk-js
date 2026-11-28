/**
 * Reads of the NEAR chain through an RPC the agent chose (never the API): the
 * keystore DAO's approval, an access key of the owner, and a wallet contract's
 * pair of keys. All at the final block.
 */

import { base64Encode, utf8 } from './bytes.js';
import { CustodyError } from './errors.js';

/** Where the chain is read from. */
export interface ChainReader {
  rpcUrl: string;
  fetch?: typeof fetch;
}

type QueryAnswer = { result?: Record<string, unknown> & { error?: unknown }; error?: unknown };

/** One `query` of the RPC; `null` when the RPC answers that what was asked is not there. */
async function query(
  reader: ChainReader,
  params: Record<string, unknown>,
  what: string,
): Promise<Record<string, unknown> | null> {
  const doFetch = reader.fetch ?? globalThis.fetch.bind(globalThis);
  let body: QueryAnswer;
  try {
    const response = await doFetch(reader.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: what,
        method: 'query',
        params: { finality: 'final', ...params },
      }),
    });
    body = (await response.json()) as QueryAnswer;
  } catch (error) {
    throw new CustodyError(
      `${what} could not be read through the NEAR RPC (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  // A missing account, key or contract is an answer; anything else is a failure to read.
  const said = JSON.stringify(body?.error ?? body?.result?.error ?? '');
  if (body?.error || body?.result?.error) {
    if (
      /UNKNOWN_ACCOUNT|UNKNOWN_ACCESS_KEY|does not exist|CodeDoesNotExist|MethodNotFound|NO_CONTRACT_CODE|MethodResolveError/.test(
        said,
      )
    ) {
      return null;
    }
    throw new CustodyError(
      `${what} could not be read through the NEAR RPC (${said.slice(0, 200)})`,
    );
  }
  if (!body?.result) throw new CustodyError(`${what}: the NEAR RPC answered nothing`);
  return body.result;
}

/** What the view `method` of `account` returns for `args`, as JSON; `null` when there is no such view. */
export async function viewFunction(
  reader: ChainReader,
  account: string,
  method: string,
  args: unknown,
): Promise<unknown> {
  const what = `\`${method}\` of ${account}`;
  const result = await query(
    reader,
    {
      request_type: 'call_function',
      account_id: account,
      method_name: method,
      args_base64: base64Encode(utf8(JSON.stringify(args))),
    },
    what,
  );
  if (result === null) return null;
  const bytes = result.result;
  if (!Array.isArray(bytes)) throw new CustodyError(`${what}: the NEAR RPC answered no result`);
  try {
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(bytes as number[])));
  } catch {
    throw new CustodyError(`${what} did not return JSON`);
  }
}

/** Whether `publicKey` (`ed25519:<base58>`) is a full-access key of `account`. */
export async function isFullAccessKey(
  reader: ChainReader,
  account: string,
  publicKey: string,
): Promise<boolean> {
  const key = await query(
    reader,
    { request_type: 'view_access_key', account_id: account, public_key: publicKey },
    `the access key ${publicKey} of ${account}`,
  );
  return key?.permission === 'FullAccess';
}

/**
 * The pair a wallet contract answers (`w_public_key`: the agent's key and the
 * TEE's, 128 characters of hex), or `null` when the account runs no wallet
 * contract.
 */
export async function walletContractPair(
  reader: ChainReader,
  account: string,
): Promise<string | null> {
  const pair = await viewFunction(reader, account, 'w_public_key', {});
  return typeof pair === 'string' ? pair : null;
}
