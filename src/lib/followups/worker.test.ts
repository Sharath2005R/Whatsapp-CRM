import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { MetaSendRejected } from '@/lib/whatsapp/meta-api'
import { drainFollowups, executeFollowup, recordFollowupStatus } from './worker'

const mocks = vi.hoisted(() => ({ text: vi.fn(), template: vi.fn(), verify: vi.fn(), decrypt: vi.fn() }))
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: mocks.decrypt }))
vi.mock('@/lib/whatsapp/meta-api', () => ({
  MetaSendRejected: class MetaSendRejected extends Error {},
  sendTextMessage: mocks.text, sendTemplateMessage: mocks.template, verifyUtilityTemplate: mocks.verify,
}))
const payload = { category: 'service', to: '+919876543210', phone_number_id: '123', language: 'en' }
function fixture() {
  const calls: { name: string; args: Record<string, unknown> }[] = []
  const replies: unknown[] = [
    { data: { status: 'ready', payload, snapshot: 'snapshot', access_token: 'cipher' } },
    { data: { status: 'authorized', access_token: 'cipher' } },
    { data: true },
  ]
  const rpc = vi.fn((name: string, args: Record<string, unknown>) => {
    calls.push({ name, args })
    return { abortSignal: vi.fn().mockResolvedValue(replies.shift()) }
  })
  return { db: { rpc } as unknown as SupabaseClient, calls, replies }
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.decrypt.mockReturnValue('private-token')
  mocks.text.mockResolvedValue({ messageId: 'wamid.1' })
  mocks.template.mockResolvedValue({ messageId: 'wamid.2' })
  mocks.verify.mockResolvedValue(undefined)
})
describe('durable follow-up worker', () => {
  it('authorizes before one send and records accepted, not delivered', async () => {
    const f = fixture()
    await executeFollowup(f.db, 'job', 'claim')
    expect(f.calls.map(c => c.name)).toEqual(['prepare_followup', 'prepare_followup', 'finish_followup'])
    expect(f.calls[1].args).toMatchObject({ p_begin: true, p_snapshot: 'snapshot' })
    expect(f.calls[2].args).toMatchObject({ p_outcome: 'accepted', p_provider_id: 'wamid.1' })
    expect(mocks.text).toHaveBeenCalledTimes(1)
    expect(mocks.text.mock.calls[0][0]).toMatchObject({ followupCallback: 'job', phoneNumberId: '123' })
  })
  it.each(['not_claimed', 'blocked', 'cancelled'])('does not send when %s', status => {
    const f = fixture()
    f.replies[0] = { data: { status } }
    return executeFollowup(f.db, 'job', 'claim').then(() => expect(mocks.text).not.toHaveBeenCalled())
  })
  it('does not send when cancellation wins final authorization', async () => {
    const f = fixture()
    f.replies[1] = { data: { status: 'not_claimed' } }
    await executeFollowup(f.db, 'job', 'claim')
    expect(mocks.text).not.toHaveBeenCalled()
  })
  it.each([new Error('timeout'), new Error('malformed response'), new Error('network')])('does not retry ambiguous provider result', async error => {
    const f = fixture()
    mocks.text.mockRejectedValue(error)
    await executeFollowup(f.db, 'job', 'claim')
    expect(mocks.text).toHaveBeenCalledTimes(1)
    expect(f.calls[2].args.p_outcome).toBe('unknown')
  })
  it('records definitive rejection without fake acceptance', async () => {
    const f = fixture()
    mocks.text.mockRejectedValue(new MetaSendRejected())
    await executeFollowup(f.db, 'job', 'claim')
    expect(f.calls[2].args).toMatchObject({ p_outcome: 'rejected', p_provider_id: null })
  })
  it('fresh template verification must succeed before authorization or send', async () => {
    const f = fixture()
    f.replies[0] = { data: { status: 'ready', access_token: 'cipher', payload: {
      ...payload, category: 'utility', waba_id: '777', variables: [],
      template: { name: 'reminder', meta_template_id: '456', category: 'Utility', status: 'APPROVED', language: 'en', body_text: 'Requested reminder' },
    } } }
    mocks.verify.mockRejectedValue(new Error('approval changed'))
    await executeFollowup(f.db, 'job', 'claim')
    expect(mocks.template).not.toHaveBeenCalled()
    expect(f.calls[1]).toMatchObject({ name: 'finish_followup', args: { p_outcome: 'preparation_failed' } })
  })
  it('does not resend when final persistence fails', async () => {
    const f = fixture()
    f.replies[2] = { error: { message: 'db unavailable' } }
    await executeFollowup(f.db, 'job', 'claim')
    expect(mocks.text).toHaveBeenCalledTimes(1)
  })
  it('fails closed on scheduler database failure', async () => {
    const f = fixture()
    f.replies[0] = { error: {} }
    await expect(drainFollowups(f.db)).rejects.toThrow()
    expect(mocks.text).not.toHaveBeenCalled()
  })
  it('binds webhook reconciliation to sender and validates opaque UUID', async () => {
    const f = fixture()
    f.replies[0] = { data: true }
    expect(await recordFollowupStatus(f.db, '123', { id: 'wamid.1', status: 'delivered', biz_opaque_callback_data: 'SQL' })).toBe(true)
    expect(f.calls[0].args).toMatchObject({ p_phone_number_id: '123', p_followup_id: null, p_status: 'delivered' })
  })
})
