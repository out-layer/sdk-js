/**
 * Cross-chain DeFi app — login, deposit, buy NEAR, stake, withdraw to ETH.
 *
 * This is one custody wallet driving an end-to-end flow across chains. The
 * wallet has addresses on NEAR, Ethereum, Solana, and Bitcoin (all derived
 * from the same wallet_id in the TEE), and all signing happens behind the
 * API key.
 *
 * Run:
 *   OUTLAYER_API_KEY=wk_... npx tsx examples/05-cross-chain-app.ts <command>
 *
 *   Commands:
 *     addresses      Show derived addresses on all chains
 *     balances       Show on-chain + intents.near balances
 *     deposit-info   Print where to send funds from external wallets
 *     buy-near       Swap intents-USDT → wNEAR → unwrap to native NEAR
 *     stake          Stake NEAR with a validator
 *     unstake        Unstake (4-epoch unlock window applies)
 *     withdraw-eth   Convert NEAR → USDT, bridge to Ethereum (gasless)
 *     login-demo     Show the cross-chain identity primitive (no UI)
 *
 * What about login? The wallet is a single identity with addresses on every
 * supported chain. Your app can let a user sign in via SIWE (Ethereum),
 * SIWS (Solana), NEAR Wallet Selector, or BIP-322 (Bitcoin) — your backend
 * maps the verified address back to the OutLayer wallet it minted for that
 * user. See login-demo for the conceptual flow.
 */

import { OutlayerClient, PolicyDeniedError, type RequestStatusResponse } from '../src/index.js';

const apiKey = process.env.OUTLAYER_API_KEY;
if (!apiKey) {
  console.error('Set OUTLAYER_API_KEY=wk_... before running');
  console.error('Get one via examples/01-register.ts');
  process.exit(1);
}

const client = new OutlayerClient({ apiKey });

// ---------------------------------------------------------------------------
// Constants — tune per environment
// ---------------------------------------------------------------------------

const VALIDATOR = process.env.VALIDATOR ?? 'astro-stakers.poolv1.near';
const ETH_RECEIVER = process.env.ETH_RECEIVER ?? '';

const USDT = 'nep141:usdt.tether-token.near';
const WNEAR = 'nep141:wrap.near';

const ONE_NEAR_YOCTO = '1000000000000000000000000'; // 10^24
const ONE_USDT = '1000000'; // 10^6

// ---------------------------------------------------------------------------
// CLI dispatch
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? 'help';
  switch (cmd) {
    case 'addresses':    return showAddresses();
    case 'balances':     return showBalances();
    case 'deposit-info': return showDepositInfo();
    case 'buy-near':     return buyNear(ONE_USDT.repeat(1)); // 10 USDT below
    case 'stake':        return stakeNear(ONE_NEAR_YOCTO);
    case 'unstake':      return unstakeNear();
    case 'withdraw-eth': return withdrawToEth(ONE_NEAR_YOCTO);
    case 'login-demo':   return loginDemo();
    default: printUsage();
  }
}

function printUsage(): void {
  console.log(
    'Commands:',
    'addresses, balances, deposit-info, buy-near, stake, unstake, withdraw-eth, login-demo',
  );
}

// ---------------------------------------------------------------------------
// 1. Cross-chain identity
// ---------------------------------------------------------------------------

/**
 * The SDK exposes the wallet's address on every supported chain. The same
 * wallet_id always derives the same address per chain (deterministic
 * HMAC-SHA256 inside the TEE).
 *
 * This is the "cross-chain login" primitive — your app's backend can let
 * users authenticate with whichever chain wallet they have, and map each
 * verified address back to the OutLayer wallet you've minted for them.
 */
async function showAddresses(): Promise<void> {
  console.log('━━━ Cross-chain addresses (same wallet_id) ━━━\n');
  for (const chain of ['near', 'ethereum', 'solana', 'bitcoin'] as const) {
    try {
      const a = await client.getAddress(chain);
      console.log(`${chain.padEnd(10)} ${a.address}`);
      if (a.vault_id) console.log(`           vault: ${a.vault_id}`);
    } catch (e) {
      console.log(`${chain.padEnd(10)} (unavailable: ${(e as Error).message})`);
    }
  }
}

