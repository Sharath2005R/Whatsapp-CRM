# Architecture

## Status vocabulary

Implemented means code and focused tests exist in this working tree. Locally
verified means it passed the stated local checks. Planned means it is not
shipped or not verified against a production dependency.

## System overview

wacrm is a Next.js App Router application using React and Tailwind for the
web UI. Route handlers under src/app/api provide server endpoints. Supabase
provides PostgreSQL, Auth, Storage, and Realtime. The WhatsApp integration
uses the Meta Cloud API through the existing webhook and sender paths.

| Area | Main implementation | Status |
| --- | --- | --- |
| Authentication and roles | src/lib/auth/account.ts | Implemented |
| CRM inbox, contacts, deals | src/app and Supabase migrations | Implemented |
| WhatsApp ingress and egress | src/app/api/whatsapp/webhook/route.ts and send/route.ts | Implemented |
| Automations and flows | src/lib/automations and src/app/api/flows | Implemented |
| Local generation | src/lib/ai/providers/ollama.ts | Implemented |
| Tenant AI context | src/lib/ai/execution-context.ts | Implemented |
| Knowledge retrieval | src/lib/ai/knowledge.ts and embeddings.ts | Implemented |
| Controlled AI actions | src/lib/ai/tools | Implemented |
| Guarded follow-ups | src/lib/followups | Implemented, production Meta verification pending |
| Billing or cross-tenant quotas | None | Not implemented |

## Tenant boundary

The accounts table is the business boundary. Profiles are members of an
account and carry owner, admin, agent, or viewer roles. Account-aware server
code obtains identity through getCurrentAccount and requireRole in
src/lib/auth/account.ts. Supabase RLS policies are the persistent enforcement
layer. Server-side service-role operations must validate account ownership
before accessing tenant data.

AI entry points build an execution context server-side in
src/lib/ai/execution-context.ts. Conversation, contact, business
configuration, knowledge, and automation data are loaded only after account
ownership is established. The model never supplies an account identifier.

## Request lifecycle

1. A browser request or Meta webhook reaches a Next route handler.
2. Authentication or webhook verification establishes a trusted caller.
3. Account-scoped data is loaded under RLS and server-side ownership checks.
4. Deterministic automations or the AI entry point decide the permitted path.
5. The response, tool result, or outbound WhatsApp message is persisted.

## Failure handling

The AI provider validates configuration and handles unavailable local
inference, malformed output, and timeouts without invoking a paid-provider
fallback. AI tool calls are schema validated, account authorized, and return
confirmed server results. Follow-up delivery uses durable authorization and
does not retry uncertain external outcomes automatically.

## Delivery and verification

The repository contains Dockerfile, docker-compose.yml, Supabase migrations,
Vitest tests, and GitHub Actions workflows. The currently documented local
verification is in STATUS.md. Live Meta behavior and a hosted Supabase
environment remain separate production checks.
