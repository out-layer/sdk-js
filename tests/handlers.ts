import { http, HttpResponse } from 'msw';

const BASE = 'https://api.outlayer.ai';

export const handlers = [
  // POST /register
  http.post(`${BASE}/register`, async () => {
    return HttpResponse.json({
      wallet_id: '00000000-0000-0000-0000-000000000001',
      api_key: 'wk_test_2a8b1f3c4d5e6789abcdef0123456789',
      near_account_id: '000000000000000000000000000000000001',
      handoff_url: 'https://app.outlayer.ai/wallet?api_key=wk_test_...',
      trial: {
        calls_remaining: 100,
        expires_at: '2026-06-20T00:00:00Z',
        limits: {
          max_instructions: 100_000_000,
          max_execution_seconds: 30,
          max_memory_mb: 64,
        },
      },
    });
  }),

  // GET /wallet/v1/address?chain=...
  http.get(`${BASE}/wallet/v1/address`, ({ request }) => {
    const chain = new URL(request.url).searchParams.get('chain') ?? 'near';
    return HttpResponse.json({
      wallet_id: '00000000-0000-0000-0000-000000000001',
      chain,
      address: chain === 'near' ? 'wallet.near' : '0x000000000000000000000000000000000000dead',
      public_key: 'ed25519:11111111111111111111111111111111',
      vault_id: null,
    });
  }),

  // GET /wallet/v1/balance
  http.get(`${BASE}/wallet/v1/balance`, () => {
    return HttpResponse.json({
      balance: '1000000000000000000000000',
      token: 'NEAR',
      account_id: 'wallet.near',
    });
  }),

  // POST /wallet/v1/intents/withdraw — happy path
  http.post(`${BASE}/wallet/v1/intents/withdraw`, () => {
    return HttpResponse.json({
      request_id: '11111111-1111-1111-1111-111111111111',
      status: 'processing',
    });
  }),

  // GET /wallet/v1/requests/{id}
  http.get(`${BASE}/wallet/v1/requests/:id`, ({ params }) => {
    return HttpResponse.json({
      request_id: params.id,
      type: 'withdraw',
      status: 'success',
      result: { tx_hash: '0xabc' },
      created_at: '2026-05-20T10:00:00Z',
      updated_at: '2026-05-20T10:00:05Z',
    });
  }),
];

// Helpers for tests that need to override the default handlers
export const errorHandlers = {
  policyDenied: http.post(`${BASE}/wallet/v1/intents/withdraw`, () => {
    return HttpResponse.json(
      { error: 'policy_denied', message: 'daily limit exceeded' },
      { status: 403 },
    );
  }),
  walletFrozen: http.post(`${BASE}/wallet/v1/intents/withdraw`, () => {
    return HttpResponse.json({ error: 'wallet_frozen' }, { status: 403 });
  }),
  rateLimited: http.post(`${BASE}/wallet/v1/intents/withdraw`, () => {
    return HttpResponse.json({ error: 'rate_limited' }, { status: 429 });
  }),
  internalErrorOnce: (() => {
    let calls = 0;
    return http.post(`${BASE}/wallet/v1/intents/withdraw`, () => {
      calls++;
      if (calls === 1) {
        return HttpResponse.json({ error: 'internal_error' }, { status: 500 });
      }
      return HttpResponse.json({
        request_id: '22222222-2222-2222-2222-222222222222',
        status: 'processing',
      });
    });
  })(),
};