async function loginDemo(): Promise<void> {
  console.log('━━━ Cross-chain login pattern ━━━\n');
  console.log(`This SDK doesn't ship a login UI — that's frontend territory.`);
  console.log('The backend recipe:\n');
  console.log('1. Frontend asks user to sign a typed message with any chain wallet:');
  console.log('   - Ethereum: EIP-4361 (Sign-In with Ethereum / SIWE)');
  console.log('   - Solana:   Sign-In with Solana / SIWS');
  console.log('   - NEAR:     near-wallet-selector + signMessage (NEP-413)');
  console.log('   - Bitcoin:  BIP-322\n');
  console.log('2. Backend verifies the signature off-chain (no RPC needed).\n');
  console.log('3. Backend looks up the verified address in your `users` table:');
  console.log('   - First-time: call OutlayerClient.register() and store the API key');
  console.log('     mapped to (chain, verified_address)');
  console.log('   - Returning:  fetch the stored API key');
  console.log('4. Issue a session cookie. Subsequent server-side calls use the API key.\n');
  console.log('Why this works: every OutLayer wallet has addresses on all four chains,');
  console.log('so the SAME wallet can be looked up by ANY of the user\'s chain wallets.');
  console.log('No "chain switch" needed — the user is always one logical entity.\n');

  console.log('Your wallet\'s addresses for cross-chain lookup:');
  await showAddresses();
}

// ---------------------------------------------------------------------------
// 2. Balances
// ---------------------------------------------------------------------------

async function showBalances(): Promise<void> {
  console.log('━━━ Balances ━━━\n');
  const onChain = await client.getBalance({ chain: 'near', source: 'chain' });
  const onIntents = await client.getBalance({ chain: 'near', source: 'intents' });
  console.log(`Native NEAR:           ${formatNear(onChain.balance)} NEAR`);
  console.log(`In intents.near:       ${formatNear(onIntents.balance)} NEAR-equivalent`);
  console.log('(USDT in intents.near is shown via /balance?token=...usdt...)');
}

// ---------------------------------------------------------------------------
// 3. Deposit instructions (cross-chain in)
// ---------------------------------------------------------------------------

/**
 * Cross-chain DEPOSIT — moving funds from an external chain into the
 * wallet's intents.near balance — is currently a bridge-side operation.
 * The SDK doesn't have a /deposit endpoint yet (planned for v0.2); for
 * now, use the established bridges:
 *
 *   - Ethereum → NEAR: https://bridge.aurora.dev or https://rainbowbridge.app
 *   - Solana → NEAR: https://allbridge.io or https://wormhole.com
 *   - Bitcoin → NEAR: NEAR Chain Signatures (via NEAR intents)
 *
 * Once the bridged token lands as a NEP-141 on the user's NEAR address,
 * call intentsDeposit() to move it into intents.near for swaps + gasless
 * cross-chain withdrawal.
 */
async function showDepositInfo(): Promise<void> {
  console.log('━━━ Deposit instructions ━━━\n');
  const near = await client.getAddress('near');
  console.log('Direct NEAR / NEP-141 deposits:');
  console.log(`  Send to: ${near.address}\n`);
  console.log('Cross-chain deposits (Ethereum, Solana, Bitcoin):');
  console.log('  1. Bridge tokens to NEAR via one of:');
  console.log('     - https://bridge.aurora.dev  (Ethereum ↔ NEAR via Rainbow Bridge)');
  console.log('     - https://wormhole.com       (Solana, Ethereum, BSC, etc.)');
  console.log('     - https://allbridge.io       (multi-chain)');
  console.log(`  2. Bridge to NEAR address: ${near.address}`);
  console.log('  3. Once token is NEP-141 on NEAR, deposit into intents.near:');
  console.log('     await client.intentsDeposit({ token, amount });');
}

