import { describe, expect, it } from 'vitest';
import {
  AGENT_KEY_SEALED_FORMAT,
  AgentKey,
  CustodyError,
  NEP413_TAG,
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
  encodeRequestMessage,
  fromHex,
  messageIsFor,
  nep413Hash,
  openSetup,
  requestHash,
  stateBytes,
  stateInitBytes,
  toHex,
  verifyNep413,
  verifyTeeHalf,
} from '../src/custody.js';
import { sealWith } from '../src/seal.js';
import requests from './fixtures/custody/agent_request.json';
import deterministic from './fixtures/custody/deterministic.json';
import keys from './fixtures/custody/keys.json';
import messages from './fixtures/custody/messages.json';
import NEP413 from './fixtures/custody/nep413_agent_key_vector.json';
import STATEMENT from './fixtures/custody/tee_key_statement_vector.json';
import { daoAnswers, statedTeeKey } from './teeKeyHelpers.js';

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

  it("asks the network's API, and the one it is given before that", async () => {
    const asked = async (options: { network?: 'mainnet' | 'testnet'; baseUrl?: string }) => {
      const urls: string[] = [];
      const fetch = (async (url: string) => {
        urls.push(url);
        return new Response(JSON.stringify({ operations: [] }));
      }) as unknown as typeof globalThis.fetch;
      const client = new WalletContract({
        account: ACCOUNT,
        key: await agent(),
        teePublicKey,
        fetch,
        ...options,
      });
      await client.list();
      return urls;
    };
    expect(await asked({})).toEqual([`https://api.outlayer.ai${OPERATION_PATH}`]);
    expect(await asked({ network: 'mainnet' })).toEqual([
      `https://api.outlayer.ai${OPERATION_PATH}`,
    ]);
    expect(await asked({ network: 'testnet' })).toEqual([
      `https://testnet-api.outlayer.ai${OPERATION_PATH}`,
    ]);
    expect(await asked({ network: 'testnet', baseUrl: 'https://api.test/' })).toEqual([
      `https://api.test${OPERATION_PATH}`,
    ]);
  });

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

  it('signs nothing for an answer under another id than the one asked for', async () => {
    // The request is the operation and the TEE's half is valid: only the id is
    // another one, which would let a second request be signed for `pay-1`.
    const { client, sent } = await stand({ ...prepared, id: 'pay-2' });
    await expect(client.run('pay-1', op)).rejects.toThrow(
      /answered for the operation `pay-2`, not for `pay-1`/,
    );
    await expect(client.ask('pay-1', op)).rejects.toThrow(/not for `pay-1`/);
    await expect(client.get('pay-1')).rejects.toThrow(/not for `pay-1`/);
    expect(sent.map((s) => `${s.method} ${s.path}`)).toEqual([
      `POST ${OPERATION_PATH}`,
      `POST ${OPERATION_PATH}`,
      `GET ${OPERATION_PATH}/pay-1`,
    ]);
    // no id at all is another id
    const none = await stand({ ...prepared, id: undefined as unknown as string });
    await expect(none.client.run('pay-1', op)).rejects.toThrow(/not for `pay-1`/);
    expect(none.sent).toHaveLength(1);
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

  it('names the operation that is prepared and waits, apart from the other conflicts', async () => {
    const key = await agent();
    const refusing = (body: Record<string, unknown>) =>
      new WalletContract({
        account: ACCOUNT,
        key,
        teePublicKey,
        fetch: (async () =>
          new Response(JSON.stringify(body), {
            status: 409,
          })) as unknown as typeof globalThis.fetch,
      });
    const waiting = await refusing({
      error: 'operation_waiting',
      message: 'the operation `pay-1` of this wallet is prepared and not over',
      waiting_operation_id: 'pay-1',
    })
      .ask('pay-2', op)
      .catch((e: unknown) => e);
    expect(waiting).toBeInstanceOf(CustodyError);
    expect(waiting).toMatchObject({
      code: 'operation_waiting',
      status: 409,
      waitingOperationId: 'pay-1',
      message: 'the operation `pay-1` of this wallet is prepared and not over',
    });

    const conflict = await refusing({
      error: 'conflict',
      message: 'the request nonce was already taken',
      waiting_operation_id: 'pay-1',
    })
      .ask('pay-2', op)
      .catch((e: unknown) => e);
    expect(conflict).toMatchObject({ code: 'conflict', status: 409 });
    expect((conflict as CustodyError).waitingOperationId).toBeUndefined();
  });
});

