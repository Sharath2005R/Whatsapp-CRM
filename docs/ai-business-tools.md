# Item 4: Controlled business tools

## Status

The five supported tools are implemented. Guarded PostgreSQL tests passed.
Live model-driven tool execution is NOT verified: the local qwen3:4b probe
reached the 30-second generation deadline with zero tool rounds and returned
safe handoff. No live WhatsApp delivery was attempted. No Item 5 work started.

Tools are opt-in through server-only `AI_BUSINESS_TOOLS_ENABLED=1`, after migration
043 and its prerequisites have been applied. The example defaults to 0; no
actual application environment or database was configured/modified here.

## Reused architecture

- `generateReply` remains the provider-neutral AI entry point.
- `dispatchInboundToAiReply` remains behind the existing webhook/flow/automation
  eligibility, account rate limit, reply cap and human-ownership checks.
- `whatsappAiContext`, `assertAiContext` and `requireAiConversation` provide the
  existing server-issued tenant boundary. The tool context rechecks membership,
  role, contact ownership and the latest inbound customer message on every call.
- `retrieveKnowledge` and Item 3 pgvector/FTS provide retrieval and provenance.
- Existing `deals`, `pipelines`, `pipeline_stages` and contact relationships are
  reused. There is no leads table or product/calendar subsystem.
- Existing conversation assignment and `notify_conversation_assigned` trigger
  are reused. The notification trigger itself is unchanged.
- Existing provider adapters, sender and AI token-usage logging remain in use.

## Supported tools

| Tool | Contract |
| --- | --- |
| search_knowledge | Strict bounded query; existing tenant RAG; numbered title/content references to model; full source IDs internal only |
| get_customer | No arguments; current conversation's contact name/company only; no customer enumeration or IDs |
| create_lead | Existing CRM deal; title and optional notes; both must quote actual customer text; confirmation required |
| update_lead | Replace notes only on the customer's sole open deal; no arbitrary fields, values, stage or ownership changes; confirmation required |
| notify_human | No arguments; pause AI and use configured same-account agent or shared queue; distinguish assignment, notification record and delivery |

The executable registry attaches closed input schemas, descriptions, permission
classes and handlers. The model sees schema metadata, never executable functions.
All tools require a current owner/admin/agent WhatsApp server context; `read` in
schema metadata describes the effect, not permission for anonymous/viewer access.
Drafts and playground do not receive an executable tool context.

## Deal confirmation and results

A model request proposes a change; it cannot perform the deal mutation itself.
The backend returns a deterministic preview with a random 12-hex-character
confirmation code. The customer must send exactly `CONFIRM <code>` within
15 minutes. SQL validates that this is the actual latest inbound message on the
same account/conversation/contact, not model-generated confirmation text.
Codes are omitted from tool results sent to the model.

Confirmation uses stored arguments, not a second model interpretation. Title
and notes are bounded literal excerpts of customer messages, never privileged
prompts or knowledge-document instructions. Operational previews/statuses are
currently English; the schema and stored values support multilingual text.

Creation requires one configured pipeline and chooses its first stage by
position/ID. An existing sole open deal returns `already_exists`. Multiple open
deals or ambiguous/missing pipeline configuration fail safely for human help.
Updates cannot select an arbitrary deal and cannot modify monetary values,
status, assignees, stage, contact IDs or account settings.

Conversation and contact row locks serialize tool writes; repeated confirmation
returns the recorded outcome instead of creating another deal. This prevents
duplicates within this tool path; it does not impose a global uniqueness rule
on independently created manual/automation deals. The ordinary automation
`create_deal` branch now checks the insert error before reporting success.

Existing reply caps remain authoritative. A low cap may prevent a later
confirmation turn from running; the bot does not bypass that cap. Pending
requests then expire and need human handling. No pending-request cleanup job
was added; retention/maintenance should be configured before sustained use.

## Handoff and notification contract

`notify_human` validates the configured assignee in the same account and updates
the existing conversation handoff fields transactionally. Invalid/foreign
assignees fail. Without an assignee, the conversation enters the shared queue.

The result reports `assignment=assigned|shared_queue`,
`notification=recorded|unconfirmed`, and always `delivery=unconfirmed`.
A saved notification row is not proof of realtime delivery, a read receipt,
email, phone contact or a response-time promise. A trigger failure can leave
assignment successful while notification is unconfirmed; tests exercise this.

