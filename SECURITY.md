# Security for This Fork

## Reporting

Do not report a suspected vulnerability in a public issue or include live
credentials, customer records, message contents, or webhook payloads in a
report. Use a private GitHub security advisory for the repository that hosts
this fork. The upstream template policy remains at .github/SECURITY.md.

## Security boundaries

- Supabase Auth and account membership provide the primary tenant boundary.
- Row-level security policies remain the database enforcement layer.
- Service-role access is server-only and must perform account ownership checks.
- WhatsApp credentials are encrypted at rest and webhooks are HMAC verified.
- AI execution receives a server-derived account context. A model, customer
  message, or retrieved document cannot select an account.
- Customer messages, knowledge excerpts, and model output are untrusted input.
- AI tools use validated server-side actions; the model never writes directly
  to the database.

## Deployment checklist

- Use unique production secrets and rotate any secret that may have appeared in
  a terminal, issue, or repository history.
- Keep Ollama on the private network or loopback interface. Do not expose port
  11434 to the public internet. Set OLLAMA_NO_CLOUD=1 for the local setup.
- Apply Supabase migrations in numerical order and review RLS policies and
  grants after every schema change.
- Restrict cron routes, Meta scopes, API keys, CORS, storage buckets, backups,
  and operational logs to the least privilege required.
- Use TLS at the public edge and retain an incident-response and backup plan.
- Keep AI_FOLLOWUPS_ENABLED and AI_FOLLOWUP_STORAGE_READY disabled until the
  required production verification has been completed.

## Logging and privacy

Do not log access tokens, encrypted token material, API keys, raw customer
messages, knowledge content, or model prompts/responses unless an approved,
redacted diagnostic process requires them. Treat exports, SQL dumps, local
databases, backups, and generated test output as sensitive operational
artifacts.
