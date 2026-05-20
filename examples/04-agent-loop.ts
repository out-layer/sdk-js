/**
 * Minimal autonomous agent loop.
 *
 * Run:
 *   OUTLAYER_API_KEY=wk_... npx tsx examples/04-agent-loop.ts
 *
 * This is the smallest plausible "AI agent with custody" — checks balance,
 * decides whether to act, and respects the policy. The agent has no
 * superpowers: every action goes through the TEE-enforced policy. If a
 * spending limit or rate limit kicks in, the agent sees a typed error
 * and backs off.
 *
 * In a real agent you'd replace the `shouldRebalance` and `decideTarget`
 * functions with whatever signal source you use (LLM, price feed, etc.).
 */

import { OutlayerClient, PolicyDeniedError, RateLimitedError } from '../src/index.js';

const apiKey = process.env.OUTLAYER_API_KEY;
if (!apiKey) {
  console.error('Set OUTLAYER_API_KEY=wk_... before running');
  process.exit(1);
}

const client = new OutlayerClient({
  apiKey,
  retry: { maxAttempts: 5, initialDelayMs: 200, maxDelayMs: 4000 },
});

const TICK_MS = 30_000;
const ALLOWED_TARGETS = ['rebalance-vault.near', 'treasury.near'];

async function main(): Promise<void> {
  console.log('Agent starting…');
  while (true) {
    try {
      await tick();
    } catch (err) {
      console.error('Tick error:', err);
    }
    await sleep(TICK_MS);
  }
}

async function tick(): Promise<void> {
  const balance = await client.getBalance({ chain: 'near' });
  console.log(`[${new Date().toISOString()}] Balance: ${balance.balance} NEAR (yocto)`);

  if (!shouldRebalance(balance.balance)) return;

  const target = decideTarget();
  if (!ALLOWED_TARGETS.includes(target)) {
    console.log(`Target ${target} not in agent allowlist — skipping`);
    return;
  }

  const amount = '1000000000000000000000000'; // 1 NEAR

  try {
    const result = await client.transfer({ chain: 'near', receiver_id: target, amount });
    console.log(`Transferred 1 NEAR → ${target}, request ${result.request_id}, ${result.status}`);
    if (result.status === 'pending_approval') {
      // Don't poll forever; let the controller handle it
      console.log(`Pending approval ${result.approval_id} — leaving for controller`);
    }
  } catch (err) {
    if (err instanceof PolicyDeniedError) {
      console.log(`Policy denied: ${err.message}. Pausing for an hour.`);
      await sleep(60 * 60 * 1000);
      return;
    }
    if (err instanceof RateLimitedError) {
      console.log('Rate-limited. Pausing 5 minutes.');
      await sleep(5 * 60 * 1000);
      return;
    }
    throw err;
  }
}

/**
 * Replace with real logic. Here: rebalance if balance > 100 NEAR.
 */
function shouldRebalance(balanceYocto: string): boolean {
  const threshold = BigInt('100000000000000000000000000');
  return BigInt(balanceYocto) > threshold;
}

/**
 * Replace with real logic. Here: round-robin between allowed targets.
 */
function decideTarget(): string {
  return ALLOWED_TARGETS[Math.floor(Math.random() * ALLOWED_TARGETS.length)] ?? '';
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