As before, auto-reply stops sending when handoff is true. The tool does not
introduce a separate WhatsApp handoff announcement or replace the sender.
The normal Item 1-3 fallback handoff path is retained.

## Orchestration and safety

Tool requests use a strict text JSON envelope above the existing Ollama/OpenAI/
Anthropic adapters: one known tool plus a closed arguments object. This is not
native function-calling and never executes model-supplied SQL, URLs or names.
Unknown tools, extra keys, ownership IDs, malformed JSON, invalid values and
control characters are rejected. No blocked tools appear in the registry.

At most three tool requests execute per generation; a fourth request yields
handoff. Calls share the existing generation time budget (30 seconds by default),
and business RPC requests have a five-second transport deadline. Database reads
and initial RAG preparation are not all covered by an end-to-end HTTP deadline;
this is not a guarantee that the entire webhook workflow finishes in 30 seconds.
Token usage from successful provider calls is summed for existing usage logging.

Sanitized backend results return to the model. For action outcomes, the server
renders the final operational text; invented model prose or a final-model timeout
cannot manufacture successful execution. Knowledge answers still pass Item 3
source/quote validation. Reference contents remain untrusted user-role data.
Source IDs remain internal; customer source facts are likewise numbered data.

Security tests cover account/customer overrides, unknown tools, forged contexts,
foreign conversations/contacts, schema violations, document instructions, and
fake model success following errors. Confirmation is the write boundary, not
an assumption that prompt instructions alone defeat injection. This does not
prove that every knowledge answer is semantically correct or that every possible
prompt injection is neutralized. Item 3's answer-quality limitations remain.

Logs use existing console logging with structured fields: known tool name,
success/failure, duration, random per-turn correlation ID and safe error category.
They exclude arguments, full messages, prompts, tokens, credentials and tenant IDs.

## Migration and deployment

`043_ai_business_tools.sql` adds only `ai_tool_requests` and the guarded
`ai_business_tool` RPC. The state table is necessary to bind confirmed actions
to exact customer-approved arguments and record idempotent results. It contains
customer text, so it has RLS enabled, no authenticated/anonymous access, and
explicit service-role grants. The RPC is SECURITY INVOKER, service-role-only,
and validates account membership/role, WhatsApp config owner, conversation,
contact, latest message, AI eligibility and deal/pipeline relationships.
Existing RLS policies are not weakened or replaced.

The migration was applied twice to verify repeatability in the disposable test
fixture. This was PostgreSQL/pgvector with simulated JWT claims and the actual
knowledge policies and notification trigger, not a full Supabase Auth/PostgREST
deployment or a replay of every historical migration. Production was untouched.
The intended development database still needs the pending Item 1-3 migrations
(040-042) and 043 in order. Verify all earlier dependencies before rollout.

Rollback: disable the tool flag first. The prior no-tool path still works; keep
the additive state/RPC while reviewing retention and any later database rollback.
Do not drop state blindly after confirmed actions.

## Performance

Single observations against synthetic data, including Windows Docker/psql
process overhead, not deployment PostgREST timings or concurrency benchmarks:

| Measurement | Observed | Database calls |
| --- | --- | --- |
| Schema validation, mean of 10,000 calls | 0.0024 ms | 0 |
| Current customer read with fresh authorization | 1.722 s | 5 |
| Create proposal with fresh authorization | 1.815 s | 5 |
| Confirm/create transaction | 0.354 s | 1 |
| Confirm/update transaction | 0.347 s | 1 |
| Handoff with recorded notification | 1.761 s | 5 |
| Handoff with unconfirmed notification | 1.739 s | 5 |
| Live qwen3:4b loop probe | 30.028 s; fallback, zero tool rounds | 4 |

The live test ran 218 SQL statements including setup/assertions. The model probe
did NOT verify a tool-driven final answer. No timeout fix, extra model, embedding
provider, paid fallback or global Ollama setting was introduced. The earlier
model RAM/coexistence limitations remain. Raw results are in the task output
`item4-tools-benchmark.json`.

## Verification

- Focused AI/tool/RAG/API/automation/webhook tests: 314 passed, two opt-in live
  tests skipped; 22 passing files, zero failures.
