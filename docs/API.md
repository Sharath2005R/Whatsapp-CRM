# API Reference

Route handlers enforce their own authorization. This list is a navigation aid,
not a replacement for their request schemas.

| Area | Routes | Access |
| --- | --- | --- |
| Account | /api/account, members, invitations, transfer-ownership, api-keys | Authenticated role checks |
| AI | /api/ai/config, draft, autoreply/:conversationId, knowledge, knowledge/:id, knowledge/reindex, playground, test, usage | Authenticated account context |
| Automations | /api/automations, /api/automations/:id, engine, cron | Account context; cron secret where applicable |
| Flows | /api/flows, /api/flows/:id, activate, runs, cron, templates | Account context; cron protection where applicable |
| WhatsApp | /api/whatsapp/webhook, send, config, broadcast, media, react, templates | Webhook verification or authenticated account access |
| Public API | /api/v1/me, contacts, conversations, messages, broadcasts, webhooks | Scoped revocable API key |

AI follow-up actions are internal controlled tools, not public HTTP endpoints.
For the existing public API contract, see public-api.md.
