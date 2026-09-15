# AI Architecture

## Provider model

The local core provider is Ollama through src/lib/ai/providers/ollama.ts.
Server configuration is validated in src/lib/ai/ollama-config.ts. The intended
generation model is qwen3:4b; the local embedding provider uses
qwen3-embedding:0.6b through its own configuration abstraction. Operators
control endpoint and allowed-model configuration through server environment
variables. The application does not expose those values to the client.

Existing OpenAI and Anthropic adapters remain supported for existing
configuration behavior. They are not a fallback for local Ollama generation.

## Trusted execution context

src/lib/ai/execution-context.ts establishes account identity on the server.
Every AI execution validates the conversation and related records before
loading history, contact data, business settings, knowledge, or automation
state. A model response and inbound customer message cannot provide an account
or conversation identity.

## Prompt boundaries

System instructions are constructed separately from customer content and
retrieved knowledge. Customer text, document excerpts, and tool-facing model
arguments are untrusted. They cannot override tenant boundaries or permission
rules.

## Retrieval and safety

Knowledge retrieval is account-scoped. It retains source metadata internally
so the application can tell a grounded response from an unsupported one. When
reliable support is absent, the normal outcome is the existing fallback or
human handoff rather than an invented answer.

Tool use is closed and validated in src/lib/ai/tools. Tools call backend
operations after authorization; the model has no direct database access.

## Reasoning output

Qwen models may return think-tagged reasoning. The provider uses the existing
safe response handling to prevent reasoning from reaching customers. A future
model change should be tested for output format before any parsing behavior is
expanded.

## Operational limits

Local inference latency and capacity depend on the host. There is no live
production Meta verification recorded for the new follow-up path, and the
local database fixture is not a substitute for a hosted Supabase deployment.
