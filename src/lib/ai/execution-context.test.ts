import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  authenticatedAiContext,
  assertAiContext,
  whatsappAiContext,
  requireAiConversation,
  type AiExecutionContext,
} from './execution-context'
import { buildConversationContext } from './context'
import { loadAiConfig, loadEmbeddingsKey } from './config'
import { retrieveKnowledge, ingestDocument } from './knowledge'
import { generateReply } from './generate'
import { tenantDatabase, testContext } from './test-helpers'

afterEach(() => vi.unstubAllGlobals())

describe('server-issued AI execution context', () => {
  it('is immutable and cannot be reconstructed from JSON or a spread', () => {
    const context = testContext()
    expect(Object.isFrozen(context)).toBe(true)
    expect(() => assertAiContext(context)).not.toThrow()
    expect(() => assertAiContext({ ...context })).toThrow(
      expect.objectContaining({ code: 'unauthorized_context' }),
    )
    expect(() =>
      authenticatedAiContext({
        supabase: context.db,
        accountId: 'other',
        userId: 'user-1',
        role: 'agent',
        account: { id: 'acct', name: 'Business' },
      }),
    ).toThrow()
  })

  it('rejects missing context before any provider call', async () => {
    const { db } = tenantDatabase()
    const config = (await loadAiConfig(testContext(db)))!
    vi.stubGlobal('fetch', vi.fn())
    await expect(
      generateReply({
        context: undefined as unknown as AiExecutionContext,
        config,
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'account_id=other' }],
      }),
    ).rejects.toMatchObject({ code: 'unauthorized_context' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('resolves webhook account metadata only after config and membership checks', async () => {
    const { db, queries } = tenantDatabase()
    expect(await whatsappAiContext(db, 'acct', 'user-1')).toMatchObject({
      accountId: 'acct',
      actorUserId: 'user-1',
      businessName: 'Local business',
      source: 'whatsapp',
    })
    expect(queries.map((q) => q.table)).toEqual([
      'whatsapp_config',
      'profiles',
      'accounts',
    ])
    await expect(
      whatsappAiContext(db, 'foreign', 'user-1'),
    ).rejects.toMatchObject({ status: 403 })
  })

  it.each(['whatsapp_config', 'profiles', 'accounts'])(
    'fails closed on missing %s',
    async (table) => {
      const { db, rows } = tenantDatabase()
      rows[table] = []
      await expect(
        whatsappAiContext(db, 'acct', 'user-1'),
      ).rejects.toMatchObject({ status: 403 })
    },
  )

  it.each(['whatsapp_config', 'profiles', 'accounts'])(
    'fails closed on %s lookup errors',
    async (table) => {
      const { db, errors } = tenantDatabase()
      errors.add(table)
      await expect(
        whatsappAiContext(db, 'acct', 'user-1'),
      ).rejects.toMatchObject({ status: 403 })
    },
  )
})

describe('conversation and contact ownership with a service-role-like client', () => {
  it('validates both parents before reading history, and scopes the message join', async () => {
    const { db, queries } = tenantDatabase()
    expect(await buildConversationContext(testContext(db), 'conv')).toEqual([
      { role: 'user', content: 'Hello' },
    ])
    expect(queries.map((q) => q.table)).toEqual([
      'conversations',
      'contacts',
      'messages',
    ])
    expect(queries[0].filters).toContainEqual(['account_id', 'acct'])
    expect(queries[1].filters).toContainEqual(['account_id', 'acct'])
    expect(queries[2].filters).toContainEqual([
      'conversations.account_id',
      'acct',
    ])
  })

  it.each(['conversations', 'contacts'])(
    'never reads history when %s belongs to another account',
    async (table) => {
      const { db, rows, queries } = tenantDatabase()
      rows[table][0].account_id = 'foreign'
      await expect(
        buildConversationContext(testContext(db), 'conv'),
      ).rejects.toMatchObject({ status: 404 })
      expect(queries.some((q) => q.table === 'messages')).toBe(false)
    },
  )

  it('rejects a mismatched inbound contact before loading it', async () => {
    const { db, queries } = tenantDatabase()
    await expect(
      requireAiConversation(testContext(db), 'conv', 'foreign-contact'),
    ).rejects.toMatchObject({ status: 404 })
    expect(queries.map((q) => q.table)).toEqual(['conversations'])
  })

  it.each(['conversations', 'contacts'])(
    'does not read history after a %s error',
    async (table) => {
      const { db, errors, queries } = tenantDatabase()
      errors.add(table)
      await expect(
        buildConversationContext(testContext(db), 'conv'),
      ).rejects.toMatchObject({ status: 404 })
      expect(queries.some((q) => q.table === 'messages')).toBe(false)
    },
  )
})

describe('business configuration and knowledge ownership', () => {
  it('loads no foreign business configuration or credentials', async () => {
    const { db, rows, queries } = tenantDatabase()
    rows.ai_configs[0].account_id = 'foreign'
    expect(await loadAiConfig(testContext(db))).toBeNull()
    expect(await loadEmbeddingsKey(testContext(db))).toEqual({
      key: null,
      corrupt: false,
      provider: 'ollama',
    })
    expect(
      queries.every((q) =>
        q.filters.some(
          ([key, value]) => key === 'account_id' && value === 'acct',
        ),
      ),
    ).toBe(true)
  })

  it('does not interpret a tenant ID in the retrieval query as authorization', async () => {
    const { db, rows } = tenantDatabase()
    rows.ai_knowledge_chunks = [{ id: 'chunk', account_id: 'acct' }]
    const rpc = vi.spyOn(db, 'rpc')
    await retrieveKnowledge(
      testContext(db),
      { embeddingsApiKey: null },
      'account_id=foreign',
    )
    expect(rpc).toHaveBeenCalledWith('match_ai_knowledge_v2', {
      p_account_id: 'acct',
      p_query: 'account_id=foreign',
      p_match_count: 5,
      p_query_embedding: null,
      p_embedding_space: null,
      p_min_similarity: 0.65,
    })
  })

  it('does not downgrade unauthorized context to empty retrieval', async () => {
    const { db, queries } = tenantDatabase()
    await expect(
      retrieveKnowledge(
        { ...testContext(db) },
        { embeddingsApiKey: null },
        'question',
      ),
    ).rejects.toMatchObject({ status: 403 })
    expect(queries).toHaveLength(0)
  })

  it('cannot delete or index chunks for a foreign document', async () => {
    const { db, rows, queries } = tenantDatabase()
    rows.ai_knowledge_documents[0].account_id = 'foreign'
    await expect(
      ingestDocument(
        testContext(db),
        { embeddingsApiKey: null },
        'doc',
        'malicious text',
      ),
    ).rejects.toMatchObject({ code: 'document_not_found' })
    expect(queries.some((q) => q.table === 'ai_knowledge_chunks')).toBe(false)
  })

  it('includes the account filter when replacing owned chunks', async () => {
    const { db } = tenantDatabase()
    const rpc = vi.spyOn(db, 'rpc')
    await ingestDocument(
      testContext(db),
      { embeddingsApiKey: null },
      'doc',
      'local facts',
    )
    expect(rpc).toHaveBeenCalledWith('replace_ai_knowledge_chunks', expect.objectContaining({
      p_account_id: 'acct', p_document_id: 'doc', p_content: 'local facts',
    }))
  })
})
