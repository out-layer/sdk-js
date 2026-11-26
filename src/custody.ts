/**
 * Agent On-chain custody: an agent whose main balance lies in a wallet
 * contract on NEAR.
 *
 * The wallet contract executes a request only under two signatures: the
 * agent's and one from OutLayer's enclave. The agent holds its own Ed25519 key
 * and uses it for two things, in two byte formats that cannot stand in for
 * each other:
 *
 * - every HTTPS request to the operation routes is signed with it (there is no
 *   API key on those routes);
 * - its half of each request to the wallet contract.
 *
 * An operation goes one way. The agent asks for it; the enclave judges it by
 * the owner's policy and, if it passes, returns the wallet contract's request
 * with its own half. The agent checks that the request is the operation it
 * asked for, signs its half LAST, and relays. {@link WalletContract.run} does
 * all of it.
 *
 * What is under two signatures is what lies in the wallet contract. The
 * agent's OutLayer wallet (`OutlayerClient`) is a separate account whose key
 * is in the enclave; it pays the gas of relaying and is where the agent keeps
 * what it works with.
 */

import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha2';
import { sha3_256 } from '@noble/hashes/sha3';

// ── Bytes ────────────────────────────────────────────────────────────────────

const utf8 = new TextEncoder();

const AGENT_PREFIX = utf8.encode('NEAR_WALLET_TWO_KEY/V1/AGENT');
const TEE_PREFIX = utf8.encode('NEAR_WALLET_TWO_KEY/V1/TEE');
const REQUEST_DOMAIN = utf8.encode('NEAR_WALLET_CONTRACT/V1');
const AGENT_REQUEST_DOMAIN = utf8.encode('OUTLAYER_AGENT_REQUEST/V1');

/** How long the wallet contract accepts a request after `created_at`, in seconds. */
export const REQUEST_TIMEOUT_SECS = 3600;

/** The path every operation is asked for at, and the root of the others. */
export const OPERATION_PATH = '/wallet/contract/v1/operations';

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Lowercase hex of `bytes`. */
export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** `length` bytes from strict lowercase hex; throws on any other text. */
export function fromHex(text: string, length: number): Uint8Array {
  if (text.length !== 2 * length || !/^[0-9a-f]*$/.test(text)) {
    throw new CustodyError(`expected ${length} bytes in lowercase hex`);
  }
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = Number.parseInt(text.slice(2 * i, 2 * i + 2), 16);
  return out;
}

