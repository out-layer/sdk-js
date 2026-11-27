/**
 * Setting up a wallet contract: the agent opens a setup, its owner finishes
 * it on the site and leaves the agent's key sealed to the setup's one-time
 * key, and the agent collects it.
 */

import { SEALED_FORMAT, SealOpenError, openWith } from '../seal.js';
import { base64Decode, toHex, utf8 } from './bytes.js';
import { CustodyError } from './errors.js';
import { WALLET_CONTRACT_CODE_HASH_HEX, deterministicAccount } from './deterministic.js';
import { AgentKey } from './keys.js';

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
    try {
      return await openWith(
        this.pair,
        sealed,
        utf8(`outlayer:wallet-contract:agent-key:${walletId}`),
      );
    } catch (error) {
      if (!(error instanceof SealOpenError)) throw error;
      throw new CustodyError(
        'the sealed agent key does not open: it was sealed to another key or for another wallet',
      );
    }
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
  /**
   * The wallet contract builds a `0s` account may run, by code hash in hex:
   * the published build by default. A build the keystore DAO approves later
   * is added here.
   */
  walletContractBuilds?: string[];
  fetch?: typeof fetch;
}

async function setupCall(
  options: SetupOptions,
  method: 'GET' | 'POST',
  body?: unknown,
  path = '/wallet/v1/contract/setup',
): Promise<Record<string, unknown>> {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const baseUrl = (options.baseUrl ?? 'https://api.outlayer.ai').replace(/\/+$/, '');
  const response = await doFetch(`${baseUrl}${path}`, {
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
    // In the fragment: the browser sends it to no server, so the token reaches
    // no log, proxy or link preview.
    url: `${appUrl}/wallet/custody#setup=${token}`,
    token,
    expiresAt: String(answer.expires_at),
    key,
  };
}

/**
 * What the owner left: the wallet contract's account and the agent's key,
 * with the TEE's public key of the pair for {@link WalletContract}. `null`
 * while the owner has not finished. Refuses a key that is not the one in the
 * contract's pair.
 *
 * `seed` is the agent's secret: store it where the agent keeps its secrets
 * and make the key again with `AgentKey.fromSeed(seed)`. The setup's one-time
 * key opens it once; after that only the owner can derive it again.
 */
export async function collectSetup(
  options: SetupOptions,
  key: SetupKey,
): Promise<{ account: string; key: AgentKey; seed: Uint8Array; teePublicKey: string } | null> {
  const answer = await setupCall(options, 'GET');
  if (answer.done !== true) return null;
  const seed = await key.open(String(answer.sealed_agent_key), String(answer.wallet_id));
  const agentKey = await AgentKey.fromSeed(seed);
  if (agentKey.publicKey !== answer.agent_public_key) {
    throw new CustodyError("the key the owner left is not the agent's key of the wallet contract");
  }
  const pair = await setupCall(options, 'GET', undefined, '/wallet/v1/contract/key');
  const account = String(answer.account_id);
  const teePublicKey = String(pair.tee_public_key);
  // A 0s account is named after its first state: it has to be the wallet
  // contract of this agent's key and this wallet's TEE key.
  const builds = options.walletContractBuilds ?? [WALLET_CONTRACT_CODE_HASH_HEX];
  if (!builds.every((build) => /^[0-9a-f]{64}$/.test(build))) {
    throw new CustodyError('`walletContractBuilds` are code hashes: 32 bytes in lowercase hex');
  }
  if (
    /^0s[0-9a-f]{40}$/.test(account) &&
    !builds.some((build) => account === deterministicAccount(agentKey.publicKey, teePublicKey, build))
  ) {
    throw new CustodyError(
      `${account} is not the wallet contract of the agent's key and this wallet's TEE key on the builds ${builds.join(', ')}`,
    );
  }
  return {
    account,
    key: agentKey,
    seed,
    teePublicKey,
  };
}