// ---------------------------------------------------------------------------
// 4. Buy NEAR — swap intents-USDT → wNEAR → unwrap
// ---------------------------------------------------------------------------

async function buyNear(usdtAmount: string): Promise<void> {
  console.log(`━━━ Buying NEAR with ${formatUsdt(usdtAmount)} USDT ━━━\n`);

  // 1. Quote
  console.log('Step 1/4 — quote');
  const quote = await client.swapQuote({
    token_in: USDT,
    token_out: WNEAR,
    amount_in: usdtAmount,
  });
  console.log(`  expect ${formatNear(quote.amount_out ?? '0')} wNEAR`);
  console.log(`  min    ${formatNear(quote.min_amount_out ?? '0')} wNEAR (slippage floor)`);
  console.log(`  eta    ${quote.time_estimate_seconds ?? '?'} s\n`);

  // 2. Execute swap
  console.log('Step 2/4 — swap');
  const swap = await tryPolicy(() =>
    client.swap({
      token_in: USDT,
      token_out: WNEAR,
      amount_in: usdtAmount,
      min_amount_out: quote.min_amount_out ?? '0',
    }),
  );
  if (!swap) return;
  await pollUntilDone(swap.request_id);
  const wnearOut = swap.amount_out ?? quote.amount_out ?? '0';
  console.log(`  got ${formatNear(wnearOut)} wNEAR\n`);

  // 3. Unwrap wNEAR → NEAR
  console.log('Step 3/4 — unwrap to native NEAR');
  const unwrap = await tryPolicy(() =>
    client.call({
      receiver_id: 'wrap.near',
      method_name: 'near_withdraw',
      args: { amount: wnearOut },
      gas: '30000000000000',
      deposit: '1',
    }),
  );
  if (!unwrap) return;
  await pollUntilDone(unwrap.request_id);
  console.log('  unwrapped\n');

  // 4. Confirm
  console.log('Step 4/4 — confirm new balance');
  const balance = await client.getBalance({ chain: 'near' });
  console.log(`  native NEAR balance: ${formatNear(balance.balance)} NEAR`);
}

// ---------------------------------------------------------------------------
// 5. Stake NEAR
// ---------------------------------------------------------------------------

async function stakeNear(amountYocto: string): Promise<void> {
  console.log(`━━━ Staking ${formatNear(amountYocto)} NEAR with ${VALIDATOR} ━━━\n`);

  const stake = await tryPolicy(() =>
    client.call({
      receiver_id: VALIDATOR,
      method_name: 'deposit_and_stake',
      args: {},
      gas: '100000000000000', // 100 TGas
      deposit: amountYocto,
    }),
  );
  if (!stake) return;
  await pollUntilDone(stake.request_id);
  console.log('Staked. Verify on-chain at:');
  const near = await client.getAddress('near');
  console.log(`  https://nearblocks.io/address/${VALIDATOR}#staking?account=${near.address}`);
}

async function unstakeNear(): Promise<void> {
  console.log(`━━━ Unstaking from ${VALIDATOR} ━━━\n`);

  const unstake = await tryPolicy(() =>
    client.call({
      receiver_id: VALIDATOR,
      method_name: 'unstake_all',
      args: {},
      gas: '100000000000000',
    }),
  );
  if (!unstake) return;
  await pollUntilDone(unstake.request_id);
  console.log('Unstake submitted.\n');
  console.log('Funds release after the validator\'s unlock window (typically 4 epochs ≈ 36–48h).');
  console.log('After the window:');
  console.log(`  await client.call({ receiver_id: '${VALIDATOR}', method_name: 'withdraw_all', args: {} });`);
}

// ---------------------------------------------------------------------------
// 6. Withdraw — NEAR → wNEAR → USDT → Ethereum (gasless on both sides)
// ---------------------------------------------------------------------------

