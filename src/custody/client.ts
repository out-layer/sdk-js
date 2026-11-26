/**
 * The operation routes of one wallet contract: ask for an operation, check
 * what the enclave prepared, sign the agent's half last, relay.
 */

import { fromHex, toHex } from './bytes.js';
import { CustodyError } from './errors.js';
import { type AgentKey, verifyTeeHalf } from './keys.js';
import {
  type Operation,
  type RequestMessage,
  checkDecimalFields,
  messageIsFor,
  requestHash,
} from './message.js';

/** The path every operation is asked for at, and the root of the others. */
export const OPERATION_PATH = '/wallet/contract/v1/operations';

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

export interface WalletContractOptions {
  /** The wallet contract's account: who the agent is. */
  account: string;
  key: AgentKey;
  /** `https://api.outlayer.ai` by default. */
  baseUrl?: string;
  /**
   * The TEE's public key in the contract's pair, in hex: the second half of
   * the contract's `w_public_key`. The TEE's half of every request is verified
   * against it before the agent signs, so the agent signs only what the
   * enclave has held to the owner's policy.
   */
  teePublicKey: string;
  fetch?: typeof fetch;
}

/**
 * The operations of one wallet contract, each request signed by the agent's
 * key.
 */
export class WalletContract {
  private readonly baseUrl: string;
  private readonly fetch: typeof fetch;
  /** The request this client signed under each id, by its hash. */
  private readonly signed = new Map<string, string>();

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
  async ask(id: string, op: Operation): Promise<OperationState> {
    checkDecimalFields(op);
    return this.send('POST', OPERATION_PATH, JSON.stringify({ id, op }));
  }

  /** Where the operation `id` stands. */
  get(id: string): Promise<OperationState> {
    return this.send('GET', `${OPERATION_PATH}/${id}`, '');
  }

  /**
   * Sign the agent's half of a prepared operation and send it. Refuses a
   * request that is not the operation `op`, is not this wallet contract's,
   * does not carry the TEE's half, or is a second request under an id this
   * client has signed for: one id is one move.
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
    if (!(await verifyTeeHalf(msg, fromHex(state.tee_half, 64), this.options.teePublicKey))) {
      throw new CustodyError(
        `the TEE's half returned for \`${state.id}\` is not valid; nothing was signed`,
      );
    }
    const hash = toHex(requestHash(msg));
    const before = this.signed.get(state.id);
    if (before !== undefined && before !== hash) {
      throw new CustodyError(
        `another request was already signed for \`${state.id}\`; this one was not signed`,
      );
    }
    this.signed.set(state.id, hash);
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
