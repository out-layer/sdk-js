import { describe, expect, it } from 'vitest';
import {
  AgentKey,
  CustodyError,
  type Operation,
  type OperationState,
  type RequestMessage,
  WalletContract,
  checkRoute,
  fromHex,
  requestHash,
  teeKeyStatement,
  toHex,
  verifyTeeKey,
} from '../src/custody.js';
import { base64Encode } from '../src/custody/bytes.js';
import messages from './fixtures/custody/messages.json';
import recordedAnswer from './fixtures/custody/oneclick_status_swap.json';
import STATEMENT from './fixtures/custody/tee_key_statement_vector.json';
import { daoAnswers } from './teeKeyHelpers.js';

// `tee_key_statement_vector.json` is the keystore's own vector
// (`keystore-worker/src/fixtures`), copied byte for byte.
// `oneclick_status_swap.json` is 1Click's answer to `GET /v0/status` for a
// fresh mainnet quote, recorded as it came.

describe("the keystore's statement of the TEE's key", () => {
  const OWNER = 'alice.testnet';
  const answer = {
    tee_public_key: STATEMENT.tee,
    scope: STATEMENT.scope,
    keystore_public_key: STATEMENT.public_key,
    tee_key_signature: STATEMENT.signature,
  };

  /** An RPC that answers `is_keystore_approved` with `approved` and records what it was asked. */
  function rpc(approved: unknown) {
    const asked: Record<string, unknown>[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      expect(url).toBe('https://rpc.test');
      asked.push(JSON.parse(init.body as string).params);
      return daoAnswers(approved);
    }) as unknown as typeof globalThis.fetch;
    return { asked, fetch };
  }
  const expected = (fetch: typeof globalThis.fetch) => ({
    owner: OWNER,
    walletId: STATEMENT.wallet,
    keystoreDaoId: STATEMENT.dao,
    rpcUrl: 'https://rpc.test',
    fetch,
  });

  it("is the keystore's text", () => {
    expect(teeKeyStatement(STATEMENT.dao, STATEMENT.scope, STATEMENT.wallet, STATEMENT.tee)).toBe(
      STATEMENT.statement,
    );
  });

  it('gives the key once the signature holds and the DAO approves the keystore', async () => {
    const { asked, fetch } = rpc(true);
    expect(await verifyTeeKey(answer, expected(fetch))).toBe(STATEMENT.tee);
    expect(asked).toEqual([
      {
        request_type: 'call_function',
        finality: 'final',
        account_id: STATEMENT.dao,
        method_name: 'is_keystore_approved',
        args_base64: btoa(JSON.stringify({ public_key: STATEMENT.public_key })),
      },
    ]);
  });

  it('refuses a statement that is not of this DAO, owner, wallet and key', async () => {
    const refusals: [string, Record<string, unknown>, Partial<ReturnType<typeof expected>>][] = [
      ['another TEE key', { tee_public_key: 'ab'.repeat(32) }, {}],
      ['an uppercase TEE key', { tee_public_key: STATEMENT.tee.toUpperCase() }, {}],
      ['another generation', { scope: 'owner:alice.testnet:2' }, {}],
      ['a generation 0', { scope: 'owner:alice.testnet:0' }, {}],
      ['a generation with a leading zero', { scope: 'owner:alice.testnet:01' }, {}],
      ['a scope of no generation', { scope: 'owner:alice.testnet' }, {}],
      ['a vault scope', { scope: 'vault.alice.testnet' }, {}],
      ['another owner', {}, { owner: 'bob.testnet' }],
      ['another wallet', {}, { walletId: '00000000-0000-0000-0000-000000000000' }],
      ['another DAO', {}, { keystoreDaoId: 'dao.outlayer.near' }],
      ['another keystore key', { keystore_public_key: `ed25519:${'1'.repeat(32)}` }, {}],
      ['a key not in base58', { keystore_public_key: 'ed25519:0OIl' }, {}],
      ['a key of another scheme', { keystore_public_key: 'secp256k1:abc' }, {}],
      ['a signature cut short', { tee_key_signature: STATEMENT.signature.slice(2) }, {}],
      ['no signature', { tee_key_signature: undefined }, {}],
    ];
    for (const [name, change, against] of refusals) {
      const { asked, fetch } = rpc(true);
      await expect(
        verifyTeeKey({ ...answer, ...change }, { ...expected(fetch), ...against }),
        name,
      ).rejects.toThrow(CustodyError);
      expect(asked, `${name}: the DAO is not read before the signature holds`).toHaveLength(0);
    }
  });

  it('refuses a keystore the DAO does not approve, and a DAO it cannot read', async () => {
    for (const approved of [false, 'true', null]) {
      await expect(verifyTeeKey(answer, expected(rpc(approved).fetch))).rejects.toThrow(
        /is not a keystore dao.outlayer.testnet approved/,
      );
    }
    const failing = (async () =>
      new Response(
        JSON.stringify({ error: { message: 'UNKNOWN_ACCOUNT' } }),
      )) as unknown as typeof fetch;
    await expect(verifyTeeKey(answer, expected(failing))).rejects.toThrow(/did not answer/);
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(verifyTeeKey(answer, expected(down))).rejects.toThrow(/could not be read/);
  });
});

