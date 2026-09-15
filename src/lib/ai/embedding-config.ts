import { AiError, type AiProvider } from './types'
import { ollamaEndpoint } from './ollama-config'

export const LOCAL_EMBEDDING_MODEL = 'qwen3-embedding:0.6b'
export const LOCAL_EMBEDDING_DIMENSIONS = 1024
// Version the input recipe as well as the model: vectors must share one space.
export const LOCAL_EMBEDDING_SPACE = 'qwen3-embedding:0.6b:1024:retrieval-v1'

export type EmbeddingConfig =
  | {
      provider: 'ollama'
      model: string
      dimensions: 1024
      space: string
      endpoint: string
      timeoutMs: number
    }
  | { provider: 'openai'; apiKey: string }

export function knowledgeEmbeddingConfig(config: {
  provider?: AiProvider
  embeddingsApiKey: string | null
}): EmbeddingConfig | null {
  if (config.provider !== 'ollama') {
    return config.embeddingsApiKey
      ? { provider: 'openai', apiKey: config.embeddingsApiKey }
      : null
  }
  const model = process.env.OLLAMA_EMBEDDING_MODEL ?? LOCAL_EMBEDDING_MODEL
  const timeoutMs = Number(process.env.OLLAMA_EMBEDDING_TIMEOUT_MS ?? 15000)
  if (
    model !== LOCAL_EMBEDDING_MODEL ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 60000
  ) {
    throw new AiError('Local embedding configuration is invalid.', {
      code: 'invalid_config',
      status: 503,
    })
  }
  return {
    provider: 'ollama',
    model,
    dimensions: LOCAL_EMBEDDING_DIMENSIONS,
    space: LOCAL_EMBEDDING_SPACE,
    endpoint: ollamaEndpoint(
      'embed',
      process.env.OLLAMA_EMBEDDING_BASE_URL ?? process.env.OLLAMA_BASE_URL,
    ),
    timeoutMs,
  }
}