- Full Vitest suite: 1,046 passed, two opt-in live tests skipped; 90 passing files,
  zero failures. Runs used `--maxWorkers=2` for this machine's memory budget.
- Separately enabled PostgreSQL test: one passed, including actual migration
  repeatability, RLS/grants, current customer lookup, A-only knowledge, empty
  retrieval, customer confirmation, creation/update, duplicate confirmation,
  missing deal, expired approval, foreign account/conversation and viewer/anonymous
  denial, injected ownership fields, untrusted document text, forced insert/update
  failures, and assignment with recorded/unconfirmed notification outcomes.
- Its optional live Qwen3:4b diagnostic: NOT verified; fallback after 30.028 seconds,
  zero tool rounds. The SQL test's passing status does not imply model success.
- TypeScript typecheck: passed.
- Lint: zero errors, 37 existing warnings.
- Production build: passed using temporary dummy build-only configuration;
  existing middleware deprecation and edge-runtime warnings remain.
- `git diff --check`: passed, with Windows line-ending notices only.

The first SQL fixture run failed because its setup omitted the service role for
knowledge indexing; this test setup was corrected and the expanded live test
passed on a fresh fixture. Intermediate TypeScript errors in the fixture and
registry typing were fixed before the closing successful checks.

The disposable container was stopped and automatically removed. Other Docker
containers, Ollama, existing application configuration and production were left
untouched. Supabase Auth/PostgREST deployment, live WhatsApp delivery and successful
Qwen3-driven tool execution remain unverified.

The opt-in test requires a fresh disposable container named
`wacrm-tools-item4-0914`, label `wacrm.tools-test=item4`, network mode `none`,
and image `pgvector/pgvector:0.8.2-pg17`. It refuses a non-empty public schema.
Run with `LIVE_AI_TOOLS=1`; add `LIVE_TOOL_MODEL=1` only for the diagnostic local
model probe. A passing SQL test does not imply that this diagnostic probe passed.
No test fixture may be run against existing application or production data.

## Blocked dependencies

- `schedule_followup`: delayed automations exist but need durable per-customer
  authorization/idempotency, send-time service-window checks, approved Utility
  template selection, category-specific accounting and recorded delivery results.
- `cancel_followup`: pending executions need a cancellation state and a race-safe
  claim/cancel contract, checked again by the scheduler before sending.
- `get_product_or_service`: no structured tenant product/service catalogue exists.
- `book_appointment`: no availability, booking or double-booking prevention backend.

The future follow-up path must recheck tenant, customer, status and cancellation
at send time; determine service-window/template eligibility; use the existing
sender; account for the actual category; then persist the outcome. None of this
was partially implemented or exposed to the model here.

## Item 4 file inventory

- `.env.local.example`: opt-in rollout flag.
- `src/lib/ai/auto-reply.ts`: pass server conversation only when enabled.
- `src/lib/ai/auto-reply.test.ts`: flag/eligibility regression coverage.
- `src/lib/ai/generate.ts`: bounded provider-neutral tool loop and safe outcomes.
- `src/lib/ai/tools/schema.ts`: exact five tools and strict runtime schemas.
- `src/lib/ai/tools/context.ts`: issued, conversation-bound tool authorization.
- `src/lib/ai/tools/execute.ts`: executable registry, safe results and logging.
- `src/lib/ai/tools/execute.test.ts`: schemas, ownership, injection and result tests.
- `src/lib/ai/tools/loop.test.ts`: provider regressions, limits and fake-success tests.
- `src/lib/ai/tools/tools.live.test.ts`: guarded real database and diagnostic model tests.
- `src/lib/automations/engine.ts`: check existing deal insert outcome.
- `src/lib/automations/engine.test.ts`: successful/failed deal insert regressions.
- `supabase/migrations/043_ai_business_tools.sql`: guarded business writes/state.
- `supabase/tests/tools-bootstrap.sql`: disposable fixture, not an app migration.
- `docs/ai-business-tools.md`: this report and rollout instructions.

Existing Item 1-3 worktree changes were preserved and are not counted above.
No dependencies, provider adapters, sender/webhook, frontend, billing, campaigns,
appointments or follow-up scheduler implementation were changed in Item 4.
