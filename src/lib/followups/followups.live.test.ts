import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

// Explicit disposable-container opt-in. Never connects to Supabase or Meta.
const container = process.env.FOLLOWUP_TEST_CONTAINER
const docker = process.env.DOCKER_TEST_EXECUTABLE || 'C:/Program Files/Docker/Docker/resources/bin/docker.exe'
const account = '00000000-0000-0000-0000-000000000001'
const actor = '10000000-0000-0000-0000-000000000001'
const conversation = '30000000-0000-0000-0000-000000000001'
const customer = '20000000-0000-0000-0000-000000000001'
const inbound = '40000000-0000-0000-0000-000000000001'
const timings: Record<string, number[]> = {}
async function timed<T>(name: string, operation: () => Promise<T>): Promise<T> {
  const start = performance.now()
  try { return await operation() }
  finally { (timings[name] ??= []).push(performance.now()-start) }
}
function command(args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(docker, args, { windowsHide: true, timeout: 30000 })
    let out = ''; let err = ''
    p.stdout.on('data', x => { out += x })
    p.stderr.on('data', x => { err += x })
    p.on('error', reject)
    p.on('close', code => code === 0 ? resolve(out.trim()) : reject(new Error(err)))
    p.stdin.end(input)
  })
}
const sql = (statement: string) => command(['exec', '-i', container!, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], statement)
const rpc = async (expression: string) => JSON.parse(await sql('SET ROLE service_role; SELECT to_jsonb(' + expression + ');'))
const tool = (name: string, args = '{}', conv = conversation, acct = account) =>
  timed(name, () => rpc(`ai_followup_tool('${acct}','${actor}','${conv}','${inbound}','${name}','${args}'::jsonb)`))
async function scheduled(reason = 'requested_reminder') {
  const proposal = await tool('schedule_followup', JSON.stringify({ delay_minutes: 5, reason }))
  expect(proposal.status).toBe('followup_confirmation_required')
  await sql(`UPDATE messages SET content_text='CONFIRM ${proposal.code}' WHERE id='${inbound}';`)
  expect((await tool('confirm')).status).toBe('followup_scheduled')
  await sql("UPDATE automation_pending_executions SET run_at=now()-interval '1 minute';")
  return await sql("SELECT id FROM automation_pending_executions WHERE execution_kind='followup' ORDER BY created_at DESC LIMIT 1;")
}
const claims = () => timed('scheduler_claim', () => rpc("coalesce((SELECT jsonb_agg(x) FROM claim_due_followups(10) x),'[]'::jsonb)"))
const prepare = (id: string, token: string) => timed('send_preparation', () => rpc(`prepare_followup('${id}','${token}')`))
const begin = (id: string, token: string, snapshot: string) => timed('quota_authorization', () => rpc(`prepare_followup('${id}','${token}',true,'${snapshot}','Requested reminder')`))
const finish = (id: string, token: string, outcome: string, provider = 'wamid.test') =>
  rpc(`finish_followup('${id}','${token}','${outcome}','${provider}')`)
const state = (id: string) => rpc(`(SELECT jsonb_build_object('status',status,'reason',failure_reason,'usage',usage_state) FROM automation_pending_executions WHERE id='${id}')`)

