/**
 * The wallet contract's request and the operations it is made for: the
 * request's encoding and hash, and the check that a request is one operation
 * and nothing else.
 */

import { sha3_256 } from '@noble/hashes/sha3';
import { base64Decode, borshBytes, borshString, concat, equalBytes, le, utf8 } from './bytes.js';
import { CustodyError } from './errors.js';

const REQUEST_DOMAIN = utf8('NEAR_WALLET_CONTRACT/V1');

/** How long the wallet contract accepts a request after `created_at`, in seconds. */
export const REQUEST_TIMEOUT_SECS = 600;

function unsigned(text: string, bits: 32 | 64 | 128, name: string): bigint {
  if (!/^[0-9]+$/.test(text)) throw new CustodyError(`\`${name}\` is not a decimal number`);
  const value = BigInt(text);
  if (value >= 1n << BigInt(bits)) throw new CustodyError(`\`${name}\` is out of range`);
  return value;
}

// ── The wallet contract's request ────────────────────────────────────────────

/** One function call, with its exact gas. */
export interface FunctionCallAction {
  action: 'function_call';
  function_name: string;
  /** Base64. */
  args: string;
  /** yoctoNEAR, a decimal string. */
  deposit: string;
  /** A decimal string. */
  gas: string;
}

/** One transfer of NEAR. */
export interface TransferAction {
  action: 'transfer';
  /** yoctoNEAR, a decimal string. */
  amount: string;
}

/**
 * A request to a wallet contract, as the API carries it: one promise to
 * another account, with one action. It has no other form: no wallet
 * operation, no second promise.
 */
export interface RequestMessage {
  /** `mainnet` or `testnet`. */
  chain_id: string;
  /** The wallet contract's account. */
  signer_id: string;
  nonce: number;
  /** Nanoseconds since the Unix epoch, a decimal string. */
  created_at_ns: string;
  promise: {
    receiver_id: string;
    action: FunctionCallAction | TransferAction;
  };
}

/** The wallet contract's Borsh encoding of `msg`. */
export function encodeRequestMessage(msg: RequestMessage): Uint8Array {
  if (!Number.isInteger(msg.nonce) || msg.nonce < 0 || msg.nonce > 0xffffffff) {
    throw new CustodyError('`nonce` is not a 32-bit number');
  }
  const action = msg.promise.action;
  const encodedAction =
    action.action === 'function_call'
      ? concat(
          Uint8Array.of(2),
          borshString(action.function_name),
          borshBytes(base64Decode(action.args)),
          le(unsigned(action.deposit, 128, 'deposit'), 16),
          le(unsigned(action.gas, 64, 'gas'), 8),
          le(0n, 8), // gas_weight: no share of the unused gas
        )
      : concat(Uint8Array.of(3), le(unsigned(action.amount, 128, 'amount'), 16));
  return concat(
    Uint8Array.of(0), // pay_for_gas
    borshString(msg.chain_id),
    borshString(msg.signer_id),
    le(BigInt(msg.nonce), 4),
    le(unsigned(msg.created_at_ns, 64, 'created_at_ns'), 8),
    le(BigInt(REQUEST_TIMEOUT_SECS), 4),
    le(0n, 4), // no wallet operation
    le(1n, 4), // one promise
    borshString(msg.promise.receiver_id),
    Uint8Array.of(0), // no refund_to
    le(1n, 4), // one action
    encodedAction,
  );
}

/** The request's canonical hash: what the two halves are signed over. */
export function requestHash(msg: RequestMessage): Uint8Array {
  return sha3_256(concat(REQUEST_DOMAIN, encodeRequestMessage(msg)));
}

// ── Operations ───────────────────────────────────────────────────────────────

/**
 * What a wallet contract does. The fields are the wallet API's own: amounts
 * are decimal strings in the token's smallest unit.
 */
export type Operation =
  | { kind: 'transfer'; to: string; amount: string }
  | { kind: 'call'; to: string; method: string; args_base64: string; gas: string; deposit: string }
  | { kind: 'withdraw'; to: string; amount: string; token: string }
  | { kind: 'intents_transfer'; to: string; amount: string; token: string }
  | { kind: 'swap'; token_in: string; amount_in: string; token_out: string; min_out: string }
  | { kind: 'cross_chain_withdraw'; to: string; amount: string; token: string; chain: string };

