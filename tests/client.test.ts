import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import {
  BadRequestError,
  type Nep413Auth,
  NotFoundError,
  OutlayerClient,
  OutlayerError,
  PolicyDeniedError,
  RateLimitedError,
  UnauthorizedError,
  WalletFrozenError,
} from '../src/index.js';
import { errorHandlers } from './handlers.js';
import { server } from './setup.js';

const apiKey = 'wk_test_xxx';
const BASE = 'https://api.outlayer.fastnear.com';

// ============================================================================
// Registration
// ============================================================================

describe('OutlayerClient.register', () => {
  it('returns an API key + wallet id', async () => {
    const r = await OutlayerClient.register();
    expect(r.api_key).toMatch(/^wk_/);
    expect(r.wallet_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.handoff_url).toContain('api_key=');
  });

  it('forwards vaultId to the request body', async () => {
    let receivedBody: unknown = null;
    server.use(
      http.post(`${BASE}/register`, async ({ request }) => {
        receivedBody = await request.json();
        return HttpResponse.json({
          wallet_id: '00000000-0000-0000-0000-000000000001',
          api_key: 'wk_test_vault_bound',
          near_account_id: '0001',
        });
      }),
    );
    await OutlayerClient.register({ vaultId: 'vault.alice.near' });
    expect(receivedBody).toEqual({ vault_id: 'vault.alice.near' });
  });

  it('respects explicit body.vault_id over vaultId convenience option', async () => {
    let receivedBody: unknown = null;
    server.use(
      http.post(`${BASE}/register`, async ({ request }) => {
        receivedBody = await request.json();
        return HttpResponse.json({
          wallet_id: '00000000-0000-0000-0000-000000000001',
          api_key: 'wk_test',
          near_account_id: '0001',
        });
      }),
    );
    await OutlayerClient.register({
      vaultId: 'vault.alice.near',
      body: { vault_id: 'vault.explicit.near' },
    });
    expect(receivedBody).toEqual({ vault_id: 'vault.explicit.near' });
  });

  it('uses custom baseUrl when provided', async () => {
    let receivedUrl = '';
    server.use(
      http.post('https://staging.example.com/register', ({ request }) => {
        receivedUrl = request.url;
        return HttpResponse.json({
          wallet_id: '00000000-0000-0000-0000-000000000001',
          api_key: 'wk_test',
          near_account_id: '0001',
        });
      }),
    );
    await OutlayerClient.register({ baseUrl: 'https://staging.example.com' });
    expect(receivedUrl).toBe('https://staging.example.com/register');
  });

  it('uses testnet base URL when network=testnet', async () => {
    let receivedUrl = '';
    server.use(
      http.post('https://api.testnet.outlayer.fastnear.com/register', ({ request }) => {
        receivedUrl = request.url;
        return HttpResponse.json({
          wallet_id: '00000000-0000-0000-0000-000000000001',
          api_key: 'wk_test',
          near_account_id: '0001',
        });
      }),
    );
    await OutlayerClient.register({ network: 'testnet' });
    expect(receivedUrl).toBe('https://api.testnet.outlayer.fastnear.com/register');
  });

  it('explicit baseUrl overrides network', async () => {
    let receivedUrl = '';
    server.use(
      http.post('https://custom.example.com/register', ({ request }) => {
        receivedUrl = request.url;
        return HttpResponse.json({
          wallet_id: '00000000-0000-0000-0000-000000000001',
          api_key: 'wk_test',
          near_account_id: '0001',
        });
      }),
    );
    await OutlayerClient.register({
      network: 'testnet',
      baseUrl: 'https://custom.example.com',
    });
    expect(receivedUrl).toBe('https://custom.example.com/register');
  });
});

describe('OutlayerClient network option', () => {
  it('targets testnet for wallet ops when network=testnet', async () => {
    let receivedUrl = '';
    server.use(
      http.get('https://api.testnet.outlayer.fastnear.com/wallet/v1/balance', ({ request }) => {
        receivedUrl = request.url;
        return HttpResponse.json({ balance: '0', token: 'NEAR', account_id: 'wallet.near' });
      }),
    );
    const client = new OutlayerClient({ apiKey, network: 'testnet' });
    await client.getBalance({ chain: 'near' });
    expect(receivedUrl).toContain('api.testnet.outlayer.fastnear.com');
  });

  it('defaults to mainnet when no network specified', async () => {
    let receivedUrl = '';
    server.use(
      http.get(`${BASE}/wallet/v1/balance`, ({ request }) => {
        receivedUrl = request.url;
        return HttpResponse.json({ balance: '0', token: 'NEAR', account_id: 'wallet.near' });
      }),
    );
    const client = new OutlayerClient({ apiKey });
    await client.getBalance({ chain: 'near' });
    expect(receivedUrl).toContain('api.outlayer.fastnear.com');
    expect(receivedUrl).not.toContain('testnet');
  });
});

// ============================================================================
// Wallet — read
// ============================================================================

describe('Wallet reads: getAddress', () => {
  it('derives a NEAR address', async () => {
    const client = new OutlayerClient({ apiKey });
    const r = await client.getAddress('near');
    expect(r.chain).toBe('near');
    expect(r.address).toBe('wallet.near');
    expect(r.public_key).toMatch(/^ed25519:/);
  });

  it('derives an Ethereum address', async () => {
    const client = new OutlayerClient({ apiKey });
    const r = await client.getAddress('ethereum');
    expect(r.chain).toBe('ethereum');
    expect(r.address).toMatch(/^0x/);
  });

  it('forwards the chain query parameter', async () => {
    let receivedQuery = '';
    server.use(
      http.get(`${BASE}/wallet/v1/address`, ({ request }) => {
        receivedQuery = new URL(request.url).search;
        return HttpResponse.json({
          wallet_id: '00000000-0000-0000-0000-000000000001',
          chain: 'solana',
          address: 'sol-address',
          public_key: 'ed25519:abc',
          vault_id: null,
        });
      }),
    );
    const client = new OutlayerClient({ apiKey });
    await client.getAddress('solana');
    expect(receivedQuery).toBe('?chain=solana');
  });

  it('sends Authorization header with Bearer token', async () => {
    let receivedAuth: string | null = null;
    server.use(
      http.get(`${BASE}/wallet/v1/address`, ({ request }) => {
        receivedAuth = request.headers.get('authorization');
        return HttpResponse.json({
          wallet_id: '00000000-0000-0000-0000-000000000001',
          chain: 'near',
          address: 'wallet.near',
          public_key: 'ed25519:abc',
          vault_id: null,
        });
      }),
    );
    const client = new OutlayerClient({ apiKey });
    await client.getAddress('near');
    expect(receivedAuth).toBe(`Bearer ${apiKey}`);
  });
});

