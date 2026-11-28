/**
 * Setting up a wallet contract: the agent opens a setup, its owner finishes
 * it on the site and leaves the owner's signature the agent's key comes from,
 * sealed to the setup's one-time key, and the agent collects it.
 *
 * The API carries the sealed signature and could be anyone's: whoever knows
 * the one-time public key can seal to it. So the agent takes nothing on the
 * API's word. It verifies the owner's NEP-413 signature over the message it
 * builds itself, reads through its own NEAR RPC that the key that made it is
 * a full-access key of the owner, derives its key from the signature, and
 * takes the account only when it is one this owner's setup can make (the `0s`
 * address of the agent's key and the TEE's key the keystore stated, the
 * owner's account, or an account under it) and the chain shows it holds that
 * pair.
 */

import { NETWORK_BASE_URLS, type Network } from '../http.js';
import { SealOpenError, openWith } from '../seal.js';
import { base58Bytes, base58Encode, base64Decode, toHex, utf8 } from './bytes.js';
import { WALLET_CONTRACT_CODE_HASH_HEX, deterministicAccount } from './deterministic.js';
import { CustodyError } from './errors.js';
import { AgentKey, agentKeyRequest, agentKeySeed } from './keys.js';
import { verifyNep413 } from './nep413.js';
import { isFullAccessKey, walletContractPair } from './rpc.js';
import { KEYSTORE_DAO_IDS, NEAR_RPC_URLS, verifyTeeKey } from './teeKey.js';

/**
 * The first byte of a sealed agent key: the owner's signature and its key.
 * Not the byte of a component's sealed input, so neither opens as the other;
 * a seal of anything else (a seed) is refused.
 */
export const AGENT_KEY_SEALED_FORMAT = 0x03;

/** What a setup's sealed agent key holds: the owner's signature and the key that made it. */
export interface OwnerSignature {
  /** The owner's NEP-413 signature of the agent key's message, 64 bytes. */
  signature: Uint8Array;
  /** The Ed25519 public key that made it, `ed25519:<base58>`. */
  publicKey: string;
}

/**
 * The agent's one-time key of a setup. The owner's page seals the owner's
 * signature to it; only this object opens what was sealed.
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
   * The owner's signature and its public key, from what the owner's page
   * sealed for the wallet `walletId`. Opening checks nothing of the
   * signature: {@link collectSetup} does.
   */
  async open(sealedBase64: string, walletId: string): Promise<OwnerSignature> {
    const sealed = base64Decode(sealedBase64);
    if (sealed[0] !== AGENT_KEY_SEALED_FORMAT || sealed.length !== 1 + 32 + 64 + 32 + 16) {
      throw new CustodyError(
        "this is not a sealed owner's signature: an owner's page of this version seals the signature and its key",
      );
    }
    let opened: Uint8Array;
    try {
      opened = await openWith(
        this.pair,
        sealed,
        utf8(`outlayer:wallet-contract:agent-key:${walletId}`),
        AGENT_KEY_SEALED_FORMAT,
      );
    } catch (error) {
      if (!(error instanceof SealOpenError)) throw error;
      throw new CustodyError(
        'the sealed agent key does not open: it was sealed to another key or for another wallet',
      );
    }
    return {
      signature: opened.slice(0, 64),
      publicKey: `ed25519:${base58Encode(opened.slice(64, 96))}`,
    };
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
  /** `mainnet` by default: the API, the keystore DAO and the RPC below follow it. */
  network?: Network;
  /** The network's API (`https://api.outlayer.ai` on mainnet) by default. */
  baseUrl?: string;
  /** `https://app.outlayer.ai` by default. */
  appUrl?: string;
  /**
   * The wallet contract builds a `0s` account may run, by code hash in hex:
   * the published build by default. A build the keystore DAO approves later
   * is added here.
   */
  walletContractBuilds?: string[];
  /**
   * The keystore DAO whose approved keystores state the TEE's key:
   * `dao.outlayer.near` on mainnet, `dao.outlayer.testnet` on testnet.
   */
  keystoreDaoId?: string;
  /** A NEAR RPC of the network, the DAO is read through: FastNEAR's by default. */
  rpcUrl?: string;
  fetch?: typeof fetch;
}

/** What {@link collectSetup} takes beside the setup's options. */
interface CollectOptions extends SetupOptions {
  /**
   * The wallet's owner account, as the agent knows it from its operator or
   * its configuration, never from an API answer (`exit_owner` and every other
   * owner name the API returns are no source for it). The owner's signature,
   * the TEE's key and the account are taken only for this owner.
   */
  owner: string;
  /**
   * The agent's OutLayer wallet id, when the agent recorded it: the setup
   * must be of this wallet. Without it the setup's own id is used; the
   * owner's signature names the wallet, so a setup of another one makes a key
   * no wallet contract of this wallet holds, and is refused.
   */
  walletId?: string;
}

async function setupCall(
  options: SetupOptions,
  method: 'GET' | 'POST',
  body?: unknown,
  path = '/wallet/v1/contract/setup',
): Promise<Record<string, unknown>> {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const baseUrl = (options.baseUrl ?? NETWORK_BASE_URLS[options.network ?? 'mainnet']).replace(
    /\/+$/,
    '',
  );
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
    // no log, proxy or link preview. `to` is the key the page seals the
    // agent's key to: it reaches the page from the agent, never from the API.
    url: `${appUrl}/wallet/custody#setup=${token}&to=${key.publicKey}`,
    token,
    expiresAt: String(answer.expires_at),
    key,
  };
}

