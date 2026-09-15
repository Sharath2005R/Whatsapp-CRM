import type { SupabaseClient } from '@supabase/supabase-js'
import type { AccountContext } from '@/lib/auth/account'
import { AiError } from './types'

export interface AiExecutionContext {
  readonly db: SupabaseClient
  readonly accountId: string
  readonly actorUserId: string
  readonly businessName: string
  readonly source: 'authenticated' | 'whatsapp'
}

// Contexts are issued inside the server, never reconstructed from request JSON.
const issued = new WeakSet<AiExecutionContext>()

function issue(context: AiExecutionContext): AiExecutionContext {
  Object.freeze(context)
  issued.add(context)
  return context
}

function denied(): never {
  throw new AiError('AI account context is not authorized.', {
    code: 'unauthorized_context',
    status: 403,
  })
}

/** Only pass the result of getCurrentAccount/requireRole, not request fields. */
export function authenticatedAiContext(
  account: AccountContext,
): AiExecutionContext {
  if (
    !account.userId ||
    !account.accountId ||
    account.account?.id !== account.accountId
  )
    denied()
  return issue({
    db: account.supabase,
    accountId: account.accountId,
    actorUserId: account.userId,
    businessName: account.account.name,
    source: 'authenticated',
  })
}

/** Called only after webhook signature verification and phone-number routing. */
export async function whatsappAiContext(
  db: SupabaseClient,
  accountId: string,
  configOwnerUserId: string,
): Promise<AiExecutionContext> {
  if (!accountId || !configOwnerUserId) denied()
  const { data: config, error: configError } = await db
    .from('whatsapp_config')
    .select('account_id')
    .eq('account_id', accountId)
    .eq('user_id', configOwnerUserId)
    .maybeSingle()
  if (configError || !config) denied()
  const { data: member, error: memberError } = await db
    .from('profiles')
    .select('user_id')
    .eq('account_id', accountId)
    .eq('user_id', configOwnerUserId)
    .maybeSingle()
  if (memberError || !member) denied()
  const { data: account, error: accountError } = await db
    .from('accounts')
    .select('id, name')
    .eq('id', accountId)
    .maybeSingle()
  if (accountError || !account || account.id !== accountId) denied()
  return issue({
    db,
    accountId,
    actorUserId: configOwnerUserId,
    businessName: account.name,
    source: 'whatsapp',
  })
}

export function assertAiContext(context: AiExecutionContext): void {
  if (!context || !issued.has(context)) denied()
}

export async function requireAiConversation(
  context: AiExecutionContext,
  conversationId: string,
  expectedContactId?: string,
) {
  assertAiContext(context)
  const { db, accountId } = context
  const { data: conversation, error } = await db
    .from('conversations')
    .select(
      'id, contact_id, assigned_agent_id, ai_autoreply_disabled, ai_reply_count',
    )
    .eq('account_id', accountId)
    .eq('id', conversationId)
    .maybeSingle()
  if (
    error ||
    !conversation ||
    !conversation.contact_id ||
    (expectedContactId !== undefined &&
      conversation.contact_id !== expectedContactId)
  ) {
    throw new AiError('Conversation not found.', {
      code: 'conversation_not_found',
      status: 404,
    })
  }
  const { data: contact, error: contactError } = await db
    .from('contacts')
    .select('id')
    .eq('account_id', accountId)
    .eq('id', conversation.contact_id)
    .maybeSingle()
  if (contactError || !contact) {
    throw new AiError('Conversation not found.', {
      code: 'conversation_not_found',
      status: 404,
    })
  }
  return conversation
}