async function withdrawToEth(amountYocto: string): Promise<void> {
  if (!ETH_RECEIVER) {
    console.error('Set ETH_RECEIVER=0x... before running withdraw-eth');
    process.exit(1);
  }
  console.log(`━━━ Withdrawing ${formatNear(amountYocto)} NEAR worth to ${ETH_RECEIVER} (Ethereum) ━━━\n`);

  // 1. Wrap NEAR → wNEAR (so it's a NEP-141 we can deposit into intents.near)
  console.log('Step 1/5 — wrap NEAR');
  const wrap = await tryPolicy(() =>
    client.call({
      receiver_id: 'wrap.near',
      method_name: 'near_deposit',
      args: {},
      gas: '30000000000000',
      deposit: amountYocto,
    }),
  );
  if (!wrap) return;
  await pollUntilDone(wrap.request_id);

  // 2. Deposit wNEAR into intents.near
  console.log('Step 2/5 — deposit into intents.near');
  const dep = await tryPolicy(() => client.intentsDeposit({ token: 'wrap.near', amount: amountYocto }));
  if (!dep) return;
  await pollUntilDone(dep.request_id);

  // 3. Quote wNEAR → USDT
  console.log('Step 3/5 — quote swap');
  const quote = await client.swapQuote({
    token_in: WNEAR,
    token_out: USDT,
    amount_in: amountYocto,
  });
  console.log(`  expect ${formatUsdt(quote.amount_out ?? '0')} USDT (min ${formatUsdt(quote.min_amount_out ?? '0')})`);

  // 4. Swap wNEAR → USDT
  console.log('Step 4/5 — execute swap');
  const swap = await tryPolicy(() =>
    client.swap({
      token_in: WNEAR,
      token_out: USDT,
      amount_in: amountYocto,
      min_amount_out: quote.min_amount_out ?? '0',
    }),
  );
  if (!swap) return;
  await pollUntilDone(swap.request_id);
  const usdtOut = swap.amount_out ?? quote.amount_out ?? '0';

  // 5. Gasless cross-chain withdraw to ETH
  console.log('Step 5/5 — gasless cross-chain withdraw');
  const withdraw = await tryPolicy(() =>
    client.withdraw({
      chain: 'ethereum',
      to: ETH_RECEIVER,
      amount: usdtOut,
      token: USDT,
    }),
  );
  if (!withdraw) return;
  if (withdraw.status === 'pending_approval') {
    console.log(`Pending approval ${withdraw.approval_id} (${withdraw.approved}/${withdraw.required})`);
    console.log('Run examples/03-multisig.ts to approve.');
    return;
  }
  const settled = await pollUntilDone(withdraw.request_id);
  console.log(`\nDone. ${formatUsdt(usdtOut)} USDT sent to ${ETH_RECEIVER}`);
  console.log(`Settlement: ${settled.result ?? 'see request status'}`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function tryPolicy<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof PolicyDeniedError) {
      console.error(`Policy denied: ${e.message}`);
      return undefined;
    }
    throw e;
  }
}

async function pollUntilDone(requestId: string): Promise<RequestStatusResponse> {
  for (let i = 0; i < 90; i++) {
    const status = await client.getRequest(requestId);
    if (status.status === 'success' || status.status === 'failed') {
      return status;
    }
    if (status.status === 'pending_approval') {
      throw new Error(`Request ${requestId} requires multisig approval`);
    }
    await sleep(2000);
  }
  throw new Error(`Request ${requestId} timed out after 3 minutes`);
}

function formatNear(yocto: string): string {
  const n = BigInt(yocto);
  const int = n / 10n ** 24n;
  const frac = n % 10n ** 24n;
  return `${int}.${frac.toString().padStart(24, '0').slice(0, 4)}`;
}

function formatUsdt(units: string): string {
  const n = BigInt(units);
  const int = n / 1_000_000n;
  const frac = n % 1_000_000n;
  return `${int}.${frac.toString().padStart(6, '0').slice(0, 2)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
