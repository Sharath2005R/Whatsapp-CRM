# Item 4A: WhatsApp Follow-Up Engine

Date: 2026-09-15.
Status: implementation and disposable PostgreSQL verification complete. Staging/Meta validation remains outstanding. NOT production-ready.
No application database migration, production deployment, live WhatsApp send, model download, dependency installation, or Ollama configuration change was performed. Item 5 was not started.

Repository root: `C:/Users/shara/Documents/Codex/2026-09-13/referenced-chatgpt-conversation-this-is-an/work/wacrm`.

## 1. Existing Architecture

`src/lib/automations/engine.ts` uses `executeStepsFrom` to suspend a workflow at a wait step in `automation_pending_executions`. The existing authenticated cron route claims legacy jobs and calls `resumePendingExecution`. `src/lib/automations/templates.ts` defines `follow_up_reminder` as a one-day wait followed by free-form text. It had no no-reply/service-window protection.

New follow-ups share that queue and cron, but have a distinct execution kind and transactional RPCs. They reuse `sendTextMessage` and `sendTemplateMessage` from the existing Meta integration. The higher-level automation sender wrapper is intentionally not used for these jobs: its phone-variant retries and post-send persistence exceptions cannot provide the required durable send boundary.

New copies of the old preset return HTTP 409. Migration 044 deactivates only exact matching two-step shipped copies and fails their pending executions. Custom workflows are not silently converted. Legacy resume now verifies the pending account and active automation.

## 2. Files Changed

This Item 4A inventory excludes pre-existing Items 1-4 changes in the dirty worktree. Paths below are relative to the repository root above.

| File | Purpose |
| --- | --- |
| `.env.local.example` | Default-off send flag and separate storage/reconciliation flag |
| `src/app/api/automations/route.ts` | Refuse unsafe legacy follow-up preset creation |
| `src/app/api/automations/cron/route.ts` | Drain follow-ups through existing scheduler; exclude them from legacy resumes |
| `src/app/api/automations/cron/route.test.ts` | Cron authorization, queue separation, safe errors |
| `src/app/api/whatsapp/webhook/route.ts` | Sender-scoped follow-up status reconciliation before legacy status mirroring |
| `src/lib/ai/tools/schema.ts` | Closed schedule/cancel schemas and feature-gated advertisement |
| `src/lib/ai/tools/execute.ts` | Existing registry handlers, confirmation routing, authoritative customer results |
| `src/lib/ai/tools/execute.test.ts` | Schema, ownership, confirmation, failure contracts |
| `src/lib/ai/tools/loop.test.ts` | Follow-ups in existing bounded orchestration |
| `src/lib/ai/generate.ts` | Advertise only enabled tools |
| `src/lib/automations/engine.ts` | Recheck account and active state during legacy resume |
| `src/lib/whatsapp/meta-api.ts` | Optional callback/timeout controls, safe rejection classification, live template lookup |
| `src/lib/whatsapp/meta-followups.test.ts` | Existing sender compatibility and simulated provider/template outcomes |
| `src/lib/followups/policy.ts` | Fixed service content and restricted Utility rendering |
| `src/lib/followups/policy.test.ts` | Category, variable, content and configuration validation |
| `src/lib/followups/worker.ts` | Prepare/authorize/send/finalize and delivery RPC adapter |
| `src/lib/followups/worker.test.ts` | One-attempt send behavior and safe failure paths |
| `src/lib/followups/followups.live.test.ts` | Opt-in disposable PostgreSQL transaction tests and timing instrumentation |
| `supabase/migrations/044_safe_followups.sql` | Queue state, ownership RPCs, accounting, settings, opt-out and client-write guards |
| `supabase/tests/followups-bootstrap.sql` | Minimal isolated database fixture extension |
| `docs/safe-followups.md` | This report and rollout limits |

## 3. Database Changes

Migration 044 adds follow-up binding, claims, failure, category and accounting fields to the existing pending queue; a distinct `execution_kind`; expanded state constraints; unique source/active-conversation indexes; a due-job index; and `messages.followup_id` plus `outbound_category`.

`followup_settings` contains operator-managed enablement, reviewed template selection, language, allowlisted variable mappings and monthly Service/Utility allowances. Tenant admins can read their own settings through RLS, but cannot raise allowances or enable sending themselves. Defaults deny sending.

`followup_usage` is an account-owned reservation ledger keyed by execution UUID. It deliberately has no execution/message/user foreign key, so accepted usage survives deletion of those records. Only deleting the account removes its accounting. It is not a second scheduler or a billing system.

`contacts.followup_opted_out` is additive. A message insert trigger handles exact STOP/UNSUBSCRIBE without the model. A separate trigger prevents authenticated clients from attaching or rewriting server-managed follow-up message links.

