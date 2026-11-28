/**
 * The 1Click route of a swap and of a withdrawal to another chain, read from
 * 1Click itself before the agent signs.
 *
 * Such an operation sends its input to a 1Click deposit address, and the
 * address comes from the API: an API that put an address of its own quote
 * there would receive the input. So the agent asks 1Click what the address was
 * quoted for and signs only a quote that is the operation: the same input, the
 * output to the wallet contract (a swap) or to the operation's recipient on
 * its chain (a withdrawal), refunds to the wallet contract, and no share for
 * anyone else. 1Click is trusted for what it quoted, as it is for the swap.
 */

import { CustodyError } from './errors.js';
import { type Operation, type RequestMessage, depositAddressOf } from './message.js';

/** 1Click's API: where a route is read from by default. */
export const ONE_CLICK_URL = 'https://1click.chaindefuser.com';

/**
 * 1Click's id of a chain as an operation may name it: the long names the API
 * takes, folded as the API folds them. Any other name is 1Click's id itself.
 */
const BLOCKCHAIN_IDS: Record<string, string> = {
  ethereum: 'eth',
  solana: 'sol',
  arbitrum: 'arb',
  bitcoin: 'btc',
  polygon: 'pol',
  optimism: 'op',
  avalanche: 'avax',
  zcash: 'zec',
  dogecoin: 'doge',
  litecoin: 'ltc',
  bitcoincash: 'bch',
  berachain: 'bera',
};

/** 1Click's id of the chain `chain`. */
export function blockchainId(chain: string): string {
  const lower = chain.trim().toLowerCase();
  return BLOCKCHAIN_IDS[lower] ?? lower;
}

/**
 * How far ahead the deadline of the quote's request (`quoteRequest.deadline`)
 * may be: 24 hours. That deadline is what the requester asked 1Click for, and
 * the API asks for one 600 seconds ahead, so a request whose deadline is far
 * ahead is not the API's request for this operation. 1Click's own
 * `quote.deadline`, which it sets days ahead on every quote, is not read.
 */
const MAX_DEADLINE_AHEAD_MS = 24 * 60 * 60 * 1000;

/** The slippage a quote may carry by default, in basis points: what the API asks 1Click for. */
export const MAX_SLIPPAGE_BPS = 100;

export interface RouteOptions {
  /** {@link ONE_CLICK_URL} by default. */
  oneClickUrl?: string;
  /**
   * The most slippage the quote may carry, in basis points (1/100 of a
   * percent): {@link MAX_SLIPPAGE_BPS} by default.
   */
  maxSlippageBps?: number;
  fetch?: typeof fetch;
}

type Json = Record<string, unknown>;

async function read(doFetch: typeof fetch, url: string): Promise<unknown> {
  let response: Response;
  try {
    response = await doFetch(url, { method: 'GET' });
  } catch (error) {
    throw new CustodyError(
      `1Click could not be reached to check the route (${error instanceof Error ? error.message : String(error)}); nothing was signed`,
    );
  }
  if (!response.ok) {
    throw new CustodyError(
      `1Click answered ${response.status} when the route was checked; nothing was signed`,
    );
  }
  try {
    return await response.json();
  } catch {
    throw new CustodyError('1Click answered the route check with no JSON; nothing was signed');
  }
}

const isNone = (value: unknown) => value === undefined || value === null;
const isNoList = (value: unknown) => isNone(value) || (Array.isArray(value) && value.length === 0);

/**
 * Throws unless the 1Click quote of the request's deposit address is the
 * operation `op` of the wallet contract `account`. Operations that go through
 * no route pass with nothing read.
 */
