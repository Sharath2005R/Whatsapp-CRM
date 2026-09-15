import { createServer, type Server, type RequestListener } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { generateOllama } from './ollama';

let server: Server | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

async function listen(handler: RequestListener) {
  server = createServer(handler);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Test server did not start');
  vi.stubEnv('OLLAMA_BASE_URL', `http://127.0.0.1:${address.port}`);
  vi.stubEnv('OLLAMA_ALLOWED_MODELS', 'qwen3:4b');
}
const args = {
  model: 'qwen3:4b',
  systemPrompt: 'sys',
  messages: [{ role: 'user' as const, content: 'Hi' }],
  timeoutMs: 2000,
};

it('sends the chat contract over HTTP to an Ollama-compatible test server', async () => {
  let requestBody = '';
  let requestPath = '';
  await listen((req, res) => {
    requestPath = req.url ?? '';
    req.on('data', (chunk) => {
      requestBody += chunk;
    });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          done: true,
          message: { role: 'assistant', content: 'Hi there' },
          prompt_eval_count: 5,
          eval_count: 2,
        })
      );
    });
  });
  expect(await generateOllama(args)).toMatchObject({
    text: 'Hi there',
    usage: { totalTokens: 7 },
  });
  expect(requestPath).toBe('/api/chat');
  expect(JSON.parse(requestBody)).toMatchObject({
    stream: false,
    think: true,
    model: 'qwen3:4b',
  });
});

it('aborts a stalled response body using the real fetch signal', async () => {
  await listen((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{"done":');
  });
  await expect(
    generateOllama({ ...args, timeoutMs: 100 })
  ).rejects.toMatchObject({ code: 'timeout', status: 504 });
});

it('does not follow a redirect to another inference host', async () => {
  await listen((_req, res) => {
    res.writeHead(307, { Location: 'http://127.0.0.1:1/leak' });
    res.end();
  });
  await expect(generateOllama(args)).rejects.toMatchObject({
    code: 'network_error',
  });
});
