# Local Ollama provider

Ollama uses the existing AI settings, draft, Playground, and auto-reply paths.
Existing OpenAI and Anthropic accounts keep their provider; there is no automatic
fallback. Newly opened, unconfigured settings default to Ollama / `qwen3:4b`.
Local semantic embeddings now use the dedicated `qwen3-embedding:0.6b` model.
No agent tools are implemented. See [local RAG](local-rag.md) for migration,
resource, and live-verification details.

## Setup

1. Apply all existing migrations, followed by
   `supabase/migrations/040_ollama_provider.sql`, to your development Supabase
   database. The new migration is transactional and re-runnable. It permits
   keyless Ollama configuration, expands usage-log provider values, and leaves
   RLS policies unchanged. Back up existing data before applying migrations.
   For tenant-aware auto-reply, also apply `041_tenant_ai_reply_slot.sql`
   before running the updated application. See [tenant AI context](tenant-ai-context.md).
   Item 3 also requires `042_local_knowledge_rag.sql` for ingestion and retrieval.
2. Install Ollama separately, then prepare the selected model:

   ```sh
   ollama pull qwen3:4b
   ```

3. Start the Ollama service with `OLLAMA_NO_CLOUD=1` in its environment. On
   PowerShell, when Ollama is not already serving:

   ```powershell
   $env:OLLAMA_NO_CLOUD = '1'
   ollama serve
   ```

4. Add these server settings to wacrm's `.env.local` alongside its existing
   Supabase/Meta configuration:

   ```dotenv
   OLLAMA_BASE_URL=http://127.0.0.1:11434
   OLLAMA_ALLOWED_MODELS=qwen3:4b
   AI_REQUEST_TIMEOUT_MS=30000
   ```

   The first two values are also the defaults. The allow-list is a comma-separated
   list of exact, operator-installed model names. Accounts cannot override the
   endpoint or request arbitrary models. No model is pulled automatically.
   Known cloud model suffixes are rejected; operators must not install aliases
   backed by cloud models. Keep cloud disabled in the Ollama service itself.

5. Run `npm run dev`. In Settings, select Ollama, enter an allowed model name,
   use **Test connection**, then save. Test with the existing Playground before
   enabling automatic WhatsApp responses. Actual inference needs a running
   Ollama instance and an installed model; an 8 GB deployment is not benchmarked.

When wacrm runs in Docker Desktop and Ollama runs on the host, use
`http://host.docker.internal:11434` as the base URL and configure Ollama's listener
appropriately. For Linux containers, use a private service hostname or explicitly
configured host gateway. Do not publicly expose the Ollama port. Environment
settings are server-only: never prefix them with `NEXT_PUBLIC_`. Restart the app
after changing them. URL credentials, query strings, fragments and redirects are
rejected. A reverse proxy path prefix is supported.

Switching an account to Ollama clears its chat and paid embedding keys.
Install `qwen3-embedding:0.6b` explicitly and use the existing Reindex action to
populate local vectors. PostgreSQL full-text retrieval remains the fallback if
local embeddings fail; there is no paid fallback. Switching back to a paid
provider requires re-entering its key and reindexing to populate its vector space.

## Verification

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```

Build requires the existing public Supabase variables. CI uses dummy values;
successful builds with placeholders do not validate a database deployment.

Focused tests:

```sh
npm test -- src/lib/ai/providers/ollama.test.ts src/lib/ai/providers/ollama.integration.test.ts src/lib/ai/config.test.ts src/app/api/ai/config/route.test.ts src/lib/ai/generate.test.ts src/lib/ai/auto-reply.test.ts
```

The integration tests use a temporary local HTTP server to exercise the native
chat contract, redirect rejection, and timeout during response-body consumption.
They do not benchmark a model. Migration application and a real-model Playground
check must be verified separately against development services.

## Errors

| Code                                                            | Operator action                                                                    |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `invalid_config`                                                | Check the base URL, allow-list, timeout, or inference proxy access.                |
| `unsupported_model`                                             | Select an exact allowed chat model; check native `think: true` support. |
| `model_not_found`                                               | Check the endpoint and install the selected model in Ollama.                       |
| `network_error`                                                 | Start Ollama and check network access; redirects are not followed.                 |
| `timeout`                                                       | Warm the model, reduce load, or review the shared request timeout.                 |
| `malformed_response` / `empty_response` / `incomplete_response` | Check the model/server. The response is not sent to WhatsApp.                      |
| `rate_limited` / `provider_error`                               | Check inference capacity and Ollama service health.                                |
| `unsafe_response` | The answer contains reasoning delimiters. Do not send it; investigate model/server compatibility. |

The existing webhook route has a 60-second processing budget. Raising inference
timeouts is not a substitute for the later durable-worker stage. Provider errors
retain the existing auto-reply behavior: log the failure and send no AI reply.
An explicit `[[HANDOFF]]` response follows the existing human-handoff path.
No tool calls are executed at this stage; unexpected tool-call responses fail
closed. Raw Ollama errors and internal endpoint details are not returned to users.

Protocol references: [chat](https://docs.ollama.com/api/chat),
[errors](https://docs.ollama.com/api/errors).

## Reasoning separation

With Windows Ollama 0.34.0 and local `qwen3:4b`, `think: false` emitted
reasoning prose in `message.content`; adding `/no_think` still returned a closing
`</think>` marker. Suppression alone was not reliable for this installed model.

The adapter now uses native `think: true`. Ollama separates the private trace
into `message.thinking`; wacrm reads only `message.content` and never returns,
stores, or logs the thinking field. A local test returned final content `4`, a
separate thinking field, and `done_reason: stop` (approximately 30.88 seconds
including model work/loading). This was a protocol check, not a latency benchmark.

Content containing opening or closing think delimiters is rejected entirely.
There is no regex stripper attempting to infer where an answer starts. Empty,
truncated, malformed and timed-out answers remain rejected. This relies on the
documented model/server protocol, not a guarantee that arbitrary untagged prose
can be classified as reasoning. Validate model/server upgrades in Playground
before enabling unattended customer replies. Native thinking may increase latency
or exhaust the unchanged output/time limits; do not automatically retry with
thinking disabled or another provider.

Reference: [Ollama thinking protocol](https://docs.ollama.com/capabilities/thinking).
