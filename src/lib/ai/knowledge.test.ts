import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  retrieveKnowledge,
  ingestDocument,
  type KnowledgeSource,
} from './knowledge'
import { tenantDatabase, testContext } from './test-helpers'

const h = vi.hoisted(() => ({ embedTexts: vi.fn() }))
vi.mock('./embeddings', () => ({
  embedTexts: h.embedTexts,
  toVectorLiteral: (v: number[]) => JSON.stringify(v),
}))
const source = (
  account: string,
  content: string,
): KnowledgeSource & { account_id: string } => ({
  id: account + '-chunk',
  document_id: account + '-doc',
  title: 'Kerala',
  content,
  score: 0.9,
  method: 'semantic',
  account_id: account,
})
beforeEach(() => {
  h.embedTexts.mockReset()
  h.embedTexts.mockImplementation(async (config, inputs: string[]) =>
    inputs.map(() =>
      Array(config.provider === 'ollama' ? 1024 : 1536).fill(0.1),
    ),
  )
  vi.stubEnv('AI_KNOWLEDGE_MIN_SIMILARITY', '0.65')
})
afterEach(() => vi.unstubAllEnvs())

function setup() {
  const fixture = tenantDatabase()
  const sources = [
    source('acct', 'Kerala package = ₹25,000'),
    source('foreign', 'Kerala package = ₹40,000'),
  ]
  fixture.rows.ai_knowledge_chunks = sources.map((value) => ({ ...value }))
  const rpc = vi.spyOn(fixture.db, 'rpc').mockImplementation((name, args) => {
    const params = args as Record<string, unknown>
    const data =
      name === 'match_ai_knowledge_v2'
        ? sources.filter((s) => s.account_id === params.p_account_id)
        : null
    return Promise.resolve({ data, error: null }) as never
  })
  return { ...fixture, sources, rpc, context: testContext(fixture.db) }
}

describe('tenant-isolated retrieval', () => {
  it('returns only Business A sources and retains provenance', async () => {
    const { context, rpc } = setup()
    const hits = await retrieveKnowledge(
      context,
      { provider: 'ollama', embeddingsApiKey: null },
      'Kerala package price',
    )
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({
      document_id: 'acct-doc',
      content: 'Kerala package = ₹25,000',
    })
    expect(JSON.stringify(hits)).not.toContain('40,000')
    expect(rpc).toHaveBeenCalledWith(
      'match_ai_knowledge_v2',
      expect.objectContaining({ p_account_id: 'acct' }),
    )
  })
  it('uses local embedding space and never selects an existing paid key for Ollama', async () => {
    const { context, rpc } = setup()
    await retrieveKnowledge(
      context,
      { provider: 'ollama', embeddingsApiKey: 'old-paid-key' },
      'price',
    )
    expect(h.embedTexts.mock.calls[0][0].provider).toBe('ollama')
    expect(rpc).toHaveBeenCalledWith(
      'match_ai_knowledge_v2',
      expect.objectContaining({
        p_embedding_space: 'qwen3-embedding:0.6b:1024:retrieval-v1',
      }),
    )
  })
  it('preserves existing paid semantic embeddings', async () => {
    const { context, rpc } = setup()
    await retrieveKnowledge(
      context,
      { provider: 'anthropic', embeddingsApiKey: 'paid-key' },
      'price',
    )
    expect(h.embedTexts.mock.calls[0][0]).toEqual({
      provider: 'openai',
      apiKey: 'paid-key',
    })
    expect(rpc).toHaveBeenCalledWith(
      'match_ai_knowledge_v2',
      expect.objectContaining({
        p_embedding_space: 'openai:text-embedding-3-small:1536',
      }),
    )
  })
  it('retains lexical-only behavior without a paid key', async () => {
    const { context, rpc } = setup()
    await retrieveKnowledge(
      context,
      { provider: 'openai', embeddingsApiKey: null },
      'Kerala',
    )
    expect(h.embedTexts).not.toHaveBeenCalled()
    expect(rpc).toHaveBeenCalledWith(
      'match_ai_knowledge_v2',
      expect.objectContaining({ p_query_embedding: null }),
    )
  })
  it('uses only tenant lexical search after local embedding failure', async () => {
    const { context, rpc } = setup()
    h.embedTexts.mockRejectedValue(new Error('offline'))
    await retrieveKnowledge(
      context,
      { provider: 'ollama', embeddingsApiKey: null },
      'Kerala',
    )
    expect(h.embedTexts).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith(
      'match_ai_knowledge_v2',
      expect.objectContaining({
        p_query_embedding: null,
        p_account_id: 'acct',
      }),
    )
  })
  it('rejects low relevance and missing results', async () => {
    const { context, sources } = setup()
    sources[0].score = 0.2
    expect(
      await retrieveKnowledge(context, { embeddingsApiKey: null }, 'unrelated'),
    ).toEqual([])
  })
  it('does not call embeddings or retrieval on an empty knowledge base', async () => {
    const { context, rows, rpc } = setup()
    rows.ai_knowledge_chunks = []
    expect(
      await retrieveKnowledge(
        context,
        { provider: 'ollama', embeddingsApiKey: null },
        'question',
      ),
    ).toEqual([])
    expect(h.embedTexts).not.toHaveBeenCalled()
    expect(rpc).not.toHaveBeenCalled()
  })
  it('treats multilingual query text as data without changing account identity', async () => {
    const { context, rpc } = setup()
    await retrieveKnowledge(
      context,
      { provider: 'ollama', embeddingsApiKey: null },
      'केरल पैकेज की कीमत क्या है?',
    )
    expect(rpc).toHaveBeenCalledWith(
      'match_ai_knowledge_v2',
      expect.objectContaining({
        p_account_id: 'acct',
        p_query: 'केरल पैकेज की कीमत क्या है?',
      }),
    )
  })
})