describe('NEP-413', () => {
  // The vector is node:crypto's, and the coordinator's `verify_nep413_signature`
  // accepts it (`test_nep413_agent_key_vector`).
  const request = {
    message: NEP413.message,
    recipient: NEP413.recipient,
    nonce: fromHex(NEP413.nonce_hex, 32),
  };
  const ownerKey = fromHex(NEP413.owner_public_key_hex, 32);
  const signature = fromHex(NEP413.signature_hex, 64);

  it('hashes and verifies as the coordinator does', async () => {
    expect(NEP413_TAG).toBe(2147484061);
    expect(toHex(nep413Hash(request))).toBe(NEP413.signed_hash_hex);
    expect(await verifyNep413(ownerKey, signature, request)).toBe(true);
    const asked = agentKeyRequest(NEP413.owner, NEP413.wallet_id);
    expect(asked.message).toBe(NEP413.message);
    expect(asked.recipient).toBe(NEP413.recipient);
    expect(toHex(asked.nonce)).toBe(NEP413.nonce_hex);
  });

  it('verifies nothing else', async () => {
    const other = agentKeyRequest('bob.near', NEP413.wallet_id);
    expect(await verifyNep413(ownerKey, signature, other)).toBe(false);
    expect(
      await verifyNep413(ownerKey, signature, { ...request, recipient: 'outlayer.near' }),
    ).toBe(false);
    expect(await verifyNep413(fromHex(keys.tee.public_key, 32), signature, request)).toBe(false);
    const flipped = signature.slice();
    flipped[0] ^= 1;
    expect(await verifyNep413(ownerKey, flipped, request)).toBe(false);
    expect(await verifyNep413(ownerKey, signature.slice(0, 63), request)).toBe(false);
  });

  it("derives the agent's key the vector names", async () => {
    const seed = agentKeySeed(signature, NEP413.owner, NEP413.wallet_id);
    expect(toHex(seed)).toBe(NEP413.agent_seed);
    expect((await AgentKey.fromSeed(seed)).publicKey).toBe(NEP413.agent_public_key);
  });
});