describe('Wallet reads: getBalance', () => {
  it('returns balance for the wallet', async () => {
    const client = new OutlayerClient({ apiKey });
    const r = await client.getBalance({ chain: 'near' });
    expect(r.balance).toBe('1000000000000000000000000');
    expect(r.token).toBe('NEAR');
  });

  it('forwards source=intents to read intents.near balance', async () => {
    let receivedQuery = '';
    server.use(
      http.get(`${BASE}/wallet/v1/balance`, ({ request }) => {
        receivedQuery = new URL(request.url).search;
        return HttpResponse.json({ balance: '0', token: 'NEAR', account_id: 'wallet.near' });
      }),
    );
    const client = new OutlayerClient({ apiKey });
    await client.getBalance({ chain: 'near', source: 'intents' });
    expect(receivedQuery).toContain('source=intents');
  });

  it('allows no chain (defaults server-side to near)', async () => {
    const client = new OutlayerClient({ apiKey });
    const r = await client.getBalance();
    expect(r.token).toBe('NEAR');
  });
});

describe('Wallet reads: listTokens', () => {
  it('returns a token catalog', async () => {
    server.use(
      http.get(`${BASE}/wallet/v1/tokens`, () => {
        return HttpResponse.json({
          tokens: [
            {
              id: 'wrap.near',
              symbol: 'wNEAR',
              chains: ['near', 'ethereum'],
              decimals: 24,
              defuse_asset_id: 'nep141:wrap.near',
            },
            {
              id: 'usdt.tether-token.near',
              symbol: 'USDT',
              chains: ['near', 'ethereum', 'solana'],
              decimals: 6,
              defuse_asset_id: 'nep141:usdt.tether-token.near',
            },
          ],
        });
      }),
    );
    const client = new OutlayerClient({ apiKey });
    const r = await client.listTokens();
    expect(r.tokens).toHaveLength(2);
    expect(r.tokens[0]?.symbol).toBe('wNEAR');
  });
});

