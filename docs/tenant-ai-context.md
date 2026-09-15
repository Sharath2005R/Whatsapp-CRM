# Phase 2, Item 2: Tenant-aware AI context

## Existing architecture and integration

- `src/lib/auth/account.ts`: `getCurrentAccount` verifies the Supabase session,
  resolves profile membership and account metadata; `requireRole` enforces the
  existing role threshold. These functions and their RLS-scoped client are unchanged.
- `src/app/api/whatsapp/webhook/route.ts`: the signed webhook resolves the account
  through its phone-number-to-`whatsapp_config` mapping, then calls
  `dispatchInboundToAiReply` only after existing deterministic flow handling.
  Neither the webhook nor the WhatsApp sender was replaced or modified.
- `src/lib/ai/generate.ts`: `generateReply` remains the shared generation entry
  point for auto-reply, drafts, playground and credential validation.
- Existing `account_id` filters in configuration, knowledge and automation queries
  are retained. History additionally verifies the conversation and its contact,
  then scopes the messages query through its conversation relationship.

## Implemented boundaries

`authenticatedAiContext` wraps only the server-resolved `AccountContext`.
`whatsappAiContext` revalidates the WhatsApp config owner, current account membership,
and account existence under the service-role client. Contexts are immutable and
registered in a server-local WeakSet. Request JSON, object spreads and serialized
copies are not accepted by `assertAiContext`. This is an internal guard against
accidental identity injection, not a substitute for authentication: callers must
continue using `requireRole` or the signed webhook. Background jobs must resolve
fresh context rather than serialize an issued object.

`generateReply`, `validateAiCredentials`, `loadAiConfig`, `loadEmbeddingsKey`,
`buildConversationContext`, `retrieveKnowledge` and `ingestDocument` require this
context. Context identity and database handles are not sent to the model.

`requireAiConversation` verifies both `conversations.account_id` and the linked
`contacts.account_id`, including the expected inbound contact when applicable.
Foreign, missing and failed ownership lookups do not load history or generate a
reply. Ingest validates document ownership before deleting or writing chunks;
chunk replacement includes both document and account filters. Retrieval keeps the
existing account-scoped FTS/semantic RPCs; authorization failures are not swallowed
as best-effort empty retrieval.

`buildSystemPrompt` includes the verified account name and the account's saved
business instructions. `withKnowledgeReferences` places retrieved text in a
user-role JSON envelope, separate from privileged system instructions. Customer
and retrieved text are explicitly untrusted. Playground accepts only user and
assistant content and strips extra object fields. Prompt rules do not guarantee
grounding or make prompt injection impossible; enforced database boundaries do
not depend on the model following those rules.

Auto-reply preserves existing flow/automation precedence, AI switches, rate limits,
reply caps and human handoff. Unknown automation eligibility now fails closed.
Handoff targets are rechecked for membership; stale targets leave the conversation
in the shared queue. Updates include account/contact filters and do not overwrite
a current human assignee. The send path rechecks ownership and human eligibility.

## Database deployment requirement

Apply `supabase/migrations/041_tenant_ai_reply_slot.sql` after existing migrations,
including Item 1's `040_ollama_provider.sql`, before using updated auto-reply.
The new `claim_ai_reply_slot_for_account` RPC atomically checks account, contact,
contact ownership, human assignment, the disabled flag and reply cap. It uses
`SECURITY INVOKER`; EXECUTE is granted only to `service_role`, with PUBLIC, anon
and authenticated explicitly revoked. Creation and grants are transactional.
No RLS policy is removed or relaxed. The old RPC remains for rolling upgrades;
the new application does not fall back to it. Missing migration means no AI send.

The migration was not applied here. No connected development Supabase database
was available for live SQL/RLS tests or a real WhatsApp round trip. Automated
database tests use query fakes that apply account filters, not a running Postgres
instance. Before deployment, verify that the new RPC refuses foreign account or
contact IDs, refuses human-owned/disabled conversations, caps concurrent claims,
and is inaccessible to authenticated/anonymous database roles.

## Ollama reasoning

The local Qwen3 test exposed reasoning in content with `think: false`. Native
`think: true` returned final content `4` with reasoning in a separate field.
The adapter uses that native separation and ignores the private field. It rejects
content containing reasoning delimiters rather than attempting to strip them.
Timeout, truncation, empty and malformed responses remain fail-closed. There is
no fallback to another provider or to disabled thinking.

