import { AiError } from './types';
import { AI_PROVIDER_DEFAULT_MODEL } from './defaults';

/** Server-only configuration. No request or account field can override it. */
export function ollamaEndpoint(path: 'chat' | 'embed', baseUrl = process.env.OLLAMA_BASE_URL) {
  const invalidConfig = () =>
    new AiError(
      'Ollama server configuration is invalid. Contact the operator.',
      {
        code: 'invalid_config',
        status: 503,
      }
    );
  let endpoint: URL;
  try {
    endpoint = new URL(baseUrl ?? 'http://127.0.0.1:11434');
  } catch {
    throw invalidConfig();
  }
  if (
    !['http:', 'https:'].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw invalidConfig();
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/, '')}/api/${path}`;
  return endpoint.toString();
}

export function loadOllamaConfig(model: string) {
  const invalidConfig = () => new AiError('Ollama server configuration is invalid. Contact the operator.', { code: 'invalid_config', status: 503 });
  const endpoint = ollamaEndpoint('chat');

  const models = (
    process.env.OLLAMA_ALLOWED_MODELS ?? AI_PROVIDER_DEFAULT_MODEL.ollama
  )
    .split(',')
    .map((value) => value.trim());
  const validModel = (value: string) =>
    value.length <= 200 &&
    /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(value) &&
    !/(?:-|:)cloud$/i.test(value);
  if (models.some((value) => !validModel(value))) throw invalidConfig();
  if (!validModel(model) || !models.includes(model)) {
    throw new AiError('This Ollama model is not enabled by the operator.', {
      code: 'unsupported_model',
      status: 400,
    });
  }
  return { endpoint };
}
