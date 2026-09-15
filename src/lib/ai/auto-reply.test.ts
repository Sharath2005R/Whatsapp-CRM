import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AiConfig } from './types'

// Shared, hoisted mock state so the module mocks can close over it.
const h = vi.hoisted(() => ({
  loadAiConfig: vi.fn(),
  buildConversationContext: vi.fn(),
  retrieveKnowledge: vi.fn(),
  generateReply: vi.fn(),
  engineSendText: vi.fn(),
  state: {
    conv: null as Record<string, unknown> | null,
    autoResponders: [] as { id: string }[],
    claim: true as boolean,
    updatePayload: null as Record<string, unknown> | null,
    rpcCalls: [] as { name: string; args: unknown }[],
    filters: [] as [string, string, unknown][],
    contactOwned: true,
    handoffMember: true,
    automationError: false,
  },
}))

vi.mock('./config', () => ({ loadAiConfig: h.loadAiConfig }))
vi.mock('./context', () => ({ buildConversationContext: h.buildConversationContext }))
vi.mock('./knowledge', () => ({ retrieveKnowledge: h.retrieveKnowledge }))
vi.mock('./generate', () => ({ generateReply: h.generateReply }))
vi.mock('@/lib/flows/meta-send', () => ({ engineSendText: h.engineSendText }))
vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table === 'automations') {
        // .select().eq().eq().in().limit() → active auto-responders
        const chain = {
          select: () => chain,
          eq: (key: string, value: unknown) => { h.state.filters.push([table, key, value]); return chain },
          in: () => chain,
          limit: () =>
            Promise.resolve({ data: h.state.autoResponders, error: h.state.automationError ? {} : null }),
        }
        return chain
      }
      const filters: [string, unknown][] = []
      const chain = {
        select: () => chain,
        eq: (key: string, value: unknown) => {
          filters.push([key, value]); h.state.filters.push([table, key, value]); return chain
        },
        is: (key: string, value: unknown) => { h.state.filters.push([table, key, value]); return chain },
        maybeSingle: async () => {
          let row: Record<string, unknown> | null = null
          if (table === 'accounts') row = { id: 'acct-1', name: 'Local business' }
          if (table === 'whatsapp_config') row = { account_id: 'acct-1', user_id: 'user-1' }
          if (table === 'profiles') {
            const userId = filters.find(([key]) => key === 'user_id')?.[1]
            if (userId === 'user-1' || h.state.handoffMember) row = { account_id: 'acct-1', user_id: userId }
          }
          if (table === 'conversations' && h.state.conv) row = { id: 'conv-1', account_id: 'acct-1', contact_id: 'contact-1', ...h.state.conv }
          if (table === 'contacts' && h.state.contactOwned) row = { id: 'contact-1', account_id: 'acct-1' }
          return { data: row && filters.every(([key, value]) => row![key] === value) ? row : null, error: null }
        },
        update: (payload: Record<string, unknown>) => {
          h.state.updatePayload = payload
          return chain
        },
        then: (resolve: (value: unknown) => unknown) => resolve({ error: null }),
      }
      return chain
    },
    rpc: (name: string, args: unknown) => {
      h.state.rpcCalls.push({ name, args })
      return Promise.resolve({ data: h.state.claim, error: null })
    },
  }),
}))

import { dispatchInboundToAiReply } from './auto-reply'

const ARGS = {
  accountId: 'acct-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  configOwnerUserId: 'user-1',
}

function aiConfig(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'sk-test',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: true,
    autoReplyMaxPerConversation: 3,
    handoffAgentId: null,
    embeddingsApiKey: null,
    ...overrides,
  }
}

beforeEach(() => {
  vi.stubEnv('AI_BUSINESS_TOOLS_ENABLED', '0')
  h.state.conv = {
    assigned_agent_id: null,
    ai_autoreply_disabled: false,
    ai_reply_count: 0,
  }
  h.state.autoResponders = []
  h.state.claim = true
  h.state.updatePayload = null
  h.state.rpcCalls = []
  h.state.filters = []
  h.state.contactOwned = true
  h.state.handoffMember = true
  h.state.automationError = false
  h.loadAiConfig.mockResolvedValue(aiConfig())
  h.buildConversationContext.mockResolvedValue([{ role: 'user', content: 'hi' }])
  h.retrieveKnowledge.mockResolvedValue([])
  h.generateReply.mockResolvedValue({ text: 'Hello!', handoff: false })
  h.engineSendText.mockResolvedValue({ whatsapp_message_id: 'm1' })
})

afterEach(() => vi.unstubAllEnvs())

describe('business tool rollout', () => {
  it.each(['0', '1'])('only passes server conversation when enabled: %s', async enabled => {
    vi.stubEnv('AI_BUSINESS_TOOLS_ENABLED', enabled)
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply.mock.calls[0][0].toolConversationId).toBe(enabled === '1' ? ARGS.conversationId : undefined)
  })
})