This relies on Ollama's documented protocol, not a classifier for untagged
reasoning prose. The protocol smoke test took approximately 30.88 seconds;
thinking can exceed the existing 30-second application timeout. The timeout and
output budget were not increased. Validate realistic prompts and capacity before
unattended operation. See [Ollama details](ollama.md#reasoning-separation) and
[the upstream thinking protocol](https://docs.ollama.com/capabilities/thinking).

## Files changed in Item 2

These 31 files exclude existing Item 1-only edits to environment examples,
translations, settings UI, provider types, Ollama configuration and migration 040.

### Server context and AI helpers

- `src/lib/ai/execution-context.ts` (new): context issuance and ownership guards.
- `src/lib/ai/context.ts`: guarded, account-scoped conversation history.
- `src/lib/ai/config.ts`: context-required configuration and key loading.
- `src/lib/ai/knowledge.ts`: context-required retrieval and owned document ingest.
- `src/lib/ai/generate.ts`: context-required shared generation entry point.
- `src/lib/ai/validate.ts`: context-required provider connectivity validation.
- `src/lib/ai/defaults.ts`: trusted business prompt and untrusted reference envelope.
- `src/lib/ai/auto-reply.ts`: verified routing, scoped mutations and handoff guards.
- `src/lib/ai/providers/ollama.ts`: native thinking separation and format rejection.

### API callers

- `src/app/api/ai/draft/route.ts`: authenticated context and ownership-first loading.
- `src/app/api/ai/playground/route.ts`: authenticated context and sanitized role fields.
- `src/app/api/ai/config/route.ts`: authenticated context for connection validation.
- `src/app/api/ai/test/route.ts`: authenticated context for connection validation.
- `src/app/api/ai/knowledge/route.ts`: context for existing ingest/key helpers.
- `src/app/api/ai/knowledge/[id]/route.ts`: context for existing reindex/key helpers.
- `src/app/api/ai/knowledge/reindex/route.ts`: context for existing reindex/key helpers.

### Migration, tests and documentation

- `supabase/migrations/041_tenant_ai_reply_slot.sql` (new): account-scoped atomic claim.
- `src/lib/ai/test-helpers.ts` (new): shared account-filtering test fixtures.
- `src/lib/ai/execution-context.test.ts` (new): context and cross-tenant denial cases.
- `src/lib/ai/defaults.test.ts` (new): prompt-role separation and fallback instructions.
- `src/lib/ai/context.test.ts`: existing transcript behavior with ownership guards.
- `src/lib/ai/config.test.ts`: provider compatibility under context-required loading.
- `src/lib/ai/knowledge.test.ts`: existing retrieval/indexing behavior under context.
- `src/lib/ai/generate.test.ts`: existing paid-provider behavior with context.
- `src/lib/ai/auto-reply.test.ts`: tenant denial, human handoff and eligibility regressions.
- `src/lib/ai/providers/ollama.test.ts`: reasoning rejection and context-aware generation.
- `src/lib/ai/providers/ollama.integration.test.ts`: native HTTP thinking contract.
- `src/app/api/ai/config/route.test.ts`: authenticated settings/connection fixtures.
- `src/app/api/ai/draft/route.test.ts` (new): actual draft/playground paths with mocked services.
- `docs/ollama.md`: migration prerequisite and reasoning/latency caveats.
- `docs/tenant-ai-context.md` (new): this implementation and verification record.

## Verification

Final verification on 2026-09-14:

| Check | Result |
| --- | --- |
| `npm test -- src/lib/ai src/app/api/ai src/app/api/whatsapp/webhook/route.test.ts` | PASS: 175 tests, 17 files |
| `npm test` | PASS: 932 tests, 86 files |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS: 0 errors, 37 pre-existing warnings |
| `npm run build` | PASS: production compilation, TypeScript and 51 static pages |
| `git diff --check` | PASS: no whitespace errors |
| Local Qwen3 native reasoning protocol smoke test | PASS: final content `4`, separate thinking field, normal stop |
| Live migration / PostgreSQL RLS / WhatsApp delivery | NOT RUN: no connected development database |

An initial typecheck caught an implicit type in the Playground message mapper;
it was corrected and the final typecheck/build passed. Earlier focused/full runs
passed 174/931 tests; the final runs above include the additional human-assignment
race regression test.

The build used temporary dummy CI values for the existing Supabase and encryption
settings, with network access for the existing Google font. No persistent
environment configuration, dependency manifest or lockfile was changed.
Existing Next.js middleware-deprecation and edge/static-generation warnings
remain. Authentication, the WhatsApp webhook/sender, and existing RLS policies
were not modified. These results validate code and mocked service boundaries,
not a deployed multi-tenant database or unattended answer quality.

## Explicitly deferred

No local embeddings, new retrieval algorithm, source/provenance redesign,
deterministic grounding verifier, agent tools, LLM training, worker redesign,
WhatsApp replacement, deployment, dependency changes or paid cloud fallback were
introduced. Item 2 is the stopping point; Items 3-6 require separate approval.
