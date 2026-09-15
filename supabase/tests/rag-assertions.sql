-- Run only after rag.live.test.ts inside its disposable fixture.
SET ROLE service_role;
SET request.jwt.claim.sub = '10000000-0000-0000-0000-000000000001';
DO $$
DECLARE v text := '[1,' || repeat('0,', 1534) || '0]';
DECLARE n integer;
BEGIN
  INSERT INTO ai_knowledge_documents(id, account_id, title, content) VALUES
    ('60000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'Legacy OpenAI', 'Original OpenAI knowledge');
  INSERT INTO ai_knowledge_chunks(document_id, account_id, content, embedding, document_content_hash) VALUES
    ('60000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001',
     'Original OpenAI knowledge', v::vector(1536), md5('Original OpenAI knowledge'));
  SELECT count(*) INTO n FROM match_ai_knowledge_v2(
    '00000000-0000-0000-0000-000000000001', 'unmatched-lexical-query', v,
    'openai:text-embedding-3-small:1536', 0.99, 5);
  IF n <> 1 THEN RAISE EXCEPTION 'Legacy OpenAI retrieval regression'; END IF;
  UPDATE ai_knowledge_documents SET content = 'Changed source document'
    WHERE id = '60000000-0000-0000-0000-000000000001';
  SELECT count(*) INTO n FROM match_ai_knowledge_v2(
    '00000000-0000-0000-0000-000000000001', 'unmatched-lexical-query', v,
    'openai:text-embedding-3-small:1536', 0.99, 5);
  IF n <> 0 THEN RAISE EXCEPTION 'Stale source was retrieved'; END IF;
  UPDATE conversations SET ai_reply_count = 0, assigned_agent_id = '10000000-0000-0000-0000-000000000001'
    WHERE id = '30000000-0000-0000-0000-000000000001';
  IF claim_ai_reply_slot_for_account('00000000-0000-0000-0000-000000000001',
    '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 3)
    THEN RAISE EXCEPTION 'Human assignment bypassed'; END IF;
  UPDATE conversations SET assigned_agent_id = NULL, ai_autoreply_disabled = true
    WHERE id = '30000000-0000-0000-0000-000000000001';
  IF claim_ai_reply_slot_for_account('00000000-0000-0000-0000-000000000001',
    '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 3)
    THEN RAISE EXCEPTION 'Handoff disable flag bypassed'; END IF;
END;
$$;
SET ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM claim_ai_reply_slot_for_account('00000000-0000-0000-0000-000000000001',
      '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 3);
    RAISE EXCEPTION 'Authenticated role could call service-only claim';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$$;
RESET ROLE;
SELECT 'PASS: OpenAI vector compatibility, stale-source exclusion, human handoff, service-only reply claim';
