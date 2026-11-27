import { describe, expect, it } from 'vitest';
import {
  AgentKey,
  CustodyError,
  OPERATION_PATH,
  type Operation,
  type OperationState,
  type RequestMessage,
  SetupKey,
  WalletContract,
  agentKeyRequest,
  agentKeySeed,
  agentRequestBytes,
  collectSetup,
  deterministicAccount,
  stateBytes,
  stateInitBytes,
  encodeRequestMessage,
  fromHex,
  messageIsFor,
  openSetup,
  requestHash,
  toHex,
  verifyTeeHalf,
} from '../src/custody.js';
import { sealWith } from '../src/seal.js';
import requests from './fixtures/custody/agent_request.json';
import keys from './fixtures/custody/keys.json';
import messages from './fixtures/custody/messages.json';
import deterministic from './fixtures/custody/deterministic.json';

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

describe("the agent's key from the owner's signature", () => {
  it('asks for the signature the Rust implementation derives from', () => {
    const request = agentKeyRequest(keys.owner, keys.wallet_id);
    expect(request.message).toBe(keys.agent.nep413_message);
    expect(request.recipient).toBe(keys.agent.nep413_recipient);
    expect(toHex(request.nonce)).toBe(keys.agent.nep413_nonce);
  });

  it('derives the same key', async () => {
    const seed = agentKeySeed(fromHex(keys.agent.signature, 64), keys.owner, keys.wallet_id);
    expect(toHex(seed)).toBe(keys.agent.seed);
    expect((await AgentKey.fromSeed(seed)).publicKey).toBe(keys.agent.public_key);
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
        : init.method === 'GET' && path === OPERATION_PATH
          ? { operations: [state] }
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

  it('lists what is under way with a request signed for the list', async () => {
    const { client, sent } = await stand(prepared);
    const open = await client.list();
    expect(open.map((o) => [o.id, o.status])).toEqual([[prepared.id, prepared.status]]);
    expect(sent.map((s) => `${s.method} ${s.path} [${s.body}]`)).toEqual([
      `GET ${OPERATION_PATH} []`,
    ]);
    expect(sent[0].headers['x-agent-account']).toBe(ACCOUNT);
  });

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

  it('signs one request under an id, and no second one', async () => {
    // The same operation prepared again, as another request, with a TEE half
    // that is valid for it.
    const again = { ...(vector.message as unknown as RequestMessage), nonce: 1 };
    const pkcs8 = fromHex(`302e020100300506032b657004220420${messages.tee_seed}`, 48);
    const tee = await globalThis.crypto.subtle.importKey(
      'pkcs8',
      pkcs8 as BufferSource,
      'Ed25519',
      false,
      ['sign'],
    );
    const signedBytes = new Uint8Array([
      ...new TextEncoder().encode('NEAR_WALLET_TWO_KEY/V1/TEE'),
      ...requestHash(again),
    ]);
    const teeHalf = toHex(
      new Uint8Array(await globalThis.crypto.subtle.sign('Ed25519', tee, signedBytes)),
    );

    const { client, sent } = await stand(prepared);
    await client.relay(prepared, op);
    await client.relay(prepared, op);
    await expect(
      client.relay({ ...prepared, message: again, tee_half: teeHalf }, op),
    ).rejects.toThrow(/another request was already signed/);
    expect(sent).toHaveLength(2);
  });

  it('sends no operation whose number is in another spelling', async () => {
    const { client, sent } = await stand(prepared);
    for (const amount of ['05', '+5', '5.0', '', ' 5']) {
      await expect(client.ask('pay-1', { ...op, amount })).rejects.toThrow(/decimal number/);
    }
    expect(sent).toHaveLength(0);
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
    const client = new WalletContract({
      account: ACCOUNT,
      key: await agent(),
      teePublicKey,
      fetch,
    });
    await expect(client.ask('pay-1', op)).rejects.toMatchObject({
      code: 'policy_denied',
      status: 403,
    });
  });
});

describe('a setup', () => {
  const walletId = keys.wallet_id;
  const aad = new TextEncoder().encode(`outlayer:wallet-contract:agent-key:${walletId}`);

  /** What the owner's page does: seal the agent's seed to the setup's key. */
  async function sealedFor(recipient: string, wallet = aad): Promise<string> {
    const ephemeral = (await crypto.subtle.generateKey({ name: 'X25519' }, false, [
      'deriveBits',
    ])) as CryptoKeyPair;
    const sealed = await sealWith(ephemeral, recipient, fromHex(keys.agent.seed, 32), wallet);
    return btoa(String.fromCharCode(...sealed));
  }

  it("opens the agent's key the owner sealed, for this wallet and this key alone", async () => {
    const setup = await SetupKey.generate();
    const sealed = await sealedFor(setup.publicKey);
    expect(toHex(await setup.open(sealed, walletId))).toBe(keys.agent.seed);

    await expect(setup.open(sealed, 'another-wallet')).rejects.toThrow(CustodyError);
    await expect((await SetupKey.generate()).open(sealed, walletId)).rejects.toThrow(CustodyError);
    await expect(setup.open('AAAA', walletId)).rejects.toThrow(/not a sealed agent key/);
  });

  it('is opened with a one-time key and collected when the owner has finished', async () => {
    let stored: { recipient?: string } = {};
    let answer: Record<string, unknown> = { wallet_id: walletId, done: false };
    const fetch = (async (url: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>).authorization).toBe('Bearer wk_test');
      if (new URL(url).pathname === '/wallet/v1/contract/key') {
        return new Response(JSON.stringify({ tee_public_key: keys.tee.public_key }));
      }
      expect(new URL(url).pathname).toBe('/wallet/v1/contract/setup');
      if (init.method === 'POST') {
        stored = { recipient: JSON.parse(init.body as string).recipient_public_key };
        return new Response(
          JSON.stringify({ token: 'ab'.repeat(32), expires_at: '2027-01-01T00:00:00Z' }),
        );
      }
      return new Response(JSON.stringify(answer));
    }) as unknown as typeof globalThis.fetch;
    const options = {
      apiKey: 'wk_test',
      baseUrl: 'https://api.test',
      appUrl: 'https://app.test/',
      fetch,
    };

    const opened = await openSetup(options);
    expect(opened.url).toBe(`https://app.test/wallet/custody#setup=${'ab'.repeat(32)}`);
    expect(stored.recipient).toBe(opened.key.publicKey);
    expect(await collectSetup(options, opened.key)).toBeNull();

    const done = {
      wallet_id: walletId,
      done: true,
      account_id: 'trader.alice.near',
      sealed_agent_key: await sealedFor(opened.key.publicKey),
    };
    answer = { ...done, agent_public_key: keys.agent.public_key };
    const collected = await collectSetup(options, opened.key);
    expect(collected?.account).toBe('trader.alice.near');
    expect(collected?.key.publicKey).toBe(keys.agent.public_key);
    expect(toHex(collected?.seed ?? new Uint8Array())).toBe(keys.agent.seed);
    expect(collected?.teePublicKey).toBe(keys.tee.public_key);

    // a key that is not the one in the contract's pair is not taken
    answer = { ...done, agent_public_key: keys.tee.public_key };
    await expect(collectSetup(options, opened.key)).rejects.toThrow(/not the agent's key/);

    // a 0s account: taken when it is the wallet contract of this agent key and TEE key
    const own0s = deterministicAccount(keys.agent.public_key, keys.tee.public_key);
    answer = { ...done, account_id: own0s, agent_public_key: keys.agent.public_key };
    expect((await collectSetup(options, opened.key))?.account).toBe(own0s);
    const other0s = deterministicAccount(keys.tee.public_key, keys.agent.public_key);
    answer = { ...done, account_id: other0s, agent_public_key: keys.agent.public_key };
    await expect(collectSetup(options, opened.key)).rejects.toThrow(/is not the wallet contract of the agent's key/);
  });
});

describe('a wallet contract at its deterministic address', () => {
  it("is custody-core's state, StateInit and 0s address", () => {
    expect(deterministic.cases).toHaveLength(3);
    for (const c of deterministic.cases) {
      const [agent, tee] = [c.pair.slice(0, 64), c.pair.slice(64)];
      expect(toHex(stateBytes(agent, tee))).toBe(c.state);
      expect(toHex(stateInitBytes(agent, tee, deterministic.code_hash_hex))).toBe(c.state_init);
      expect(deterministicAccount(agent, tee, deterministic.code_hash_hex)).toBe(c.account_id);
    }
    expect(deterministic.cases.map((c) => c.account_id)).toContain('0scaf38f4da73c18308919d2f94e5445cd4131e2a5');
  });

  it('defaults to the published build', () => {
    const c = deterministic.cases[0];
    expect(deterministicAccount(c.pair.slice(0, 64), c.pair.slice(64))).toBe(c.account_id);
  });
});