// ── The 1Click route of a swap and of a withdrawal to another chain ────────

const WALLET = 'outlayer.near';
// The recorded quote's ten minutes are over: the same answer, with a deadline
// ten minutes ahead of the run. The deadline itself is held below.
const recorded = {
  ...recordedAnswer,
  quoteResponse: {
    ...recordedAnswer.quoteResponse,
    quoteRequest: {
      ...recordedAnswer.quoteResponse.quoteRequest,
      deadline: new Date(Date.now() + 600_000).toISOString(),
    },
  },
};
const request = recorded.quoteResponse.quoteRequest;
const DEPOSIT = recorded.quoteResponse.quote.depositAddress;

/** The wallet contract's request that sends `amount` of `token` to `address` inside NEAR Intents. */
function toDeposit(token: string, amount: string, address = DEPOSIT): RequestMessage {
  const args = JSON.stringify({ receiver_id: address, token_id: token, amount });
  return {
    chain_id: 'mainnet',
    signer_id: WALLET,
    nonce: 7,
    created_at_ns: '1800000000123456789',
    promise: {
      receiver_id: 'intents.near',
      action: {
        action: 'function_call',
        function_name: 'mt_transfer',
        args: base64Encode(new TextEncoder().encode(args)),
        deposit: '1',
        gas: '30000000000000',
      },
    },
  };
}

const swap: Operation = {
  kind: 'swap',
  token_in: request.originAsset,
  amount_in: request.amount,
  token_out: request.destinationAsset,
  min_out: recorded.quoteResponse.quote.minAmountOut,
};

const USDC_NEAR = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const USDC_ETH = 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near';
const USDC_BASE = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near';
const ETH = 'nep141:eth.omft.near';
const TOKENS = [
  { assetId: 'nep141:wrap.near', blockchain: 'near', symbol: 'wNEAR' },
  { assetId: USDC_NEAR, blockchain: 'near', symbol: 'USDC' },
  { assetId: USDC_ETH, blockchain: 'eth', symbol: 'USDC' },
  { assetId: USDC_BASE, blockchain: 'base', symbol: 'USDC' },
  { assetId: ETH, blockchain: 'eth', symbol: 'ETH' },
];
const withdraw: Operation = {
  kind: 'cross_chain_withdraw',
  to: '0x1111111111111111111111111111111111111111',
  amount: '2500000',
  token: USDC_NEAR,
  chain: 'Ethereum',
};
/** 1Click's answer for the withdrawal's deposit address, built on the recorded one. */
const withdrawStatus = (change: Record<string, unknown> = {}) => ({
  ...recorded,
  quoteResponse: {
    ...recorded.quoteResponse,
    quoteRequest: {
      ...request,
      originAsset: USDC_NEAR,
      destinationAsset: USDC_ETH,
      amount: '2500000',
      recipient: withdraw.to,
      recipientType: 'DESTINATION_CHAIN',
      ...change,
    },
    quote: { ...recorded.quoteResponse.quote, amountIn: '2500000', minAmountOut: '2490000' },
  },
});