const INTENTS_CONTRACT = 'intents.near';

/** The fields of an operation that are numbers written as decimal strings. */
const DECIMAL_FIELDS = new Set(['amount', 'amount_in', 'min_out', 'gas', 'deposit']);

/**
 * Throws unless every number of `op` is written the one way: decimal, no
 * sign, no leading zero. A number in another spelling (`05`, `+5`) is
 * prepared and counted by the API and then fails {@link messageIsFor}.
 */
export function checkDecimalFields(op: Operation): void {
  for (const [field, value] of Object.entries(op)) {
    if (DECIMAL_FIELDS.has(field) && !/^(0|[1-9][0-9]*)$/.test(value)) {
      throw new CustodyError(`\`${field}\` is a decimal number with no sign and no leading zero`);
    }
  }
}

function sameJson(args: string, expected: Record<string, string>): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(base64Decode(args)));
  } catch {
    return false;
  }
  if (typeof parsed !== 'object' || parsed === null) return false;
  const keys = Object.keys(parsed);
  return (
    keys.length === Object.keys(expected).length &&
    keys.every((key) => (parsed as Record<string, unknown>)[key] === expected[key])
  );
}

/**
 * Whether the base64 texts `args` and `expected` carry the same bytes: the
 * bytes are what the request's hash covers, whatever the spelling. `args`
 * that is not base64 is `false`; `expected` that is not base64 throws.
 */
function sameBytes(args: string, expected: string): boolean {
  const wanted = base64Decode(expected);
  let got: Uint8Array;
  try {
    got = base64Decode(args);
  } catch {
    return false;
  }
  return equalBytes(got, wanted);
}

function isCall(
  action: FunctionCallAction | TransferAction,
  name: string,
  deposit: string,
): action is FunctionCallAction {
  return (
    action.action === 'function_call' && action.function_name === name && action.deposit === deposit
  );
}

/**
 * Whether `msg` is the request for `op` from the wallet contract `account`,
 * and nothing else. The agent signs its half only when this holds.
 *
 * For a swap and a withdrawal to another chain the input goes to a 1Click
 * deposit address, which only the API knows: the token and the amount are
 * checked, and the address is taken as given. What 1Click then does with the
 * input is in the operation's `quote`.
 */
export function messageIsFor(msg: RequestMessage, op: Operation, account: string): boolean {
  if (msg.signer_id !== account || msg.promise.receiver_id === account) return false;
  const { receiver_id, action } = msg.promise;
  switch (op.kind) {
    case 'transfer':
      return receiver_id === op.to && action.action === 'transfer' && action.amount === op.amount;
    case 'call':
      return (
        receiver_id === op.to &&
        isCall(action, op.method, op.deposit) &&
        action.gas === op.gas &&
        sameBytes(action.args, op.args_base64)
      );
    case 'withdraw':
      return (
        receiver_id === INTENTS_CONTRACT &&
        isCall(action, 'ft_withdraw', '1') &&
        op.token.startsWith('nep141:') &&
        sameJson(action.args, {
          token: op.token.slice('nep141:'.length),
          receiver_id: op.to,
          amount: op.amount,
        })
      );
    case 'intents_transfer':
      return (
        receiver_id === INTENTS_CONTRACT &&
        isCall(action, 'mt_transfer', '1') &&
        sameJson(action.args, { receiver_id: op.to, token_id: op.token, amount: op.amount })
      );
    case 'swap':
    case 'cross_chain_withdraw': {
      if (receiver_id !== INTENTS_CONTRACT || !isCall(action, 'mt_transfer', '1')) return false;
      const [token, amount] =
        op.kind === 'swap' ? [op.token_in, op.amount_in] : [op.token, op.amount];
      let depositAddress: unknown;
      try {
        depositAddress = JSON.parse(
          new TextDecoder().decode(base64Decode(action.args)),
        ).receiver_id;
      } catch {
        return false;
      }
      return (
        typeof depositAddress === 'string' &&
        depositAddress !== account &&
        sameJson(action.args, { receiver_id: depositAddress, token_id: token, amount })
      );
    }
  }
}