describe('Wallet reads: getRequest', () => {
  it('fetches by id via path param', async () => {
    let receivedId = '';
    server.use(
      http.get(`${BASE}/wallet/v1/requests/:id`, ({ params }) => {
        receivedId = params.id as string;
        return HttpResponse.json({
          request_id: params.id,
          type: 'withdraw',
          status: 'success',
          result: { tx_hash: '0xabc' },
          created_at: '2026-05-20T10:00:00Z',
        });
      }),
    );
    const client = new OutlayerClient({ apiKey });
    const r = await client.getRequest('11111111-1111-1111-1111-111111111111');
    expect(receivedId).toBe('11111111-1111-1111-1111-111111111111');
    expect(r.status).toBe('success');
  });

  it('throws NotFoundError on 404', async () => {
    server.use(
      http.get(`${BASE}/wallet/v1/requests/:id`, () => {
        return HttpResponse.json({ error: 'request_not_found' }, { status: 404 });
      }),
    );
    const client = new OutlayerClient({ apiKey });
    await expect(client.getRequest('nope')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('Wallet reads: listRequests', () => {
  it('forwards filter query params', async () => {
    let receivedQuery = '';
    server.use(
      http.get(`${BASE}/wallet/v1/requests`, ({ request }) => {
        receivedQuery = new URL(request.url).search;
        return HttpResponse.json({ requests: [], total: 0 });
      }),
    );
    const client = new OutlayerClient({ apiKey });
    await client.listRequests({ type: 'withdraw', status: 'success', limit: 25, offset: 50 });
    expect(receivedQuery).toContain('type=withdraw');
    expect(receivedQuery).toContain('status=success');
    expect(receivedQuery).toContain('limit=25');
    expect(receivedQuery).toContain('offset=50');
  });
});

// ============================================================================
// Wallet — write
// ============================================================================

describe('Wallet writes: withdraw — happy path', () => {
  it('returns a request_id on success', async () => {
    const client = new OutlayerClient({ apiKey });
    const r = await client.withdraw({
      chain: 'near',
      to: 'bob.near',
      amount: '1000000000000000000000000',
    });
    expect(r.status).toBe('processing');
    expect(r.request_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('returns pending_approval as a value, not an error', async () => {
    server.use(
      http.post(`${BASE}/wallet/v1/intents/withdraw`, () => {
        return HttpResponse.json({
          request_id: '11111111-1111-1111-1111-111111111111',
          status: 'pending_approval',
          approval_id: '22222222-2222-2222-2222-222222222222',
          required: 2,
          approved: 0,
        });
      }),
    );
    const client = new OutlayerClient({ apiKey });
    const r = await client.withdraw({ chain: 'near', to: 'bob.near', amount: '1' });
    expect(r.status).toBe('pending_approval');
    expect(r.approval_id).toBe('22222222-2222-2222-2222-222222222222');
    expect(r.required).toBe(2);
  });
});

describe('Wallet writes: withdraw — errors', () => {
  it('throws PolicyDeniedError on 403 policy_denied', async () => {
    server.use(errorHandlers.policyDenied);
    const client = new OutlayerClient({ apiKey });
    await expect(
      client.withdraw({ chain: 'near', to: 'bob.near', amount: '1' }),
    ).rejects.toBeInstanceOf(PolicyDeniedError);
  });

  it('throws WalletFrozenError on 403 wallet_frozen', async () => {
    server.use(errorHandlers.walletFrozen);
    const client = new OutlayerClient({ apiKey });
    await expect(
      client.withdraw({ chain: 'near', to: 'bob.near', amount: '1' }),
    ).rejects.toBeInstanceOf(WalletFrozenError);
  });

  it('throws RateLimitedError on 429', async () => {
    server.use(errorHandlers.rateLimited);
    const client = new OutlayerClient({ apiKey });
    await expect(
      client.withdraw({ chain: 'near', to: 'bob.near', amount: '1' }),
    ).rejects.toBeInstanceOf(RateLimitedError);
  });
});

describe('Wallet writes: withdrawDryRun', () => {
  it('does NOT attach Idempotency-Key (dry-run is read-only)', async () => {
    let receivedKey: string | null = null;
    server.use(
      http.post(`${BASE}/wallet/v1/intents/withdraw/dry-run`, ({ request }) => {
        receivedKey = request.headers.get('idempotency-key');
        return HttpResponse.json({
          would_succeed: true,
          estimated_fee: '100',
          fee_token: 'NEAR',
          policy_check: { decision: 'allowed' },
        });
      }),
    );
    const client = new OutlayerClient({ apiKey });
    const r = await client.withdrawDryRun({ chain: 'near', to: 'bob.near', amount: '1' });
    expect(r.would_succeed).toBe(true);
    expect(receivedKey).toBeNull();
  });
});

describe('Wallet writes: call', () => {
  it('forwards the contract call body', async () => {
    let receivedBody: unknown = null;
    server.use(
      http.post(`${BASE}/wallet/v1/call`, async ({ request }) => {
        receivedBody = await request.json();
        return HttpResponse.json({
          request_id: '33333333-3333-3333-3333-333333333333',
          status: 'processing',
        });
      }),
    );
    const client = new OutlayerClient({ apiKey });
    await client.call({
      receiver_id: 'wrap.near',
      method_name: 'near_deposit',
      args: {},
      deposit: '5000000000000000000000000',
    });
    expect(receivedBody).toMatchObject({
      receiver_id: 'wrap.near',
      method_name: 'near_deposit',
      deposit: '5000000000000000000000000',
    });
  });

  it('strips idempotencyKey from body before sending', async () => {
    let receivedBody: Record<string, unknown> = {};
    server.use(
      http.post(`${BASE}/wallet/v1/call`, async ({ request }) => {
        receivedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          request_id: '33333333-3333-3333-3333-333333333333',
          status: 'processing',
        });
      }),
    );
    const client = new OutlayerClient({ apiKey });
    await client.call({
      receiver_id: 'wrap.near',
      method_name: 'near_deposit',
      args: {},
      idempotencyKey: 'my-key',
    });
    expect(receivedBody.idempotencyKey).toBeUndefined();
  });
});

describe('Wallet writes: transfer', () => {
  it('forwards transfer body with default near chain', async () => {
    let receivedBody: unknown = null;
    server.use(
      http.post(`${BASE}/wallet/v1/transfer`, async ({ request }) => {
        receivedBody = await request.json();
        return HttpResponse.json({
          request_id: '44444444-4444-4444-4444-444444444444',
          status: 'processing',
        });
      }),
    );
    const client = new OutlayerClient({ apiKey });
    await client.transfer({ receiver_id: 'bob.near', amount: '1' });
    expect(receivedBody).toMatchObject({ receiver_id: 'bob.near', amount: '1' });
  });
});

describe('Wallet writes: intentsDeposit', () => {
  it('forwards token + amount', async () => {
    let receivedBody: unknown = null;
    server.use(
      http.post(`${BASE}/wallet/v1/intents/deposit`, async ({ request }) => {
        receivedBody = await request.json();
        return HttpResponse.json({
          request_id: '55555555-5555-5555-5555-555555555555',
          status: 'processing',
        });
      }),
    );
    const client = new OutlayerClient({ apiKey });
    await client.intentsDeposit({ token: 'wrap.near', amount: '1000' });
    expect(receivedBody).toMatchObject({ token: 'wrap.near', amount: '1000' });
  });
});

describe('Wallet writes: swap + swapQuote', () => {
  it('swap returns amount_out + intent_hash', async () => {
    server.use(
      http.post(`${BASE}/wallet/v1/intents/swap`, () => {
        return HttpResponse.json({
          request_id: '66666666-6666-6666-6666-666666666666',
          status: 'success',
          amount_out: '950000',
          intent_hash: 'intent-abc',
        });
      }),
    );
    const client = new OutlayerClient({ apiKey });
    const r = await client.swap({
      token_in: 'nep141:wrap.near',
      token_out: 'nep141:usdt.tether-token.near',
      amount_in: '1000000000000000000000000',
    });
    expect(r.amount_out).toBe('950000');
    expect(r.intent_hash).toBe('intent-abc');
  });

  it('swapQuote does NOT attach Idempotency-Key', async () => {
    let receivedKey: string | null = null;
    server.use(
      http.post(`${BASE}/wallet/v1/intents/swap/quote`, ({ request }) => {
        receivedKey = request.headers.get('idempotency-key');
        return HttpResponse.json({
          amount_out: '950000',
          min_amount_out: '940000',
          time_estimate_seconds: 10,
        });
      }),
    );
    const client = new OutlayerClient({ apiKey });
    await client.swapQuote({
      token_in: 'nep141:wrap.near',
      token_out: 'nep141:usdt.tether-token.near',
      amount_in: '1000',
    });
    expect(receivedKey).toBeNull();
  });
});

describe('Wallet: cross-chain deposit (1Click)', () => {
  it('createDepositIntent posts chain/amount/token and returns a deposit address', async () => {
    let receivedBody: unknown = null;
    server.use(
      http.post(`${BASE}/wallet/v1/deposit-intent`, async ({ request }) => {
        receivedBody = await request.json();
        return HttpResponse.json({
          intent_id: 'int-1',
          deposit_address: '0xDEADBEEF',
          amount: '5000000',
          amount_out: '4999490',
          min_amount_out: '4949495',
          expires_at: '2026-05-24T00:00:00Z',
          estimated_time_secs: 45,
        });
      }),
    );
    const client = new OutlayerClient({ apiKey });
    const r = await client.createDepositIntent({
      chain: 'ethereum',
      amount: '5000000',
      token: 'USDC',
    });
    expect(receivedBody).toEqual({ chain: 'ethereum', amount: '5000000', token: 'USDC' });
    expect(r.deposit_address).toBe('0xDEADBEEF');
    expect(r.intent_id).toBe('int-1');
  });

  it('getDepositStatus passes intentId as the id query param', async () => {
    let receivedQuery = '';
    server.use(
      http.get(`${BASE}/wallet/v1/deposit-status`, ({ request }) => {
        receivedQuery = new URL(request.url).search;
        return HttpResponse.json({
          intent_id: 'int-1',
          status: 'success',
          result: { amountOut: '4999490' },
        });
      }),
    );
    const client = new OutlayerClient({ apiKey });
    const r = await client.getDepositStatus('int-1');
    expect(receivedQuery).toContain('id=int-1');
    expect(r.status).toBe('success');
  });
});

describe('Wallet writes: signMessage', () => {
  it('defaults to NEP-413 format and returns signature', async () => {
    let receivedBody: Record<string, unknown> = {};
    server.use(
      http.post(`${BASE}/wallet/v1/sign-message`, async ({ request }) => {
        receivedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          account_id: 'wallet.near',
          signature: 'sig-base64',
          signature_base64: 'sig-base64',
          public_key: 'ed25519:abc',
          nonce: 'nonce-base64',
        });
      }),
    );
    const client = new OutlayerClient({ apiKey });
    const r = await client.signMessage({
      message: 'login:myapp:1716200000',
      recipient: 'myapp.example',
    });
    expect(receivedBody.message).toBe('login:myapp:1716200000');
    expect(r.signature).toBe('sig-base64');
  });
});

// ============================================================================
// Sub-namespaces
// ============================================================================

describe('client.policy', () => {
  it('get() returns the current policy', async () => {
    server.use(
      http.get(`${BASE}/wallet/v1/policy`, () => {
        return HttpResponse.json({
          wallet_id: 'w1',
          controller: 'alice.near',
          frozen: false,
          rules: { limits: { daily: { '*': '100' } } },
          usage: { daily: { '*': '20' } },
        });
      }),
    );
    const client = new OutlayerClient({ apiKey });
    const p = await client.policy.get();
    expect(p.controller).toBe('alice.near');
    expect(p.frozen).toBe(false);
    expect(p.rules?.limits?.daily?.['*']).toBe('100');
  });

  it('encrypt() POSTs rules and returns encrypted blob', async () => {
    let receivedBody: unknown = null;
    server.use(
      http.post(`${BASE}/wallet/v1/encrypt-policy`, async ({ request }) => {
        receivedBody = await request.json();
        return HttpResponse.json({
          encrypted_base64: 'AAAA',
          wallet_pubkey: 'ed25519:abc',
        });
      }),
    );
    const client = new OutlayerClient({ apiKey });
    const r = await client.policy.encrypt({
      wallet_id: 'w1',
      rules: { rate_limit: { max_per_hour: 60 } },
    });
    expect(r.encrypted_base64).toBe('AAAA');
    expect(receivedBody).toMatchObject({ wallet_id: 'w1' });
  });

  it('sign() wraps the encrypted_data field', async () => {
    let receivedBody: unknown = null;
    server.use(
      http.post(`${BASE}/wallet/v1/sign-policy`, async ({ request }) => {
        receivedBody = await request.json();
        return HttpResponse.json({ signature_hex: 'deadbeef', public_key_hex: 'abc' });
      }),
    );
    const client = new OutlayerClient({ apiKey });
    const r = await client.policy.sign('AAAA');
    expect(receivedBody).toEqual({ encrypted_data: 'AAAA' });
    expect(r.signature_hex).toBe('deadbeef');
  });

  it('invalidateCache() POSTs wallet_id and resolves to undefined', async () => {
    let receivedBody: unknown = null;
    server.use(
      http.post(`${BASE}/wallet/v1/invalidate-cache`, async ({ request }) => {
        receivedBody = await request.json();
        return HttpResponse.json({ ok: true });
      }),
    );
    const client = new OutlayerClient({ apiKey });
    const r = await client.policy.invalidateCache('w1');
    expect(receivedBody).toEqual({ wallet_id: 'w1' });
    expect(r).toBeUndefined();
  });
});

describe('client.approvals', () => {
  it('listPending() returns approvals array', async () => {
    server.use(
      http.get(`${BASE}/wallet/v1/pending_approvals`, () => {
        return HttpResponse.json({
          approvals: [
            {
              approval_id: 'a1',
              request_id: 'r1',
              type: 'withdraw',
              request_data: { to: 'bob.near', amount: '100' },
              required: 2,
              approved: 0,
              expires_at: '2026-05-21T00:00:00Z',
            },
          ],
        });
      }),
    );
    const client = new OutlayerClient({ apiKey });
    const r = await client.approvals.listPending();
    expect(r.approvals).toHaveLength(1);
    expect(r.approvals[0]?.approval_id).toBe('a1');
  });

  it('approve() puts NEP-413 auth in body, id in path', async () => {
    let receivedBody: unknown = null;
    let receivedPath = '';
    server.use(
      http.post(`${BASE}/wallet/v1/approve/:id`, async ({ request, params }) => {
        receivedBody = await request.json();
        receivedPath = params.id as string;
        return HttpResponse.json({
          approval_id: params.id,
          status: 'pending',
          approved: 1,
          required: 2,
        });
      }),
    );
    const client = new OutlayerClient({ apiKey });
    const auth: Nep413Auth = {
      signature: 'sig',
      public_key: 'pk',
      account_id: 'alice.near',
      nonce: 'nonce',
    };
    const r = await client.approvals.approve('a1', auth);
    expect(receivedPath).toBe('a1');
    expect(receivedBody).toEqual(auth);
    expect(r.approved).toBe(1);
  });

  it('reject() with no reason omits the field', async () => {
    let receivedBody: Record<string, unknown> = {};
    server.use(
      http.post(`${BASE}/wallet/v1/reject/:id`, async ({ request }) => {
        receivedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          approval_id: 'a1',
          status: 'rejected',
          approved: 0,
          required: 2,
        });
      }),
    );
    const client = new OutlayerClient({ apiKey });
    await client.approvals.reject('a1', {
      signature: 'sig',
      public_key: 'pk',
      account_id: 'alice.near',
      nonce: 'nonce',
    });
    expect(receivedBody.reason).toBeUndefined();
  });

  it('reject() with reason includes it in body', async () => {
    let receivedBody: Record<string, unknown> = {};
    server.use(
      http.post(`${BASE}/wallet/v1/reject/:id`, async ({ request }) => {
        receivedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          approval_id: 'a1',
          status: 'rejected',
          approved: 0,
          required: 2,
        });
      }),
    );
    const client = new OutlayerClient({ apiKey });
    await client.approvals.reject(
      'a1',
      {
        signature: 'sig',
        public_key: 'pk',
        account_id: 'alice.near',
        nonce: 'nonce',
      },
      'destination not in allowlist',
    );
    expect(receivedBody.reason).toBe('destination not in allowlist');
  });
});

