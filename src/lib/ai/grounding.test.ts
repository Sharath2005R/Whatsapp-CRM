import { expect, it, vi, afterEach } from 'vitest'
import { validateGroundedReply } from './grounding'
import { generateReply } from './generate'
import { testContext, tenantDatabase } from './test-helpers'
import { loadAiConfig } from './config'
import { knowledgeQuery } from './query'
import type { KnowledgeSource } from './knowledge'

const sources: KnowledgeSource[] = [
  {
    id: 'a-chunk',
    document_id: 'a-doc',
    title: 'Kerala',
    content: 'Kerala package = ₹25,000.',
    score: 0.9,
    method: 'semantic',
  },
]
const messages = [
  { role: 'user' as const, content: 'What is the Kerala package price?' },
]
const reply = (answer: string, quote = sources[0].content, ref = 1) =>
  JSON.stringify({ answer, evidence: [{ ref, quote }] })
afterEach(() => vi.unstubAllGlobals())

it('retains validated internal source IDs for a cited answer', () => {
  expect(
    validateGroundedReply(
      reply('The Kerala package costs ₹25,000.'),
      sources,
      messages,
    ),
  ).toMatchObject({
    text: 'The Kerala package costs ₹25,000.',
    handoff: false,
    grounding: { status: 'cited', sourceIds: ['a-chunk'] },
  })
})
it.each([
  reply('It costs ₹40,000.'),
  reply('It costs ₹25,000.', 'Invented policy'),
  reply('It costs ₹25,000.', sources[0].content, 9),
  'not json',
  JSON.stringify({ answer: 'Free hotel upgrade', evidence: [] }),
  '[[HANDOFF]]',
])('hands off malformed or unsupported output', (raw) => {
  expect(validateGroundedReply(raw, sources, messages).handoff).toBe(true)
})
it('never calls a model when no reliable knowledge was retrieved', async () => {
  const { db } = tenantDatabase()
  const context = testContext(db)
  const config = (await loadAiConfig(context))!
  vi.stubGlobal('fetch', vi.fn())
  expect(
    await generateReply({
      context,
      config,
      systemPrompt: 'sys',
      messages,
      knowledge: [],
    }),
  ).toMatchObject({ handoff: true, grounding: { status: 'no_knowledge' } })
  expect(fetch).not.toHaveBeenCalled()
})
it('preserves multilingual answer text and safely localizes a missing-answer fallback', () => {
  const hindi = [
    { role: 'user' as const, content: 'केरल पैकेज की कीमत क्या है?' },
  ]
  expect(
    validateGroundedReply(
      reply('केरल पैकेज की कीमत ₹25,000 है।'),
      sources,
      hindi,
    ).text,
  ).toContain('₹25,000')
  expect(validateGroundedReply('[[HANDOFF]]', sources, hindi).text).toContain(
    'पुष्टि',
  )
  const kannada = [
    { role: 'user' as const, content: 'ಕೇರಳ ಪ್ಯಾಕೇಜ್ ಬೆಲೆ ಎಷ್ಟು?' },
  ]
  expect(validateGroundedReply('[[HANDOFF]]', sources, kannada).text).toContain(
    'ಮಾಹಿತಿಯನ್ನು',
  )
})
it('uses bounded prior customer context without trusting assistant assertions', () => {
  expect(
    knowledgeQuery([
      { role: 'user', content: 'Kerala package' },
      { role: 'assistant', content: 'Invented free hotel' },
      { role: 'user', content: 'How much?' },
    ]),
  ).toBe('How much?\nPrevious customer context: Kerala package')
})

it('rejects fabricated prices written with Hindi or Kannada digits', () => {
  expect(validateGroundedReply(reply('कीमत ₹४०,००० है।'), sources, messages).handoff).toBe(true)
  expect(validateGroundedReply(reply('ಬೆಲೆ ₹೪೦,೦೦೦.'), sources, messages).handoff).toBe(true)
  expect(validateGroundedReply(reply('कीमत ₹२५,००० है।'), sources, messages).handoff).toBe(false)
})
it('preserves handoff even when the sentinel is wrapped in a cited JSON answer', () => {
  expect(validateGroundedReply(reply('[[HANDOFF]]'), sources, messages).handoff).toBe(true)
})
