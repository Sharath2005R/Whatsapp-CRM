BEGIN;
-- Keep the existing OpenAI vector(1536) and HNSW index intact.
ALTER TABLE public.ai_knowledge_chunks
  ADD COLUMN IF NOT EXISTS local_embedding vector(1024),
  ADD COLUMN IF NOT EXISTS local_embedding_space text,
  ADD COLUMN IF NOT EXISTS document_content_hash text;
UPDATE public.ai_knowledge_chunks c SET document_content_hash = md5(d.content)
FROM public.ai_knowledge_documents d
WHERE c.document_id = d.id AND c.account_id = d.account_id AND c.document_content_hash IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ai_knowledge_documents_id_account_idx
  ON public.ai_knowledge_documents(id, account_id);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.ai_knowledge_chunks'::regclass
                 AND conname = 'ai_knowledge_chunks_document_account_fk') THEN
    -- Preserve legacy inconsistent rows but prevent new ones; reads exclude them.
    ALTER TABLE public.ai_knowledge_chunks ADD CONSTRAINT ai_knowledge_chunks_document_account_fk
      FOREIGN KEY (document_id, account_id)
      REFERENCES public.ai_knowledge_documents(id, account_id) ON DELETE CASCADE NOT VALID;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.replace_ai_knowledge_chunks(
  p_account_id uuid, p_document_id uuid, p_content text, p_chunks jsonb
) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public
AS $$
DECLARE current_content text;
BEGIN
  SELECT d.content INTO current_content FROM public.ai_knowledge_documents d
  WHERE d.id = p_document_id AND d.account_id = p_account_id FOR UPDATE;
  IF NOT FOUND OR NOT (auth.role() = 'service_role' OR is_account_member(p_account_id, 'admin')) THEN
    RAISE EXCEPTION 'Knowledge document not available' USING ERRCODE = '42501';
  END IF;
  IF current_content IS DISTINCT FROM p_content THEN
    RAISE EXCEPTION 'Document changed during indexing' USING ERRCODE = '40001';
  END IF;
  IF jsonb_typeof(p_chunks) IS DISTINCT FROM 'array' OR jsonb_array_length(p_chunks) > 200 THEN
    RAISE EXCEPTION 'Invalid chunk batch' USING ERRCODE = '22023';
  END IF;
  DELETE FROM public.ai_knowledge_chunks WHERE account_id = p_account_id AND document_id = p_document_id;
  INSERT INTO public.ai_knowledge_chunks
    (account_id, document_id, chunk_index, content, embedding, local_embedding, local_embedding_space, document_content_hash)
  SELECT p_account_id, p_document_id, (ordinality - 1)::integer, value->>'content',
    (value->>'embedding')::vector(1536), (value->>'local_embedding')::vector(1024),
    value->>'local_embedding_space', md5(current_content)
  FROM jsonb_array_elements(p_chunks) WITH ORDINALITY;
END;
$$;
REVOKE ALL ON FUNCTION public.replace_ai_knowledge_chunks(uuid, uuid, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.replace_ai_knowledge_chunks(uuid, uuid, text, jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.match_ai_knowledge_v2(
  p_account_id uuid, p_query text, p_query_embedding text DEFAULT NULL,
  p_embedding_space text DEFAULT NULL, p_min_similarity double precision DEFAULT 0.65,
  p_match_count integer DEFAULT 5
) RETURNS TABLE (id uuid, document_id uuid, title text, content text, score double precision, method text)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public
AS $$
  -- Materialize this tenant's current chunks BEFORE vector scoring. Exact search
  -- avoids global ANN recall/filtering issues for small business corpora.
  WITH owned AS MATERIALIZED (
    SELECT c.*, d.title
    FROM public.ai_knowledge_chunks c
    JOIN public.ai_knowledge_documents d ON d.id = c.document_id AND d.account_id = c.account_id
    WHERE c.account_id = p_account_id AND d.account_id = p_account_id
      AND (auth.role() = 'service_role' OR is_account_member(p_account_id))
      AND c.document_content_hash = md5(d.content)
  ), scored AS (
    SELECT c.*,
      CASE
        WHEN p_query_embedding IS NULL THEN NULL
        WHEN p_embedding_space = 'qwen3-embedding:0.6b:1024:retrieval-v1'
          AND c.local_embedding_space = p_embedding_space
          THEN 1 - (c.local_embedding <=> p_query_embedding::vector(1024))
        WHEN p_embedding_space = 'openai:text-embedding-3-small:1536'
          THEN 1 - (c.embedding <=> p_query_embedding::vector(1536))
        ELSE NULL
      END AS similarity,
      ts_rank(c.fts, plainto_tsquery('simple', p_query))::double precision AS lexical_rank,
      c.fts @@ plainto_tsquery('simple', p_query) AS lexical_match
    FROM owned c
  )
  SELECT c.id, c.document_id, c.title, c.content,
    CASE WHEN c.similarity >= GREATEST(0.0, LEAST(1.0, p_min_similarity)) THEN c.similarity ELSE c.lexical_rank END,
    CASE WHEN c.similarity >= GREATEST(0.0, LEAST(1.0, p_min_similarity)) THEN 'semantic' ELSE 'lexical' END
  FROM scored c
  WHERE c.similarity >= GREATEST(0.0, LEAST(1.0, p_min_similarity))
     OR (c.lexical_match AND c.lexical_rank > 0)
  ORDER BY (c.similarity >= GREATEST(0.0, LEAST(1.0, p_min_similarity))) DESC NULLS LAST,
    c.similarity DESC NULLS LAST, c.lexical_rank DESC, c.id
  LIMIT GREATEST(0, LEAST(20, p_match_count));
$$;
REVOKE ALL ON FUNCTION public.match_ai_knowledge_v2(uuid, text, text, text, double precision, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.match_ai_knowledge_v2(uuid, text, text, text, double precision, integer) TO authenticated, service_role;
COMMIT;
