import type { SupabaseClient } from '@supabase/supabase-js'
import { authenticatedAiContext } from './execution-context'

export function testContext(db = {} as SupabaseClient, accountId = 'acct') {
  return authenticatedAiContext({
    supabase: db,
    accountId,
    userId: 'user-1',
    role: 'admin',
    account: { id: accountId, name: `Business ${accountId}` },
  })
}

type Row = Record<string, unknown>

/** Query fake that actually applies equality filters, including with admin access. */
export function tenantDatabase() {
  const rows: Record<string, Row[]> = {
    accounts: [{ id: 'acct', name: 'Local business' }],
    profiles: [{ user_id: 'user-1', account_id: 'acct' }],
    whatsapp_config: [{ user_id: 'user-1', account_id: 'acct' }],
    conversations: [
      {
        id: 'conv',
        account_id: 'acct',
        contact_id: 'contact',
        assigned_agent_id: null,
        ai_autoreply_disabled: false,
        ai_reply_count: 0,
      },
    ],
    contacts: [{ id: 'contact', account_id: 'acct' }],
    messages: [
      {
        conversation_id: 'conv',
        content_type: 'text',
        sender_type: 'customer',
        content_text: 'Hello',
        'conversations.account_id': 'acct',
      },
    ],
    ai_configs: [
      {
        account_id: 'acct',
        provider: 'ollama',
        model: 'qwen3:4b',
        api_key: null,
        is_active: true,
        auto_reply_enabled: true,
        auto_reply_max_per_conversation: 3,
        system_prompt: 'Trusted instructions',
        handoff_agent_id: null,
        embeddings_api_key: null,
      },
    ],
    ai_knowledge_documents: [{ id: 'doc', account_id: 'acct' }],
    ai_knowledge_chunks: [],
    automations: [],
  }
  const queries: {
    table: string
    filters: [string, unknown][]
    operation: string
  }[] = []
  const errors = new Set<string>()
  const db = {
    from(table: string) {
      const query = {
        table,
        filters: [] as [string, unknown][],
        operation: 'select',
      }
      queries.push(query)
      let payload: Row | Row[] | undefined
      const result = () => {
        const matches = (rows[table] ?? []).filter((row) =>
          query.filters.every(([key, value]) => row[key] === value),
        )
        if (query.operation === 'update' && payload && !errors.has(table))
          matches.forEach((row) => Object.assign(row, payload))
        return {
          data: matches,
          count: matches.length,
          error: errors.has(table) ? { message: 'query failed' } : null,
        }
      }
      const chain = {
        select: () => chain,
        eq: (key: string, value: unknown) => {
          query.filters.push([key, value])
          return chain
        },
        is: (key: string, value: unknown) => {
          query.filters.push([key, value])
          return chain
        },
        in: () => chain,
        order: () => chain,
        limit: async () => result(),
        maybeSingle: async () => {
          const r = result()
          return { ...r, data: r.data[0] ?? null }
        },
        delete: () => {
          query.operation = 'delete'
          return chain
        },
        update: (value: Row) => {
          query.operation = 'update'
          payload = value
          return chain
        },
        insert: (value: Row | Row[]) => {
          query.operation = 'insert'
          payload = value
          return chain
        },
        then: (resolve: (value: ReturnType<typeof result>) => unknown) =>
          resolve(result()),
      }
      return chain
    },
    rpc: async () => ({ data: [], error: null }),
  }
  return { db: db as unknown as SupabaseClient, rows, queries, errors }
}
