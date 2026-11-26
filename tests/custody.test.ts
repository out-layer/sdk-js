import { describe, expect, it } from 'vitest';
import {
  AgentKey,
  CustodyError,
  OPERATION_PATH,
  type Operation,
  type OperationState,
  type RequestMessage,
  WalletContract,
  agentRequestBytes,
  encodeRequestMessage,
  fromHex,
  messageIsFor,
  requestHash,
  toHex,
  verifyTeeHalf,
} from '../src/custody.js';
import requests from './fixtures/custody/agent_request.json';
import messages from './fixtures/custody/messages.json';

// The fixtures are the Rust implementation's own vectors
// (`shared-tee-helpers/custody-core/vectors`), copied byte for byte.

const ACCOUNT = 'trader.alice.near';
const teePublicKey = messages.public_key.slice(64);

const agent = () => AgentKey.fromSeed(fromHex(messages.agent_seed, 32));
const message = (name: string) =>
  messages.cases.find((c) => c.name === name)?.message as unknown as RequestMessage;

describe('the request to a wallet contract', () => {
  it('encodes and hashes as the contract does', () => {
    for (const c of messages.cases) {
      const msg = c.message as unknown as RequestMessage;
      expect(toHex(encodeRequestMessage(msg)), c.name).toBe(c.borsh);
      expect(toHex(requestHash(msg)), c.name).toBe(c.hash);
    }
  });

  it('refuses a number that is not one', () => {
    const msg = message('a transfer of NEAR');
    const withAmount = (amount: string): RequestMessage => ({
      ...msg,
      promise: { ...msg.promise, action: { action: 'transfer', amount } },
    });
    for (const amount of [
      '',
      '+5',
      '-5',
      '5.0',
      '0x5',
      '340282366920938463463374607431768211456',
    ]) {
      expect(() => encodeRequestMessage(withAmount(amount)), amount).toThrow(CustodyError);
    }
  });
});

describe("the agent's key", () => {
  it('is the key of the vectors', async () => {
    expect((await agent()).publicKey).toBe(messages.public_key.slice(0, 64));
    expect((await agent()).publicKey).toBe(requests.agent_public_key);
  });

  it('signs the same half as the Rust implementation', async () => {
    const key = await agent();
    for (const c of messages.cases) {
      const msg = c.message as unknown as RequestMessage;
      expect(toHex(await key.signHalf(msg)), c.name).toBe(c.agent_half);
      expect(await verifyTeeHalf(msg, fromHex(c.tee_half, 64), teePublicKey), c.name).toBe(true);
      // the agent's half is not the TEE's
      expect(await verifyTeeHalf(msg, fromHex(c.agent_half, 64), teePublicKey), c.name).toBe(false);
    }
  });

  it('signs an HTTPS request as the Rust implementation does', async () => {
    const key = await agent();
    for (const c of requests.cases) {
      const request = {
        account: c.wallet_contract,
        method: c.method,
        path: c.path,
        body: c.body,
        timestamp: c.timestamp,
        nonce: fromHex(c.nonce, 16),
      };
      expect(toHex(agentRequestBytes(request))).toBe(c.signed_bytes);
      const headers = await key.signRequest(request);
      expect(headers['x-agent-signature']).toBe(c.signature);
      expect(headers['x-agent-account']).toBe(c.wallet_contract);
      expect(headers['x-agent-timestamp']).toBe(String(c.timestamp));
      expect(headers['x-agent-nonce']).toBe(c.nonce);
    }
  });
});