/** 1Click as a fetch: `status` for the status of DEPOSIT, `TOKENS` for the tokens. */
function oneClick(status: unknown, tokens: unknown = TOKENS) {
  const asked: string[] = [];
  const fetch = (async (url: string) => {
    asked.push(url);
    const { pathname, searchParams } = new URL(url);
    if (pathname === '/v0/status' && searchParams.get('depositAddress') === DEPOSIT) {
      return new Response(JSON.stringify(status));
    }
    if (pathname === '/v0/tokens') return new Response(JSON.stringify(tokens));
    return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
  }) as unknown as typeof globalThis.fetch;
  return { asked, fetch };
}

const withRequest = (change: Record<string, unknown>) => ({
  ...recorded,
  quoteResponse: { ...recorded.quoteResponse, quoteRequest: { ...request, ...change } },
});
const withQuote = (change: Record<string, unknown>) => ({
  ...recorded,
  quoteResponse: {
    ...recorded.quoteResponse,
    quote: { ...recorded.quoteResponse.quote, ...change },
  },
});

describe("a swap's route", () => {
  const msg = toDeposit(swap.token_in, swap.amount_in);

  it("is signed when 1Click's quote is the swap, read from 1Click's own address", async () => {
    const { asked, fetch } = oneClick(recorded);
    await checkRoute(msg, swap, WALLET, { fetch, oneClickUrl: 'https://1click.test/' });
    expect(asked).toEqual([`https://1click.test/v0/status?depositAddress=${DEPOSIT}`]);
    // a lower floor than the quote's is the agent's own choice
    await checkRoute(msg, { ...swap, min_out: '1' }, WALLET, oneClick(recorded));
    // a quote of no confidentiality, or a lower slippage, is the same route
    await checkRoute(msg, swap, WALLET, oneClick(withRequest({ confidentiality: undefined })));
    await checkRoute(msg, swap, WALLET, oneClick(withRequest({ slippageTolerance: 50 })));
    // no referral, spelled any way 1Click may spell none
    for (const referral of [null, undefined, '']) {
      await checkRoute(msg, swap, WALLET, oneClick(withRequest({ referral })));
    }
    // a higher slippage, when the agent allows it
    const loose = withRequest({ slippageTolerance: 300 });
    await expect(checkRoute(msg, swap, WALLET, oneClick(loose))).rejects.toThrow(/above 100/);
    await checkRoute(msg, swap, WALLET, { ...oneClick(loose), maxSlippageBps: 300 });
    await expect(
      checkRoute(msg, swap, WALLET, { ...oneClick(recorded), maxSlippageBps: -1 }),
    ).rejects.toThrow(/maxSlippageBps/);
    // by default from 1Click itself
    const byDefault = oneClick(recorded);
    await checkRoute(msg, swap, WALLET, byDefault);
    expect(byDefault.asked[0]).toBe(
      `https://1click.chaindefuser.com/v0/status?depositAddress=${DEPOSIT}`,
    );
  });

  it('is refused for any field that is not the operation', async () => {
    const refusals: [string, unknown, RegExp][] = [
      ['another deposit address', withQuote({ depositAddress: 'ab'.repeat(32) }), /depositAddress/],
      ['an exact output', withRequest({ swapType: 'EXACT_OUTPUT' }), /swapType/],
      ['a deposit from another chain', withRequest({ depositType: 'ORIGIN_CHAIN' }), /depositType/],
      ['a deposit by memo', withRequest({ depositMode: 'MEMO' }), /depositMode/],
      ['another amount', withRequest({ amount: '99999999999999999999999' }), /amount/],
      ['another quoted input', withQuote({ amountIn: '99999999999999999999999' }), /amountIn/],
      ['no quoted input', withQuote({ amountIn: undefined }), /amountIn is undefined/],
      ['another input token', withRequest({ originAsset: USDC_NEAR }), /originAsset/],
      ['a referral', withRequest({ referral: 'mallory' }), /referral is set/],
      ['a refund to someone else', withRequest({ refundTo: 'mallory.near' }), /refundTo/],
      ['a refund out of Intents', withRequest({ refundType: 'ORIGIN_CHAIN' }), /refundType/],
      [
        'an app fee',
        withRequest({ appFees: [{ recipient: 'mallory.near', fee: 100 }] }),
        /appFees is not empty/,
      ],
      [
        'a rebate',
        withRequest({ rebates: [{ recipient: 'mallory.near', share: 100 }] }),
        /rebates/,
      ],
      ['a virtual-chain recipient', withRequest({ virtualChainRecipient: '0x1' }), /virtualChain/],
      [
        'a message to the recipient',
        withRequest({ customRecipientMsg: 'x' }),
        /customRecipientMsg/,
      ],
      [
        'another output token',
        withRequest({ destinationAsset: 'nep141:wrap.near' }),
        /destinationAsset/,
      ],
      ['the output to someone else', withRequest({ recipient: 'mallory.near' }), /recipient/],
      [
        'the output to another chain',
        withRequest({ recipientType: 'DESTINATION_CHAIN' }),
        /recipientType/,
      ],
      [
        'the output to confidential Intents',
        withRequest({ recipientType: 'CONFIDENTIAL_INTENTS' }),
        /recipientType/,
      ],
      ['a floor below the operation', withQuote({ minAmountOut: '294524' }), /below the operation/],
      ['no floor', withQuote({ minAmountOut: undefined }), /minAmountOut/],
      ['no quote at all', { status: 'PENDING_DEPOSIT' }, /depositAddress/],
      ['a slippage above 1%', withRequest({ slippageTolerance: 101 }), /slippageTolerance is 101/],
      ['no slippage', withRequest({ slippageTolerance: undefined }), /slippageTolerance is not/],
      ['a slippage as text', withRequest({ slippageTolerance: '100' }), /slippageTolerance is not/],
      ['a confidential quote', withRequest({ confidentiality: 'private' }), /confidentiality/],
      ['a deadline passed', withRequest({ deadline: '2020-01-01T00:00:00.000Z' }), /has passed/],
      ['no deadline', withRequest({ deadline: undefined }), /deadline is not a time/],
      [
        'a deadline more than 24 hours ahead',
        withRequest({ deadline: new Date(Date.now() + 25 * 3600_000).toISOString() }),
        /more than 24 hours ahead/,
      ],
      // an address that has had its deposit, or is used up
      ...[
        'KNOWN_DEPOSIT_TX',
        'PROCESSING',
        'INCOMPLETE_DEPOSIT',
        'SUCCESS',
        'REFUNDED',
        'FAILED',
      ].map((status): [string, unknown, RegExp] => [
        `the status ${status}`,
        { ...recorded, status },
        new RegExp(`status is "${status}"`),
      ]),
      ['no status', { ...recorded, status: undefined }, /status is undefined/],
    ];
    for (const [name, status, why] of refusals) {
      await expect(checkRoute(msg, swap, WALLET, oneClick(status)), name).rejects.toThrow(why);
    }
    // the operation's own floor above the quote's
    const higher = { ...swap, min_out: '294526' };
    await expect(checkRoute(msg, higher, WALLET, oneClick(recorded))).rejects.toThrow(/below/);
    // a quote for another wallet contract
    const other = { ...msg, signer_id: 'trader.alice.near' };
    await expect(checkRoute(other, swap, 'trader.alice.near', oneClick(recorded))).rejects.toThrow(
      /refundTo.*recipient/,
    );
  });

  it('is refused when 1Click cannot be read', async () => {
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(checkRoute(msg, swap, WALLET, { fetch: down })).rejects.toThrow(
      /could not be reached/,
    );
    // 1Click knows no quote for an address the API made up
    const madeUp = toDeposit(swap.token_in, swap.amount_in, 'cd'.repeat(32));
    await expect(checkRoute(madeUp, swap, WALLET, oneClick(recorded))).rejects.toThrow(
      /answered 404/,
    );
    const notJson = (async () => new Response('<html>')) as unknown as typeof fetch;
    await expect(checkRoute(msg, swap, WALLET, { fetch: notJson })).rejects.toThrow(/no JSON/);
  });

  it('reads nothing for an operation that goes through no route', async () => {
    const { asked, fetch } = oneClick(recorded);
    await checkRoute(
      msg,
      { kind: 'intents_transfer', to: DEPOSIT, token: 'nep141:wrap.near', amount: '1' },
      WALLET,
      { fetch },
    );
    expect(asked).toHaveLength(0);
  });
});

