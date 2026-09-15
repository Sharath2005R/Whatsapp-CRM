import { AiError, type ProviderResult } from '../types';
import { MAX_OUTPUT_TOKENS } from '../defaults';
import { loadOllamaConfig } from '../ollama-config';
import { normalizeUsage, type ProviderArgs } from './shared';

function httpError(status: number): AiError {
  const [code, message] =
    status === 404
      ? [
          'model_not_found',
          'The configured Ollama model or chat endpoint was not found. Contact the operator.',
        ]
      : status === 400
        ? [
            'unsupported_model',
            'Ollama rejected the model or chat configuration.',
          ]
        : status === 401 || status === 403
          ? [
              'invalid_config',
              'Ollama access was denied. Contact the operator.',
            ]
          : status === 429
            ? ['rate_limited', 'Ollama is busy. Please try again later.']
            : ['provider_error', 'Ollama could not complete the request.'];
  return new AiError(message, { code, status: 502 });
}

/** Native non-streaming chat; deliberately no retries or provider fallback. */
export async function generateOllama(
  args: Omit<ProviderArgs, 'apiKey'>
): Promise<ProviderResult> {
  const { endpoint } = loadOllamaConfig(args.model);
  if (
    !Number.isSafeInteger(args.timeoutMs) ||
    args.timeoutMs < 1 ||
    args.timeoutMs > 2_147_483_647
  ) {
    throw new AiError('AI request timeout configuration is invalid.', {
      code: 'invalid_config',
      status: 503,
    });
  }
  const signal = AbortSignal.timeout(args.timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      redirect: 'error',
      cache: 'no-store',
      signal,
      body: JSON.stringify({
        model: args.model,
        stream: false,
        // Use Ollama's native reasoning separation; think:false leaked reasoning
        // into content with the verified local qwen3:4b model.
        think: true,
        messages: [
          { role: 'system', content: args.systemPrompt },
          ...args.messages.map(({ role, content }) => ({ role, content })),
        ],
        options: { num_predict: MAX_OUTPUT_TOKENS },
      }),
    });
    if (!response.ok) throw httpError(response.status);
    // Keep response-body consumption inside the same timeout boundary.
    const data = await response.json();
    if (
      !data ||
      typeof data !== 'object' ||
      data.error ||
      data.done !== true ||
      data.message?.role !== 'assistant' ||
      typeof data.message.content !== 'string' ||
      (data.message.tool_calls !== undefined &&
        (!Array.isArray(data.message.tool_calls) ||
          data.message.tool_calls.length > 0))
    ) {
      throw new AiError('Ollama returned a malformed chat response.', {
        code: 'malformed_response',
      });
    }
    if (data.done_reason === 'length') {
      throw new AiError(
        'Ollama could not finish the reply within the output limit.',
        { code: 'incomplete_response' }
      );
    }
    const text = data.message.content.trim();
    // Reject, do not attempt to recover an answer from malformed reasoning.
    if (/<\/?think\b/i.test(text)) {
      throw new AiError('Ollama returned an unsafe answer format.', {
        code: 'unsafe_response',
      });
    }
    if (!text)
      throw new AiError('Ollama returned an empty response.', {
        code: 'empty_response',
      });
    return {
      text,
      usage: normalizeUsage({
        prompt: data.prompt_eval_count,
        completion: data.eval_count,
      }),
    };
  } catch (err) {
    if (err instanceof AiError) throw err;
    if (
      signal.aborted ||
      (err instanceof Error &&
        ['TimeoutError', 'AbortError'].includes(err.name))
    ) {
      throw new AiError('Ollama took too long to respond.', {
        code: 'timeout',
        status: 504,
      });
    }
    if (err instanceof SyntaxError) {
      throw new AiError('Ollama returned invalid JSON.', {
        code: 'malformed_response',
      });
    }
    // Do not expose internal URLs, proxy errors, or credentials in responses.
    throw new AiError('Could not reach Ollama. Contact the operator.', {
      code: 'network_error',
      status: 502,
    });
  }
}