function base64Decode(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

function base64Encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function unsigned(text: string, bits: 32 | 64 | 128, name: string): bigint {
  if (!/^[0-9]+$/.test(text)) throw new CustodyError(`\`${name}\` is not a decimal number`);
  const value = BigInt(text);
  if (value >= 1n << BigInt(bits)) throw new CustodyError(`\`${name}\` is out of range`);
  return value;
}

function le(value: bigint, bytes: number): Uint8Array {
  const out = new Uint8Array(bytes);
  let rest = value;
  for (let i = 0; i < bytes; i++) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
}

function borshBytes(bytes: Uint8Array): Uint8Array {
  return concat(le(BigInt(bytes.length), 4), bytes);
}

function borshString(text: string): Uint8Array {
  return borshBytes(utf8.encode(text));
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
        action.args === base64Encode(base64Decode(op.args_base64))
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

// ── The agent's key ──────────────────────────────────────────────────────────

/** PKCS#8 wrapping of a 32-byte Ed25519 seed. */
const PKCS8_ED25519 = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

/** The parts of a signed request, as the headers carry them. */
export interface SignedRequestHeaders {
  'x-agent-account': string;
  'x-agent-timestamp': string;
  'x-agent-nonce': string;
  'x-agent-signature': string;
}

/**
 * The agent's Ed25519 key of a wallet contract. The private key stays in this
 * object; nothing here sends it anywhere.
 */
export class AgentKey {
  private constructor(
    private readonly key: CryptoKey,
    /** The public key, 32 bytes in hex: the first half of the contract's pair. */
    readonly publicKey: string,
  ) {}

  /** From the key's 32-byte seed. */
  static async fromSeed(seed: Uint8Array): Promise<AgentKey> {
    if (seed.length !== 32) throw new CustodyError('an Ed25519 seed is 32 bytes');
    const subtle = globalThis.crypto.subtle;
    const pair = await subtle.importKey(
      'pkcs8',
      concat(PKCS8_ED25519, seed) as BufferSource,
      'Ed25519',
      true,
      ['sign'],
    );
    const jwk = await subtle.exportKey('jwk', pair);
    const publicKey = base64Decode((jwk.x as string).replace(/-/g, '+').replace(/_/g, '/'));
    const key = await subtle.importKey(
      'pkcs8',
      concat(PKCS8_ED25519, seed) as BufferSource,
      'Ed25519',
      false,
      ['sign'],
    );
    return new AgentKey(key, toHex(publicKey));
  }

  private async sign(bytes: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(
      await globalThis.crypto.subtle.sign('Ed25519', this.key, bytes as BufferSource),
    );
  }

  /**
   * The agent's half over `msg`, 64 bytes. Call it only for a request
   * {@link messageIsFor} accepted: this signature is what lets the wallet
   * contract execute it.
   */
  async signHalf(msg: RequestMessage): Promise<Uint8Array> {
    return this.sign(concat(AGENT_PREFIX, requestHash(msg)));
  }

  /** The headers of an HTTPS request to the operation routes. */
  async signRequest(request: {
    account: string;
    method: string;
    path: string;
    body: string;
    /** Seconds since the Unix epoch. */
    timestamp: number;
    /** 16 bytes; a request is taken once. */
    nonce: Uint8Array;
  }): Promise<SignedRequestHeaders> {
    const signature = await this.sign(agentRequestBytes(request));
    return {
      'x-agent-account': request.account,
      'x-agent-timestamp': String(request.timestamp),
      'x-agent-nonce': toHex(request.nonce),
      'x-agent-signature': toHex(signature),
    };
  }
}

/**
 * What the owner's wallet is asked to sign (NEP-413) for the agent's key of
 * the wallet `walletId`. The signature IS the agent's key: ask for it only on
 * the owner's own setup or recovery page.
 */
export function agentKeyRequest(
  owner: string,
  walletId: string,
): {
  message: string;
  recipient: string;
  nonce: Uint8Array;
} {
  return {
    message: `This signature is the key of your OutLayer agent. Sign it only on app.outlayer.ai, when you set up or recover an agent.\nOwner: ${owner}\nWallet: ${walletId}`,
    recipient: 'outlayer-agent-key',
    nonce: concat(utf8.encode('outlayer/agent-key/v1/nonce'), new Uint8Array(5)),
  };
}

/**
 * The 32-byte seed of the agent's key from the owner's signature (64 bytes)
 * over {@link agentKeyRequest}. The owner's wallet makes the same signature
 * again on request, so the key needs no backup.
 */
export function agentKeySeed(signature: Uint8Array, owner: string, walletId: string): Uint8Array {
  if (signature.length !== 64) throw new CustodyError('an Ed25519 signature is 64 bytes');
  return hmac(
    sha256,
    utf8.encode('outlayer/agent-key/v1'),
    concat(signature, utf8.encode(agentKeyRequest(owner, walletId).message)),
  );
}

/** The bytes the agent's key signs for an HTTPS request. */
export function agentRequestBytes(request: {
  account: string;
  method: string;
  path: string;
  body: string;
  timestamp: number;
  nonce: Uint8Array;
}): Uint8Array {
  if (request.nonce.length !== 16) throw new CustodyError('a request nonce is 16 bytes');
  return concat(
    AGENT_REQUEST_DOMAIN,
    borshString(request.account),
    borshString(request.method),
    borshString(request.path),
    sha256(utf8.encode(request.body)),
    le(BigInt(request.timestamp), 8),
    request.nonce,
  );
}

/** Whether `half` is the TEE's signature over `msg` by `teePublicKey` (hex). */
export async function verifyTeeHalf(
  msg: RequestMessage,
  half: Uint8Array,
  teePublicKey: string,
): Promise<boolean> {
  const subtle = globalThis.crypto.subtle;
  const key = await subtle.importKey(
    'raw',
    fromHex(teePublicKey, 32) as BufferSource,
    'Ed25519',
    false,
    ['verify'],
  );
  return subtle.verify(
    'Ed25519',
    key,
    half as BufferSource,
    concat(TEE_PREFIX, requestHash(msg)) as BufferSource,
  );
}

// ── Setting up ───────────────────────────────────────────────────────────────

const SEALED_FORMAT = 0x02;
const SEAL_KDF_INFO = utf8.encode('outlayer:encryption-keys:v1:seal:kdf');

/**
 * The agent's one-time key of a setup. The owner's page seals the agent's key
 * to it; only this object opens what was sealed.
 */
export class SetupKey {
  private constructor(
    private readonly pair: CryptoKeyPair,
    /** The X25519 public key, 32 bytes in hex: what a setup is opened with. */
    readonly publicKey: string,
  ) {}

  static async generate(): Promise<SetupKey> {
    const subtle = globalThis.crypto.subtle;
    const pair = (await subtle.generateKey({ name: 'X25519' }, false, [
      'deriveBits',
    ])) as CryptoKeyPair;
    return new SetupKey(pair, toHex(new Uint8Array(await subtle.exportKey('raw', pair.publicKey))));
  }

  /**
   * The 32-byte seed of the agent's key, from what the owner's page sealed
   * for the wallet `walletId`.
   */
  async open(sealedBase64: string, walletId: string): Promise<Uint8Array> {
    const sealed = base64Decode(sealedBase64);
    if (sealed[0] !== SEALED_FORMAT || sealed.length !== 1 + 32 + 32 + 16) {
      throw new CustodyError('this is not a sealed agent key');
    }
    const subtle = globalThis.crypto.subtle;
    const ephemeralPublic = sealed.slice(1, 33);
    const their = await subtle.importKey(
      'raw',
      ephemeralPublic as BufferSource,
      { name: 'X25519' },
      false,
      [],
    );
    const shared = await subtle.deriveBits(
      { name: 'X25519', public: their },
      this.pair.privateKey,
      256,
    );
    const hkdf = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
    const key = await subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new Uint8Array(0),
        info: concat(SEAL_KDF_INFO, ephemeralPublic, fromHex(this.publicKey, 32)) as BufferSource,
      },
      hkdf,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt'],
    );
    let seed: ArrayBuffer;
    try {
      seed = await subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: new Uint8Array(12),
          additionalData: utf8.encode(
            `outlayer:wallet-contract:agent-key:${walletId}`,
          ) as BufferSource,
        },
        key,
        sealed.slice(33) as BufferSource,
      );
    } catch {
      throw new CustodyError(
        'the sealed agent key does not open: it was sealed to another key or for another wallet',
      );
    }
    return new Uint8Array(seed);
  }
}