describe("a withdrawal's route to another chain", () => {
  const msg = toDeposit(USDC_NEAR, '2500000');

  it('is signed for the same token on the chain the operation names', async () => {
    const { asked, fetch } = oneClick(withdrawStatus());
    await checkRoute(msg, withdraw, WALLET, { fetch });
    expect(asked.map((url) => new URL(url).pathname)).toEqual(['/v0/status', '/v0/tokens']);
    // 1Click's own id of the chain, in any case
    for (const chain of ['eth', 'ETH', ' ethereum ']) {
      await checkRoute(
        msg,
        { ...withdraw, chain } as Operation,
        WALLET,
        oneClick(withdrawStatus()),
      );
    }
  });

  it('is refused for another recipient, another token or another chain', async () => {
    const refusals: [string, unknown, Operation, RegExp][] = [
      [
        'another recipient',
        withdrawStatus({ recipient: '0x2222222222222222222222222222222222222222' }),
        withdraw,
        /recipient/,
      ],
      [
        'delivery inside Intents',
        withdrawStatus({ recipientType: 'INTENTS' }),
        withdraw,
        /recipientType/,
      ],
      [
        'another token on the chain',
        withdrawStatus({ destinationAsset: ETH }),
        withdraw,
        /destinationAsset/,
      ],
      [
        'the token on another chain',
        withdrawStatus({ destinationAsset: USDC_BASE }),
        withdraw,
        /destinationAsset/,
      ],
      [
        'an asset 1Click does not list',
        withdrawStatus({ destinationAsset: 'nep141:fake.near' }),
        withdraw,
        /destinationAsset/,
      ],
      [
        'another chain than the quote',
        withdrawStatus(),
        { ...withdraw, chain: 'base' } as Operation,
        /on base/,
      ],
      [
        'a refund to someone else',
        withdrawStatus({ refundTo: 'mallory.near' }),
        withdraw,
        /refundTo/,
      ],
      ['another amount', withdrawStatus({ amount: '2500001' }), withdraw, /amount is "2500001"/],
      [
        'another quoted input',
        {
          ...withdrawStatus(),
          quoteResponse: {
            ...withdrawStatus().quoteResponse,
            quote: { ...withdrawStatus().quoteResponse.quote, amountIn: '2500001' },
          },
        },
        withdraw,
        /amountIn is "2500001"/,
      ],
      ['a referral', withdrawStatus({ referral: 'mallory' }), withdraw, /referral is set/],
      [
        'a slippage above 1%',
        withdrawStatus({ slippageTolerance: 150 }),
        withdraw,
        /slippageTolerance is 150/,
      ],
      [
        'an address used up',
        { ...withdrawStatus(), status: 'REFUNDED' },
        withdraw,
        /status is "REFUNDED"/,
      ],
    ];
    for (const [name, status, op, why] of refusals) {
      await expect(checkRoute(msg, op, WALLET, oneClick(status)), name).rejects.toThrow(why);
    }
    // an input 1Click does not list has no symbol to match
    const unlisted = TOKENS.filter((t) => t.assetId !== USDC_NEAR);
    await expect(
      checkRoute(msg, withdraw, WALLET, oneClick(withdrawStatus(), unlisted)),
    ).rejects.toThrow(/destinationAsset/);
    await expect(
      checkRoute(msg, withdraw, WALLET, oneClick(withdrawStatus(), { tokens: [] })),
    ).rejects.toThrow(/destinationAsset/);
  });
});

