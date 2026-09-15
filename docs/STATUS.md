# Current Status

## Implemented

- Account-scoped CRM, Supabase Auth, roles, and RLS.
- Existing Meta WhatsApp webhook and sender integration.
- Local Ollama generation with configuration validation and safe failures.
- Server-derived tenant AI context and separated prompt inputs.
- Local embeddings, account-scoped knowledge retrieval, and grounding checks.
- Controlled AI business tools with server-side validation.
- Guarded follow-up scheduling and worker behavior.

## Locally verified

- Follow-up PostgreSQL/RLS fixture: 24 of 24 focused tests passed.
- Full Vitest run with the fixture: 1,159 tests passed; two pre-existing
  opt-in tests were skipped.
- Typecheck passed.
- Lint passed with zero errors and 37 existing warnings.
- Production build passed.

## Partially verified or open

- Ollama was exercised locally with qwen3:4b. Capacity and latency remain
  host-dependent.
- Follow-up Meta behavior is simulated; live Meta delivery and template
  verification are still required.
- Fixture PostgreSQL is not a hosted Supabase RLS deployment.
- Item 5 and production deployment work are not complete.
- Internal follow-up allowance tracking is not product billing or global quota.
