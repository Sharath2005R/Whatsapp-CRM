# Item 3: Local business knowledge and RAG

## Status

Implementation, local embeddings, multilingual retrieval and isolated PostgreSQL
knowledge/RLS tests are complete. Live Qwen3:4b answer generation is NOT verified:
the real RAG chat request timed out after a diagnostic 90 seconds while available
RAM fell to approximately 146 MiB. The application timeout remains unchanged.
No cloud fallback, extra chat model, agent tools or global Ollama settings were added.

## Inspection findings

1. Knowledge is stored in existing account-owned `ai_knowledge_documents` rows
   with title/content, and `ai_knowledge_chunks` with document/account IDs.
2. `chunkText` preserves paragraphs where possible, packing up to 1,200 characters.
3. Migration 030 creates a generated language-neutral `simple` FTS index, pgvector,
   a `vector(1536)` embedding column and an HNSW index.
4. The original `embedTexts` used OpenAI `text-embedding-3-small`.
5. Existing Anthropic accounts also required a separate OpenAI key for semantic
   embeddings; Ollama previously used only lexical retrieval.
6. pgvector was already present. No external vector database is needed.
7. Item 2 introduced server-issued execution context. Existing retrieval RPCs are
   `SECURITY INVOKER` after migration 032 and are governed by account RLS.
8. Draft, playground and auto-reply use `retrieveKnowledge` and put references in
   an untrusted user-role envelope through `withKnowledgeReferences`.
9. Original retrieval discarded document/chunk identifiers and had no semantic
   relevance threshold. Source references are now retained internally.
10. Local embeddings require a different vector space, provider dispatch, source
    metadata, confidence filtering and a deterministic empty-result handoff.

## Model and resources

Selected model: **qwen3-embedding:0.6b**, not qwen3:4b.
The installed model is a dedicated 595.78M-parameter Q8_0 embedding model:

- Disk size: 639,150,858 bytes, approximately 610 MiB.
- Dimensions: 1,024.
- Installed digest: `ac6da0dfba84a81fdbfbaf330198c33cd77c4cdfc53e8bc50eb581914a15621d`.
- Ollama advertised capabilities: embedding; model context limit: 32,768.
- Runtime allocation reported by Ollama during the test: about 2.21 GiB.
- Qwen3:4b runtime allocation: about 2.97 GiB, CPU-only in this test.
- The machine has about 15.73 GiB RAM; about 2.38 GiB was free before the test.
  The two resident models reported roughly 5.17 GiB combined.

