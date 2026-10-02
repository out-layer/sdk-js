/**
 * The owner's inbox, read by a server of the owner's: sign a device in with
 * the custody wallet, list what the owner's agents left, read each task, and
 * close the notices with Got it.
 *
 * Run:
 *   OUTLAYER_API_KEY=wk_... npx tsx examples/07-inbox.ts
 *
 * The wallet whose key this is must be the owner of the agents' secret rows:
 * tasks reach the owner of the row a run named. A notice asks nothing and is
 * closed here. A task that asks something — a confirmation, an answer — is
 * approved where it is shown first, in the dashboard: its link is printed.
 *
 * The device's key is printed nowhere and kept nowhere here; a server keeps
 * `inbox.exportDevice(device)` beside the session and never hands it to a
 * browser.
 */

import { OutlayerClient, inbox } from '../src/index.js';

const apiKey = process.env.OUTLAYER_API_KEY;
if (!apiKey) {
  console.error('Set OUTLAYER_API_KEY=wk_... before running');
  process.exit(1);
}

const baseUrl = 'https://testnet-api.outlayer.ai';
const recipient = 'outlayer.testnet';
const client = new OutlayerClient({ apiKey, network: 'testnet' });
const signer = inbox.walletSigner(client);

// The account: the one the wallet signs as.
const { accountId } = await signer('which account', recipient);
const device = await inbox.newDevice();
const session = await inbox.signIn({ baseUrl, recipient }, signer, accountId, device);
console.log(`signed in as ${accountId} until ${new Date(session.validUntil * 1000).toISOString()}`);

const { tasks, more } = await inbox.listTasks(session);
// A device signed in just now reads only what arrives from now on: older
// tasks are locked here until the owner's `tasks_unlock`.
for (const listed of tasks) {
  if (listed.locked) {
    console.log(`${listed.id}: locked on this device`);
    continue;
  }
  const task = await inbox.readTask(device, listed, accountId);
  const fields = task.envelope.display.fields.map((f) => `${f.label}: ${f.values.join(', ')}`).join('; ');
  console.log(`${listed.id} [${task.envelope.kind}] ${task.envelope.display.title} — ${fields}`);
  if (task.envelope.kind === 'notice') {
    await inbox.acknowledge(session, listed.id);
    console.log('  got it');
  } else {
    console.log(`  approve it in the dashboard: https://app.outlayer.ai/inbox/${listed.id}`);
  }
}
if (more) console.log('more wait than one read lists');

await inbox.signOut(session);
