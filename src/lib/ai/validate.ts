import { generateReply } from './generate'
import type { AiConfig } from './types'
import type { AiExecutionContext } from './execution-context'

/**
 * Cheap liveness + auth check: one tiny generation against the
 * configured provider/model with the caller's key. Throws `AiError`
 * (invalid_key / rate_limited / network / timeout) on failure, resolves
 * on success. Used by the settings "Test key" button and before
 * persisting a config — the same "verify before save" discipline the
 * WhatsApp config uses with Meta.
 */
export async function validateAiCredentials(context: AiExecutionContext, config: AiConfig): Promise<void> {
  await generateReply({
    context,
    config,
    systemPrompt: 'You are a connectivity check. Reply with the single word: OK.',
    messages: [{ role: 'user', content: 'ping' }],
  })
}
