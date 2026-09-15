import type { ChatMessage } from './types'

/**
 * The text to retrieve knowledge against: the most recent customer
 * (`user`) turn in the conversation context. Falls back to the last
 * message of any role, then empty string. Shared by the draft route and
 * the auto-reply bot so both query the knowledge base the same way.
 */
export function latestUserMessage(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return messages[i].content
  }
  return messages.length > 0 ? messages[messages.length - 1].content : ''
}

/** Keep the latest question primary; previous customer text resolves follow-ups.
 * Never use assistant-generated facts as retrieval authority. */
export function knowledgeQuery(messages: ChatMessage[]): string {
  const turns = messages.filter(message => message.role === 'user').slice(-2)
  const latest = turns.at(-1)?.content.trim() ?? ''
  if (!latest) return ''
  if (turns.length < 2 || latest.length > 160) return latest.slice(0, 1600)
  return `${latest.slice(0, 1000)}\nPrevious customer context: ${turns[0].content.slice(0, 500)}`
}