describe('the request is the operation that was asked for', () => {
  const cases: [string, Operation][] = [
    [
      'a transfer of NEAR',
      { kind: 'transfer', to: 'bob.near', amount: '1000000000000000000000000' },
    ],
    [
      'a call',
      {
        kind: 'call',
        to: 'app.near',
        method: 'do_it',
        args_base64: btoa('{"x":1}'),
        gas: '30000000000000',
        deposit: '1',
      },
    ],
    [
      'a transfer inside NEAR Intents',
      { kind: 'intents_transfer', to: '0'.repeat(64), token: 'nep141:wrap.near', amount: '5000' },
    ],
    [
      'a withdrawal from NEAR Intents to NEAR',
      { kind: 'withdraw', to: 'bob.near', token: 'nep141:usdt.tether-token.near', amount: '7' },
    ],
  ];

  it('accepts the request built for it', () => {
    for (const [name, op] of cases)
      expect(messageIsFor(message(name), op, ACCOUNT), name).toBe(true);
  });

  it('accepts no request built for another operation', () => {
    for (const [name] of cases) {
      for (const [other, op] of cases) {
        if (other !== name)
          expect(messageIsFor(message(name), op, ACCOUNT), `${name} / ${other}`).toBe(false);
      }
    }
  });

  it('refuses a request that differs in one field', () => {
    const transfer = message('a transfer of NEAR');
    const op = cases[0][1];
    expect(messageIsFor({ ...transfer, signer_id: 'other.alice.near' }, op, ACCOUNT)).toBe(false);
    expect(messageIsFor(transfer, { ...op, amount: '1' } as Operation, ACCOUNT)).toBe(false);
    expect(messageIsFor(transfer, { ...op, to: 'mallory.near' } as Operation, ACCOUNT)).toBe(false);

    const intents = message('a transfer inside NEAR Intents');
    const intentsOp = cases[2][1];
    expect(
      messageIsFor(intents, { ...intentsOp, token: 'nep141:usdc.near' } as Operation, ACCOUNT),
    ).toBe(false);
    const elsewhere: RequestMessage = {
      ...intents,
      promise: { ...intents.promise, receiver_id: 'fake-intents.near' },
    };
    expect(messageIsFor(elsewhere, intentsOp, ACCOUNT)).toBe(false);
  });

  it('holds a swap to its token and amount, with the deposit address as given', () => {
    const toDeposit = message('a transfer inside NEAR Intents');
    const swap: Operation = {
      kind: 'swap',
      token_in: 'nep141:wrap.near',
      amount_in: '5000',
      token_out: 'nep141:usdc.near',
      min_out: '1',
    };
    expect(messageIsFor(toDeposit, swap, ACCOUNT)).toBe(true);
    expect(messageIsFor(toDeposit, { ...swap, amount_in: '4999' }, ACCOUNT)).toBe(false);
    expect(messageIsFor(toDeposit, { ...swap, token_in: 'nep141:usdc.near' }, ACCOUNT)).toBe(false);
    expect(messageIsFor(message('a transfer of NEAR'), swap, ACCOUNT)).toBe(false);
  });
});

describe('the client', () => {
  const op: Operation = { kind: 'transfer', to: 'bob.near', amount: '1000000000000000000000000' };
  const vector = messages.cases[0];
  const prepared: OperationState = {
    id: 'pay-1',
    status: 'awaiting_signature',
    request_hash: 'h',
    message: vector.message as unknown as RequestMessage,
    tee_half: vector.tee_half,
  };

  /** A server that answers `ask` with `state` and records what it is sent. */
  async function stand(state: OperationState) {
    const sent: { method: string; path: string; headers: Record<string, string>; body: string }[] =
      [];
    const fetch = (async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      sent.push({
        method: init.method as string,
        path,
        headers: init.headers as Record<string, string>,
        body: (init.body as string) ?? '',
      });
      const answer = path.endsWith('/relay')
        ? { ...state, status: 'success', message: undefined }
        : state;
      return new Response(JSON.stringify(answer), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const client = new WalletContract({
      account: ACCOUNT,
      key: await agent(),
      teePublicKey,
      fetch,
      baseUrl: 'https://api.test/',
    });
    return { client, sent };
  }

  it('asks, signs its half last, and relays', async () => {
    const { client, sent } = await stand(prepared);
    const done = await client.run('pay-1', op);
    expect(done.status).toBe('success');

    expect(sent.map((s) => `${s.method} ${s.path}`)).toEqual([
      `POST ${OPERATION_PATH}`,
      `POST ${OPERATION_PATH}/pay-1/relay`,
    ]);
    expect(JSON.parse(sent[0].body)).toEqual({ id: 'pay-1', op });
    expect(JSON.parse(sent[1].body)).toEqual({ agent_half: vector.agent_half });
    for (const request of sent) {
      expect(request.headers['x-agent-account']).toBe(ACCOUNT);
      expect(request.headers['x-agent-signature']).toMatch(/^[0-9a-f]{128}$/);
    }
    expect(sent[0].headers['x-agent-nonce']).not.toBe(sent[1].headers['x-agent-nonce']);
  });

  it('signs nothing for a request that is not the operation', async () => {
    const { client, sent } = await stand(prepared);
    await expect(client.run('pay-1', { ...op, amount: '1' })).rejects.toThrow(/not the operation/);
    expect(sent).toHaveLength(1);
  });

  it("signs nothing when the TEE's half is not valid", async () => {
    const { client, sent } = await stand({ ...prepared, tee_half: vector.agent_half });
    await expect(client.run('pay-1', op)).rejects.toThrow(/TEE's half/);
    expect(sent).toHaveLength(1);
  });

  it('returns an operation that waits for approvers as it stands', async () => {
    const { client, sent } = await stand({
      id: 'pay-1',
      status: 'pending_approval',
      request_hash: 'h',
      approval_id: 'a',
    });
    expect((await client.run('pay-1', op)).status).toBe('pending_approval');
    expect(sent).toHaveLength(1);
  });

  it('reports a refusal with its code', async () => {
    const fetch = (async () =>
      new Response(JSON.stringify({ error: 'policy_denied', message: 'over the daily limit' }), {
        status: 403,
      })) as unknown as typeof globalThis.fetch;
    const client = new WalletContract({ account: ACCOUNT, key: await agent(), fetch });
    await expect(client.ask('pay-1', op)).rejects.toMatchObject({
      code: 'policy_denied',
      status: 403,
    });
  });
});
