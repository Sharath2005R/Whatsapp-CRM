import { retrieveKnowledge, type KnowledgeSource } from '../knowledge'
import type { AiConfig } from '../types'
import { assertToolContext, toolContext, type ToolContext } from './context'
import { validateToolCall, TOOL_SCHEMAS, type ToolName } from './schema'

export interface ToolResult {
  success: boolean
  data?: Record<string, unknown>
  error?: 'invalid_tool_call' | 'unavailable' | 'operation_failed'
  retryable?: boolean
  /** Server-rendered operational response; model prose can never override it. */
  customerText?: string
  handoff?: boolean
  sources?: KnowledgeSource[]
}

const confirmations: Record<string, string> = {
  created: 'Your enquiry has been saved in our CRM.',
  updated: 'The notes on your enquiry have been updated.',
  already_exists: 'You already have an open enquiry. No duplicate was created.',
  followup_cancelled: 'Your follow-up has been cancelled.',
  followup_already_sent: 'That follow-up has already been sent.',
  followup_in_progress: 'That follow-up has already started sending. Cancellation cannot be confirmed.',
  followup_not_found: 'There is no matching follow-up to cancel.',
  followup_not_pending: 'That follow-up is no longer pending.',
  followup_already_pending: 'You already have a pending follow-up. No duplicate was scheduled.',
}

/** Decode a narrow DB contract, not arbitrary JSON returned to the customer/model. */
export function businessResult(value: unknown): ToolResult {
  if (!value || typeof value !== 'object') return { success: false, error: 'operation_failed' }
  const r = value as Record<string, unknown>
  if (r.status === 'followup_scheduled' && typeof r.run_at === 'string' && Number.isFinite(Date.parse(r.run_at)))
    return { success: true, data: { status: r.status, run_at: r.run_at },
      customerText: `Your reminder is scheduled for ${new Date(r.run_at).toISOString()} (UTC). Sending remains subject to messaging eligibility.` }
  if (r.status === 'followup_confirmation_required' && typeof r.code === 'string' && /^[a-f0-9]{12}$/.test(r.code) &&
      typeof r.delay_minutes === 'number' && Number.isInteger(r.delay_minutes) && r.delay_minutes >= 5 && r.delay_minutes <= 43200 &&
      ['requested_reminder', 'no_reply'].includes(String(r.reason)))
    return { success: true, data: { status: r.status },
      customerText: `Schedule a reminder ${r.delay_minutes} minutes after confirmation${r.reason === 'no_reply' ? ', only if you have not replied again' : ''}? Reply CONFIRM ${r.code} within 15 minutes. Nothing has been scheduled yet.` }
  if (typeof r.status === 'string' && Object.hasOwn(confirmations, r.status))
    return { success: true, data: { status: r.status }, customerText: confirmations[r.status] }
  if (r.status === 'confirmation_required' && typeof r.code === 'string' && /^[a-f0-9]{12}$/.test(r.code)) {
    const parsed = validateToolCall({ tool: r.tool, arguments: r.arguments })
    if (!parsed || !['create_lead', 'update_lead'].includes(parsed.tool)) return { success: false, error: 'operation_failed' }
    const preview = parsed.tool === 'create_lead'
      ? `Create an enquiry titled ${JSON.stringify(parsed.arguments.title)}${parsed.arguments.notes ? ` with notes ${JSON.stringify(parsed.arguments.notes)}` : ''}`
      : `Replace your enquiry notes with ${JSON.stringify(parsed.arguments.notes)}`
    return { success: true, data: { status: 'confirmation_required' },
      customerText: `${preview}? Reply CONFIRM ${r.code} within 15 minutes to approve. Nothing has been changed yet.` }
  }
  if (r.status === 'handed_off' && ['assigned', 'shared_queue'].includes(String(r.assignment)) &&
    ['recorded', 'unconfirmed'].includes(String(r.notification)) && r.delivery === 'unconfirmed')
    return { success: true, handoff: true, data: { status: r.status, assignment: r.assignment,
      notification: r.notification, delivery: 'unconfirmed' },
      customerText: r.assignment === 'assigned'
        ? 'Your conversation has been assigned to human support. Notification delivery could not be confirmed.'
        : 'Your conversation is in the human support queue.' }
  return { success: false, error: 'operation_failed', retryable: false }
}