describe('dispatchInboundToAiReply — eligibility gates', () => {
  it('claims a slot and sends on the happy path', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.rpcCalls).toEqual([
      {
        name: 'claim_ai_reply_slot_for_account',
        args: { p_account_id: 'acct-1', p_contact_id: 'contact-1', conversation_id: 'conv-1', max_replies: 3 },
      },
    ])
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', text: 'Hello!' }),
    )
  })

  it('grounds the reply in retrieved knowledge', async () => {
    h.retrieveKnowledge.mockResolvedValue(['Returns accepted within 30 days.'])
    await dispatchInboundToAiReply(ARGS)
    expect(h.retrieveKnowledge).toHaveBeenCalled()
    const systemPrompt = h.generateReply.mock.calls[0][0].systemPrompt as string
    expect(systemPrompt).not.toContain('Returns accepted within 30 days.')
    expect(h.generateReply.mock.calls[0][0].messages[0]).toMatchObject({
      role: 'user', content: expect.stringContaining('Returns accepted within 30 days.'),
    })
  })

  it('stands down when an active message-level automation exists', async () => {
    h.state.autoResponders = [{ id: 'auto-1' }]
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('does not send when the atomic slot claim loses the race', async () => {
    h.state.claim = false
    await dispatchInboundToAiReply(ARGS)
    // It still attempts the claim, but the send is skipped.
    expect(h.state.rpcCalls).toHaveLength(1)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when AI is off / not configured', async () => {
    h.loadAiConfig.mockResolvedValue(null)
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when auto-reply is disabled for the account', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ autoReplyEnabled: false }))
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when a human agent is assigned', async () => {
    h.state.conv = {
      assigned_agent_id: 'agent-9',
      ai_autoreply_disabled: false,
      ai_reply_count: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when auto-reply was disabled on this conversation', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: true,
      ai_reply_count: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when the per-conversation cap is reached', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 3,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when there is nothing to reply to', async () => {
    h.buildConversationContext.mockResolvedValue([])
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })
})

describe('dispatchInboundToAiReply — handoff', () => {
  it('leaves a stale or foreign handoff agent in the shared queue', async () => {
    h.state.handoffMember = false
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffAgentId: 'foreign-agent' }))
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload).toMatchObject({ ai_autoreply_disabled: true })
    expect(h.state.updatePayload).not.toHaveProperty('assigned_agent_id')
    expect(h.state.filters).toContainEqual(['profiles', 'account_id', 'acct-1'])
    expect(h.state.filters).toContainEqual(['conversations', 'account_id', 'acct-1'])
    expect(h.state.filters).toContainEqual(['conversations', 'assigned_agent_id', null])
  })
  it('disables auto-reply, writes a summary, and does not send on handoff', async () => {
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.rpcCalls).toHaveLength(0)
    expect(h.state.updatePayload).toMatchObject({ ai_autoreply_disabled: true })
    expect(h.state.updatePayload?.ai_handoff_summary).toContain(
      'AI agent handed off',
    )
    // No handoff target configured → conversation left unassigned.
    expect(h.state.updatePayload).not.toHaveProperty('assigned_agent_id')
  })

  it('routes to the configured handoff agent on handoff', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffAgentId: 'agent-7' }))
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload).toMatchObject({
      ai_autoreply_disabled: true,
      assigned_agent_id: 'agent-7',
    })
  })
})

describe('dispatchInboundToAiReply account boundary', () => {
  it.each([
    { accountId: 'foreign' }, { conversationId: 'foreign' }, { contactId: 'foreign' },
    { configOwnerUserId: 'foreign' },
  ])('rejects mismatched routing %j before business data or generation', async override => {
    await dispatchInboundToAiReply({ ...ARGS, ...override })
    expect(h.loadAiConfig).not.toHaveBeenCalled()
    expect(h.buildConversationContext).not.toHaveBeenCalled()
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.rpcCalls).toHaveLength(0)
  })

  it('rejects an owned conversation linked to a foreign contact', async () => {
    h.state.contactOwned = false
    await dispatchInboundToAiReply(ARGS)
    expect(h.loadAiConfig).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('fails closed when automation eligibility cannot be determined', async () => {
    h.state.automationError = true
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.state.filters).toContainEqual(['automations', 'account_id', 'acct-1'])
  })

  it('does not claim or send when the provider rejects reasoning output', async () => {
    h.generateReply.mockRejectedValueOnce(new Error('unsafe_response'))
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.rpcCalls).toHaveLength(0)
  })

  it('does not send if a human takes ownership while generation is running', async () => {
    h.generateReply.mockImplementationOnce(async () => {
      h.state.conv!.assigned_agent_id = 'agent-9'
      return { text: 'Hello!', handoff: false }
    })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })
})
