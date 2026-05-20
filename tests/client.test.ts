import { describe, expect, it } from 'vitest';
import { HttpResponse, http } from 'msw';
import { server } from './setup.js';
import { errorHandlers } from './handlers.js';
import {
  OutlayerClient,
  OutlayerError,
  PolicyDeniedError,
  RateLimitedError,
  WalletFrozenError,
} from '../src/index.js';

const apiKey = 'wk_test_xxx';
const BASE = 'https://api.outlayer.fastnear.com';

describe('OutlayerClient.register', () => {
  it('returns an API key + wallet id', async () => {
    const r = await OutlayerClient.register();
    expect(r.api_key).toMatch(/^wk_/);
    expect(r.wallet_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.handoff_url).toContain('api_key=');
  });
});

describe('OutlayerClient.getAddress', () => {
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
});

describe('OutlayerClient.getBalance', () => {
  it('returns balance for the wallet', async () => {
    const client = new OutlayerClient({ apiKey });
    const r = await client.getBalance({ chain: 'near' });
    expect(r.balance).toBe('1000000000000000000000000');
    expect(r.token).toBe('NEAR');
  });
});

describe('OutlayerClient.withdraw — happy path', () => {
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
});

describe('OutlayerClient.withdraw — error paths', () => {
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

describe('OutlayerClient retry behavior', () => {
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
});

describe('OutlayerError shape', () => {
  it('carries code, status, message', async () => {
    server.use(errorHandlers.policyDenied);
    const client = new OutlayerClient({ apiKey });
    try {
      await client.withdraw({ chain: 'near', to: 'bob.near', amount: '1' });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(OutlayerError);
      const err = e as OutlayerError;
      expect(err.code).toBe('policy_denied');
      expect(err.status).toBe(403);
      expect(err.message).toContain('daily limit');
    }
  });
});

describe('Idempotency-Key auto-generation', () => {
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
});
