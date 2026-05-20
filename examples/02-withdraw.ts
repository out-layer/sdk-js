/**
 * Withdraw across chains via NEAR Intents (gasless).
 *
 * Run:
 *   OUTLAYER_API_KEY=wk_... npx tsx examples/02-withdraw.ts
 *
 * Demonstrates:
 *   - Dry-run first to check policy + balance without spending gas
 *   - Withdraw with typed error handling
 *   - Polling for async settlement
 */

import {
  OutlayerClient,
  PolicyDeniedError,
  WalletFrozenError,
  RateLimitedError,
  type Chain,
} from '../src/index.js';

const apiKey = process.env.OUTLAYER_API_KEY;
if (!apiKey) {
  console.error('Set OUTLAYER_API_KEY=wk_... before running');
  process.exit(1);
}

const client = new OutlayerClient({ apiKey });

async function main(): Promise<void> {
  const withdrawArgs = {
    chain: 'ethereum' as Chain,
    to: '0x742d35Cc6634C0532925a3b844Bc9e7595f8b4f5',
    amount: '1000000', // 1 USDT (6 decimals)
    token: 'nep141:usdt.tether-token.near',
  };

  // 1. Dry-run — checks policy + balance without executing
  console.log('━━━ Dry run ━━━');
  const dry = await client.withdrawDryRun(withdrawArgs);
  console.log('Would succeed:    ', dry.would_succeed);
  console.log('Estimated fee:    ', dry.estimated_fee, dry.fee_token);
  console.log('Policy decision:  ', dry.policy_check?.decision);

  if (!dry.would_succeed) {
    console.log('Aborting — dry-run failed:', dry.reason ?? dry.message);
    return;
  }

  // 2. Execute
  console.log('\n━━━ Executing ━━━');
  let result;
  try {
    result = await client.withdraw(withdrawArgs);
  } catch (err) {
    if (err instanceof PolicyDeniedError) {
      console.error('Policy rejected:', err.message);
      return;
    }
    if (err instanceof WalletFrozenError) {
      console.error('Wallet is frozen — contact the controller');
      return;
    }
    if (err instanceof RateLimitedError) {
      console.error('Rate-limited, try later');
      return;
    }
    throw err;
  }

  console.log('Request ID:  ', result.request_id);
  console.log('Status:      ', result.status);

  if (result.status === 'pending_approval') {
    console.log(
      `\nAwaiting ${result.required} multisig approvals (${result.approved ?? 0} so far).`,
    );
    console.log('See examples/03-multisig.ts for the approval flow.');
    return;
  }

  // 3. Poll until settled
  console.log('\n━━━ Polling ━━━');
  for (let i = 0; i < 60; i++) {
    const status = await client.getRequest(result.request_id);
    console.log(`[${i}] ${status.status}`, status.result ?? '');
    if (status.status === 'success' || status.status === 'failed') break;
    await sleep(2000);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