Existing RLS is retained. Queue/ledger/RPC writes are service-role-only. Business RPCs also check account membership, actor role, configured sender owner and current customer/conversation. Migration 044 and fixture RPC/RLS restrictions passed on real disposable PostgreSQL. Full Supabase-stack migration/RLS validation is still required before rollout.

## 4. State Machine

`awaiting_confirmation -> scheduled -> pending -> claimed -> sending -> sent -> delivered`

Alternate terminal or hold states: `cancelled`, `expired`, `blocked`, `failed`, `unknown`.
`sent` means provider accepted or reported sent, not delivered. Read maps to delivered at job level while preserving read on the message.

Expired confirmation: 15 minutes. Delay: 5-43,200 minutes. Due jobs older than 24 hours expire. Claimed jobs can be reclaimed after five minutes with a new token. Sending jobs older than five minutes become unknown, never resendable.

## 5. schedule_followup

`validateToolCall` accepts only integer `delay_minutes` and reason `requested_reminder | no_reply`. No body, tenant, recipient, sender, category, template or arbitrary database ID is accepted.

`executeTool -> businessOperation -> ai_followup_tool` uses server-issued Item 4 context. The SQL function independently validates account/actor, conversation/contact, sender configuration and latest actual customer message. It creates a confirmation proposal, not an immediate send.

A short server-generated confirmation code and exact delay are rendered by `businessResult`. Only an actual current customer CONFIRM message schedules the job. The delay starts at confirmation time. Codes never enter model tool-result data. Non-follow-up confirmations still route to the existing CRM confirmation contract.

## 6. cancel_followup

No model arguments are accepted. The backend finds the latest relevant follow-up for the current account/conversation/contact and locks it. Awaiting, scheduled, pending and claimed jobs can be cancelled. Repeated cancellation is idempotent.

Sending/unknown returns cancellation-unconfirmed; sent/delivered returns already-sent. The server, not model prose, chooses the customer-facing outcome.

## 7. Idempotency

Unique account/source-message proposal key; one active follow-up per account/conversation; one outbound message link per execution; one durable usage reservation per execution. A claim token must match at final authorization.

There is exactly one network send attempt after durable authorization. There is no phone-variant retry and no automatic retry after timeout, malformed acceptance, transport ambiguity, crash or uncertain persistence.

This is an at-most-one-attempt design, NOT distributed exactly-once delivery. A crash after authorization but before the HTTP request can leave an unsent job held as unknown. Operator reconciliation is required; never reset such a job to scheduled as a retry strategy.

## 8. Race Handling

Claim RPC uses row locks and SKIP LOCKED. Final authorization locks the execution and account settings, revalidates ownership/configuration/handoff/window/quota, inserts the outbound message and reserves usage in the same transaction.

Cancellation before authorization wins. After authorization it is too late to promise cancellation, even if the process has not yet entered its HTTP call. There is an unavoidable external-network boundary after database authorization.

Reservations serialize on the account settings row. Real concurrent PostgreSQL tests passed for duplicate claims, cancellation against authorization, and the final remaining Service/Utility allowance. These bounded fixture tests are not a load test or proof of every possible interleaving.

## 9. Service Window

`prepare_followup` determines category from the latest stored customer message timestamp at inspection and again at final authorization. Outbound conversation timestamps are not used. A 30-second safety margin is subtracted from the nominal 24-hour window.

Inside the window: fixed service reminder through existing text sender. Outside: configured approved Utility template only. Missing reliable inbound time, invalid ownership or changed preparation blocks sending. External policy/time/network races still require Meta test validation.

## 10. Utility Templates

Uses existing `message_templates` rows and fields: account, Meta ID, category, raw approval status, language, body and components. Requires matching tenant, APPROVED and Utility, selected by the operator.

`prepareSendPlan` supports en/hi/kn and regional variants, body-only templates without buttons/headers, and at most two variables: customer_name/business_name. Values are bounded and control characters are rejected. Service text is fixed. No retrieved content or model-generated message text is rendered.

`verifyUtilityTemplate` reads the configured WABA's template list immediately before authorization, matching Meta ID/name/language/body/approval/category and permitted components. Redirects, failures and incompatible definitions block sending. Unsupported components and languages fail closed.

No promotional free-form content is classified as Utility. Operator review and Meta's classification are still required; this is not an automatic semantic classifier.

## 11. Usage/Quota

Actual send-time category is stored on the message and ledger. UTC calendar months are used. Limits default to zero. No existing SaaS plan, billing or category-allowance implementation was found; consequently these are operator-configured FOLLOW-UP allowances, not global WhatsApp plan enforcement. Manual sends, broadcasts and custom automation sends remain outside this ledger.

