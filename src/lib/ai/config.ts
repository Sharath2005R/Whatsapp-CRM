import { assertAiContext, type AiExecutionContext } from './execution-context'
import { decrypt } from '@/lib/whatsapp/encryption'
import type { AiConfig, AiProvider } from './types'

interface AiConfigRow {
  provider: AiProvider
  model: string
  api_key: string | null
  system_prompt: string | null
  is_active: boolean
  auto_reply_enabled: boolean
  auto_reply_max_per_conversation: number
  handoff_agent_id: string | null
  embeddings_api_key: string | null
}

const CONFIG_COLUMNS =
  'provider, model, api_key, system_prompt, is_active, auto_reply_enabled, auto_reply_max_per_conversation, handoff_agent_id, embeddings_api_key'

/**
 * Load and decrypt the account's AI config for *use* (draft or
 * auto-reply). Returns `null` when there's no row or the master switch
 * (`is_active`) is off — both mean "AI is not available", which callers
 * treat identically. Throws only if the stored key can't be decrypted
 * (mismatched `ENCRYPTION_KEY`), so that distinct failure surfaces
 * rather than looking like "not configured".
 *
 * Requires a server-issued context, retaining its original RLS-scoped
 * dashboard client or verified webhook service-role client.
 */
export async function loadAiConfig(
  context: AiExecutionContext,
  opts: { requireActive?: boolean } = {},
): Promise<AiConfig | null> {
  assertAiContext(context)
  const { db, accountId } = context
  const { requireActive = true } = opts
  const { data, error } = await db
    .from('ai_configs')
    .select(CONFIG_COLUMNS)
    .eq('account_id', accountId)
    .maybeSingle()

  if (error) throw error
  if (!data) return null

  const row = data as AiConfigRow
  // The Playground passes requireActive:false so an admin can test the
  // agent before flipping the master switch on.
  if (requireActive && !row.is_active) return null
  // Paid providers require a stored key; Ollama uses server configuration.
  if (row.provider !== 'ollama' && !row.api_key) return null

  // The embeddings key is optional and independent of the chat key —
  // a corrupt/undecryptable one should downgrade to lexical KB, not
  // take down draft/auto-reply, so decrypt failures are swallowed here.
  // Ollama selects its local embedding adapter separately; never decrypt a paid key.
  let embeddingsApiKey: string | null = null
  if (row.provider !== 'ollama' && row.embeddings_api_key) {
    try {
      embeddingsApiKey = decrypt(row.embeddings_api_key)
    } catch {
      // Not silent — a rotated/mismatched ENCRYPTION_KEY here means
      // semantic search quietly stops working, so leave a breadcrumb.
      console.error(
        `[ai config] embeddings key for account ${accountId} could not be decrypted — check ENCRYPTION_KEY; semantic search is disabled until it is re-entered.`,
      )
      embeddingsApiKey = null
    }
  }

  return {
    provider: row.provider,
    model: row.model,
    apiKey: row.provider === 'ollama' ? '' : decrypt(row.api_key!),
    systemPrompt: row.system_prompt,
    isActive: row.is_active,
    autoReplyEnabled: row.auto_reply_enabled,
    autoReplyMaxPerConversation: row.auto_reply_max_per_conversation,
    handoffAgentId: row.handoff_agent_id,
    embeddingsApiKey,
  }
}

/**
 * Load + decrypt just the embeddings key, independent of `is_active`.
 * Used by the knowledge-base ingest routes so the KB gets embedded (and
 * semantic search works) whenever an embeddings key is present, even if
 * the assistant's master switch is currently off.
 *
 * Returns `{ key, corrupt }`: `key` is null when there's no key OR it
 * can't be decrypted; `corrupt` distinguishes those cases so callers can
 * warn ("a key is set but unusable") rather than silently indexing
 * lexical-only and reporting success.
 */
export async function loadEmbeddingsKey(
  context: AiExecutionContext,
): Promise<{ key: string | null; corrupt: boolean; provider: AiProvider }> {
  assertAiContext(context)
  const { db, accountId } = context
  const { data, error } = await db
    .from('ai_configs')
    .select('provider, embeddings_api_key')
    .eq('account_id', accountId)
    .maybeSingle()
  if (error) throw error
  const provider: AiProvider = data?.provider ?? 'ollama'
  if (provider === 'ollama' || !data?.embeddings_api_key)
    return { key: null, corrupt: false, provider }
  try {
    return { key: decrypt(data.embeddings_api_key), corrupt: false, provider }
  } catch {
    console.error(
      `[ai config] embeddings key for account ${accountId} could not be decrypted — check ENCRYPTION_KEY.`,
    )
    return { key: null, corrupt: true, provider }
  }
}
