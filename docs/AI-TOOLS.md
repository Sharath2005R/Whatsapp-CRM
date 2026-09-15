# Controlled AI Tools

The model can request only the closed set defined in src/lib/ai/tools/schema.ts.
src/lib/ai/tools/execute.ts validates arguments, resolves the trusted AI
execution context, enforces account ownership, and returns confirmed results.

| Tool | Purpose | Writes | Confirmation |
| --- | --- | --- | --- |
| search_knowledge | Find account-owned knowledge | No | Retrieved sources |
| get_customer | Read the current customer context | No | Server-selected customer |
| create_lead | Create a permitted CRM lead | Yes | Persisted action result |
| update_lead | Update an authorized lead | Yes | Persisted action result |
| notify_human | Notify a human operator | Yes | Server action result |
| schedule_followup | Request guarded WhatsApp follow-up | Yes | Durable schedule result |
| cancel_followup | Cancel an authorized follow-up | Yes | Durable cancellation result |

The model cannot select arbitrary tenant, contact, conversation, or database
identifiers. The server derives the account and validates current-message
scope. It does not grant arbitrary SQL, authentication, payment, catalogue,
appointment, marketing, bulk-send, or external network capabilities.

Follow-up tools honor the same consent, suppression, handoff, and conversation
state checks as the worker. Details are in FOLLOW-UPS.md.