Reserved entries consume available capacity but are not reported as confirmed accepted usage. Definitive rejection releases reservation. Acceptance counts once even if delivery later fails. Ambiguous acceptance remains reserved pending reconciliation. A later matching provider callback can reconcile it.

These internal accepted-attempt semantics are not a Meta invoice calculator. Meta pricing is based on delivery and includes category/window exceptions; do not hardcode the blanket claim that every Utility message incurs a fee. See [official WhatsApp pricing](https://whatsappbusiness.com/products/platform-pricing/). No rate or fee estimate is implemented.

Do not purge current-period usage reservations. Extending allowances across every outbound sender requires separately approved integration work, not silently labeling this ledger a global plan quota.

## 12. Delivery Status

The existing signed webhook passes the sender phone-number ID into `recordFollowupStatus`. The SQL updater correlates by provider ID or validated opaque execution UUID and verifies the frozen sender binding. Delivered/read do not regress to sent; accepted delivery failures remain failed with accepted usage.

Legacy unscoped message mirroring excludes follow-up-linked messages when follow-up storage is enabled. Provider correlation is also retained in the ledger if history or execution rows are deleted.

`AI_FOLLOWUP_STORAGE_READY=1` keeps callbacks reconciling when `AI_FOLLOWUPS_ENABLED=0` pauses new work. Enabling sends also implies storage readiness. Do not disable both flags while callbacks remain outstanding.

Opaque callback round-trip, actual signed Meta events and real delivery have not been tested.

## 13. Customer Reply

No-reply reminders store the confirmation message timestamp as the baseline; otherwise confirmation itself would look like a new reply. A later customer message causes server-side skip/cancellation during send preparation. Requested reminders remain eligible after another reply, subject to all other checks.

Exact STOP/UNSUBSCRIBE marks the contact opted out and cancels pre-send reminders. Opt-out is follow-up-specific, not a claim of comprehensive WhatsApp consent management.

## 14. Human Handoff

Assigned conversations and disabled AI block reminders at send time. Active message automations and active conversation flow runs also block this AI path.

`followup_attention` routes configuration/template/quota blocks through existing assignment fields and the existing notification trigger, validating a configured assignee against tenant membership. Without an assignee the conversation enters the shared human queue. A recorded notification is not confirmed human receipt. Provider unknown outcomes still require operator reconciliation.

## 15. Security Tests

Passed mocked tests cover model-supplied tenant/account/phone/template/category/message/SQL overrides; invalid delay/reason; foreign conversation/customer denial before RPC; tool-loop content injection; confirmation secrecy; failure without fake success; provider acceptance distinct from delivery; and safe content/variable rendering.

All 24 opt-in database cases passed, covering proposal/confirmation/cancel; cross-tenant schedule/cancel; RPC/RLS restrictions; worker claim and cancellation races; Service/Utility last-slot races; quota exhaustion; missing/wrong-category templates; changed snapshot; human handoff/opt-out; deleted/foreign bindings; changed sender/contact configuration; no-reply skip; duplicate acceptance/status ordering; rejected provider usage; usage retention; and STOP.

These are tests of a minimal fixture plus actual migration 044, not a complete Supabase-stack integration suite. Live testing found and fixed an ambiguous PL/pgSQL category variable in the quota query. The fixture adapter was also corrected to serialize PostgreSQL booleans as JSON and reset all conversations' handoff state between cases. Race assertions were retained.

## 16. Focused Tests

Final command: `npm test -- --maxWorkers=2 src/lib/followups src/lib/ai/tools src/lib/whatsapp/meta-followups.test.ts src/lib/automations/engine.test.ts src/lib/ai/auto-reply.test.ts src/app/api/automations/cron/route.test.ts`.

The earlier mock-focused run passed 211 tests in 2.00 seconds. All 24 additional database-focused cases subsequently passed inside the final full-suite run with FOLLOWUP_TEST_CONTAINER enabled. One pre-existing Item 4 opt-in case remains skipped. Test-run duration is not follow-up latency.

## 17. Full Test Suite

Final `npm test -- --maxWorkers=2 --reporter=default --reporter=json --outputFile=../../outputs/item4a-final-tests.json`, with the isolated FOLLOWUP_TEST_CONTAINER enabled: 1,159 passed, 0 failed, 2 skipped; 95 files passed / 2 skipped. Duration 144.78 seconds. Both skips are pre-existing opt-in cases; no Item 4A database case was skipped. The JSON artifact confirms success.

## 18. Typecheck

`npm run typecheck`: passed after final implementation changes. No dependencies or TypeScript configuration changed.

## 19. Lint

`npm run lint`: passed with 0 errors and 37 pre-existing warnings. No unrelated warning cleanup performed.

## 20. Production Build

`npm run build`: passed; 51 static pages generated. Existing middleware deprecation and edge-runtime notices remain.

The sandboxed initial build failed downloading the existing Inter Google font. The successful build used permitted network access and temporary process-only dummy Supabase/encryption settings, not application environment files or live credentials. Build success does not compile or exercise PostgreSQL functions.

## 21. Performance

Measurements completed on the isolated PostgreSQL fixture. Test-harness median timings, including Windows/Docker/psql process overhead and both accepted/denied test cases: schedule 472.2 ms, cancel 464.8 ms, claim 494.5 ms, preparation 598.1 ms, quota authorization 696.7 ms. The corresponding maxima were 717.5, 541.7, 3612.6, 1238.7 and 1529.5 ms. These are not HTTP API or production latency figures.

Three additional database-server-only samples ran in a rollback transaction, with provider acceptance simulated and no network calls:

| Operation | Median ms | Range ms |
| --- | ---: | ---: |
| Schedule proposal | 2.612 | 1.545-13.935 |
| Cancel confirmed reminder | 1.102 | 0.402-1.232 |
| Scheduler claim | 2.779 | 2.014-4.857 |
| Send preparation | 2.956 | 2.056-4.105 |
| Quota authorization | 2.921 | 2.233-6.466 |
| Claim through simulated acceptance | 9.427 | 8.823-19.144 |

The server-only samples exclude transaction commit, application/transport overhead, template lookup, real sending and delivery. Production end-to-end latency and load behavior remain unmeasured. The small sample is diagnostic, not a capacity estimate.

Verified worker call structure in mocks: inspect RPC, authorize/reserve RPC, finalize RPC; one shared claim RPC per batch. Utility adds one read-only Meta template lookup, then one send. Existing Item 4 context checks surround the scheduling/cancellation RPC. No LLM is called by the delayed worker.

Each database call is bounded at 5 seconds, template lookup at 10 seconds, send at 15 seconds. Batch size is 10 sequential jobs. Host execution budget and cron frequency must be validated before rollout; a short serverless timeout can leave an authorized job unknown rather than retry it.

## 22. Live Tests Performed

After the user restored Docker Desktop, actual migration 044 was applied to fresh disposable PostgreSQL fixtures and all 24 SQL tests passed. No application database or Meta endpoint was used. Containers used the existing pgvector image, no network, no published ports, 512 MB memory and one CPU. The final verified disposable container was stopped and auto-removed after testing and the rollback-only timing probe.

The earlier Docker startup failure is resolved for this verification. No reset, dependency installation, Windows security bypass, or Docker/Ollama configuration change was performed.

To reproduce, create a fresh auto-removed container using the installed pgvector image, no network, no published ports, resource bounds, and label `codex.item4a=disposable`. Set process-only `FOLLOWUP_TEST_CONTAINER` to its full 64-character ID and run `src/lib/followups/followups.live.test.ts` or the full suite. The test refuses an unlabeled, networked, port-exposing or nonempty fixture and applies only test bootstraps plus actual migration 044. Remove only that verified disposable container afterward.

## 23. Known Limitations / Rollout Gate

Do not enable Item 4A yet. Disposable transaction tests now pass, but full Supabase migration/RLS checks and required Meta checks are outstanding. No actual application DB has migration 044 applied by this task. Default-off flags and operator allowances were not enabled.

Rollout after verification: pause/drain existing cron workers, inspect the legacy preset quarantine results, apply migration 044 to the intended development environment, configure operator-reviewed tenant settings/template/allowances, set storage readiness, then enable follow-up sends and existing business tools. Resume cron only with an adequate execution budget. Keep storage readiness on if sends are later paused.

Custom delayed workflows remain outside these guarantees and need an explicit audit. The shipped preset is quarantined, not automatically converted into a different message workflow. There is no new follow-up management UI or billing integration.

Unknown send outcomes have no automatic resend or automatic reservation release. No total-delivery guarantee, global plan quota, general promotional-content classifier, full consent platform, or confirmed human notification delivery is claimed.

## 24. Meta / Live Verification Outstanding

Verify in an authorized nonproduction Meta environment: real 24-hour boundary behavior; WABA template lookup/permissions/pagination; exact supported languages/components/variable behavior; current Utility classification and recategorization; opaque callback round-trip; accepted-before-response/crash cases; signed duplicate/out-of-order callbacks; provider rejection vs ambiguity; and actual delivered/failed events.

Validate deployment timeout behavior and capacity under concurrent workers, repeat isolation/quota checks against the full intended staging schema, and measure real end-to-end latency before rollout. Local fixture tests and diagnostic timings now pass; live WhatsApp delivery and production readiness are not claimed.

STOP: Item 4A only. Items 5 and beyond require approval.