/**
 * What the owner left: the wallet contract's account and the agent's key,
 * with the TEE's public key of the pair for {@link WalletContract}. `null`
 * while the owner has not finished.
 *
 * Nothing of it is taken from the API. The owner's signature has to verify
 * (NEP-413) over the agent key's message for `owner` and the wallet, by a key
 * the NEAR RPC shows as a full-access key of `owner`; the agent's key is
 * derived from it here, as the owner's page derives it; the TEE's key has to
 * come with the statement of a keystore the DAO approves, for `owner` and
 * this wallet; and the account has to be the `0s` address of that pair on an
 * accepted build, `owner` itself, or an account under `owner`
 * (`….<owner>`), and answer on chain with exactly that pair. Any other
 * account is refused whatever it answers: anyone can deploy a contract whose
 * `w_public_key` returns a pair. `owner`'s own accounts are the owner's to
 * keep: what else runs there, and which keys it holds, is trusted with the
 * owner.
 *
 * `seed` is the agent's secret: store it where the agent keeps its secrets
 * and make the key again with `AgentKey.fromSeed(seed)`. The setup's one-time
 * key opens it once; after that only the owner can derive it again.
 */
export async function collectSetup(
  options: CollectOptions,
  key: SetupKey,
): Promise<{ account: string; key: AgentKey; seed: Uint8Array; teePublicKey: string } | null> {
  const answer = await setupCall(options, 'GET');
  if (answer.done !== true) return null;
  const owner = options.owner;
  if (typeof owner !== 'string' || owner === '') {
    throw new CustodyError("`owner` is the wallet's owner account: the agent's key is held to it");
  }
  const walletId = String(answer.wallet_id);
  if (options.walletId !== undefined && options.walletId !== walletId) {
    throw new CustodyError(
      `the setup is of the wallet ${walletId}, not of this agent's wallet ${options.walletId}`,
    );
  }
  const network = options.network ?? 'mainnet';
  const chain = {
    rpcUrl: options.rpcUrl ?? NEAR_RPC_URLS[network],
    ...(options.fetch ? { fetch: options.fetch } : {}),
  };

  // The owner's signature, over the message the agent builds itself.
  const signed = await key.open(String(answer.sealed_agent_key), walletId);
  const request = agentKeyRequest(owner, walletId);
  const signerKey = base58Bytes(signed.publicKey.slice('ed25519:'.length)) ?? new Uint8Array();
  if (!(await verifyNep413(signerKey, signed.signature, request))) {
    throw new CustodyError(
      `the owner's signature in the setup is not a signature of the agent key's message for ${owner}'s wallet ${walletId}`,
    );
  }
  if (!(await isFullAccessKey(chain, owner, signed.publicKey))) {
    throw new CustodyError(
      `the owner's signature in the setup was made with ${signed.publicKey}, which is not a full-access key of ${owner}`,
    );
  }
  const seed = agentKeySeed(signed.signature, owner, walletId);
  const agentKey = await AgentKey.fromSeed(seed);
  if (agentKey.publicKey !== answer.agent_public_key) {
    throw new CustodyError(
      "the key the owner's signature makes is not the agent's key the API recorded",
    );
  }

  const teePublicKey = await verifyTeeKey(
    await setupCall(options, 'GET', undefined, '/wallet/v1/contract/key'),
    {
      owner,
      walletId,
      keystoreDaoId: options.keystoreDaoId ?? KEYSTORE_DAO_IDS[network],
      ...chain,
    },
  );

  // The account is one this owner's setup can make: the 0s address of the
  // agent's key and this wallet's TEE key on an accepted build (the address
  // commits to the build and the pair, so nothing else runs there), the
  // owner's own account, or an account under it. The API names the account,
  // and a contract anyone deployed can answer with this pair.
  const account = String(answer.account_id);
  const builds = options.walletContractBuilds ?? [WALLET_CONTRACT_CODE_HASH_HEX];
  if (!builds.every((build) => /^[0-9a-f]{64}$/.test(build))) {
    throw new CustodyError('`walletContractBuilds` are code hashes: 32 bytes in lowercase hex');
  }
  if (/^0s[0-9a-f]{40}$/.test(account)) {
    if (
      !builds.some(
        (build) => account === deterministicAccount(agentKey.publicKey, teePublicKey, build),
      )
    ) {
      throw new CustodyError(
        `${account} is not the wallet contract of the agent's key and this wallet's TEE key on the builds ${builds.join(', ')}`,
      );
    }
  } else if (account !== owner && !account.endsWith(`.${owner}`)) {
    throw new CustodyError(
      `${account} is not the 0s address of the agent's key and this wallet's TEE key, ${owner}, or an account under ${owner}; it was not taken`,
    );
  }
  // And it holds exactly this pair, read from the chain.
  const pair = await walletContractPair(chain, account);
  if (pair !== agentKey.publicKey + teePublicKey) {
    throw new CustodyError(
      pair === null
        ? `${account} runs no wallet contract on chain`
        : `${account} holds another pair of keys on chain than the agent's key and this wallet's TEE key`,
    );
  }
  return {
    account,
    key: agentKey,
    seed,
    teePublicKey,
  };
}
