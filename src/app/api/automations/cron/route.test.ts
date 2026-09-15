import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const h = vi.hoisted(() => ({ drain: vi.fn(), resume: vi.fn(), admin: vi.fn() }))
vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: h.admin }))
vi.mock('@/lib/automations/engine', () => ({ resumePendingExecution: h.resume }))
vi.mock('@/lib/followups/worker', () => ({ drainFollowups: h.drain }))
import { GET } from './route'
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('AUTOMATION_CRON_SECRET','private-cron')
  vi.stubEnv('AI_FOLLOWUPS_ENABLED','1')
  h.drain.mockResolvedValue(1)
})
afterEach(() => vi.unstubAllEnvs())
const request = (secret='private-cron') => new Request('http://localhost/api/automations/cron', { headers:{'x-cron-secret':secret} })
describe('shared scheduler follow-up integration', () => {
  it('requires cron authorization before creating a client or claiming jobs', async () => {
    expect((await GET(request('wrong'))).status).toBe(401)
    expect(h.admin).not.toHaveBeenCalled()
    expect(h.drain).not.toHaveBeenCalled()
  })
  it('isolates legacy pending rows from follow-up jobs', async () => {
    const b = { select:vi.fn(),eq:vi.fn(),not:vi.fn(),lte:vi.fn(),order:vi.fn(),limit:vi.fn() }
    for (const key of ['select','eq','not','lte','order'] as const) b[key].mockReturnValue(b)
    b.limit.mockResolvedValue({data:[]})
    const db = {from:vi.fn().mockReturnValue(b)}
    h.admin.mockReturnValue(db)
    expect(await (await GET(request())).json()).toEqual({processed:0,followups:1})
    expect(h.drain).toHaveBeenCalledWith(db)
    expect(b.not).toHaveBeenCalledWith('automation_id','is',null)
    expect(h.resume).not.toHaveBeenCalled()
  })
  it('does not expose internal errors or report success after failed claim', async () => {
    h.drain.mockRejectedValue(new Error('secret credential'))
    const response = await GET(request())
    expect(response.status).toBe(503)
    expect(JSON.stringify(await response.json())).not.toContain('secret')
  })
})