describe('a setup', () => {
  const walletId = NEP413.wallet_id;
  const owner = NEP413.owner;
  const aad = new TextEncoder().encode(`outlayer:wallet-contract:agent-key:${walletId}`);
  const signedByOwner = new Uint8Array([
    ...fromHex(NEP413.signature_hex, 64),
    ...fromHex(NEP413.owner_public_key_hex, 32),
  ]);
  const AGENT = NEP413.agent_public_key;
  const TEE = keys.tee.public_key;

  /** What the owner's page does: seal the owner's signature and its key to the setup's key. */
  async function sealedFor(
    recipient: string,
    plaintext = signedByOwner,
    format = AGENT_KEY_SEALED_FORMAT,
    wallet = aad,
  ): Promise<string> {
    const ephemeral = (await crypto.subtle.generateKey({ name: 'X25519' }, false, [
      'deriveBits',
    ])) as CryptoKeyPair;
    const sealed = await sealWith(ephemeral, recipient, plaintext, wallet, format);
    return btoa(String.fromCharCode(...sealed));
  }

  /** A signature of the agent key's message by another key, sealed with that key. */
  async function signedBy(seedHex: string, message: string): Promise<Uint8Array> {
    const pkcs8 = fromHex(`302e020100300506032b657004220420${seedHex}`, 48);
    const key = await crypto.subtle.importKey('pkcs8', pkcs8 as BufferSource, 'Ed25519', true, [
      'sign',
    ]);
    const hash = nep413Hash({
      message,
      recipient: NEP413.recipient,
      nonce: fromHex(NEP413.nonce_hex, 32),
    });
    const signature = new Uint8Array(
      await crypto.subtle.sign('Ed25519', key, hash as BufferSource),
    );
    const jwk = await crypto.subtle.exportKey('jwk', key);
    const pub = Uint8Array.from(
      atob(`${(jwk.x as string).replace(/-/g, '+').replace(/_/g, '/')}=`),
      (c) => c.charCodeAt(0),
    );
    return new Uint8Array([...signature, ...pub]);
  }

  it("opens the owner's signature the page sealed, for this wallet and this key alone", async () => {
    const setup = await SetupKey.generate();
    const sealed = await sealedFor(setup.publicKey);
    const opened = await setup.open(sealed, walletId);
    expect(toHex(opened.signature)).toBe(NEP413.signature_hex);
    expect(opened.publicKey).toBe(NEP413.owner_public_key);

    await expect(setup.open(sealed, 'another-wallet')).rejects.toThrow(CustodyError);
    await expect((await SetupKey.generate()).open(sealed, walletId)).rejects.toThrow(CustodyError);
    await expect(setup.open('AAAA', walletId)).rejects.toThrow(/not a sealed owner's signature/);
    // the earlier format: a seed sealed with the byte 0x02, refused unopened
    const seedSealed = await sealedFor(setup.publicKey, fromHex(NEP413.agent_seed, 32), 0x02);
    await expect(setup.open(seedSealed, walletId)).rejects.toThrow(
      /not a sealed owner's signature/,
    );
    // the right length under the old byte, or under the new byte a seed: both refused
    const oldByte = await sealedFor(setup.publicKey, signedByOwner, 0x02);
    await expect(setup.open(oldByte, walletId)).rejects.toThrow(/not a sealed owner's signature/);
    const seedNewByte = await sealedFor(setup.publicKey, fromHex(NEP413.agent_seed, 32));
    await expect(setup.open(seedNewByte, walletId)).rejects.toThrow(
      /not a sealed owner's signature/,
    );
  });

  /** The chain as the RPC answers it: the owner's keys, the DAO, and each account's pair. */
  interface Chain {
    fullAccess: Record<string, string>; // key → its permission, for `owner`
    approved: boolean;
    pairs: Record<string, string>;
  }
  const rpcAnswer = (chain: Chain, init: RequestInit): Response => {
    const params = JSON.parse(init.body as string).params;
    if (params.request_type === 'view_access_key') {
      const permission =
        params.account_id === owner ? chain.fullAccess[params.public_key] : undefined;
      return new Response(
        JSON.stringify(
          permission === undefined
            ? { jsonrpc: '2.0', id: 'x', error: { cause: { name: 'UNKNOWN_ACCESS_KEY' } } }
            : { jsonrpc: '2.0', id: 'x', result: { nonce: 1, permission } },
        ),
      );
    }
    if (params.method_name === 'is_keystore_approved') return daoAnswers(chain.approved);
    if (params.method_name === 'w_public_key') {
      const pair = chain.pairs[params.account_id];
      return pair === undefined
        ? new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 'x',
              error: { cause: { name: 'NO_CONTRACT_CODE' } },
            }),
          )
        : daoAnswers(pair);
    }
    throw new Error(`unexpected RPC query ${JSON.stringify(params)}`);
  };

  it('is opened with a one-time key and collected when the owner has finished', async () => {
    let stored: { recipient?: string } = {};
    let answer: Record<string, unknown> = { wallet_id: walletId, done: false };
    const own0s = deterministicAccount(AGENT, TEE);
    const otherBuild = 'ab'.repeat(32);
    const onOther = deterministicAccount(AGENT, TEE, otherBuild);
    const chain: Chain = {
      fullAccess: { [NEP413.owner_public_key]: 'FullAccess' },
      approved: true,
      pairs: {
        'trader.alice.near': AGENT + TEE,
        [own0s]: AGENT + TEE,
        '0sam.near': AGENT + TEE,
        'alice.near': AGENT + TEE,
        'a.trader.alice.near': AGENT + TEE,
        'mallory.near': AGENT + TEE,
        'xalice.near': AGENT + TEE,
        'alice.near.mallory.near': AGENT + TEE,
        near: AGENT + TEE,
        [onOther]: AGENT + TEE,
      },
    };
    const teeKey = await statedTeeKey(TEE, owner, walletId);
    const fetch = (async (url: string, init: RequestInit) => {
      if (url === 'https://rpc.test') return rpcAnswer(chain, init);
      expect((init.headers as Record<string, string>).authorization).toBe('Bearer wk_test');
      if (new URL(url).pathname === '/wallet/v1/contract/key') {
        return new Response(JSON.stringify(teeKey));
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
      owner,
      keystoreDaoId: STATEMENT.dao,
      rpcUrl: 'https://rpc.test',
      fetch,
    };

    const opened = await openSetup(options);
    expect(opened.key.publicKey).toMatch(/^[0-9a-f]{64}$/);
    expect(opened.url).toBe(
      `https://app.test/wallet/custody#setup=${'ab'.repeat(32)}&to=${opened.key.publicKey}`,
    );
    expect(stored.recipient).toBe(opened.key.publicKey);
    expect(await collectSetup(options, opened.key)).toBeNull();

    const done = {
      wallet_id: walletId,
      done: true,
      account_id: 'trader.alice.near',
      agent_public_key: AGENT,
      sealed_agent_key: await sealedFor(opened.key.publicKey),
    };
    answer = done;
    const collected = await collectSetup(options, opened.key);
    expect(collected?.account).toBe('trader.alice.near');
    expect(collected?.key.publicKey).toBe(AGENT);
    expect(toHex(collected?.seed ?? new Uint8Array())).toBe(NEP413.agent_seed);
    expect(collected?.teePublicKey).toBe(TEE);
    // the agent's own record of its wallet id, when it has one
    expect((await collectSetup({ ...options, walletId }, opened.key))?.account).toBe(
      'trader.alice.near',
    );
    await expect(
      collectSetup({ ...options, walletId: 'another-wallet' }, opened.key),
    ).rejects.toThrow(/not of this agent's wallet another-wallet/);

    // a key the API recorded that the signature does not make is not taken
    answer = { ...done, agent_public_key: TEE };
    await expect(collectSetup(options, opened.key)).rejects.toThrow(
      /not the agent's key the API recorded/,
    );

    // the account holds the pair on chain, whatever the API says of it
    answer = { ...done, account_id: 'other.alice.near' };
    await expect(collectSetup(options, opened.key)).rejects.toThrow(
      /runs no wallet contract on chain/,
    );
    chain.pairs['other.alice.near'] = TEE + AGENT;
    await expect(collectSetup(options, opened.key)).rejects.toThrow(
      /holds another pair of keys on chain/,
    );
    chain.pairs['other.alice.near'] = AGENT + 'cd'.repeat(32);
    await expect(collectSetup(options, opened.key)).rejects.toThrow(
      /holds another pair of keys on chain/,
    );

    // a 0s account: taken when it is the wallet contract of this agent key and TEE key
    answer = { ...done, account_id: own0s };
    expect((await collectSetup(options, opened.key))?.account).toBe(own0s);
    // the owner's own account, and an account under it at any depth
    for (const account of ['alice.near', 'a.trader.alice.near']) {
      answer = { ...done, account_id: account };
      expect((await collectSetup(options, opened.key))?.account).toBe(account);
    }
    // any other account is refused, though it answers with the pair on chain:
    // anyone can deploy a contract that does. A named account that starts
    // with 0s is a named account.
    for (const account of [
      '0sam.near',
      'mallory.near',
      'xalice.near',
      'alice.near.mallory.near',
      'near',
      own0s.toUpperCase(),
    ]) {
      chain.pairs[account] = AGENT + TEE;
      answer = { ...done, account_id: account };
      await expect(collectSetup(options, opened.key), account).rejects.toThrow(
        /or an account under alice.near; it was not taken/,
      );
    }
    const other0s = deterministicAccount(TEE, AGENT);
    chain.pairs[other0s] = AGENT + TEE;
    answer = { ...done, account_id: other0s };
    await expect(collectSetup(options, opened.key)).rejects.toThrow(
      /is not the wallet contract of the agent's key/,
    );

    // a 0s account on another build: refused by default, taken when that build is accepted
    answer = { ...done, account_id: onOther };
    await expect(collectSetup(options, opened.key)).rejects.toThrow(/on the builds/);
    const accepting = { ...options, walletContractBuilds: [otherBuild] };
    expect((await collectSetup(accepting, opened.key))?.account).toBe(onOther);

    // another owner: the signature is not of that owner's message
    answer = done;
    await expect(collectSetup({ ...options, owner: 'mallory.near' }, opened.key)).rejects.toThrow(
      /not a signature of the agent key's message for mallory.near's wallet/,
    );

    // the signing key is no full-access key of the owner: removed, or a function-call key
    chain.fullAccess[NEP413.owner_public_key] = undefined as unknown as string;
    await expect(collectSetup(options, opened.key)).rejects.toThrow(
      /not a full-access key of alice.near/,
    );
    chain.fullAccess[NEP413.owner_public_key] = { FunctionCall: {} } as unknown as string;
    await expect(collectSetup(options, opened.key)).rejects.toThrow(
      /not a full-access key of alice.near/,
    );
  });

  it("takes no signature that is not the owner's over this wallet's message", async () => {
    const MALLORY_SEED = 'f5e5767cf153319517630f226876b86c8160cc583bc013744c6bf255f5cc0ee5';
    const chain: Chain = {
      fullAccess: { [NEP413.owner_public_key]: 'FullAccess' },
      approved: true,
      pairs: {},
    };
    const teeKey = await statedTeeKey(TEE, owner, walletId);
    const run = async (plaintext: Uint8Array, format = AGENT_KEY_SEALED_FORMAT) => {
      const setup = await SetupKey.generate();
      const sealed_agent_key = await sealedFor(setup.publicKey, plaintext, format);
      // whatever key the seal makes, the API records it and the chain answers with it:
      // the API made the account itself
      const signature = plaintext.slice(0, 64);
      const agent =
        plaintext.length === 96
          ? (await AgentKey.fromSeed(agentKeySeed(signature, owner, walletId))).publicKey
          : AGENT;
      chain.pairs['trader.alice.near'] = agent + TEE;
      const fetch = (async (url: string, init: RequestInit) => {
        if (url === 'https://rpc.test') return rpcAnswer(chain, init);
        if (new URL(url).pathname === '/wallet/v1/contract/key') {
          return new Response(JSON.stringify(teeKey));
        }
        return new Response(
          JSON.stringify({
            wallet_id: walletId,
            done: true,
            account_id: 'trader.alice.near',
            agent_public_key: agent,
            sealed_agent_key,
          }),
        );
      }) as unknown as typeof globalThis.fetch;
      return collectSetup(
        {
          apiKey: 'wk_test',
          baseUrl: 'https://api.test',
          owner,
          keystoreDaoId: STATEMENT.dao,
          rpcUrl: 'https://rpc.test',
          fetch,
        },
        setup,
      );
    };
    expect((await run(signedByOwner))?.key.publicKey).toBe(AGENT);
    // the API's own key, signing the owner's message: verifies, but is no key of the owner
    const mallory = await signedBy(MALLORY_SEED, NEP413.message);
    await expect(run(mallory)).rejects.toThrow(/not a full-access key of alice.near/);
    // the API's own key named as the owner's, beside the owner's real signature
    const swapped = new Uint8Array([...signedByOwner.slice(0, 64), ...mallory.slice(64)]);
    await expect(run(swapped)).rejects.toThrow(/not a signature of the agent key's message/);
    // the owner's own key over another wallet's message
    const otherWallet = NEP413.message.replace(walletId, 'another-wallet');
    const ownerOther = await signedBy(NEP413.owner_secret_seed, otherWallet);
    await expect(run(ownerOther)).rejects.toThrow(/not a signature of the agent key's message/);
    // random bytes in the place of a signature
    const random = crypto.getRandomValues(new Uint8Array(96));
    await expect(run(random)).rejects.toThrow(/not a signature of the agent key's message/);
    // a seed of the API's choosing, sealed the earlier way
    await expect(run(fromHex(NEP413.agent_seed, 32), 0x02)).rejects.toThrow(
      /not a sealed owner's signature/,
    );
  });

  it('takes no TEE key the keystore did not state, or a DAO did not approve the keystore of', async () => {
    const done = {
      wallet_id: walletId,
      done: true,
      account_id: 'trader.alice.near',
      agent_public_key: AGENT,
    };
    const run = async (teeKey: unknown, approved: boolean) => {
      const setup = await SetupKey.generate();
      const sealed_agent_key = await sealedFor(setup.publicKey);
      const chain: Chain = {
        fullAccess: { [NEP413.owner_public_key]: 'FullAccess' },
        approved,
        pairs: { 'trader.alice.near': AGENT + TEE },
      };
      const fetch = (async (url: string, init: RequestInit) => {
        if (url === 'https://rpc.test') return rpcAnswer(chain, init);
        if (new URL(url).pathname === '/wallet/v1/contract/key') {
          return new Response(JSON.stringify(teeKey));
        }
        return new Response(JSON.stringify({ ...done, sealed_agent_key }));
      }) as unknown as typeof globalThis.fetch;
      return collectSetup(
        {
          apiKey: 'wk_test',
          baseUrl: 'https://api.test',
          owner,
          keystoreDaoId: STATEMENT.dao,
          rpcUrl: 'https://rpc.test',
          fetch,
        },
        setup,
      );
    };
    const stated = await statedTeeKey(TEE, owner, walletId);
    expect((await run(stated, true))?.teePublicKey).toBe(TEE);
    // the API swaps the key: the statement no longer holds
    await expect(run({ ...stated, tee_public_key: AGENT }, true)).rejects.toThrow(
      /does not state this TEE key/,
    );
    // no statement at all
    await expect(run({ tee_public_key: TEE }, true)).rejects.toThrow(CustodyError);
    // a statement by a keystore the DAO does not approve
    await expect(run(stated, false)).rejects.toThrow(
      /is not a keystore dao.outlayer.testnet approved/,
    );
    // a statement for another owner
    await expect(run(await statedTeeKey(TEE, 'mallory.near', walletId), true)).rejects.toThrow(
      /not for an owner scope of alice.near/,
    );
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
    expect(deterministic.cases.map((c) => c.account_id)).toContain(
      '0scaf38f4da73c18308919d2f94e5445cd4131e2a5',
    );
  });

  it('defaults to the published build', () => {
    const c = deterministic.cases[0];
    expect(deterministicAccount(c.pair.slice(0, 64), c.pair.slice(64))).toBe(c.account_id);
  });
});