Qwen describes the model as multilingual with 100+ languages and Apache-2.0
licensing. The dedicated small model avoids downloading another multi-billion
parameter generator. [Model specification](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B),
[official Ollama model](https://ollama.com/library/qwen3-embedding:0.6b).

Both models could become resident, but comfortable coexistence was NOT demonstrated
under this development machine's current workload. An 8 GB VPS was not tested and
should not be assumed sufficient. Freeing memory or operator-controlled serial
model loading needs a separate validation run; neither was forced here.

## Retrieval architecture

`embedTexts` keeps its existing OpenAI key-based interface and accepts an explicit
embedding-provider configuration. Ollama accounts select the local adapter even
if stale paid credentials exist. Paid providers retain their explicit embedding
key behavior. Local failures never retry a paid service.

The local adapter uses Ollama's native `/api/embed`, batches of at most eight
inputs, one overall request deadline, no redirects, and `truncate:false`.
It validates the response model, vector count, dimension, finite numbers and
nonzero vectors. Query instructions follow the embedding model's retrieval recipe;
documents remain unprefixed. The versioned space identifier includes that recipe.
The model's weights/tag and recipe must stay fixed until reindexing after an upgrade.

Migration 042 adds `local_embedding vector(1024)`, `local_embedding_space` and
`document_content_hash` to the existing chunk table. It preserves the existing
OpenAI vector column and index. A composite document/account foreign key prevents
new cross-account parent relationships. It is NOT VALID to avoid deleting legacy
inconsistent data; retrieval excludes such rows and operators should audit them
before validating that constraint on a deployed database.

`replace_ai_knowledge_chunks` checks ownership/role, locks the document, verifies
that its content has not changed, and replaces chunks in one transaction. A failed
embedding can still save current lexical chunks, then report the embedding error.
A failed database write rolls back the replacement. Modified source documents
cannot match stale chunk hashes while reindexing is pending.

`match_ai_knowledge_v2` materializes only the authenticated/server-routed account's
current chunks and matching parent documents before scoring. It retains RLS and
explicit account checks. It never returns a global result set for application-side
tenant filtering. Semantic matches use a default cosine threshold of 0.65; lexical
matches retain PostgreSQL's language-neutral FTS. Empty/failed retrieval yields no
source references. Local search uses exact scoring within the tenant, intentionally
avoiding global ANN recall/filtering issues for a small corpus.

`knowledgeQuery` keeps the latest question primary and uses a bounded preceding
customer turn for short follow-ups. Assistant assertions do not become retrieval
authority. Source output retains chunk ID, document ID, title, score and method.
Only numbered references and content are sent to the model, not database handles
or tenant IDs.

## Answer safety

No sources means a deterministic handoff/fallback without a generation request.
This deliberately makes even ungrounded small-talk conservative when a knowledge
base is empty. Drafts receive a safe fallback string; auto-reply uses its existing
human-handoff branch and assignment rules.

With sources, the model must return a JSON answer with source numbers and exact
supporting quotations. Invalid JSON, missing evidence, unknown references,
nonmatching quotations, handoff sentinels and new numeric claims cause fallback.
Numeric checking includes Latin, Devanagari and Kannada digits. Source IDs remain
in the internal generation result; they are not exposed as executable model IDs.
Provenance is per-execution and is not yet persisted as a separate audit record.

References and customer text remain untrusted user-role data. They cannot select
accounts, alter provider settings, or execute tools. Native Ollama reasoning
separation and delimiter rejection remain in place.

**Limit:** exact quotations and numeric checks are not a semantic proof that every
sentence answers the question correctly. They cannot rule out every nonnumeric
hallucination, misleading attribution, or prompt-injection response. Real answer
quality and adversarial model behavior need further live evaluation. Do not treat
`grounding.status = cited` as a claim of formally verified truth.

## Measured performance

Synthetic small-business corpus: nine documents across two tenants, including
Kerala prices of INR 25,000 and INR 40,000, other packages, deposits, office hours,
transport, meals, document requirements and an instruction-injection document.

| Measurement | Observed |
| --- | --- |
| Cold single-document embedding | 6.86 s |
| Warm query embedding | 0.276 s |
| Indexing nine documents | 13.79 s |
| Retrieval including query embedding and Docker/psql overhead | 1.068 s |
| Complete RAG context preparation | 0.920 s |
| Hindi retrieval | 1.069 s; correct price; similarity 0.7165 |
| Kannada retrieval | 1.418 s; correct price; similarity 0.6529 |
| Unsupported Antarctica question | No matching sources |
| Complete Qwen3:4b reply | FAILED: timed out after 90.01 s |

These are single-run observations, not throughput or concurrency benchmarks.
The database path used actual pgvector SQL through Docker/psql, not PostgREST, so
transport overhead differs from deployment. Kannada's score is close to the
threshold; two examples do not establish production multilingual quality.
Normal app deadlines remain 15 seconds for embeddings and 30 seconds for chat.
The diagnostic used temporary 60/90-second limits to measure failures separately.

The generated measurements are in the task output file `item3-rag-benchmark.json`.
An embedding outage can still use tenant FTS, but language-neutral token matching
does not provide cross-language semantic matching by itself. Larger corpora,
concurrent tenants, and VPS latency have not been benchmarked.

## Migrations and live verification

Migration 041 does not provide any embedding or retrieval schema. It is still
required for the updated WhatsApp auto-reply claim. Its SQL was applied and tested
in the disposable local fixture alongside 030, 032 and 042. Migration 042 was also
reapplied to verify idempotence.

The fixture used PostgreSQL 17 and pgvector 0.8.2, actual knowledge policies/RPCs,
and the existing account-role membership logic with simulated JWT session claims.
It tested foreign account reads, direct foreign document reads, foreign writes,
viewer writes, anonymous execution, mismatched document/account relationships,
atomic rollback, stale reindex requests, legacy OpenAI vector retrieval, stale
document exclusion, and service-only/human-aware reply claims.

This was NOT a full Supabase Auth/PostgREST deployment and not a replay of all
application migrations. No configured application or production database was
modified. Migrations 040, 041 and 042 still need application to the intended
development/deployment Supabase database before deploying this code. Live
WhatsApp delivery remains unverified.

Rollback: revert the Item 3 application changes first. Keep the additive columns
and functions until a reviewed database rollback is planned; they do not prevent
the prior application from reading lexical/legacy OpenAI knowledge. Dropping
local vectors would discard derived indexes and require reindexing, so no
destructive down migration is run automatically.

## Configuration and reproduction

No application dependency or lockfile change is required.
Install only the dedicated embedding model:

```powershell
ollama pull qwen3-embedding:0.6b
```

Server-only configuration defaults:

```dotenv
OLLAMA_EMBEDDING_MODEL=qwen3-embedding:0.6b
OLLAMA_EMBEDDING_BASE_URL=http://127.0.0.1:11434
OLLAMA_EMBEDDING_TIMEOUT_MS=15000
AI_KNOWLEDGE_MIN_SIMILARITY=0.65
```

The embedding URL defaults to the existing Ollama base URL if not separately set.
Keep `OLLAMA_NO_CLOUD=1` in the Ollama service. Never expose its port publicly or
use NEXT_PUBLIC variables for provider configuration. Model installation does
not automatically reindex documents; apply migration 042, then use the existing
knowledge UI's Reindex action.

The guarded live test requires a fresh disposable container named
`wacrm-rag-item3-0914`, label `wacrm.rag-test=item3`, network mode `none`,
the image `pgvector/pgvector:0.8.2-pg17`, and no reused data volume. It refuses a
non-empty public schema. It uses synthetic data only. Set `LIVE_OLLAMA_RAG=1`
for `npm test -- src/lib/ai/rag.live.test.ts --maxWorkers=1`.
`supabase/tests/rag-assertions.sql` supplies additional SQL assertions afterward.
Do not run either SQL fixture against application or production data.

## Verification results

- Focused AI/RAG/API/WhatsApp webhook regression tests: 213 passed, one opt-in
  live test skipped; no failures (19 passing files).
- Full Vitest suite: 970 passed, one opt-in live test skipped; no failures
  (88 passing files). Both closing runs used `--maxWorkers=2` to fit available RAM.
- Separately enabled live test: one passed for database/retrieval assertions;
  its diagnostic chat request recorded a timeout, NOT a successful AI answer.
- Additional real SQL assertions passed: legacy OpenAI vectors, stale-source
  exclusion, human/disabled reply eligibility and service-only reply claiming.
- Typecheck: passed.
- Lint: zero errors, 37 existing warnings.
- Production build: passed with temporary dummy build-only configuration;
  no persistent environment changes. Existing middleware/edge warnings remain.
- `git diff --check`: passed; Git reported Windows line-ending warnings only.

Earlier fixture/type errors were fixed before the closing runs. An initial
default-worker suite hit worker startup timeouts under resource pressure; the
bounded-worker full runs passed. Dependency manifests, lockfile, WhatsApp
webhook/sender and Supabase client modules have no changes against HEAD.

The verified disposable test container was stopped and automatically removed
after verification. Other Docker containers and Ollama were left untouched.
Intended Supabase deployment and live WhatsApp verification remain pending,
along with successful live RAG answer generation and adversarial answer evaluation.

## Item 3 file inventory

- `.env.local.example`: embedding and threshold settings.
- `src/lib/ai/embedding-config.ts`: local/paid embedding selection and validation.
- `src/lib/ai/embeddings.ts`: extend the existing embedding interface.
- `src/lib/ai/providers/ollama-embeddings.ts`: bounded native embedding adapter.
- `src/lib/ai/providers/ollama-embeddings.test.ts`: adapter/configuration/failure tests.
- `src/lib/ai/ollama-config.ts`: shared local endpoint validation.
- `src/lib/ai/config.ts`: expose provider selection to existing ingest callers.
- `src/lib/ai/config.test.ts`: updated provider metadata assertions.
- `src/lib/ai/knowledge.ts`: atomic ingest and source-aware retrieval.
- `src/lib/ai/knowledge.test.ts`: retrieval, ownership and provider regressions.
- `src/lib/ai/query.ts`: bounded multi-turn retrieval query.
- `src/lib/ai/defaults.ts`: numbered untrusted knowledge references.
- `src/lib/ai/grounding.ts`: source/quote validation and safe fallback.
- `src/lib/ai/grounding.test.ts`: unsupported, multilingual and numeric claim tests.
- `src/lib/ai/generate.ts`: evidence-aware generation and empty-knowledge gate.
- `src/lib/ai/types.ts`: internal grounding metadata and embedding documentation.
- `src/lib/ai/auto-reply.ts`: pass source-aware knowledge through the existing path.
- `src/lib/ai/execution-context.test.ts`: ownership tests for the atomic RPC.
- `src/lib/ai/rag.live.test.ts`: guarded live database/model/performance checks.
- `src/app/api/ai/draft/route.ts`: richer retrieval context.
- `src/app/api/ai/draft/route.test.ts`: source-aware draft/playground regressions.
- `src/app/api/ai/playground/route.ts`: richer retrieval context.
- `src/app/api/ai/knowledge/route.ts`: select local embeddings during ingestion.
- `src/app/api/ai/knowledge/[id]/route.ts`: select local embeddings during updates.
- `src/app/api/ai/knowledge/reindex/route.ts`: select local embeddings during reindex.
- `src/components/settings/ai-config.tsx`: reuse existing semantic/reindex indicator for Ollama.
- `supabase/migrations/042_local_knowledge_rag.sql`: additive vector storage and guarded RPCs.
- `supabase/tests/rag-bootstrap.sql`: disposable membership/table fixture.
- `supabase/tests/rag-assertions.sql`: additional real SQL regression assertions.
- `docs/ollama.md`: updated local embedding setup.
- `docs/local-rag.md`: this implementation, measurements and limitations report.

Existing Item 1/2 changes remain in the worktree and are not part of this inventory.
No Item 4 tool implementation has started.
