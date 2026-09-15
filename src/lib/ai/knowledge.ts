import { assertAiContext, type AiExecutionContext } from './execution-context'
import { AiError, type AiConfig } from './types'
import { chunkText } from './chunk'
import { embedTexts, toVectorLiteral } from './embeddings'
import { knowledgeEmbeddingConfig } from './embedding-config'
import { validateVectors } from './providers/ollama-embeddings'

type KnowledgeConfig = Pick<AiConfig, 'embeddingsApiKey'> &
  Partial<Pick<AiConfig, 'provider'>>

export interface KnowledgeSource {
  id: string
  document_id: string
  title: string
  content: string
  score: number
  method: 'semantic' | 'lexical'
}

export async function ingestDocument(
  context: AiExecutionContext,
  config: KnowledgeConfig,
  documentId: string,
  content: string,
): Promise<void> {
  assertAiContext(context)
  const { db, accountId } = context
  const { data: document, error } = await db
    .from('ai_knowledge_documents')
    .select('id')
    .eq('account_id', accountId)
    .eq('id', documentId)
    .maybeSingle()
  if (error || !document)
    throw new AiError('Knowledge document not found.', {
      code: 'document_not_found',
      status: 404,
    })
  if (content.length > 120000)
    throw new AiError('Document is too large to index in one request.', {
      code: 'document_too_large',
      status: 400,
    })

  const chunks = chunkText(content)
  const selected = knowledgeEmbeddingConfig(config)
  let vectors: number[][] | null = null
  let embeddingError: unknown
  if (selected && chunks.length) {
    try {
      vectors = validateVectors(
        await embedTexts(selected, chunks),
        chunks.length,
        selected.provider === 'ollama' ? 1024 : 1536,
      )
    } catch (error) {
      embeddingError = error
    }
  }
  const rows = chunks.map((text, index) => ({
    content: text,
    embedding:
      vectors && selected?.provider === 'openai'
        ? toVectorLiteral(vectors[index])
        : null,
    local_embedding:
      vectors && selected?.provider === 'ollama'
        ? toVectorLiteral(vectors[index])
        : null,
    local_embedding_space:
      vectors && selected?.provider === 'ollama' ? selected.space : null,
  }))
  // One transaction with ownership and document-version checks inside SQL.
  const { error: writeError } = await db.rpc('replace_ai_knowledge_chunks', {
    p_account_id: accountId,
    p_document_id: documentId,
    p_content: content,
    p_chunks: rows,
  })
  if (writeError)
    throw new AiError('Knowledge indexing could not be saved. Please retry.', {
      code: 'indexing_failed',
    })
  // On embedding failure, current lexical chunks have still been saved atomically.
  if (embeddingError) throw embeddingError
}

/** Account-filtered retrieval with provenance; no globally retrieved rows. */
export async function retrieveKnowledge(
  context: AiExecutionContext,
  config: KnowledgeConfig,
  queryText: string,
  k = 5,
): Promise<KnowledgeSource[]> {
  assertAiContext(context)
  const { db, accountId } = context
  const query = queryText.trim().slice(0, 1600)
  if (!query || k <= 0) return []
  const threshold = Number(process.env.AI_KNOWLEDGE_MIN_SIMILARITY ?? 0.65)
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new AiError('Knowledge relevance threshold is invalid.', {
      code: 'invalid_config',
      status: 503,
    })
  }
  const selected = knowledgeEmbeddingConfig(config)
  let vector: string | null = null
  let space: string | null = null
  try {
    const { count, error } = await db
      .from('ai_knowledge_chunks')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId)
    if (error || !count) return []
    if (selected) {
      try {
        const embeddings = validateVectors(
          await embedTexts(selected, [query], 'query'),
          1,
          selected.provider === 'ollama' ? 1024 : 1536,
        )
        vector = toVectorLiteral(embeddings[0])
        space =
          selected.provider === 'ollama'
            ? selected.space
            : 'openai:text-embedding-3-small:1536'
      } catch {
        console.warn(
          '[ai knowledge] embeddings unavailable; using tenant lexical retrieval',
        )
      }
    }
    const { data, error: matchError } = await db.rpc('match_ai_knowledge_v2', {
      p_account_id: accountId,
      p_query: query,
      p_query_embedding: vector,
      p_embedding_space: space,
      p_min_similarity: threshold,
      p_match_count: Math.min(20, Math.floor(k)),
    })
    if (matchError || !Array.isArray(data)) return []
    return data
      .filter(
        (row): row is KnowledgeSource =>
          typeof row.id === 'string' &&
          typeof row.document_id === 'string' &&
          typeof row.title === 'string' &&
          typeof row.content === 'string' &&
          Number.isFinite(row.score) &&
          row.content.length > 0 &&
          ((row.method === 'semantic' && row.score >= threshold) ||
            (row.method === 'lexical' && row.score > 0)),
      )
      .slice(0, k)
  } catch {
    return []
  }
}