describe('client.audit', () => {
  it('list() returns events', async () => {
    server.use(
      http.get(`${BASE}/wallet/v1/audit`, () => {
        return HttpResponse.json({
          events: [
            {
              type: 'withdraw_submitted',
              request_id: 'r1',
              status: 'success',
              details: { amount: '100' },
              at: '2026-05-20T10:00:00Z',
            },
          ],
        });
      }),
    );
    const client = new OutlayerClient({ apiKey });
    const r = await client.audit.list({ limit: 10 });
    expect(r.events).toHaveLength(1);
    expect(r.events[0]?.type).toBe('withdraw_submitted');
  });

  it('list() forwards limit/offset query params', async () => {
    let receivedQuery = '';
    server.use(
      http.get(`${BASE}/wallet/v1/audit`, ({ request }) => {
        receivedQuery = new URL(request.url).search;
        return HttpResponse.json({ events: [] });
      }),
    );
    const client = new OutlayerClient({ apiKey });
    await client.audit.list({ limit: 25, offset: 100 });
    expect(receivedQuery).toContain('limit=25');
    expect(receivedQuery).toContain('offset=100');
  });
});

// ============================================================================
// Error mapping
// ============================================================================

describe('Error mapping', () => {
  it('401 missing_auth → UnauthorizedError', async () => {
    server.use(
      http.get(`${BASE}/wallet/v1/balance`, () => {
        return HttpResponse.json({ error: 'missing_auth' }, { status: 401 });
      }),
    );
    const client = new OutlayerClient({ apiKey });
    await expect(client.getBalance()).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('401 invalid_api_key → UnauthorizedError', async () => {
    server.use(
      http.get(`${BASE}/wallet/v1/balance`, () => {
        return HttpResponse.json({ error: 'invalid_api_key' }, { status: 401 });
      }),
    );
    const client = new OutlayerClient({ apiKey });
    await expect(client.getBalance()).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('400 invalid_address → BadRequestError', async () => {
    server.use(
      http.post(`${BASE}/wallet/v1/intents/withdraw`, () => {
        return HttpResponse.json(
          { error: 'invalid_address', message: 'not a valid eth address' },
          { status: 400 },
        );
      }),
    );
    const client = new OutlayerClient({ apiKey });
    await expect(
      client.withdraw({ chain: 'ethereum', to: 'oops', amount: '1' }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it('400 insufficient_balance → BadRequestError with message', async () => {
    server.use(
      http.post(`${BASE}/wallet/v1/intents/withdraw`, () => {
        return HttpResponse.json(
          { error: 'insufficient_balance', message: 'need 100, have 50' },
          { status: 400 },
        );
      }),
    );
    const client = new OutlayerClient({ apiKey });
    try {
      await client.withdraw({ chain: 'near', to: 'bob.near', amount: '100' });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(BadRequestError);
      expect((e as BadRequestError).code).toBe('insufficient_balance');
      expect((e as BadRequestError).message).toContain('need 100');
    }
  });

  it('unknown error code falls back to OutlayerError base class', async () => {
    server.use(
      http.post(`${BASE}/wallet/v1/intents/withdraw`, () => {
        return HttpResponse.json({ error: 'mystery_code', message: 'unhandled' }, { status: 418 });
      }),
    );
    const client = new OutlayerClient({ apiKey });
    try {
      await client.withdraw({ chain: 'near', to: 'bob.near', amount: '1' });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(OutlayerError);
      expect(e).not.toBeInstanceOf(PolicyDeniedError);
      expect((e as OutlayerError).status).toBe(418);
    }
  });

  it('carries code, status, message on all errors', async () => {
    server.use(errorHandlers.policyDenied);
    const client = new OutlayerClient({ apiKey });
    try {
      await client.withdraw({ chain: 'near', to: 'bob.near', amount: '1' });
      throw new Error('should have thrown');
    } catch (e) {
      const err = e as OutlayerError;
      expect(err.code).toBe('policy_denied');
      expect(err.status).toBe(403);
      expect(err.message).toContain('daily limit');
    }
  });
});

// ============================================================================
// Retry / network behavior
// ============================================================================

describe('Retry behavior', () => {
  it('retries on 500 and succeeds on second attempt', async () => {
    let calls = 0;
    server.use(
      http.post(`${BASE}/wallet/v1/intents/withdraw`, () => {
        calls++;
        if (calls === 1) {
          return HttpResponse.json({ error: 'internal_error' }, { status: 500 });
        }
        return HttpResponse.json({
          request_id: '22222222-2222-2222-2222-222222222222',
          status: 'processing',
        });
      }),
    );
    const client = new OutlayerClient({
      apiKey,
      retry: { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 10 },
    });
    const r = await client.withdraw({ chain: 'near', to: 'bob.near', amount: '1' });
    expect(r.status).toBe('processing');
    expect(calls).toBe(2);
  });

  it('exhausts retries on persistent 500 and throws', async () => {
    let calls = 0;
    server.use(
      http.post(`${BASE}/wallet/v1/intents/withdraw`, () => {
        calls++;
        return HttpResponse.json({ error: 'internal_error' }, { status: 500 });
      }),
    );
    const client = new OutlayerClient({
      apiKey,
      retry: { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 10 },
    });
    await expect(
      client.withdraw({ chain: 'near', to: 'bob.near', amount: '1' }),
    ).rejects.toBeInstanceOf(OutlayerError);
    expect(calls).toBe(3);
  });

  it('does NOT retry on 403 (policy_denied)', async () => {
    let calls = 0;
    server.use(
      http.post(`${BASE}/wallet/v1/intents/withdraw`, () => {
        calls++;
        return HttpResponse.json({ error: 'policy_denied' }, { status: 403 });
      }),
    );
    const client = new OutlayerClient({
      apiKey,
      retry: { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 10 },
    });
    await expect(
      client.withdraw({ chain: 'near', to: 'bob.near', amount: '1' }),
    ).rejects.toBeInstanceOf(PolicyDeniedError);
    expect(calls).toBe(1);
  });

  it('respects maxAttempts: 1 (no retry on 500)', async () => {
    let calls = 0;
    server.use(
      http.post(`${BASE}/wallet/v1/intents/withdraw`, () => {
        calls++;
        return HttpResponse.json({ error: 'internal_error' }, { status: 500 });
      }),
    );
    const client = new OutlayerClient({
      apiKey,
      retry: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 10 },
    });
    await expect(
      client.withdraw({ chain: 'near', to: 'bob.near', amount: '1' }),
    ).rejects.toBeInstanceOf(OutlayerError);
    expect(calls).toBe(1);
  });

  it('wraps network error into OutlayerError with code "network_error"', async () => {
    server.use(
      http.post(`${BASE}/wallet/v1/intents/withdraw`, () => {
        return HttpResponse.error(); // Simulates a network failure
      }),
    );
    const client = new OutlayerClient({
      apiKey,
      retry: { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 5 },
    });
    try {
      await client.withdraw({ chain: 'near', to: 'bob.near', amount: '1' });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(OutlayerError);
      expect((e as OutlayerError).code).toBe('network_error');
    }
  });
});

// ============================================================================
// Idempotency
// ============================================================================

describe('Idempotency-Key', () => {
  it('attaches an Idempotency-Key header on writes', async () => {
    let receivedKey: string | null = null;
    server.use(
      http.post(`${BASE}/wallet/v1/intents/withdraw`, ({ request }) => {
        receivedKey = request.headers.get('Idempotency-Key');
        return HttpResponse.json({
          request_id: '33333333-3333-3333-3333-333333333333',
          status: 'processing',
        });
      }),
    );
    const client = new OutlayerClient({ apiKey });
    await client.withdraw({ chain: 'near', to: 'bob.near', amount: '1' });
    expect(receivedKey).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('respects a user-supplied Idempotency-Key', async () => {
    let receivedKey: string | null = null;
    server.use(
      http.post(`${BASE}/wallet/v1/intents/withdraw`, ({ request }) => {
        receivedKey = request.headers.get('Idempotency-Key');
        return HttpResponse.json({
          request_id: '44444444-4444-4444-4444-444444444444',
          status: 'processing',
        });
      }),
    );
    const client = new OutlayerClient({ apiKey });
    await client.withdraw({
      chain: 'near',
      to: 'bob.near',
      amount: '1',
      idempotencyKey: 'my-job-12345',
    });
    expect(receivedKey).toBe('my-job-12345');
  });

  it('does NOT attach Idempotency-Key on GET requests', async () => {
    let receivedKey: string | null = null;
    server.use(
      http.get(`${BASE}/wallet/v1/balance`, ({ request }) => {
        receivedKey = request.headers.get('idempotency-key');
        return HttpResponse.json({ balance: '0', token: 'NEAR', account_id: 'wallet.near' });
      }),
    );
    const client = new OutlayerClient({ apiKey });
    await client.getBalance();
    expect(receivedKey).toBeNull();
  });
});

// ============================================================================
// Confidential Intents (Defuse confidential shard)
// ============================================================================

describe('Confidential Intents: confidentialDeposit (SHIELD)', () => {
  it('forwards token + amount and returns a ConfidentialOpResponse', async () => {
    let receivedBody: unknown = null;
    server.use(
      http.post(`${BASE}/wallet/v1/confidential/deposit`, async ({ request }) => {
        receivedBody = await request.json();
        return HttpResponse.json({
          request_id: 'aaaaaaaa-0000-0000-0000-000000000001',
          status: 'pending_deposit',
          intent_hash: 'cintent-shield',
          deposit_address: 'hop-addr-1',
        });
      }),
    );
    const client = new OutlayerClient({ apiKey });
    const r = await client.confidentialDeposit({
      token: 'nep141:wrap.near',
      amount: '10000000000000000000000',
    });
    expect(receivedBody).toEqual({
      token: 'nep141:wrap.near',
      amount: '10000000000000000000000',
    });
    expect(r.status).toBe('pending_deposit');
    expect(r.request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.intent_hash).toBe('cintent-shield');
  });

  it('auto-attaches an Idempotency-Key header', async () => {
    let receivedKey: string | null = null;
    server.use(
      http.post(`${BASE}/wallet/v1/confidential/deposit`, ({ request }) => {
        receivedKey = request.headers.get('Idempotency-Key');
        return HttpResponse.json({
          request_id: 'aaaaaaaa-0000-0000-0000-000000000002',
          status: 'pending_deposit',
        });
      }),
    );
    const client = new OutlayerClient({ apiKey });
    await client.confidentialDeposit({ token: 'nep141:wrap.near', amount: '1' });
    expect(receivedKey).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('strips idempotencyKey from the request body', async () => {
    let receivedBody: Record<string, unknown> = {};
    server.use(
      http.post(`${BASE}/wallet/v1/confidential/deposit`, async ({ request }) => {
        receivedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          request_id: 'aaaaaaaa-0000-0000-0000-000000000003',
          status: 'pending_deposit',
        });
      }),
    );
    const client = new OutlayerClient({ apiKey });
    await client.confidentialDeposit({
      token: 'nep141:wrap.near',
      amount: '1',
      idempotencyKey: 'shield-key',
    });
    expect(receivedBody.idempotencyKey).toBeUndefined();
  });

  it('throws OutlayerError with code confidential_unavailable on 503', async () => {
    server.use(
      http.post(`${BASE}/wallet/v1/confidential/deposit`, () => {
        return HttpResponse.json({ error: 'confidential_unavailable' }, { status: 503 });
      }),
    );
    const client = new OutlayerClient({
      apiKey,
      retry: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 10 },
    });
    try {
      await client.confidentialDeposit({ token: 'nep141:wrap.near', amount: '1' });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(OutlayerError);
      expect((e as OutlayerError).code).toBe('confidential_unavailable');
      expect((e as OutlayerError).status).toBe(503);
    }
  });
});

describe('Confidential Intents: confidentialUnshield', () => {
  it('forwards token + amount and returns a ConfidentialOpResponse', async () => {
    let receivedBody: unknown = null;
    server.use(
      http.post(`${BASE}/wallet/v1/confidential/unshield`, async ({ request }) => {
        receivedBody = await request.json();
        return HttpResponse.json({
          request_id: 'bbbbbbbb-0000-0000-0000-000000000001',
          status: 'pending_deposit',
        });
      }),
    );
    const client = new OutlayerClient({ apiKey });
    const r = await client.confidentialUnshield({ token: 'nep141:wrap.near', amount: '500' });
    expect(receivedBody).toEqual({ token: 'nep141:wrap.near', amount: '500' });
    expect(r.status).toBe('pending_deposit');
  });

  it('throws OutlayerError with code confidential_jwt_expired on 502', async () => {
    server.use(
      http.post(`${BASE}/wallet/v1/confidential/unshield`, () => {
        return HttpResponse.json({ error: 'confidential_jwt_expired' }, { status: 502 });
      }),
    );
    const client = new OutlayerClient({
      apiKey,
      retry: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 10 },
    });
    try {
      await client.confidentialUnshield({ token: 'nep141:wrap.near', amount: '1' });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(OutlayerError);
      expect((e as OutlayerError).code).toBe('confidential_jwt_expired');
      expect((e as OutlayerError).status).toBe(502);
    }
  });
});

describe('Confidential Intents: confidentialWithdraw', () => {
  it('returns a ConfidentialOpResponse (intent_hash / deposit_address, no tx_hash)', async () => {
    server.use(
      http.post(`${BASE}/wallet/v1/confidential/withdraw`, () => {
        return HttpResponse.json({
          request_id: 'cccccccc-0000-0000-0000-000000000001',
          status: 'processing',
          intent_hash: 'cintent-wd',
          deposit_address: 'hop-addr-wd',
        });
      }),
    );
    const client = new OutlayerClient({ apiKey });
    const r = await client.confidentialWithdraw({
      chain: 'solana',
      to: 'Esf7JS1sM46vEHtk75ik7N7UD5FJ13TXVKGWEd2kksiw',
      amount: '500000',
      token: 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near',
    });
    expect(r.status).toBe('processing');
    expect(r.deposit_address).toBe('hop-addr-wd');
  });

  it('passes chain="near" through (native NEAR delivery, not rejected)', async () => {
    let receivedBody: Record<string, unknown> = {};
    server.use(
      http.post(`${BASE}/wallet/v1/confidential/withdraw`, async ({ request }) => {
        receivedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          request_id: 'cccccccc-0000-0000-0000-000000000002',
          status: 'pending_deposit',
        });
      }),
    );
    const client = new OutlayerClient({ apiKey });
    const r = await client.confidentialWithdraw({
      chain: 'near',
      to: 'zavodil.near',
      amount: '10000000000000000000000',
      token: 'nep141:wrap.near',
    });
    expect(receivedBody.chain).toBe('near');
    expect(receivedBody.to).toBe('zavodil.near');
    expect(r.status).toBe('pending_deposit');
  });

  it('respects a user-supplied Idempotency-Key', async () => {
    let receivedKey: string | null = null;
    server.use(
      http.post(`${BASE}/wallet/v1/confidential/withdraw`, ({ request }) => {
        receivedKey = request.headers.get('Idempotency-Key');
        return HttpResponse.json({
          request_id: 'cccccccc-0000-0000-0000-000000000003',
          status: 'processing',
        });
      }),
    );
    const client = new OutlayerClient({ apiKey });
    await client.confidentialWithdraw({
      chain: 'near',
      to: 'bob.near',
      amount: '1',
      token: 'nep141:wrap.near',
      idempotencyKey: 'wd-job-1',
    });
    expect(receivedKey).toBe('wd-job-1');
  });

  it('throws PolicyDeniedError on 403 (same policy engine as public withdraw)', async () => {
    server.use(
      http.post(`${BASE}/wallet/v1/confidential/withdraw`, () => {
        return HttpResponse.json(
          { error: 'policy_denied', message: 'address not whitelisted' },
          { status: 403 },
        );
      }),
    );
    const client = new OutlayerClient({ apiKey });
    await expect(
      client.confidentialWithdraw({
        chain: 'solana',
        to: 'x',
        amount: '1',
        token: 'nep141:wrap.near',
      }),
    ).rejects.toBeInstanceOf(PolicyDeniedError);
  });
});

describe('Confidential Intents: confidentialWithdrawDryRun', () => {
  it('returns a quote and does NOT attach Idempotency-Key', async () => {
    let receivedKey: string | null = null;
    server.use(
      http.post(`${BASE}/wallet/v1/confidential/withdraw/dry-run`, ({ request }) => {
        receivedKey = request.headers.get('idempotency-key');
        return HttpResponse.json({
          amount_out: '498000',
          min_amount_out: '495000',
          time_estimate_seconds: 30,
        });
      }),
    );
    const client = new OutlayerClient({ apiKey });
    const r = await client.confidentialWithdrawDryRun({
      chain: 'solana',
      to: 'x',
      amount: '500000',
      token: 'nep141:wrap.near',
    });
    expect(r.amount_out).toBe('498000');
    expect(receivedKey).toBeNull();
  });

  it('throws BadRequestError on 400 bad_request', async () => {
    server.use(
      http.post(`${BASE}/wallet/v1/confidential/withdraw/dry-run`, () => {
        return HttpResponse.json(
          { error: 'bad_request', message: 'missing token' },
          { status: 400 },
        );
      }),
    );
    const client = new OutlayerClient({ apiKey });
    await expect(
      client.confidentialWithdrawDryRun({
        chain: 'solana',
        to: 'x',
        amount: '1',
        token: 'nep141:wrap.near',
      }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });
});

describe('Confidential Intents: confidentialTransfer', () => {
  it('forwards to + amount + token and returns a ConfidentialOpResponse', async () => {
    let receivedBody: unknown = null;
    server.use(
      http.post(`${BASE}/wallet/v1/confidential/transfer`, async ({ request }) => {
        receivedBody = await request.json();
        return HttpResponse.json({
          request_id: 'dddddddd-0000-0000-0000-000000000001',
          status: 'success',
        });
      }),
    );
    const client = new OutlayerClient({ apiKey });
    const r = await client.confidentialTransfer({
      to: '950c134ec86a21a8525d16d1dbae79258b923cabdaa8d32da284d931f74bdcb2',
      amount: '1000000',
      token: 'nep141:wrap.near',
    });
    expect(receivedBody).toEqual({
      to: '950c134ec86a21a8525d16d1dbae79258b923cabdaa8d32da284d931f74bdcb2',
      amount: '1000000',
      token: 'nep141:wrap.near',
    });
    expect(r.status).toBe('success');
  });

  it('strips idempotencyKey from the request body (keeps token)', async () => {
    let receivedBody: Record<string, unknown> = {};
    server.use(
      http.post(`${BASE}/wallet/v1/confidential/transfer`, async ({ request }) => {
        receivedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          request_id: 'dddddddd-0000-0000-0000-000000000002',
          status: 'success',
        });
      }),
    );
    const client = new OutlayerClient({ apiKey });
    await client.confidentialTransfer({
      to: 'bob-hex',
      amount: '1',
      token: 'nep141:wrap.near',
      idempotencyKey: 'transfer-key',
    });
    expect(receivedBody.idempotencyKey).toBeUndefined();
    expect(receivedBody.token).toBe('nep141:wrap.near');
  });

  it('throws WalletFrozenError on 403 wallet_frozen', async () => {
    server.use(
      http.post(`${BASE}/wallet/v1/confidential/transfer`, () => {
        return HttpResponse.json({ error: 'wallet_frozen' }, { status: 403 });
      }),
    );
    const client = new OutlayerClient({ apiKey });
    await expect(
      client.confidentialTransfer({ to: 'bob-hex', amount: '1', token: 'nep141:wrap.near' }),
    ).rejects.toBeInstanceOf(WalletFrozenError);
  });
});

describe('Confidential Intents: confidentialSwap + confidentialSwapQuote', () => {
  it('confidentialSwap returns a ConfidentialOpResponse', async () => {
    let receivedBody: unknown = null;
    server.use(
      http.post(`${BASE}/wallet/v1/confidential/swap`, async ({ request }) => {
        receivedBody = await request.json();
        return HttpResponse.json({
          request_id: 'eeeeeeee-0000-0000-0000-000000000001',
          status: 'processing',
          intent_hash: 'cintent-swap',
        });
      }),
    );
    const client = new OutlayerClient({ apiKey });
    const r = await client.confidentialSwap({
      token_in: 'nep141:wrap.near',
      token_out: 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
      amount_in: '5000000000000000000000000',
    });
    expect(receivedBody).toMatchObject({ token_in: 'nep141:wrap.near' });
    expect(r.status).toBe('processing');
    expect(r.intent_hash).toBe('cintent-swap');
  });

  it('confidentialSwap throws BadRequestError on 400 (e.g. token_in == token_out)', async () => {
    server.use(
      http.post(`${BASE}/wallet/v1/confidential/swap`, () => {
        return HttpResponse.json(
          { error: 'bad_request', message: 'token_in == token_out' },
          { status: 400 },
        );
      }),
    );
    const client = new OutlayerClient({ apiKey });
    await expect(
      client.confidentialSwap({
        token_in: 'nep141:wrap.near',
        token_out: 'nep141:wrap.near',
        amount_in: '1',
      }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it('confidentialSwapQuote returns a quote and does NOT attach Idempotency-Key', async () => {
    let receivedKey: string | null = null;
    server.use(
      http.post(`${BASE}/wallet/v1/confidential/swap/quote`, ({ request }) => {
        receivedKey = request.headers.get('idempotency-key');
        return HttpResponse.json({
          amount_out: '950000',
          min_amount_out: '940000',
          time_estimate_seconds: 12,
        });
      }),
    );
    const client = new OutlayerClient({ apiKey });
    const r = await client.confidentialSwapQuote({
      token_in: 'nep141:wrap.near',
      token_out: 'nep141:usdt.tether-token.near',
      amount_in: '1000',
    });
    expect(r.amount_out).toBe('950000');
    expect(receivedKey).toBeNull();
  });
});

describe('Confidential Intents: confidentialDepositIntent', () => {
  it('forwards source_asset + amount and returns a bridge deposit_address', async () => {
    let receivedBody: unknown = null;
    server.use(
      http.post(`${BASE}/wallet/v1/confidential/deposit-intent`, async ({ request }) => {
        receivedBody = await request.json();
        return HttpResponse.json({
          intent_id: 'cdi-1',
          deposit_address: '5AmGa2Bcfajbytg55UUb4vCAAzKBMYKZNQwx5S2BH2qf',
          amount: '500000',
          amount_out: '499490',
          min_amount_out: '494495',
          expires_at: '2026-06-02T00:00:00Z',
        });
      }),
    );
    const client = new OutlayerClient({ apiKey });
    const r = await client.confidentialDepositIntent({
      source_asset: 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near',
      amount: '500000',
    });
    expect(receivedBody).toEqual({
      source_asset: 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near',
      amount: '500000',
    });
    expect(r.deposit_address).toBe('5AmGa2Bcfajbytg55UUb4vCAAzKBMYKZNQwx5S2BH2qf');
    expect(r.intent_id).toBe('cdi-1');
  });

  it('surfaces the optional hint field when present (NEAR-source path)', async () => {
    server.use(
      http.post(`${BASE}/wallet/v1/confidential/deposit-intent`, () => {
        return HttpResponse.json({
          intent_id: 'cdi-2',
          deposit_address: 'f51768dc0c4d4bbb78890262da9882dee2ee5b6c2fcf2c527e56c6eadcb54353',
          amount: '500000',
          amount_out: '500000',
          min_amount_out: '500000',
          hint: 'source chain is near; POST /wallet/v1/intents/deposit is more direct',
        });
      }),
    );
    const client = new OutlayerClient({ apiKey });
    const r = await client.confidentialDepositIntent({
      chain: 'near',
      token: 'nep141:wrap.near',
      amount: '500000',
    });
    expect(r.hint).toContain('near');
  });
});

describe('Confidential Intents: confidentialBalance', () => {
  it('forwards the token query param and returns a single balance', async () => {
    let receivedToken: string | null = null;
    server.use(
      http.get(`${BASE}/wallet/v1/confidential/balance`, ({ request }) => {
        receivedToken = new URL(request.url).searchParams.get('token');
        return HttpResponse.json({
          balance: '1000000',
          token: 'nep141:wrap.near',
          account_id: '950c134ec86a21a8525d16d1dbae79258b923cabdaa8d32da284d931f74bdcb2',
        });
      }),
    );
    const client = new OutlayerClient({ apiKey });
    const r = await client.confidentialBalance({ token: 'nep141:wrap.near' });
    expect(receivedToken).toBe('nep141:wrap.near');
    expect('balances' in r).toBe(false);
    if (!('balances' in r)) {
      expect(r.balance).toBe('1000000');
      expect(r.token).toBe('nep141:wrap.near');
    }
  });

  it('returns the full balances list when no token is given', async () => {
    let receivedQuery = '';
    server.use(
      http.get(`${BASE}/wallet/v1/confidential/balance`, ({ request }) => {
        receivedQuery = new URL(request.url).search;
        return HttpResponse.json({
          balances: [
            { token: 'nep141:wrap.near', balance: '1000000' },
            { token: 'nep141:usdt.tether-token.near', balance: '250000' },
          ],
          account_id: '950c134ec86a21a8525d16d1dbae79258b923cabdaa8d32da284d931f74bdcb2',
        });
      }),
    );
    const client = new OutlayerClient({ apiKey });
    const r = await client.confidentialBalance();
    expect(receivedQuery).not.toContain('token=');
    expect('balances' in r).toBe(true);
    if ('balances' in r) {
      expect(r.balances).toHaveLength(2);
      expect(r.balances[0]?.token).toBe('nep141:wrap.near');
    }
  });
});
