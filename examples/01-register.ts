/**
 * Register a new wallet and inspect what you got.
 *
 * Run: npx tsx examples/01-register.ts
 *
 * Expected output: an API key, addresses on 4 chains, and current balance.
 * The API key is shown once — save it. Trial limits apply until you set a
 * policy via the dashboard.
 */

import { OutlayerClient } from '../src/index.js';

async function main(): Promise<void> {
  // No auth needed for register.
  //
  // For sovereign custody, pass an already-deployed vault id:
  //   const result = await OutlayerClient.register({ vaultId: 'vault.alice.near' });
  // Vaults are deployed via the dashboard (https://outlayer.fastnear.com/vault)
  // or the CLI (`outlayer vault init`) — NOT through this SDK. See docs/vaults.md.
  const result = await OutlayerClient.register();

  console.log('━━━ Wallet created ━━━');
  console.log('Wallet ID:        ', result.wallet_id);
  console.log('NEAR account:     ', result.near_account_id);
  console.log('API key (save!):  ', result.api_key);
  console.log('Handoff URL:      ', result.handoff_url);
  if (result.trial) {
    console.log('Trial calls left: ', result.trial.calls_remaining);
    console.log('Trial expires:    ', result.trial.expires_at);
  }

  if (!result.api_key) {
    throw new Error('Expected api_key on anonymous registration');
  }
  const client = new OutlayerClient({ apiKey: result.api_key });

  console.log('\n━━━ Derived addresses ━━━');
  for (const chain of ['near', 'ethereum', 'solana', 'bitcoin'] as const) {
    try {
      const addr = await client.getAddress(chain);
      console.log(`${chain.padEnd(8)} → ${addr.address}`);
    } catch (e) {
      console.log(`${chain.padEnd(8)} → unsupported`);
    }
  }

  console.log('\n━━━ Balance ━━━');
  const balance = await client.getBalance({ chain: 'near' });
  console.log(`${balance.token}: ${balance.balance}`);

  console.log('\nNext step: visit', result.handoff_url);
  console.log('to set a policy (spending limits, allowlists, multisig).');
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
