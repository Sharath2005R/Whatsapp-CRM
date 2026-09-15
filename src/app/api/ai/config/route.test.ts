import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  getCurrentAccount: vi.fn(),
}));
vi.mock('@/lib/auth/account', () => ({
  ...mocks,
  toErrorResponse: () => Response.json({ error: 'Forbidden' }, { status: 403 }),
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  RATE_LIMITS: { adminAction: {} },
  rateLimitResponse: () => Response.json({}, { status: 429 }),
}));
vi.mock('@/lib/whatsapp/encryption', () => ({
  encrypt: (key: string) => `encrypted:${key}`,
  decrypt: (key: string) => key.replace('encrypted:', ''),
}));
import { GET, POST } from './route';
import { POST as testConnection } from '../test/route';

let existing: Record<string, unknown> | null;
let writes: Array<Record<string, unknown>>;
let filters: Array<[string, string, unknown]>;
function database() {
  return {
    from(table: string) {
      const chain = {
        select: () => chain,
        eq: (key: string, value: unknown) => {
          filters.push([table, key, value]);
          return chain;
        },
        maybeSingle: async () => ({
          data: table === 'ai_configs' ? existing : null,
          error: null,
        }),
        update: (row: Record<string, unknown>) => {
          writes.push(row);
          return chain;
        },
        insert: (row: Record<string, unknown>) => {
          writes.push(row);
          return chain;
        },
        then: (resolve: (result: { error: null }) => unknown) =>
          resolve({ error: null }),
      };
      return chain;
    },
  };
}
function request(body: Record<string, unknown>) {
  return new Request('http://localhost/api/ai/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
const local = { provider: 'ollama', model: 'qwen3:4b', is_active: true };
beforeEach(() => {
  existing = null;
  writes = [];
  filters = [];
  const context = {
    supabase: database(),
    accountId: 'trusted-account',
    userId: 'admin',
    role: 'admin',
    account: { id: 'trusted-account', name: 'Trusted business' },
  };
  mocks.requireRole.mockResolvedValue(context);
  mocks.getCurrentAccount.mockResolvedValue(context);
  vi.stubEnv('OLLAMA_BASE_URL', 'http://127.0.0.1:11434');
  vi.stubEnv('OLLAMA_ALLOWED_MODELS', 'qwen3:4b');
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        Response.json({
          done: true,
          message: { role: 'assistant', content: 'OK' },
        })
      )
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('Ollama settings through the existing routes', () => {
  it('lets an admin disable an existing Ollama setup while inference is offline', async () => {
    existing = { id: 'config', ...local, api_key: null };
    vi.mocked(fetch).mockRejectedValue(new Error('offline'));
    expect((await POST(request({ ...local, is_active: false }))).status).toBe(200);
    expect(writes[0]).toMatchObject({ is_active: false });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('saves a keyless configuration under the authenticated account only', async () => {
    const response = await POST(
      request({
        ...local,
        account_id: 'foreign-account',
        endpoint: 'https://evil.example',
        base_url: 'https://evil.example',
      })
    );
    expect(response.status).toBe(200);
    expect(mocks.requireRole).toHaveBeenCalledWith('admin');
    expect(writes).toEqual([
      expect.objectContaining({
        ...local,
        account_id: 'trusted-account',
        created_by: 'admin',
        api_key: null,
        embeddings_api_key: null,
      }),
    ]);
    expect(filters).toContainEqual([
      'ai_configs',
      'account_id',
      'trusted-account',
    ]);
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe(
      'http://127.0.0.1:11434/api/chat'
    );
  });
  it('clears old provider keys when switching to Ollama', async () => {
    existing = {
      id: 'config',
      provider: 'openai',
      model: 'gpt-x',
      api_key: 'encrypted:old-secret',
    };
    expect((await POST(request(local))).status).toBe(200);
    expect(writes[0]).toMatchObject({
      api_key: null,
      embeddings_api_key: null,
    });
    expect(JSON.stringify(vi.mocked(fetch).mock.calls)).not.toContain(
      'old-secret'
    );
  });
  it('returns neither keys nor server endpoint in GET', async () => {
    existing = { ...local, api_key: null, embeddings_api_key: null };
    const result = await (await GET()).json();
    expect(result).toMatchObject({
      configured: true,
      has_key: false,
      has_embeddings_key: false,
    });
    expect(result).not.toHaveProperty('api_key');
    expect(result).not.toHaveProperty('embeddings_api_key');
    expect(JSON.stringify(result)).not.toContain('11434');
  });
  it.each([{ api_key: 'paid-secret' }, { embeddings_api_key: 'paid-secret' }])(
    'rejects paid credentials for Ollama',
    async (credentials) => {
      expect((await POST(request({ ...local, ...credentials }))).status).toBe(
        400
      );
      expect(fetch).not.toHaveBeenCalled();
      expect(writes).toHaveLength(0);
    }
  );
  it('does not save an unapproved model or unknown provider', async () => {
    expect((await POST(request({ ...local, model: 'other:4b' }))).status).toBe(
      400
    );
    expect(
      (await POST(request({ ...local, provider: 'unknown' }))).status
    ).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });
  it('does not save after a provider failure', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('private-url-secret'));
    const result = await POST(request(local));
    expect(result.status).toBe(400);
    expect(await result.json()).toMatchObject({
      code: 'network_error',
      error: expect.not.stringContaining('secret'),
    });
    expect(writes).toHaveLength(0);
  });
  it('rejects unauthorized configuration changes before inference or writes', async () => {
    mocks.requireRole.mockRejectedValue(new Error('forbidden'));
    expect((await POST(request(local))).status).toBe(403);
    expect((await testConnection(request(local))).status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });
  it('rejects a handoff agent outside the account', async () => {
    expect(
      (await POST(request({ ...local, handoff_agent_id: 'foreign-agent' })))
        .status
    ).toBe(400);
    expect(filters).toContainEqual([
      'profiles',
      'account_id',
      'trusted-account',
    ]);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('tests Ollama without loading or saving any provider key', async () => {
    const result = await testConnection(request(local));
    expect(result.status).toBe(200);
    expect(filters).toHaveLength(0);
    expect(writes).toHaveLength(0);
    expect(mocks.requireRole).toHaveBeenCalledWith('admin');
  });
  it('preserves paid-provider key validation and encryption', async () => {
    expect(
      (await POST(request({ provider: 'openai', model: 'gpt-x' }))).status
    ).toBe(400);
    vi.mocked(fetch).mockResolvedValue(
      Response.json({ choices: [{ message: { content: 'OK' } }] })
    );
    expect(
      (
        await POST(
          request({ provider: 'openai', model: 'gpt-x', api_key: 'sk-test' })
        )
      ).status
    ).toBe(200);
    expect(writes[0]).toMatchObject({
      provider: 'openai',
      api_key: 'encrypted:sk-test',
    });
    expect(vi.mocked(fetch).mock.calls[0][0]).toContain('api.openai.com');
  });
  it('preserves paid-provider settings-only saves without inference', async () => {
    existing = {
      id: 'config',
      provider: 'anthropic',
      model: 'claude-x',
      api_key: 'encrypted:sk-test',
    };
    expect(
      (
        await POST(
          request({
            provider: 'anthropic',
            model: 'claude-x',
            system_prompt: 'Business context',
          })
        )
      ).status
    ).toBe(200);
    expect(fetch).not.toHaveBeenCalled();
    expect(writes[0]).not.toHaveProperty('api_key');
  });
});
