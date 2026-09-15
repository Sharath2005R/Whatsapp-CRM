import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MessageTemplate } from '@/types'
import { MetaSendRejected, sendTextMessage, sendTemplateMessage, verifyUtilityTemplate } from './meta-api'

const fetchMock = vi.fn()
const args = { phoneNumberId: '123', accessToken: 'secret', to: '919876543210', followupCallback: 'job', signal: AbortSignal.timeout(1000) }
const template = { name: 'requested_reminder', meta_template_id: '456', language: 'en', body_text: 'Requested reminder' } as MessageTemplate
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock) })
afterEach(() => vi.unstubAllGlobals())
describe('existing sender follow-up options', () => {
  it.each(['text', 'template'])('passes correlation, no redirects and timeout for %s', async type => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: 'wamid.1' }] })))
    const result = type === 'text' ? await sendTextMessage({ ...args, text: 'Reminder' })
      : await sendTemplateMessage({ ...args, templateName: template.name, language: 'en', template })
    expect(result).toEqual({ messageId: 'wamid.1' })
    const options = fetchMock.mock.calls[0][1]
    expect(options).toMatchObject({ redirect: 'error', signal: args.signal })
    expect(JSON.parse(options.body).biz_opaque_callback_data).toBe('job')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it('preserves normal text sender request without follow-up fields', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: 'wamid.old' }] })))
    await sendTextMessage({ phoneNumberId: '123', accessToken: 'secret', to: '919876543210', text: 'Hello' })
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).not.toHaveProperty('biz_opaque_callback_data')
  })
  it.each([400, 401, 403, 429])('classifies definitive rejection %s', async status => {
    fetchMock.mockResolvedValue(new Response('{}', { status }))
    await expect(sendTextMessage({ ...args, text: 'Reminder' })).rejects.toBeInstanceOf(MetaSendRejected)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it.each([408, 500, 502, 503])('does not treat uncertain response %s as definitive rejection', async status => {
    fetchMock.mockResolvedValue(new Response('{}', { status }))
    try { await sendTextMessage({ ...args, text: 'Reminder' }); expect.fail('Must reject') }
    catch (error) { expect(error).not.toBeInstanceOf(MetaSendRejected) }
  })
  it.each(['{}', 'not json', '{"messages":[{"id":null}]}'])('rejects malformed acceptance %s without retry', async body => {
    fetchMock.mockResolvedValue(new Response(body))
    await expect(sendTextMessage({ ...args, text: 'Reminder' })).rejects.toThrow()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it('requires current approved Utility category in configured WABA', async () => {
    const remote = { id: '456', name: template.name, language: 'en', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'BODY', text: template.body_text }] }
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ data: [remote] })))
    await expect(verifyUtilityTemplate({ template, accessToken: 'secret', wabaId: '777' })).resolves.toBeUndefined()
    expect(String(fetchMock.mock.calls[0][0])).toContain('/777/message_templates')
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ ...remote, category: 'MARKETING' }] })))
    await expect(verifyUtilityTemplate({ template, accessToken: 'secret', wabaId: '777' })).rejects.toThrow()
  })
})
