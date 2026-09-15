# Guarded WhatsApp Follow-Ups

The follow-up implementation extends the existing automation queue and cron
path. Its main code is in src/lib/followups/policy.ts and
src/lib/followups/worker.ts, with schema changes in migration
044_safe_followups.sql.

## Controls

Scheduling and delivery require a trusted account context. The policy checks
feature flags, tenant settings, customer reply and no-reply baselines,
STOP/UNSUBSCRIBE signals, human handoff, active automation status, timing
windows, service-window restrictions, and relevant utility-template rules.
Customer activity and explicit cancellation can invalidate a scheduled item.

## Delivery behavior

The worker claims a due record, performs durable authorization checks, and
makes at most one external network attempt. A confirmed provider result is
recorded as sent. An uncertain result is terminal and is not retried
automatically, preventing duplicate WhatsApp sends.

The followup_usage table supports tenant-local limits and idempotency; it is
not a billing system or a global cross-tenant quota service.

## Verification boundary

Twenty-four disposable PostgreSQL/RLS fixture tests passed for the follow-up
engine. The broader Vitest suite also passed with that fixture. This validates
the SQL and server behavior locally, not live Meta delivery semantics or a
hosted Supabase configuration. AI_FOLLOWUPS_ENABLED and
AI_FOLLOWUP_STORAGE_READY are disabled in the example configuration pending
production verification.