describe.skipIf(!container)('disposable PostgreSQL follow-up transactions', () => {
  afterAll(() => {
    const report = Object.fromEntries(Object.entries(timings).map(([name,values]) => {
      const sorted = [...values].sort((a,b) => a-b)
      return [name,{calls:values.length,medianMs:sorted[Math.floor(sorted.length/2)],maxMs:sorted.at(-1)}]
    }))
    process.stdout.write('FOLLOWUP_DATABASE_TIMINGS_WITH_DOCKER_OVERHEAD '+JSON.stringify(report)+'\n')
  })
  beforeAll(async () => {
    if (!/^[a-f0-9]{64}$/.test(container!)) throw new Error('Full disposable container ID required')
    const info = JSON.parse(await command(['inspect', container!]))[0]
    if (info.Config.Labels?.['codex.item4a'] !== 'disposable' || info.HostConfig.NetworkMode !== 'none' ||
        !info.HostConfig.AutoRemove || Object.keys(info.HostConfig.PortBindings || {}).length)
      throw new Error('Refusing non-isolated container')
    const existing = await sql("SELECT to_regclass('public.accounts') IS NOT NULL;")
    if (existing !== 'f') throw new Error('Fixture requires an empty disposable database')
    for (const path of ['supabase/tests/rag-bootstrap.sql', 'supabase/tests/tools-bootstrap.sql',
      'supabase/tests/followups-bootstrap.sql', 'supabase/migrations/044_safe_followups.sql'])
      await sql(await readFile(path, 'utf8'))
  }, 60000)
  beforeEach(async () => {
    await sql(`
      TRUNCATE messages,automation_pending_executions,followup_usage CASCADE;
      DELETE FROM followup_settings;
      UPDATE contacts SET phone='919876543210',followup_opted_out=false;
      UPDATE conversations SET assigned_agent_id=NULL,ai_autoreply_disabled=false;
      UPDATE conversations SET contact_id='${customer}' WHERE id='${conversation}';
      UPDATE whatsapp_config SET access_token='fixture-cipher',status='connected';
      INSERT INTO followup_settings(account_id,enabled,reviewed_customer_reminder,service_monthly_limit,utility_monthly_limit)
        VALUES('${account}',true,true,500,500);
      INSERT INTO messages(id,conversation_id,sender_type,content_text) VALUES('${inbound}','${conversation}','customer','Remind me');
    `)
  })
  it('schedules, confirms idempotently, cancels and refuses cancelled execution', async () => {
    const id = await scheduled()
    expect((await tool('confirm')).status).toBe('followup_scheduled')
    expect((await tool('cancel_followup')).status).toBe('followup_cancelled')
    expect(await claims()).toEqual([])
    expect((await state(id)).status).toBe('cancelled')
    expect((await tool('cancel_followup')).status).toBe('followup_cancelled')
  })
  it.each(['schedule_followup', 'cancel_followup'])('denies cross-tenant %s and foreign customer', async name => {
    await expect(tool(name, '{}', '30000000-0000-0000-0000-000000000002')).rejects.toThrow()
    await expect(tool(name, '{}', conversation, '00000000-0000-0000-0000-000000000002')).rejects.toThrow()
    await sql(`UPDATE conversations SET contact_id='20000000-0000-0000-0000-000000000002' WHERE id='${conversation}';`)
    await expect(tool(name)).rejects.toThrow()
  })
  it('denies client RPC access and allowance changes', async () => {
    await expect(sql(`SET ROLE authenticated; SELECT ai_followup_tool('${account}','${actor}','${conversation}','${inbound}','cancel_followup','{}');`)).rejects.toThrow()
    await expect(sql("SET ROLE authenticated; UPDATE followup_settings SET utility_monthly_limit=1000000;")).rejects.toThrow()
    expect(await sql("SET ROLE authenticated; SELECT count(*) FROM followup_settings;")).toBe('0')
  })
  it('has one winner for two concurrent workers and never reclaims an authorized send', async () => {
    const id = await scheduled()
    const lists = await Promise.all([claims(), claims()])
    const winners = lists.flat()
    expect(winners).toHaveLength(1)
    const token = winners[0].claim_token
    const p = await prepare(id, token)
    expect((await begin(id, token, p.snapshot)).status).toBe('authorized')
    expect((await begin(id, token, p.snapshot)).status).toBe('not_claimed')
    await sql("UPDATE automation_pending_executions SET send_started_at=now()-interval '10 minutes';")
    expect(await claims()).toEqual([])
    expect((await state(id)).status).toBe('unknown')
  })
  it('serializes cancellation against send authorization', async () => {
    const id = await scheduled()
    const [{ claim_token: token }] = await claims()
    const p = await prepare(id, token)
    const [cancelled, authorized] = await Promise.all([tool('cancel_followup'), begin(id, token, p.snapshot)])
    if (cancelled.status === 'followup_cancelled') expect(authorized.status).toBe('not_claimed')
    else {
      expect(cancelled.status).toBe('followup_in_progress')
      expect(authorized.status).toBe('authorized')
    }
  })
  it.each(['service','utility'])('reserves the last %s allowance atomically across two conversations', async category => {
    const first = await scheduled()
    // A second independently bound customer conversation in the same account.
    const second = await sql(`
      INSERT INTO conversations(id,account_id,contact_id) VALUES('30000000-0000-0000-0000-000000000003','${account}','${customer}') ON CONFLICT DO NOTHING;
      INSERT INTO messages(conversation_id,sender_type,content_text) VALUES('30000000-0000-0000-0000-000000000003','customer','Remind me');
      INSERT INTO automation_pending_executions(execution_kind,account_id,user_id,contact_id,conversation_id,next_step_position,status,run_at,
        followup_config_id,followup_config_fingerprint,followup_phone,followup_phone_number_id,followup_reason,context)
      SELECT 'followup',account_id,user_id,contact_id,'30000000-0000-0000-0000-000000000003',0,'scheduled',run_at,
        followup_config_id,followup_config_fingerprint,followup_phone,followup_phone_number_id,followup_reason,context
        FROM automation_pending_executions WHERE id='${first}' RETURNING id;
      UPDATE followup_settings SET service_monthly_limit=1,utility_monthly_limit=1;
    `)
    if (category==='utility') await sql(`
      INSERT INTO message_templates(id,account_id,name,category,status,meta_template_id,language,body_text)
        VALUES('90000000-0000-0000-0000-000000000001','${account}','reminder','Utility','APPROVED','456','en','Requested reminder')
        ON CONFLICT(id) DO UPDATE SET category='Utility';
      UPDATE followup_settings SET utility_template_id='90000000-0000-0000-0000-000000000001';
      UPDATE messages SET created_at=now()-interval '25 hours';
    `)
    const jobs = await claims()
    expect(jobs).toHaveLength(2)
    const plans = await Promise.all(jobs.map((j: {id: string;claim_token: string}) => prepare(j.id,j.claim_token)))
    const results = await Promise.all(jobs.map((j: {id: string;claim_token: string},i: number) => begin(j.id,j.claim_token,plans[i].snapshot)))
    expect(results.filter(x => x.status==='authorized')).toHaveLength(1)
    expect(results.filter(x => x.reason==='blocked_quota_exceeded')).toHaveLength(1)
    expect(second).toMatch(/^[a-f0-9-]+$/)
  })
  it('detects a changed preparation snapshot', async () => {
    const id = await scheduled()
    const [{ claim_token: token }] = await claims()
    const p = await prepare(id,token)
    await sql("UPDATE accounts SET name='Changed business' WHERE id='"+account+"';")
    expect((await begin(id,token,p.snapshot)).status).toBe('blocked')
    expect((await state(id)).reason).toBe('failed_preparation_changed')
  })
  it('refuses a locally misclassified template outside the service window', async () => {
    const id = await scheduled()
    const [{ claim_token: token }] = await claims()
    await sql(`
      INSERT INTO message_templates(id,account_id,name,category,status,meta_template_id,language,body_text)
        VALUES('90000000-0000-0000-0000-000000000001','${account}','reminder','Marketing','APPROVED','456','en','Sale offer')
        ON CONFLICT(id) DO UPDATE SET category='Marketing';
      UPDATE followup_settings SET utility_template_id='90000000-0000-0000-0000-000000000001';
      UPDATE messages SET created_at=now()-interval '25 hours';
    `)
    await prepare(id,token)
    expect((await state(id)).reason).toBe('blocked_template_invalid')
  })
  it('preserves legacy CRM confirmation lookup when follow-up configuration is absent', async () => {
    await sql("DELETE FROM followup_settings; UPDATE messages SET content_text='CONFIRM abcdef123456';")
    expect((await tool('confirm')).status).toBe('followup_not_found')
  })
  it.each([
    ["UPDATE followup_settings SET service_monthly_limit=0", 'blocked_quota_exceeded'],
    ["UPDATE messages SET created_at=now()-interval '25 hours'", 'blocked_template_missing'],
    ["UPDATE conversations SET assigned_agent_id='10000000-0000-0000-0000-000000000001'", 'skipped_human_handoff'],
    ["UPDATE contacts SET followup_opted_out=true", 'skipped_opted_out'],
    ["UPDATE whatsapp_config SET access_token='changed'", 'failed_configuration'],
    ["UPDATE contacts SET phone='919999999999'", 'failed_configuration'],
    ["UPDATE automation_pending_executions SET contact_id=NULL", 'failed_ownership'],
    ["UPDATE automation_pending_executions SET conversation_id=NULL", 'failed_ownership'],
  ])('revalidates send-time state: %s', async (mutation, reason) => {
    const id = await scheduled()
    const [{ claim_token: token }] = await claims()
    await sql(mutation)
    const p = await prepare(id,token)
    if (p.status==='ready') await begin(id,token,p.snapshot)
    expect((await state(id)).reason).toBe(reason)
    expect(await sql("SELECT count(*) FROM messages WHERE sender_type='bot';")).toBe('0')
  })
  it('skips a no-reply reminder after a new inbound message', async () => {
    const id = await scheduled('no_reply')
    await sql(`INSERT INTO messages(conversation_id,sender_type,content_text) VALUES('${conversation}','customer','I am back');`)
    const [{ claim_token: token }] = await claims()
    await prepare(id,token)
    expect((await state(id)).reason).toBe('skipped_customer_replied')
  })
  it('records accepted once, distinguishes delivery and rejects foreign sender callbacks', async () => {
    const id = await scheduled()
    const [{ claim_token: token }] = await claims()
    const p = await prepare(id,token)
    await begin(id,token,p.snapshot)
    await finish(id,token,'accepted')
    await finish(id,token,'accepted')
    expect(await state(id)).toMatchObject({ status:'sent',usage:'accepted' })
    expect(await rpc(`followup_delivery_status('999','wamid.test','${id}','delivered')`)).toBe(false)
    expect(await rpc(`followup_delivery_status('123','wamid.test','${id}','delivered')`)).toBe(true)
    await rpc(`followup_delivery_status('123','wamid.test','${id}','sent')`)
    expect((await state(id)).status).toBe('delivered')
    expect(await sql("SELECT count(*) FROM messages WHERE sender_type='bot';")).toBe('1')
  })
  it('releases definitive rejection but holds unknown acceptance without retry', async () => {
    const id = await scheduled()
    const [{ claim_token: token }] = await claims()
    const p = await prepare(id,token)
    await begin(id,token,p.snapshot)
    await finish(id,token,'rejected')
    expect(await state(id)).toMatchObject({ status:'failed',usage:'released',reason:'failed_provider' })
    expect(await claims()).toEqual([])
  })
  it('retains accepted usage after execution and message deletion', async () => {
    const id = await scheduled()
    const [{ claim_token: token }] = await claims()
    const p = await prepare(id,token)
    await begin(id,token,p.snapshot)
    await finish(id,token,'accepted')
    await sql("DELETE FROM messages; DELETE FROM automation_pending_executions;")
    expect(await sql("SELECT count(*) FROM followup_usage WHERE state='accepted';")).toBe('1')
    expect(await rpc(`followup_delivery_status('123','wamid.test','${id}','delivered')`)).toBe(true)
  })
  it('STOP cancels pending reminder without involving the model', async () => {
    const id = await scheduled()
    await sql(`INSERT INTO messages(conversation_id,sender_type,content_text) VALUES('${conversation}','customer','STOP');`)
    expect(await state(id)).toMatchObject({ status:'cancelled',reason:'skipped_opted_out' })
  })
}, 30000)