/** A setup the agent opened: what it hands to its owner, and how it collects the result. */
export interface OpenedSetup {
  /** The page the owner opens. */
  url: string;
  token: string;
  expiresAt: string;
  key: SetupKey;
}

interface SetupOptions {
  /** The wallet's API key (`wk_…`). */
  apiKey: string;
  /** `https://api.outlayer.ai` by default. */
  baseUrl?: string;
  /** `https://app.outlayer.ai` by default. */
  appUrl?: string;
  fetch?: typeof fetch;
}

async function setupCall(
  options: SetupOptions,
  method: 'GET' | 'POST',
  body?: unknown,
): Promise<Record<string, unknown>> {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const baseUrl = (options.baseUrl ?? 'https://api.outlayer.ai').replace(/\/+$/, '');
  const response = await doFetch(`${baseUrl}/wallet/v1/contract/setup`, {
    method,
    headers: {
      authorization: `Bearer ${options.apiKey}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const answer = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new CustodyError(
      typeof answer.message === 'string' ? answer.message : response.statusText,
      typeof answer.error === 'string' ? answer.error : undefined,
      response.status,
    );
  }
  return answer;
}

/**
 * Open the setup of a wallet contract for the wallet of `apiKey`. Give `url`
 * to the wallet's owner; keep `key` in memory until {@link collectSetup}
 * returns the agent's key. Opening again replaces the setup.
 */
export async function openSetup(options: SetupOptions): Promise<OpenedSetup> {
  const key = await SetupKey.generate();
  const answer = await setupCall(options, 'POST', { recipient_public_key: key.publicKey });
  const token = String(answer.token);
  const appUrl = (options.appUrl ?? 'https://app.outlayer.ai').replace(/\/+$/, '');
  return {
    url: `${appUrl}/wallet/custody?setup=${token}`,
    token,
    expiresAt: String(answer.expires_at),
    key,
  };
}

/**
 * What the owner left: the wallet contract's account and the agent's key.
 * `null` while the owner has not finished. Refuses a key that is not the one
 * in the contract's pair.
 *
 * `seed` is the agent's secret: store it where the agent keeps its secrets
 * and make the key again with `AgentKey.fromSeed(seed)`. The setup's one-time
 * key opens it once; after that only the owner can derive it again.
 */
export async function collectSetup(
  options: SetupOptions,
  key: SetupKey,
): Promise<{ account: string; key: AgentKey; seed: Uint8Array } | null> {
  const answer = await setupCall(options, 'GET');
  if (answer.done !== true) return null;
  const seed = await key.open(String(answer.sealed_agent_key), String(answer.wallet_id));
  const agentKey = await AgentKey.fromSeed(seed);
  if (agentKey.publicKey !== answer.agent_public_key) {
    throw new CustodyError("the key the owner left is not the agent's key of the wallet contract");
  }
  return { account: String(answer.account_id), key: agentKey, seed };
}

// ── The API ──────────────────────────────────────────────────────────────────

/** Where an operation stands. */
export interface OperationState {
  /** The agent's own id of the operation. */
  id: string;
  status: 'pending_approval' | 'awaiting_signature' | 'relayed' | 'success' | 'failed' | 'closed';
  request_hash: string;
  /** `pending_approval`: the vote the approvers cast on. */
  approval_id?: string;
  /** `awaiting_signature`: the wallet contract's request. */
  message?: RequestMessage;
  /** `awaiting_signature`: the TEE's half, in hex. */
  tee_half?: string;
  tx_hash?: string;
  /** `success`, `failed`: what the chain answered. */
  result?: unknown;
  /** `closed`: why. */
  reason?: string;
  /** A swap or a withdrawal to another chain: what 1Click quoted. */
  quote?: { amount_in: string; amount_out: string; min_amount_out: string; deadline?: string };
  /** A swap or a withdrawal to another chain, once sent: 1Click's status of the route. */
  route_status?: string;
}

/** A refusal of the API or of this client's own checks. */
export class CustodyError extends Error {
  constructor(
    message: string,
    /** The API's error code, when the API refused. */
    readonly code?: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'CustodyError';
  }
}

export interface WalletContractOptions {
  /** The wallet contract's account: who the agent is. */
  account: string;
  key: AgentKey;
  /** `https://api.outlayer.ai` by default. */
  baseUrl?: string;
  /**
   * The TEE's public key in the contract's pair, in hex. When given, the
   * TEE's half is verified before the agent signs.
   */
  teePublicKey?: string;
  fetch?: typeof fetch;
}

/**
 * The operations of one wallet contract, each request signed by the agent's
 * key.
 */
export class WalletContract {
  private readonly baseUrl: string;
  private readonly fetch: typeof fetch;

  constructor(private readonly options: WalletContractOptions) {
    this.baseUrl = (options.baseUrl ?? 'https://api.outlayer.ai').replace(/\/+$/, '');
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private async send(method: 'GET' | 'POST', path: string, body: string): Promise<OperationState> {
    const headers = await this.options.key.signRequest({
      account: this.options.account,
      method,
      path,
      body,
      timestamp: Math.floor(Date.now() / 1000),
      nonce: globalThis.crypto.getRandomValues(new Uint8Array(16)),
    });
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { ...headers, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
      ...(method === 'POST' ? { body } : {}),
    });
    const text = await response.text();
    let answer: Record<string, unknown> = {};
    try {
      answer = JSON.parse(text);
    } catch {
      // not JSON: reported below as it came
    }
    if (!response.ok) {
      throw new CustodyError(
        typeof answer.message === 'string' ? answer.message : text || response.statusText,
        typeof answer.error === 'string' ? answer.error : undefined,
        response.status,
      );
    }
    return answer as unknown as OperationState;
  }

  /**
   * Ask for an operation under `id`. Asking again under the same id continues
   * the same operation: after its approvers voted, this is how it goes on.
   */
  ask(id: string, op: Operation): Promise<OperationState> {
    return this.send('POST', OPERATION_PATH, JSON.stringify({ id, op }));
  }

  /** Where the operation `id` stands. */
  get(id: string): Promise<OperationState> {
    return this.send('GET', `${OPERATION_PATH}/${id}`, '');
  }

  /**
   * Sign the agent's half of a prepared operation and send it. Refuses a
   * request that is not the operation `op`, is not this wallet contract's, or
   * (with `teePublicKey`) does not carry the TEE's half.
   */
  async relay(state: OperationState, op: Operation): Promise<OperationState> {
    const msg = state.message;
    if (state.status !== 'awaiting_signature' || !msg || !state.tee_half) {
      throw new CustodyError(
        `the operation \`${state.id}\` is \`${state.status}\`: there is nothing to sign`,
      );
    }
    if (!messageIsFor(msg, op, this.options.account)) {
      throw new CustodyError(
        `the request returned for \`${state.id}\` is not the operation that was asked for; it was not signed`,
      );
    }
    if (
      this.options.teePublicKey &&
      !(await verifyTeeHalf(msg, fromHex(state.tee_half, 64), this.options.teePublicKey))
    ) {
      throw new CustodyError(
        `the TEE's half returned for \`${state.id}\` is not valid; nothing was signed`,
      );
    }
    const half = await this.options.key.signHalf(msg);
    return this.send(
      'POST',
      `${OPERATION_PATH}/${state.id}/relay`,
      JSON.stringify({ agent_half: toHex(half) }),
    );
  }

  /**
   * Ask for `op` under `id` and, when it is prepared, sign and relay it.
   * Returns where the operation stands: `pending_approval` when it waits for
   * approvers (call again with the same id after they voted), otherwise the
   * outcome.
   */
  async run(id: string, op: Operation): Promise<OperationState> {
    const state = await this.ask(id, op);
    return state.status === 'awaiting_signature' ? this.relay(state, op) : state;
  }
}
