/**
 * Multisig approval flow.
 *
 * Run:
 *   OUTLAYER_API_KEY=wk_... npx tsx examples/03-multisig.ts
 *
 * Demonstrates:
 *   - Submitting an action that exceeds the auto-approve threshold
 *   - Listing pending approvals (any approver's view)
 *   - The SHAPE of an approve call — actual NEP-413 signing needs a NEAR
 *     wallet (Wallet Selector in the browser, or near-api-js KeyStore in
 *     Node). The SDK does NOT sign for you; signing is intentionally the
 *     responsibility of the approver's own NEAR wallet.
 *
 * Prereq: a wallet with a policy that has an `approval` block configured,
 * e.g. via the dashboard:
 *
 *   approval: {
 *     threshold: { required: 2, of: 3 },
 *     above_usd: 100,
 *     approvers: [admin1, admin2, admin3],
 *   }
 */

import { OutlayerClient, type Nep413Auth } from '../src/index.js';

const apiKey = process.env.OUTLAYER_API_KEY;
if (!apiKey) {
  console.error('Set OUTLAYER_API_KEY=wk_... before running');
  process.exit(1);
}

const client = new OutlayerClient({ apiKey });

async function main(): Promise<void> {
  // 1. Trigger an action large enough to require approval
  console.log('━━━ Triggering withdraw ━━━');
  const result = await client.withdraw({
    chain: 'near',
    to: 'bob.near',
    amount: '50000000000000000000000000', // 50 NEAR — above per-tx limit
  });

  if (result.status !== 'pending_approval') {
    console.log('Did NOT require approval. Status:', result.status);
    console.log('Either the policy auto-approves this amount, or the wallet has no policy.');
    return;
  }

  console.log('Pending approval:');
  console.log('  approval_id:', result.approval_id);
  console.log('  required:   ', result.required);
  console.log('  approved:   ', result.approved);

  // 2. List pending approvals (each approver's UI calls this)
  console.log('\n━━━ Listing pending approvals ━━━');
  const { approvals } = await client.approvals.listPending();
  for (const a of approvals) {
    console.log(
      `  ${a.approval_id} — ${a.type} — ${a.approved}/${a.required} — expires ${a.expires_at}`,
    );
  }

  // 3. Submit approval (SHAPE only — see comments below for actual signing)
  console.log('\n━━━ Approval payload shape ━━━');
  const auth: Nep413Auth = await signApprovalWithNearWallet(
    result.approval_id ?? '',
    'request-hash-placeholder',
  );

  // In a real app this is where the approver POSTs:
  //   await client.approvals.approve(result.approval_id, auth);
  // We log the shape instead so this script can run without a NEAR wallet.
  console.log('Would POST:', auth);
}

/**
 * STUB. In production:
 *   - Browser: use @near-wallet-selector + wallet.signMessage(...)
 *   - Node: use near-api-js KeyPair + nearAPI.utils.serialize.serialize(...)
 *
 * The signed message is:
 *   approve:{approval_id}:{request_hash}
 *
 * `request_hash` comes from the pending approval object's
 * `request_data` — exact format documented at docs/approvals.md.
 */
async function signApprovalWithNearWallet(
  approvalId: string,
  requestHash: string,
): Promise<Nep413Auth> {
  console.log(`(stub) signing approve:${approvalId}:${requestHash}`);
  return {
    signature: 'ed25519:<base58_signature>',
    public_key: 'ed25519:<base58_pubkey>',
    account_id: 'approver.near',
    nonce: Buffer.from(new Uint8Array(32)).toString('base64'),
  };
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