export async function checkRoute(
  msg: RequestMessage,
  op: Operation,
  account: string,
  options: RouteOptions = {},
): Promise<void> {
  if (op.kind !== 'swap' && op.kind !== 'cross_chain_withdraw') return;
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const base = (options.oneClickUrl ?? ONE_CLICK_URL).replace(/\/+$/, '');
  const address = depositAddressOf(msg);
  if (address === null) {
    throw new CustodyError('the request names no deposit address; nothing was signed');
  }
  const maxSlippage = options.maxSlippageBps ?? MAX_SLIPPAGE_BPS;
  if (!Number.isInteger(maxSlippage) || maxSlippage < 0) {
    throw new CustodyError('`maxSlippageBps` is a whole number of basis points');
  }

  const status = (await read(
    doFetch,
    `${base}/v0/status?depositAddress=${encodeURIComponent(address)}`,
  )) as Json | null;
  const quoteResponse = (status?.quoteResponse ?? {}) as Json;
  const request = (quoteResponse.quoteRequest ?? {}) as Json;
  const quote = (quoteResponse.quote ?? {}) as Json;

  const [token, amount] = op.kind === 'swap' ? [op.token_in, op.amount_in] : [op.token, op.amount];
  const wrong: string[] = [];
  const expect = (field: string, got: unknown, wanted: string) => {
    if (got !== wanted)
      wrong.push(`${field} is ${JSON.stringify(got)}, not ${JSON.stringify(wanted)}`);
  };
  // An address whose quote is still waiting for its deposit: a later status
  // means a deposit reached it already, and a finished one is used up. The
  // deadline checked is the one the quote was requested with
  // (`quoteRequest.deadline`): not passed, and no further than 24 hours
  // ahead. A second relay of a request already signed is not checked again
  // (`WalletContract.relay`).
  if (status?.status !== 'PENDING_DEPOSIT') {
    wrong.push(
      `the status is ${JSON.stringify(status?.status)}, not "PENDING_DEPOSIT": the address has had its deposit`,
    );
  } else {
    const deadline =
      typeof request.deadline === 'string' ? Date.parse(request.deadline) : Number.NaN;
    if (Number.isNaN(deadline)) wrong.push('deadline is not a time');
    else if (deadline <= Date.now())
      wrong.push(`the quote's deadline ${request.deadline} has passed`);
    else if (deadline > Date.now() + MAX_DEADLINE_AHEAD_MS)
      wrong.push(`the quote's deadline ${request.deadline} is more than 24 hours ahead`);
  }
  expect('depositAddress', quote.depositAddress, address);
  expect('swapType', request.swapType, 'EXACT_INPUT');
  expect('depositType', request.depositType, 'INTENTS');
  if (!isNone(request.depositMode)) expect('depositMode', request.depositMode, 'SIMPLE');
  expect('amount', request.amount, amount);
  // The request sends exactly the operation's amount, so the quote is for it.
  expect('amountIn', quote.amountIn, amount);
  expect('originAsset', request.originAsset, token);
  expect('refundTo', request.refundTo, account);
  expect('refundType', request.refundType, 'INTENTS');
  const slippage = request.slippageTolerance;
  if (typeof slippage !== 'number' || !Number.isFinite(slippage)) {
    wrong.push('slippageTolerance is not a number');
  } else if (slippage > maxSlippage) {
    wrong.push(`slippageTolerance is ${slippage} basis points, above ${maxSlippage}`);
  }
  if (!isNone(request.confidentiality))
    expect('confidentiality', request.confidentiality, 'public');
  // Nothing of the input or the output goes to anyone else.
  for (const field of ['appFees', 'rebates']) {
    if (!isNoList(request[field])) wrong.push(`${field} is not empty`);
  }
  for (const field of [
    'customRecipientMsg',
    'virtualChainRecipient',
    'virtualChainRefundRecipient',
  ]) {
    if (!isNone(request[field])) wrong.push(`${field} is set`);
  }
  if (!isNone(request.referral) && request.referral !== '') wrong.push('referral is set');

  if (op.kind === 'swap') {
    expect('destinationAsset', request.destinationAsset, op.token_out);
    expect('recipient', request.recipient, account);
    expect('recipientType', request.recipientType, 'INTENTS');
    const minOut = quote.minAmountOut;
    if (typeof minOut !== 'string' || !/^[0-9]+$/.test(minOut)) {
      wrong.push('minAmountOut is not a decimal number');
    } else if (BigInt(minOut) < BigInt(op.min_out)) {
      wrong.push(`minAmountOut is ${minOut}, below the operation's ${op.min_out}`);
    }
  } else {
    expect('recipient', request.recipient, op.to);
    expect('recipientType', request.recipientType, 'DESTINATION_CHAIN');
    if (wrong.length === 0) {
      const tokens = await read(doFetch, `${base}/v0/tokens`);
      const listed = Array.isArray(tokens) ? (tokens as Json[]) : [];
      const symbol = listed.find((t) => t?.assetId === token)?.symbol;
      const chain = blockchainId(op.chain);
      const same = listed.some(
        (t) =>
          t?.assetId === request.destinationAsset &&
          t?.blockchain === chain &&
          typeof symbol === 'string' &&
          typeof t?.symbol === 'string' &&
          t.symbol.toLowerCase() === symbol.toLowerCase(),
      );
      if (!same) {
        wrong.push(
          `destinationAsset ${JSON.stringify(request.destinationAsset)} is not, in 1Click's tokens, ${typeof symbol === 'string' ? symbol : token} on ${chain}`,
        );
      }
    }
  }

  if (wrong.length > 0) {
    throw new CustodyError(
      `1Click's quote for the deposit address ${address} is not the operation: ${wrong.join('; ')}. Nothing was signed`,
    );
  }
}
