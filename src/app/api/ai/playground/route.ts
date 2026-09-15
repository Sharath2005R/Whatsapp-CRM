import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'
import { loadAiConfig } from '@/lib/ai/config'
import { retrieveKnowledge } from '@/lib/ai/knowledge'
import { generateReply } from '@/lib/ai/generate'
import { buildSystemPrompt, withKnowledgeReferences } from '@/lib/ai/defaults'
import { authenticatedAiContext } from '@/lib/ai/execution-context'
import { knowledgeQuery } from '@/lib/ai/query'
import { AiError, type ChatMessage } from '@/lib/ai/types'

// Keep the tested transcript bounded, mirroring the live context window.
const MAX_TURNS = 20

/**
 * POST /api/ai/playground  (agent+)
 *
 * Test-chat with the account's agent WITHOUT touching WhatsApp. Runs the
 * exact same path the auto-reply bot uses — knowledge-base retrieval +
 * `auto_reply` system prompt + the configured provider — so what you see
 * here is what a real customer would get. Reads the config even when the
 * master switch is off (requireActive:false) so you can try it before
 * going live. Stateless: the client sends the running transcript each turn.
 */
export async function POST(request: Request) {
  try {
    const account = await requireRole('agent')
    const { userId } = account
    const context = authenticatedAiContext(account)

    const limit = checkRateLimit(`ai-playground:${userId}`, RATE_LIMITS.aiDraft)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    const rawMessages = Array.isArray(body?.messages) ? body.messages : null
    if (!rawMessages) {
      return NextResponse.json(
        { error: 'messages is required' },
        { status: 400 },
      )
    }

    const messages: ChatMessage[] = rawMessages
      .filter(
        (m: unknown): m is ChatMessage =>
          !!m &&
          typeof m === 'object' &&
          ((m as ChatMessage).role === 'user' ||
            (m as ChatMessage).role === 'assistant') &&
          typeof (m as ChatMessage).content === 'string' &&
          (m as ChatMessage).content.trim().length > 0,
      )
      .slice(-MAX_TURNS)
      .map(({ role, content }: ChatMessage) => ({ role, content }))

    if (messages.length === 0) {
      return NextResponse.json(
        { error: 'Send a message to test the agent.' },
        { status: 400 },
      )
    }

    const config = await loadAiConfig(context, {
      requireActive: false,
    }).catch((err) => {
      console.error('[ai/playground] loadAiConfig error:', err)
      throw new AiError('Stored API key could not be decrypted.', {
        code: 'key_decrypt_failed',
        status: 400,
      })
    })
    if (!config) {
      return NextResponse.json(
        {
          error:
            'No agent configured yet. Choose a provider and model in Setup.',
          code: 'ai_not_configured',
        },
        { status: 400 },
      )
    }

    const knowledge = await retrieveKnowledge(
      context,
      config,
      knowledgeQuery(messages),
    )
    const systemPrompt = buildSystemPrompt({
      userPrompt: config.systemPrompt,
      mode: 'auto_reply',
      businessName: context.businessName,
      hasKnowledge: knowledge.length > 0,
    })

    const { text, handoff } = await generateReply({
      knowledge,
      context,
      config,
      systemPrompt,
      messages: withKnowledgeReferences(messages, knowledge),
    })
    return NextResponse.json({ reply: text, handoff })
  } catch (err) {
    if (err instanceof AiError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status },
      )
    }
    return toErrorResponse(err)
  }
}