describe('the client and the route', () => {
  const teePublicKey = messages.public_key.slice(64);

  async function teeHalf(msg: RequestMessage): Promise<string> {
    const pkcs8 = fromHex(`302e020100300506032b657004220420${messages.tee_seed}`, 48);
    const tee = await globalThis.crypto.subtle.importKey(
      'pkcs8',
      pkcs8 as BufferSource,
      'Ed25519',
      false,
      ['sign'],
    );
    const signed = new Uint8Array([
      ...new TextEncoder().encode('NEAR_WALLET_TWO_KEY/V1/TEE'),
      ...requestHash(msg),
    ]);
    return toHex(new Uint8Array(await globalThis.crypto.subtle.sign('Ed25519', tee, signed)));
  }

  async function stand(
    status: unknown,
    maxSlippageBps?: number,
    msg = toDeposit(swap.token_in, swap.amount_in),
  ) {
    const prepared: OperationState = {
      id: 'swap-1',
      status: 'awaiting_signature',
      request_hash: 'h',
      message: msg,
      tee_half: await teeHalf(msg),
    };
    const sent: string[] = [];
    const route = oneClick(status);
    const fetch = (async (url: string, init: RequestInit) => {
      if (url.startsWith('https://1click.test')) return route.fetch(url, init);
      sent.push(`${init.method} ${new URL(url).pathname}`);
      return new Response(JSON.stringify({ ...prepared, status: 'success', message: undefined }));
    }) as unknown as typeof globalThis.fetch;
    const client = new WalletContract({
      account: WALLET,
      key: await AgentKey.fromSeed(fromHex(messages.agent_seed, 32)),
      teePublicKey,
      oneClickUrl: 'https://1click.test',
      ...(maxSlippageBps === undefined ? {} : { maxSlippageBps }),
      fetch,
      baseUrl: 'https://api.test',
    });
    return { client, prepared, sent, asked: route.asked };
  }

  it("signs a swap whose route is 1Click's quote of it", async () => {
    const { client, prepared, sent, asked } = await stand(recorded);
    expect((await client.relay(prepared, swap)).status).toBe('success');
    expect(asked).toHaveLength(1);
    expect(sent).toEqual(['POST /wallet/contract/v1/operations/swap-1/relay']);
  });

  it('checks the route once per request: sent again, the request signed already is not read again', async () => {
    const { client, prepared, sent, asked } = await stand(recorded);
    await client.relay(prepared, swap);
    // the deposit has reached the address since: a second relay of the same request goes on
    await client.relay(prepared, swap);
    expect(asked).toHaveLength(1);
    expect(sent).toHaveLength(2);
  });

  it('signs nothing for a route whose slippage is above the limit, unless the agent allows it', async () => {
    const loose = withRequest({ slippageTolerance: 200 });
    const strict = await stand(loose);
    await expect(strict.client.relay(strict.prepared, swap)).rejects.toThrow(/above 100/);
    expect(strict.sent).toHaveLength(0);
    // refused first: the next relay of the same request checks again
    await expect(strict.client.relay(strict.prepared, swap)).rejects.toThrow(/above 100/);
    expect(strict.asked).toHaveLength(2);
    const allowing = await stand(loose, 200);
    expect((await allowing.client.relay(allowing.prepared, swap)).status).toBe('success');
  });

  it('signs nothing for a route to another recipient', async () => {
    const { client, prepared, sent } = await stand(withRequest({ recipient: 'mallory.near' }));
    await expect(client.relay(prepared, swap)).rejects.toThrow(/Nothing was signed/);
    expect(sent).toHaveLength(0);
  });

  it("signs a withdrawal to another chain whose route is 1Click's quote of it", async () => {
    const msg = toDeposit(USDC_NEAR, '2500000');
    const { client, prepared, sent, asked } = await stand(withdrawStatus(), undefined, msg);
    expect((await client.relay(prepared, withdraw)).status).toBe('success');
    expect(asked.map((url) => new URL(url).pathname)).toEqual(['/v0/status', '/v0/tokens']);
    expect(sent).toEqual(['POST /wallet/contract/v1/operations/swap-1/relay']);
  });

  it('signs nothing for a withdrawal whose route delivers to another address or another chain', async () => {
    const msg = toDeposit(USDC_NEAR, '2500000');
    const elsewhere = await stand(
      withdrawStatus({ recipient: '0x2222222222222222222222222222222222222222' }),
      undefined,
      msg,
    );
    await expect(elsewhere.client.relay(elsewhere.prepared, withdraw)).rejects.toThrow(
      /recipient is .*Nothing was signed/,
    );
    expect(elsewhere.sent).toHaveLength(0);
    const otherChain = await stand(withdrawStatus({ destinationAsset: USDC_BASE }), undefined, msg);
    await expect(otherChain.client.relay(otherChain.prepared, withdraw)).rejects.toThrow(
      /destinationAsset .*Nothing was signed/,
    );
    expect(otherChain.sent).toHaveLength(0);
  });
});
