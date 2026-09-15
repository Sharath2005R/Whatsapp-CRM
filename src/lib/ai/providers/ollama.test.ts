import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateOllama } from './ollama';
import { generateReply } from '../generate';
import { loadOllamaConfig } from '../ollama-config';
import { testContext } from '../test-helpers';

const context = testContext();

const args = {
  model: 'qwen3:4b',
  systemPrompt: 'Verified business instructions',
  timeoutMs: 1000,
  messages: [{ role: 'user' as const, content: 'What is the price?' }],
};
const reply = { done: true, message: { role: 'assistant', content: 'Hello' } };

beforeEach(() => {
  vi.stubEnv('OLLAMA_BASE_URL', 'http://127.0.0.1:11434');
  vi.stubEnv('OLLAMA_ALLOWED_MODELS', 'qwen3:4b');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(reply)));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('Ollama configuration', () => {
  it('uses operator configuration, including a reverse proxy prefix', () => {
    vi.stubEnv('OLLAMA_BASE_URL', 'http://inference.internal:11434/ollama/');
    expect(loadOllamaConfig(args.model).endpoint).toBe(
      'http://inference.internal:11434/ollama/api/chat'
    );
  });
  it.each([
    '',
    'not a url',
    'file:///tmp/model',
    'https://user:secret@host',
    'https://host/?key=secret',
    'http://host/#secret',
  ])('rejects invalid endpoint %s without echoing it', (url) => {
    vi.stubEnv('OLLAMA_BASE_URL', url);
    expect(() => loadOllamaConfig(args.model)).toThrow(
      expect.objectContaining({ code: 'invalid_config' })
    );
  });
  it.each(['', 'qwen3:4b,', '*', 'model:cloud'])(
    'rejects invalid operator model configuration %s',
    (models) => {
      vi.stubEnv('OLLAMA_ALLOWED_MODELS', models);
      expect(() => loadOllamaConfig(args.model)).toThrow(
        expect.objectContaining({ code: 'invalid_config' })
      );
    }
  );
  it('rejects unavailable model choices before sending any request', async () => {
    await expect(
      generateOllama({ ...args, model: 'other:4b' })
    ).rejects.toMatchObject({ code: 'unsupported_model' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([0, -1, 1.5, Infinity, 2_147_483_648])(
    'rejects invalid timeout %s',
    async (timeoutMs) => {
      await expect(
        generateOllama({ ...args, timeoutMs })
      ).rejects.toMatchObject({ code: 'invalid_config' });
      expect(fetch).not.toHaveBeenCalled();
    }
  );
});

describe('Ollama generation', () => {
  it.each(['<think>private</think>answer', 'private</think>answer', '<THINK>unfinished'])('rejects reasoning delimiters instead of guessing an answer: %s', async content => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ ...reply, message: { role: 'assistant', content } }));
    await expect(generateOllama(args)).rejects.toMatchObject({ code: 'unsafe_response' });
  });
  it('uses native chat with separate thinking and without credentials, streaming or redirects', async () => {
    vi.mocked(fetch).mockResolvedValue(
      Response.json({ ...reply, prompt_eval_count: 12, eval_count: 3 })
    );
    const result = await generateOllama(args);
    expect(result).toEqual({
      text: 'Hello',
      usage: { promptTokens: 12, completionTokens: 3, totalTokens: 15 },
    });
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('http://127.0.0.1:11434/api/chat');
    expect(init?.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(init?.redirect).toBe('error');
    expect(JSON.parse(init?.body as string)).toMatchObject({
      model: args.model,
      stream: false,
      think: true,
      messages: [
        { role: 'system', content: args.systemPrompt },
        ...args.messages,
      ],
      options: { num_predict: 1024 },
    });
  });
  it('returns no fabricated usage and never exposes separate thinking', async () => {
    vi.mocked(fetch).mockResolvedValue(
      Response.json({
        ...reply,
        message: { ...reply.message, thinking: 'internal secret' },
      })
    );
    expect(await generateOllama(args)).toEqual({ text: 'Hello', usage: null });
  });
  it.each([
    null,
    {},
    { ...reply, done: false },
    { ...reply, error: 'internal secret' },
    { ...reply, message: { role: 'user', content: 'bad' } },
    { ...reply, message: { role: 'assistant', content: 10 } },
    {
      ...reply,
      message: {
        ...reply.message,
        tool_calls: [{ function: { name: 'create_lead' } }],
      },
    },
  ])('rejects malformed or unsupported responses: %j', async (body) => {
    vi.mocked(fetch).mockResolvedValue(Response.json(body));
    await expect(generateOllama(args)).rejects.toMatchObject({
      code: 'malformed_response',
    });
  });
  it('rejects invalid JSON', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response('<html>proxy secret</html>')
    );
    await expect(generateOllama(args)).rejects.toMatchObject({
      code: 'malformed_response',
    });
  });
  it('rejects truncated replies', async () => {
    vi.mocked(fetch).mockResolvedValue(
      Response.json({ ...reply, done_reason: 'length' })
    );
    await expect(generateOllama(args)).rejects.toMatchObject({
      code: 'incomplete_response',
    });
  });
  it('rejects empty replies', async () => {
    vi.mocked(fetch).mockResolvedValue(
      Response.json({ ...reply, message: { role: 'assistant', content: '  ' } })
    );
    await expect(generateOllama(args)).rejects.toMatchObject({
      code: 'empty_response',
    });
  });
  it.each([
    [400, 'unsupported_model'],
    [404, 'model_not_found'],
    [401, 'invalid_config'],
    [403, 'invalid_config'],
    [429, 'rate_limited'],
    [500, 'provider_error'],
  ])('maps HTTP %s safely', async (status, code) => {
    vi.mocked(fetch).mockResolvedValue(
      Response.json(
        { error: 'secret private URL' },
        { status: status as number }
      )
    );
    await expect(generateOllama(args)).rejects.toMatchObject({
      code,
      message: expect.not.stringContaining('secret'),
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('sanitizes connection errors', async () => {
    vi.mocked(fetch).mockRejectedValue(
      new TypeError('failed: http://private:secret@host')
    );
    await expect(generateOllama(args)).rejects.toMatchObject({
      code: 'network_error',
      message: expect.not.stringContaining('secret'),
    });
  });
  it('maps timeouts while connecting', async () => {
    vi.mocked(fetch).mockRejectedValue(
      new DOMException('timeout', 'TimeoutError')
    );
    await expect(generateOllama(args)).rejects.toMatchObject({
      code: 'timeout',
      status: 504,
    });
  });
  it('maps timeouts while reading the body', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.reject(new DOMException('aborted', 'AbortError')),
    } as Response);
    await expect(generateOllama(args)).rejects.toMatchObject({
      code: 'timeout',
      status: 504,
    });
  });
  it('integrates with generateReply and the existing handoff protocol without fallback', async () => {
    vi.mocked(fetch).mockResolvedValue(
      Response.json({
        ...reply,
        message: { role: 'assistant', content: '[[HANDOFF]]' },
      })
    );
    const config = {
      provider: 'ollama' as const,
      model: args.model,
      apiKey: '',
      systemPrompt: null,
      isActive: true,
      autoReplyEnabled: true,
      autoReplyMaxPerConversation: 3,
      handoffAgentId: null,
      embeddingsApiKey: null,
    };
    expect(await generateReply({ ...args, context, config })).toEqual({
      text: '',
      handoff: true,
      usage: null,
    });
    vi.mocked(fetch).mockRejectedValue(new Error('offline'));
    await expect(generateReply({ ...args, context, config })).rejects.toMatchObject({
      code: 'network_error',
    });
    expect(
      vi
        .mocked(fetch)
        .mock.calls.every(([url]) =>
          String(url).startsWith('http://127.0.0.1:11434/')
        )
    ).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
