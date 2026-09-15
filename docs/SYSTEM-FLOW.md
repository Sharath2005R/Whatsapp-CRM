# System Flows

## Incoming WhatsApp message

~~~mermaid
flowchart TD
  A[Customer] --> B[Meta WhatsApp Cloud API]
  B --> C[Webhook route]
  C --> D[HMAC verification and sender/account resolution]
  D --> E[Contact and conversation lookup]
  E --> F[Message persistence and idempotency]
  F --> G{Eligible deterministic automation?}
  G -->|yes| H[Automation or flow engine]
  G -->|no or AI path| I[Server-derived AI execution context]
  I --> J[Conversation history and tenant configuration]
  J --> K[Knowledge retrieval]
  K --> L[Ollama generation]
  L --> M{Validated tool request?}
  M -->|yes| N[Server-side tenant-scoped tool]
  N --> L
  M -->|no| O[Grounding and safety checks]
  O --> P[Existing WhatsApp sender]
  P --> Q[Persist delivery state]
~~~

The webhook and sender remain the existing integration points. Human handoff
and automation eligibility rules are evaluated before an automated reply is
sent.

## Retrieval and grounded answers

~~~mermaid
flowchart LR
  A[Trusted account context] --> B[Account-scoped documents and chunks]
  C[Conversation turn] --> D[Local query embedding]
  D --> B
  B --> E[Retrieved excerpts with internal source metadata]
  E --> F[Untrusted context section of AI prompt]
  F --> G[Ollama response]
  G --> H{Grounded or supported?}
  H -->|yes| I[Reply with internal sources retained]
  H -->|no| J[Existing fallback or human handoff]
~~~

Customer text and retrieved excerpts are untrusted. They remain separate from
system instructions, and neither may define identity, permissions, tools, or
tenant selection.

## Follow-up lifecycle

~~~mermaid
stateDiagram-v2
  [*] --> scheduled
  scheduled --> canceled: customer reply, opt-out, handoff, or explicit cancel
  scheduled --> claimed: due worker claims eligible item
  claimed --> sent: durable authorization then one confirmed delivery
  claimed --> uncertain: network outcome cannot be confirmed
  sent --> [*]
  canceled --> [*]
  uncertain --> [*]
~~~

An uncertain external send is not retried automatically. The worker checks
tenant controls, opt-out signals, conversation state, time window, and
eligible automation status before it makes one network attempt.
