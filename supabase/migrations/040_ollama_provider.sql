-- Add operator-managed local inference without changing existing account choices.
BEGIN;

ALTER TABLE ai_configs DROP CONSTRAINT IF EXISTS ai_configs_provider_check;
ALTER TABLE ai_configs ADD CONSTRAINT ai_configs_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'ollama'));
ALTER TABLE ai_configs ALTER COLUMN api_key DROP NOT NULL;
ALTER TABLE ai_configs DROP CONSTRAINT IF EXISTS ai_configs_provider_key_check;
ALTER TABLE ai_configs ADD CONSTRAINT ai_configs_provider_key_check CHECK (
  (provider = 'ollama' AND api_key IS NULL AND embeddings_api_key IS NULL)
  OR (provider IN ('openai', 'anthropic') AND api_key IS NOT NULL)
);
ALTER TABLE ai_configs DROP CONSTRAINT IF EXISTS ai_configs_ollama_model_check;
ALTER TABLE ai_configs ADD CONSTRAINT ai_configs_ollama_model_check CHECK (
  provider <> 'ollama' OR (
    length(model) BETWEEN 1 AND 200
    AND model ~ '^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$'
    AND model !~* '(-|:)cloud$'
  )
);

ALTER TABLE ai_usage_log DROP CONSTRAINT IF EXISTS ai_usage_log_provider_check;
ALTER TABLE ai_usage_log ADD CONSTRAINT ai_usage_log_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'ollama'));

COMMIT;
