/**
 * Confidential Intents round-trip: SHIELD → read balance → UNSHIELD.
 *
 * Run:
 *   OUTLAYER_API_KEY=wk_... npx tsx examples/06-confidential-roundtrip.ts
 *
 * Demonstrates:
 *   - SHIELD a public intents balance into the confidential shard (async)
 *   - Read the confidential balance (single + full list)
 *   - UNSHIELD back to the public intents balance (async)
 *   - Graceful handling of `503 confidential_unavailable`
 *
 * Prerequisite: the wallet needs a PUBLIC intents balance of `TOKEN` to shield.
 * If you only hold NEAR, first wrap it and deposit into intents.near:
 *   await client.call({ contract_id: 'wrap.near', method: 'near_deposit', args: {}, deposit: AMOUNT });
 *   await client.intentsDeposit({ token: TOKEN, amount: AMOUNT });
 *
 * NOTE: SHIELD/UNSHIELD publicly link your wallet to the shielded pool. For the
 * privacy-preserving path use cross-chain deposit/withdraw — see the README.
 */

import {
  OutlayerClient,
  OutlayerError,
  PolicyDeniedError,
  WalletFrozenError,
  type ConfidentialOpResponse,
} from '../src/index.js';

const apiKey = process.env.OUTLAYER_API_KEY;
if (!apiKey) {
  console.error('Set OUTLAYER_API_KEY=wk_... before running');
  process.exit(1);
}

const client = new OutlayerClient({ apiKey });

const TOKEN = 'nep141:wrap.near';
const AMOUNT = '10000000000000000000000'; // 0.01 wNEAR

async function main(): Promise<void> {
  // 1. SHIELD — public intents → confidential shard (async)
  console.log('━━━ SHIELD ━━━');
  let shield: ConfidentialOpResponse;
  try {
    shield = await client.confidentialDeposit({ token: TOKEN, amount: AMOUNT });
  } catch (err) {
    if (err instanceof OutlayerError && err.code === 'confidential_unavailable') {
      console.log('Confidential intents are not enabled on this deployment — nothing to do.');
      return;
    }
    if (err instanceof PolicyDeniedError) {
      console.error('Policy rejected the shield:', err.message);
      return;
    }
    if (err instanceof WalletFrozenError) {
      console.error('Wallet is frozen — contact the controller');
      return;
    }
    throw err;
  }
  console.log('Request ID:  ', shield.request_id);
  console.log('Status:      ', shield.status);
  await poll(shield.request_id, 'shield');

  // 2. Read the confidential balance — single asset, then the full list
  console.log('\n━━━ Confidential balance ━━━');
  const one = await client.confidentialBalance({ token: TOKEN });
  if (!('balances' in one)) {
    console.log(`${one.token}:`, one.balance, `(account ${one.account_id})`);
  }
  const all = await client.confidentialBalance();
  if ('balances' in all) {
    console.log('All confidential balances:');
    for (const b of all.balances) console.log(' ', b.token, b.balance);
  }

  // 3. UNSHIELD — confidential shard → public intents (async)
  console.log('\n━━━ UNSHIELD ━━━');
  const unshield = await client.confidentialUnshield({ token: TOKEN, amount: AMOUNT });
  console.log('Request ID:  ', unshield.request_id);
  console.log('Status:      ', unshield.status);
  await poll(unshield.request_id, 'unshield');
}

async function poll(requestId: string, label: string): Promise<void> {
  console.log(`Polling ${label}…`);
  for (let i = 0; i < 60; i++) {
    const status = await client.getRequest(requestId);
    console.log(`[${label} ${i}] ${status.status}`, status.result ?? '');
    if (status.status === 'success' || status.status === 'failed' || status.status === 'refunded') return;
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
