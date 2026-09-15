import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { knowledgeEmbeddingConfig } from '../embedding-config'
import { embedTexts } from '../embeddings'
import { validateVectors } from './ollama-embeddings'

beforeEach(() => {
  vi.stubEnv('OLLAMA_EMBEDDING_MODEL', 'qwen3-embedding:0.6b')
  vi.stubEnv('OLLAMA_EMBEDDING_TIMEOUT_MS', '15000')
  vi.stubEnv('OLLAMA_EMBEDDING_BASE_URL', 'http://127.0.0.1:11434')
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (_url, init) => {
      const input = JSON.parse(init.body).input
      return Response.json({
        model: 'qwen3-embedding:0.6b',
        embeddings: input.map(() => Array(1024).fill(0.1)),
      })
    }),
  )
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})
const config = () =>
  knowledgeEmbeddingConfig({
    provider: 'ollama',
    embeddingsApiKey: 'must-not-use-paid-key',
  })!

it('uses local embedding model and query recipe without a paid fallback', async () => {
  expect(await embedTexts(config(), ['price'], 'query')).toHaveLength(1)
  const [url, init] = vi.mocked(fetch).mock.calls[0]
  expect(url).toBe('http://127.0.0.1:11434/api/embed')
  expect(init!.headers).toEqual({ 'Content-Type': 'application/json' })
  expect(JSON.parse(init!.body as string)).toMatchObject({
    model: 'qwen3-embedding:0.6b',
    dimensions: 1024,
    truncate: false,
  })
  expect(init!.body).toContain('Query: price')
})
it('bounds batches and leaves document text unprefixed', async () => {
  expect(await embedTexts(config(), Array(9).fill('document'))).toHaveLength(9)
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(
    JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string).input[0],
  ).toBe('document')
})
it.each(['qwen3:4b', 'other:cloud', ''])(
  'rejects unsupported embedding model %s',
  (model) => {
    vi.stubEnv('OLLAMA_EMBEDDING_MODEL', model)
    expect(config).toThrow()
    expect(fetch).not.toHaveBeenCalled()
  },
)
it.each(['0', 'NaN', '60001'])('rejects invalid timeout %s', (value) => {
  vi.stubEnv('OLLAMA_EMBEDDING_TIMEOUT_MS', value)
  expect(config).toThrow()
})
it.each(['https://user:secret@host', 'http://host/?key=x', 'file:///model'])(
  'rejects unsafe endpoint %s',
  (value) => {
    vi.stubEnv('OLLAMA_EMBEDDING_BASE_URL', value)
    expect(config).toThrow()
  },
)
it.each(
  [[], [[1]], [Array(1024).fill(0)], [Array(1024).fill(NaN)]].map(
    (vectors) => ({ vectors }),
  ),
)('rejects malformed vectors', ({ vectors }) => {
  expect(() => validateVectors(vectors, 1, 1024)).toThrow()
})
it.each([404, 500])(
  'fails safely on HTTP %s without fallback',
  async (status) => {
    vi.mocked(fetch).mockResolvedValue(
      Response.json({ error: 'secret' }, { status }),
    )
    await expect(embedTexts(config(), ['x'])).rejects.toThrow(
      'Local embedding service rejected',
    )
    expect(fetch).toHaveBeenCalledTimes(1)
  },
)
it('handles timeout without retry or paid fallback', async () => {
  vi.mocked(fetch).mockRejectedValue(
    new DOMException('timeout', 'TimeoutError'),
  )
  await expect(embedTexts(config(), ['x'])).rejects.toMatchObject({
    code: 'embedding_timeout',
  })
  expect(fetch).toHaveBeenCalledTimes(1)
})
it('preserves explicit existing paid embedding configuration', () => {
  expect(
    knowledgeEmbeddingConfig({
      provider: 'anthropic',
      embeddingsApiKey: 'key',
    }),
  ).toEqual({ provider: 'openai', apiKey: 'key' })
  expect(
    knowledgeEmbeddingConfig({ provider: 'openai', embeddingsApiKey: null }),
  ).toBeNull()
})

it('rejects a mismatched embedding model response', async () => {
  vi.mocked(fetch).mockResolvedValue(
    Response.json({ model: 'other', embeddings: [Array(1024).fill(0.1)] }),
  )
  await expect(embedTexts(config(), ['x'])).rejects.toMatchObject({
    code: 'embeddings_malformed',
  })
})
it('does not leak raw network errors or retry a paid endpoint', async () => {
  vi.mocked(fetch).mockRejectedValue(new Error('internal-secret-endpoint'))
  await expect(embedTexts(config(), ['x'])).rejects.toThrow(
    'Local embedding service is unavailable.',
  )
  expect(fetch).toHaveBeenCalledTimes(1)
})
it('rejects missing vectors and invalid JSON safely', async () => {
  vi.mocked(fetch).mockResolvedValue(
    Response.json({ model: 'qwen3-embedding:0.6b', embeddings: [] }),
  )
  await expect(embedTexts(config(), ['x'])).rejects.toMatchObject({
    code: 'embeddings_malformed',
  })
  vi.mocked(fetch).mockResolvedValue(new Response('{not-json'))
  await expect(embedTexts(config(), ['x'])).rejects.toThrow(
    'Local embedding service is unavailable.',
  )
})
