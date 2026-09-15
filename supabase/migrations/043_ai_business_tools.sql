-- Only the verified WhatsApp server path may propose/confirm these operations.
-- Existing deals, contacts, assignments and notification triggers remain authoritative.
BEGIN;

CREATE TABLE IF NOT EXISTS public.ai_tool_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
  tool text NOT NULL CHECK (tool IN ('create_lead', 'update_lead', 'notify_human')),
  arguments jsonb NOT NULL,
  confirmation_code text NOT NULL DEFAULT substr(replace(gen_random_uuid()::text, '-', ''), 1, 12),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '15 minutes',
  result jsonb,
  UNIQUE (conversation_id, message_id, tool)
);
ALTER TABLE public.ai_tool_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_tool_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_tool_requests TO service_role;

CREATE OR REPLACE FUNCTION public.ai_business_tool(
  p_account_id uuid, p_actor_user_id uuid, p_conversation_id uuid,
  p_message_id uuid, p_tool text, p_arguments jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public
SET statement_timeout = '5s'
AS $$
DECLARE
  c public.conversations%ROWTYPE;
  cfg public.ai_configs%ROWTYPE;
  m public.messages%ROWTYPE;
  r public.ai_tool_requests%ROWTYPE;
  d public.deals%ROWTYPE;
  n integer;
  pipeline uuid;
  stage uuid;
  agent uuid;
  notification_recorded boolean := false;
  out_result jsonb;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' OR NOT EXISTS (
    SELECT 1 FROM public.profiles p JOIN public.whatsapp_config w
      ON w.account_id = p.account_id AND w.user_id = p.user_id
    WHERE p.account_id = p_account_id AND p.user_id = p_actor_user_id
      AND p.account_role IN ('owner', 'admin', 'agent')
  ) THEN RAISE EXCEPTION 'Tool context denied' USING ERRCODE = '42501'; END IF;

  SELECT * INTO c FROM public.conversations
    WHERE id = p_conversation_id AND account_id = p_account_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Conversation unavailable' USING ERRCODE = '42501'; END IF;
  -- Contact lock serializes this tool across multiple conversations for one customer.
  PERFORM 1 FROM public.contacts WHERE id = c.contact_id AND account_id = p_account_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Customer unavailable' USING ERRCODE = '42501'; END IF;
  SELECT * INTO m FROM public.messages WHERE conversation_id = c.id
    AND sender_type = 'customer' ORDER BY created_at DESC, id DESC LIMIT 1;
  IF m.id IS NULL OR m.id IS DISTINCT FROM p_message_id OR m.content_type IS DISTINCT FROM 'text' THEN
    RAISE EXCEPTION 'Stale customer turn' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO cfg FROM public.ai_configs WHERE account_id = p_account_id;
  IF NOT FOUND OR NOT cfg.is_active OR NOT cfg.auto_reply_enabled
    OR c.assigned_agent_id IS NOT NULL OR c.ai_autoreply_disabled
    OR c.ai_reply_count >= cfg.auto_reply_max_per_conversation
    OR EXISTS (SELECT 1 FROM public.automations WHERE account_id = p_account_id
      AND is_active AND trigger_type IN ('new_message_received', 'keyword_match')) THEN
    RAISE EXCEPTION 'AI action not eligible' USING ERRCODE = '42501';
  END IF;
  IF p_arguments IS NULL OR jsonb_typeof(p_arguments) <> 'object' THEN
    RAISE EXCEPTION 'Invalid arguments' USING ERRCODE = '22023';
  END IF;

  IF p_tool = 'confirm' THEN
    -- Confirmation is derived from the actual latest inbound, never a model field.
    IF p_arguments <> '{}'::jsonb OR btrim(m.content_text) !~* '^CONFIRM [a-f0-9]{12}$' THEN
      RAISE EXCEPTION 'Confirmation required' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO r FROM public.ai_tool_requests WHERE account_id = p_account_id
      AND conversation_id = c.id AND contact_id = c.contact_id
      AND confirmation_code = lower(substr(btrim(m.content_text), 9))
      AND tool IN ('create_lead', 'update_lead') FOR UPDATE;
    IF NOT FOUND OR r.expires_at < now() THEN
      RETURN jsonb_build_object('status', 'confirmation_expired');
    END IF;
    IF r.result IS NOT NULL THEN RETURN r.result; END IF;
    -- Never choose between multiple active deals, including inconsistent legacy rows.
    SELECT count(*) INTO n FROM public.deals WHERE account_id = p_account_id
      AND contact_id = c.contact_id AND status = 'open';
    IF n > 1 THEN RETURN jsonb_build_object('status', 'ambiguous_deal'); END IF;
    SELECT * INTO d FROM public.deals WHERE account_id = p_account_id
      AND contact_id = c.contact_id AND status = 'open' FOR UPDATE;
    IF d.id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.pipelines p JOIN public.pipeline_stages s ON s.pipeline_id = p.id
      WHERE p.id = d.pipeline_id AND p.account_id = p_account_id AND s.id = d.stage_id
    ) THEN RAISE EXCEPTION 'Deal relationship denied' USING ERRCODE = '42501'; END IF;
    IF r.tool = 'create_lead' THEN
      IF d.id IS NOT NULL THEN
        out_result := jsonb_build_object('status', 'already_exists');
      ELSE
        SELECT count(*) INTO n FROM public.pipelines WHERE account_id = p_account_id;
        IF n <> 1 THEN RETURN jsonb_build_object('status', 'pipeline_configuration_required'); END IF;
        SELECT id INTO pipeline FROM public.pipelines WHERE account_id = p_account_id;
        SELECT id INTO stage FROM public.pipeline_stages WHERE pipeline_id = pipeline ORDER BY position, id LIMIT 1;
        IF stage IS NULL THEN RETURN jsonb_build_object('status', 'pipeline_configuration_required'); END IF;
        INSERT INTO public.deals(account_id, user_id, pipeline_id, stage_id, contact_id,
          conversation_id, title, notes, currency, status)
        SELECT p_account_id, p_actor_user_id, pipeline, stage, c.contact_id, c.id,
          r.arguments->>'title', r.arguments->>'notes', default_currency, 'open'
        FROM public.accounts WHERE id = p_account_id RETURNING * INTO d;
        IF d.id IS NULL THEN RAISE EXCEPTION 'Deal insert failed'; END IF;
        out_result := jsonb_build_object('status', 'created');
      END IF;
    ELSE
      IF d.id IS NULL THEN RETURN jsonb_build_object('status', 'deal_not_found'); END IF;
      UPDATE public.deals SET notes = r.arguments->>'notes', updated_at = now()
        WHERE id = d.id AND account_id = p_account_id AND contact_id = c.contact_id
        RETURNING * INTO d;
      IF d.id IS NULL THEN RAISE EXCEPTION 'Deal update failed'; END IF;
      out_result := jsonb_build_object('status', 'updated');
    END IF;
    UPDATE public.ai_tool_requests SET result = out_result WHERE id = r.id;
    RETURN out_result;
  END IF;

  IF p_tool NOT IN ('create_lead', 'update_lead', 'notify_human') OR p_tool IS NULL THEN
    RAISE EXCEPTION 'Unknown tool' USING ERRCODE = '22023';
  END IF;
  IF p_tool = 'create_lead' THEN
    IF (p_arguments - 'title' - 'notes') <> '{}'::jsonb
      OR jsonb_typeof(p_arguments->'title') IS DISTINCT FROM 'string'
      OR length(btrim(p_arguments->>'title')) NOT BETWEEN 1 AND 200
      OR (p_arguments ? 'notes' AND (jsonb_typeof(p_arguments->'notes') <> 'string'
        OR length(p_arguments->>'notes') > 1000)) THEN
      RAISE EXCEPTION 'Invalid deal arguments' USING ERRCODE = '22023';
    END IF;
  ELSIF p_tool = 'update_lead' THEN
    IF (p_arguments - 'notes') <> '{}'::jsonb
      OR jsonb_typeof(p_arguments->'notes') IS DISTINCT FROM 'string'
      OR length(btrim(p_arguments->>'notes')) NOT BETWEEN 1 AND 1000 THEN
      RAISE EXCEPTION 'Invalid deal arguments' USING ERRCODE = '22023';
    END IF;
  ELSIF p_arguments <> '{}'::jsonb THEN
    RAISE EXCEPTION 'Invalid handoff arguments' USING ERRCODE = '22023';
  END IF;

  -- Do not copy model/system/knowledge text into CRM. Proposed fields must quote
  -- an actual customer turn; the customer still approves the exact preview.
  IF p_tool IN ('create_lead', 'update_lead') AND EXISTS (
    SELECT 1 FROM jsonb_each_text(p_arguments) a WHERE NOT EXISTS (
      SELECT 1 FROM public.messages msg WHERE msg.conversation_id = c.id
        AND msg.sender_type = 'customer' AND msg.content_type = 'text'
        AND strpos(msg.content_text, a.value) > 0
    )
  ) THEN RAISE EXCEPTION 'Customer evidence required' USING ERRCODE = '22023'; END IF;

  SELECT * INTO r FROM public.ai_tool_requests WHERE conversation_id = c.id
    AND message_id = m.id AND tool = p_tool;
  IF FOUND THEN
    IF r.result IS NOT NULL THEN RETURN r.result; END IF;
  ELSE
    INSERT INTO public.ai_tool_requests(account_id, conversation_id, contact_id, message_id, tool, arguments)
      VALUES(p_account_id, c.id, c.contact_id, m.id, p_tool, p_arguments) RETURNING * INTO r;
  END IF;
  IF p_tool <> 'notify_human' THEN
    RETURN jsonb_build_object('status', 'confirmation_required', 'tool', r.tool,
      'arguments', r.arguments, 'code', r.confirmation_code);
  END IF;

  IF cfg.handoff_agent_id IS NOT NULL THEN
    SELECT user_id INTO agent FROM public.profiles WHERE account_id = p_account_id
      AND user_id = cfg.handoff_agent_id AND account_role IN ('owner', 'admin', 'agent');
    IF agent IS NULL THEN RAISE EXCEPTION 'Handoff assignee unavailable' USING ERRCODE = '42501'; END IF;
  END IF;
  UPDATE public.conversations SET ai_autoreply_disabled = true,
    ai_handoff_summary = 'AI requested human support.', assigned_agent_id = agent
    WHERE id = c.id AND account_id = p_account_id AND assigned_agent_id IS NULL
    RETURNING * INTO c;
  IF c.id IS NULL THEN RAISE EXCEPTION 'Assignment failed'; END IF;
  -- The existing trigger may swallow errors. A recorded row is not human delivery.
  SELECT EXISTS (SELECT 1 FROM public.notifications WHERE account_id = p_account_id
    AND conversation_id = c.id AND user_id = agent AND created_at >= transaction_timestamp())
    INTO notification_recorded;
  out_result := jsonb_build_object('status', 'handed_off',
    'assignment', CASE WHEN agent IS NULL THEN 'shared_queue' ELSE 'assigned' END,
    'notification', CASE WHEN notification_recorded THEN 'recorded' ELSE 'unconfirmed' END,
    'delivery', 'unconfirmed');
  UPDATE public.ai_tool_requests SET result = out_result WHERE id = r.id;
  RETURN out_result;
END;
$$;
REVOKE ALL ON FUNCTION public.ai_business_tool(uuid, uuid, uuid, uuid, text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_business_tool(uuid, uuid, uuid, uuid, text, jsonb) TO service_role;
COMMIT;
