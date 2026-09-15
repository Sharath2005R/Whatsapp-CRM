import { randomUUID } from 'node:crypto'
import { assertAiContext, requireAiConversation, type AiExecutionContext } from '../execution-context'
import { AiError } from '../types'

export interface ToolContext {
  readonly ai: AiExecutionContext
  readonly conversationId: string
  readonly contactId: string
  readonly messageId: string
  readonly customerText: string
  readonly correlation: string
}
const issued = new WeakSet<ToolContext>()

export async function toolContext(ai: AiExecutionContext, conversationId: string, latestCustomerText: string): Promise<ToolContext> {
  assertAiContext(ai)
  if (ai.source !== 'whatsapp') throw new AiError('Business actions are unavailable here.', { code: 'tool_unauthorized' })
  const conv = await requireAiConversation(ai, conversationId)
  if (conv.assigned_agent_id || conv.ai_autoreply_disabled) throw new AiError('Conversation is human-owned.', { code: 'tool_unauthorized' })
  const { data: member, error: roleError } = await ai.db.from('profiles').select('account_role')
    .eq('account_id', ai.accountId).eq('user_id', ai.actorUserId).maybeSingle()
  if (roleError || !['owner', 'admin', 'agent'].includes(member?.account_role))
    throw new AiError('Business actions are not authorized.', { code: 'tool_unauthorized' })
  const { data: rows, error } = await ai.db.from('messages').select('id, content_text, content_type')
    .eq('conversation_id', conversationId).eq('sender_type', 'customer')
    .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(1)
  const m = rows?.[0]
  if (error || !m?.id || m.content_type !== 'text' || m.content_text?.trim() !== latestCustomerText.trim())
    throw new AiError('Customer context changed.', { code: 'tool_stale_context' })
  const result = Object.freeze({ ai, conversationId, contactId: conv.contact_id as string,
    messageId: m.id as string, customerText: m.content_text as string, correlation: randomUUID() })
  issued.add(result)
  return result
}

export function assertToolContext(context: ToolContext): void {
  if (!context || !issued.has(context)) throw new AiError('Invalid tool context.', { code: 'tool_unauthorized' })
  assertAiContext(context.ai)
}