describe('owned document indexing', () => {
  it('writes local vectors in one account-scoped RPC, not the OpenAI column', async () => {
    const { context, rpc } = setup()
    await ingestDocument(
      context,
      { provider: 'ollama', embeddingsApiKey: null },
      'doc',
      'local knowledge',
    )
    const params = rpc.mock.calls[0][1] as Record<string, unknown>
    expect(params).toMatchObject({ p_account_id: 'acct', p_document_id: 'doc' })
    const chunk = (params.p_chunks as Record<string, unknown>[])[0]
    expect(chunk.embedding).toBeNull()
    expect(JSON.parse(chunk.local_embedding as string)).toHaveLength(1024)
  })
  it('writes existing OpenAI vectors without local vectors', async () => {
    const { context, rpc } = setup()
    await ingestDocument(
      context,
      { provider: 'openai', embeddingsApiKey: 'key' },
      'doc',
      'knowledge',
    )
    const params = rpc.mock.calls[0][1] as Record<string, unknown>
    const chunk = (params.p_chunks as Record<string, unknown>[])[0]
    expect(JSON.parse(chunk.embedding as string)).toHaveLength(1536)
    expect(chunk.local_embedding).toBeNull()
  })
  it('saves current lexical chunks after embedding failure, then reports the failure', async () => {
    const { context, rpc } = setup()
    h.embedTexts.mockRejectedValue(new Error('offline'))
    await expect(
      ingestDocument(
        context,
        { provider: 'ollama', embeddingsApiKey: null },
        'doc',
        'knowledge',
      ),
    ).rejects.toThrow('offline')
    expect(rpc).toHaveBeenCalledWith(
      'replace_ai_knowledge_chunks',
      expect.objectContaining({
        p_chunks: [
          expect.objectContaining({
            content: 'knowledge',
            local_embedding: null,
          }),
        ],
      }),
    )
  })
  it('rejects foreign documents before embedding or writes', async () => {
    const { context, rows, rpc } = setup()
    rows.ai_knowledge_documents[0].account_id = 'foreign'
    await expect(
      ingestDocument(
        context,
        { provider: 'ollama', embeddingsApiKey: null },
        'doc',
        'attack',
      ),
    ).rejects.toMatchObject({ status: 404 })
    expect(h.embedTexts).not.toHaveBeenCalled()
    expect(rpc).not.toHaveBeenCalled()
  })
  it('surfaces failed atomic writes without claiming indexing success', async () => {
    const { context, rpc } = setup()
    rpc.mockImplementation(
      () => Promise.resolve({ data: null, error: { code: '40001' } }) as never,
    )
    await expect(
      ingestDocument(
        context,
        { embeddingsApiKey: null },
        'doc',
        'stale document',
      ),
    ).rejects.toMatchObject({ code: 'indexing_failed' })
  })
})