async function businessOperation(context: ToolContext, tool: string, args: Record<string, string | number>, followup = false): Promise<ToolResult> {
  const { ai } = context
  const { data, error } = await ai.db.rpc(followup ? 'ai_followup_tool' : 'ai_business_tool', {
    p_account_id: ai.accountId, p_actor_user_id: ai.actorUserId,
    p_conversation_id: context.conversationId, p_message_id: context.messageId,
    p_tool: tool, p_arguments: args,
  }).abortSignal(AbortSignal.timeout(5000))
  if (followup && tool === 'confirm' && !error && data?.status === 'followup_not_found')
    return businessOperation(context, tool, args)
  return error ? { success: false, error: 'operation_failed' as const } : businessResult(data)
}

type Handler = (context: ToolContext, config: AiConfig, args: Record<string, string | number>) => Promise<ToolResult>
const handlers: Record<ToolName, Handler> = {
  async search_knowledge(context, config, args) {
    const sources = await retrieveKnowledge(context.ai, config, String(args.query))
    return { success: true, sources, data: { sources: sources.map((s, i) => ({ ref: i + 1, title: s.title, content: s.content })) } }
  },
  async get_customer(context) {
    const { data, error } = await context.ai.db.from('contacts').select('name, company')
      .eq('account_id', context.ai.accountId).eq('id', context.contactId).maybeSingle()
    return error || !data ? { success: false, error: 'unavailable' }
      : { success: true, data: { name: typeof data.name === 'string' ? data.name.slice(0, 200) : null,
        company: typeof data.company === 'string' ? data.company.slice(0, 200) : null } }
  },
  create_lead: (context, _config, args) => businessOperation(context, 'create_lead', args),
  update_lead: (context, _config, args) => businessOperation(context, 'update_lead', args),
  notify_human: (context, _config, args) => businessOperation(context, 'notify_human', args),
  schedule_followup: (context, _config, args) => businessOperation(context, 'schedule_followup', args, true),
  cancel_followup: (context, _config, args) => businessOperation(context, 'cancel_followup', args, true),
}

// Executable functions never enter the model prompt. Only TOOL_SCHEMAS do.
const registry = new Map((Object.keys(TOOL_SCHEMAS) as ToolName[]).map(name =>
  [name, { name, ...TOOL_SCHEMAS[name], execute: handlers[name] }] as const))

export async function confirmCustomerAction(context: ToolContext): Promise<ToolResult | null> {
  assertToolContext(context)
  if (!/^CONFIRM [a-f0-9]{12}$/i.test(context.customerText.trim())) return null
  const start = performance.now()
  let result: ToolResult
  try { result = await businessOperation(context, 'confirm', {}, process.env.AI_FOLLOWUPS_ENABLED === '1') }
  catch { result = { success: false, error: 'operation_failed' } }
  console.info('[ai tool]', { tool: 'customer_confirmation', success: result.success,
    durationMs: Math.round(performance.now() - start), correlation: context.correlation, error: result.error })
  return result
}

export async function executeTool(context: ToolContext, config: AiConfig, input: unknown): Promise<ToolResult> {
  const start = performance.now()
  const call = validateToolCall(input)
  let result: ToolResult = { success: false, error: 'invalid_tool_call' }
  let correlation = 'invalid-context'
  try {
    assertToolContext(context)
    correlation = context.correlation
    if (!call) return result
    const { ai } = context
    const current = await toolContext(ai, context.conversationId, context.customerText)
    if (current.contactId !== context.contactId || current.messageId !== context.messageId)
      return result = { success: false, error: 'unavailable' }
    result = await registry.get(call.tool)!.execute(context, config, call.arguments)
    return result
  } catch { return result = { success: false, error: 'operation_failed' } }
  finally {
    console.info('[ai tool]', { tool: call?.tool ?? 'rejected', success: result.success,
      durationMs: Math.round(performance.now() - start), correlation, error: result.error })
  }
}

export function modelToolResult(result: ToolResult): Record<string, unknown> {
  return { success: result.success, data: result.data, error: result.error, retryable: result.retryable }
}
