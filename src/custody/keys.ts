/**
 * The agent's Ed25519 key of a wallet contract: where it comes from, the two
 * byte formats it signs, and the check of the TEE's half.
 */

import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha2';
import { base64Decode, borshString, concat, fromHex, le, toHex, utf8 } from './bytes.js';
import { CustodyError } from './errors.js';
import { type RequestMessage, requestHash } from './message.js';

/** What each half of a request to the wallet contract is signed under, by its role. */
const AGENT_PREFIX = utf8('NEAR_WALLET_TWO_KEY/V1/AGENT');
const TEE_PREFIX = utf8('NEAR_WALLET_TWO_KEY/V1/TEE');
/** What an HTTPS request to the operation routes is signed under. */
const AGENT_REQUEST_DOMAIN = utf8('OUTLAYER_AGENT_REQUEST/V1');

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
    nonce: concat(utf8('outlayer/agent-key/v1/nonce'), new Uint8Array(5)),
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
    utf8('outlayer/agent-key/v1'),
    concat(signature, utf8(agentKeyRequest(owner, walletId).message)),
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
    sha256(utf8(request.body)),
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
