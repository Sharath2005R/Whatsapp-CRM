import { AiError } from '../types'
import type { EmbeddingConfig } from '../embedding-config'

export function validateVectors(
  value: unknown,
  count: number,
  dimensions: number,
): number[][] {
  if (
    !Array.isArray(value) ||
    value.length !== count ||
    value.some(
      (vector) =>
        !Array.isArray(vector) ||
        vector.length !== dimensions ||
        vector.some((n) => typeof n !== 'number' || !Number.isFinite(n)) ||
        !vector.some((n) => n !== 0),
    )
  ) {
    throw new AiError('Embedding response contains invalid vectors.', {
      code: 'embeddings_malformed',
    })
  }
  return value
}

export async function embedOllama(
  config: Extract<EmbeddingConfig, { provider: 'ollama' }>,
  inputs: string[],
  purpose: 'query' | 'document',
): Promise<number[][]> {
  const result: number[][] = []
  // One total deadline, not a new full budget for every batch.
  const signal = AbortSignal.timeout(config.timeoutMs)
  try {
    for (let start = 0; start < inputs.length; start += 8) {
      const batch = inputs.slice(start, start + 8)
      const input =
        purpose === 'query'
          ? batch.map(
              (text) =>
                `Instruct: Retrieve business knowledge that answers the customer question.\nQuery: ${text}`,
            )
          : batch
      const response = await fetch(config.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        redirect: 'error',
        cache: 'no-store',
        signal,
        body: JSON.stringify({
          model: config.model,
          input,
          dimensions: config.dimensions,
          truncate: false,
          keep_alive: '2m',
        }),
      })
      if (!response.ok) {
        throw new AiError('Local embedding service rejected the request.', {
          code:
            response.status === 404
              ? 'embedding_model_not_found'
              : 'embedding_provider_error',
        })
      }
      const data = await response.json()
      if (data?.error || data?.model !== config.model) {
        throw new AiError(
          'Embedding response model does not match configuration.',
          { code: 'embeddings_malformed' },
        )
      }
      result.push(
        ...validateVectors(data.embeddings, batch.length, config.dimensions),
      )
    }
    return result
  } catch (error) {
    if (error instanceof AiError) throw error
    if (
      signal.aborted ||
      (error instanceof Error &&
        ['TimeoutError', 'AbortError'].includes(error.name))
    ) {
      throw new AiError('Local embedding request timed out.', {
        code: 'embedding_timeout',
        status: 504,
      })
    }
    throw new AiError('Local embedding service is unavailable.', {
      code: 'embedding_unavailable',
    })
  }
}
