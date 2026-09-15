import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import { MetaSendRejected, sendTextMessage, sendTemplateMessage, verifyUtilityTemplate } from '@/lib/whatsapp/meta-api'
import { prepareSendPlan } from './policy'

async function finish(db: SupabaseClient, id: string, token: string, outcome: string, providerId?: string) {
  const { error } = await db.rpc('finish_followup', { p_id: id, p_token: token, p_outcome: outcome, p_provider_id: providerId ?? null })
    .abortSignal(AbortSignal.timeout(5000))
  if (error) console.warn('[followup]', { id, event: 'result_persistence_failed' })
}

/** Exactly one network send attempt after durable authorization. No phone retries. */
export async function executeFollowup(db: SupabaseClient, id: string, token: string): Promise<void> {
  const started = performance.now()
  let sendAttempted = false
  let event = 'not_sent'
  try {
    const { data, error } = await db.rpc('prepare_followup', { p_id: id, p_token: token }).abortSignal(AbortSignal.timeout(5000))
    if (error) { event = 'preparation_database_error'; return }
    if (data?.status !== 'ready') {
      event = typeof data?.reason === 'string' && /^[a-z_]{1,60}$/.test(data.reason) ? data.reason : 'not_claimed'
      return
    }
    const plan = prepareSendPlan(data.payload)
    const accessToken = decrypt(data.access_token)
    if (plan.template) await verifyUtilityTemplate({ template: plan.template, accessToken, wabaId: data.payload.waba_id })
    const { data: authorization, error: authError } = await db.rpc('prepare_followup', {
      p_id: id, p_token: token, p_begin: true, p_snapshot: data.snapshot, p_body: plan.body,
    }).abortSignal(AbortSignal.timeout(5000))
    if (authError) { event = 'authorization_database_error'; return }
    if (authorization?.status !== 'authorized') {
      event = typeof authorization?.reason === 'string' && /^[a-z_]{1,60}$/.test(authorization.reason) ? authorization.reason : 'authorization_refused'
      return
    }
    // Cancellation/claim/quota/configuration were rechecked in this transaction.
    // Once sending begins an uncertain result must be reconciled, never retried.
    const finalToken = decrypt(authorization.access_token)
    const common = { phoneNumberId: plan.phoneNumberId, accessToken: finalToken, to: plan.to,
      followupCallback: id, signal: AbortSignal.timeout(15000) }
    sendAttempted = true
    const result = plan.category === 'service'
      ? await sendTextMessage({ ...common, text: plan.body })
      : await sendTemplateMessage({ ...common, templateName: plan.template!.name,
        language: plan.language, template: plan.template, params: plan.params })
    event = 'accepted'
    await finish(db, id, token, 'accepted', result.messageId)
  } catch (error) {
    event = !sendAttempted ? 'preparation_failed' : error instanceof MetaSendRejected ? 'rejected' : 'unknown'
    try { await finish(db, id, token, event) } catch { event = 'result_persistence_failed' }
  } finally {
    console.info('[followup]', { id, event, durationMs: Math.round(performance.now() - started) })
  }
}

export async function drainFollowups(db: SupabaseClient): Promise<number> {
  const { data, error } = await db.rpc('claim_due_followups', { p_limit: 10 }).abortSignal(AbortSignal.timeout(5000))
  if (error || !Array.isArray(data)) throw new Error('Follow-up claim failed')
  for (const row of data) await executeFollowup(db, row.id, row.claim_token)
  return data.length
}

export async function recordFollowupStatus(db: SupabaseClient, phoneNumberId: string, status: {
  id: string; status: string; biz_opaque_callback_data?: string
}): Promise<boolean> {
  const opaque = status.biz_opaque_callback_data
  const id = typeof opaque === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(opaque) ? opaque : null
  const { data, error } = await db.rpc('followup_delivery_status', {
    p_phone_number_id: phoneNumberId, p_provider_id: status.id, p_followup_id: id, p_status: status.status,
  }).abortSignal(AbortSignal.timeout(5000))
  if (error) throw new Error('Follow-up delivery update failed')
  return data === true
}
