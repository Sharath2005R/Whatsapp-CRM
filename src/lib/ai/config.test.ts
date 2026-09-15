import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

// decrypt is identity in tests so we don't depend on real ciphertext.
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => `plain:${v}`,
}))

import { loadAiConfig, loadEmbeddingsKey } from './config'
import { testContext } from './test-helpers'

function dbReturning(row: Record<string, unknown> | null) {
  const chain = {
    from: () => chain,
    select: () => chain,
    eq: () => chain,
    maybeSingle: () => Promise.resolve({ data: row, error: null }),
  }
  return testContext(chain as unknown as SupabaseClient)
}

const ROW = {
  provider: 'openai',
  model: 'gpt-x',
  api_key: 'enc-key',
  system_prompt: null,
  is_active: false,
  auto_reply_enabled: false,
  auto_reply_max_per_conversation: 3,
  embeddings_api_key: null,
}

describe('loadAiConfig requireActive', () => {
  it('loads Ollama without a key and suppresses any legacy paid embeddings key', async () => {
    const db = dbReturning({
      ...ROW,
      provider: 'ollama',
      api_key: null,
      is_active: true,
      embeddings_api_key: 'old-paid-key',
    })
    expect(await loadAiConfig(db)).toMatchObject({
      provider: 'ollama',
      apiKey: '',
      embeddingsApiKey: null,
    })
    expect(await loadEmbeddingsKey(db)).toEqual({
      key: null,
      corrupt: false,
      provider: 'ollama',
    })
  })

  it('still requires a key for existing paid providers', async () => {
    expect(
      await loadAiConfig(
        dbReturning({ ...ROW, is_active: true, api_key: null }),
      ),
    ).toBeNull()
  })
  it('returns null for an inactive config by default', async () => {
    expect(await loadAiConfig(dbReturning(ROW))).toBeNull()
  })

  it('returns the config when requireActive is false (Playground path)', async () => {
    const config = await loadAiConfig(dbReturning(ROW), {
      requireActive: false,
    })
    expect(config).not.toBeNull()
    expect(config!.provider).toBe('openai')
    expect(config!.apiKey).toBe('plain:enc-key')
  })

  it('returns null when there is no row', async () => {
    expect(
      await loadAiConfig(dbReturning(null), { requireActive: false }),
    ).toBeNull()
  })
})
