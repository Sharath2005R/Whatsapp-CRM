# Entity Relationships

The migrations in supabase/migrations are the authoritative schema. This
diagram focuses on the tenant and AI-related entities rather than every
supporting table.

~~~mermaid
erDiagram
  ACCOUNTS ||--o{ PROFILES : has_members
  ACCOUNTS ||--o{ CONTACTS : owns
  ACCOUNTS ||--o{ CONVERSATIONS : owns
  ACCOUNTS ||--o{ PIPELINES : owns
  ACCOUNTS ||--o{ AUTOMATIONS : owns
  ACCOUNTS ||--o{ FLOWS : owns
  ACCOUNTS ||--o{ AI_CONFIGS : owns
  ACCOUNTS ||--o{ AI_KNOWLEDGE_DOCUMENTS : owns
  ACCOUNTS ||--o{ WHATSAPP_CONFIG : owns
  ACCOUNTS ||--o{ FOLLOWUP_SETTINGS : owns
  CONTACTS ||--o{ CONVERSATIONS : participates_in
  CONTACTS ||--o{ DEALS : has
  CONVERSATIONS ||--o{ MESSAGES : contains
  PIPELINES ||--o{ PIPELINE_STAGES : contains
  PIPELINE_STAGES ||--o{ DEALS : classifies
  AUTOMATIONS ||--o{ AUTOMATION_STEPS : contains
  AUTOMATIONS ||--o{ AUTOMATION_LOGS : records
  AUTOMATIONS ||--o{ AUTOMATION_PENDING_EXECUTIONS : queues
  FLOWS ||--o{ FLOW_NODES : contains
  FLOWS ||--o{ FLOW_RUNS : records
  AI_KNOWLEDGE_DOCUMENTS ||--o{ AI_KNOWLEDGE_CHUNKS : splits_into
  CONVERSATIONS ||--o{ AI_TOOL_REQUESTS : requests
  CONVERSATIONS ||--o{ AI_USAGE_LOG : records
  FOLLOWUP_SETTINGS ||--o{ FOLLOWUP_USAGE : limits
  MESSAGES }o--|| AUTOMATION_PENDING_EXECUTIONS : followup_reference
~~~

## Tenant ownership

Account ownership is explicit on CRM, automation, WhatsApp, AI configuration,
knowledge, and follow-up settings records. A conversation also links a contact
to its account; messages are reached through their conversation. RLS and
server-side ownership checks must agree before a server action uses a
service-role client.

FOLLOWUP_USAGE has a logical execution identifier used for idempotency; it is
not represented here as a database foreign key. The diagram does not imply
that every line is a direct constraint.
