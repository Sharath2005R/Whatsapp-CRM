-- Add a distinct follow-up job kind to the existing automation queue.
BEGIN;
-- Quarantine only the exact shipped unsafe preset, never infer identity from its name.
-- Custom workflows need an operator audit; their semantics are not rewritten here.
WITH legacy AS (
  SELECT a.id FROM public.automations a
  WHERE a.trigger_type='new_message_received'
    AND (SELECT count(*) FROM public.automation_steps st WHERE st.automation_id=a.id)=2
    AND EXISTS (SELECT 1 FROM public.automation_steps st WHERE st.automation_id=a.id
      AND st.parent_step_id IS NULL AND st.position=0 AND st.step_type='wait'
      AND st.step_config='{"amount":1,"unit":"days"}'::jsonb)
    AND EXISTS (SELECT 1 FROM public.automation_steps st WHERE st.automation_id=a.id
      AND st.parent_step_id IS NULL AND st.position=1 AND st.step_type='send_message'
      AND st.step_config->>'text'='Just circling back — did you have any other questions for us? Happy to help!')
), disabled AS (
  UPDATE public.automations SET is_active=false WHERE id IN (SELECT id FROM legacy) RETURNING id
)
UPDATE public.automation_pending_executions SET status='failed'
  WHERE automation_id IN (SELECT id FROM disabled) AND status='pending';
ALTER TABLE public.automation_pending_executions
  ADD COLUMN IF NOT EXISTS execution_kind text NOT NULL DEFAULT 'automation',
  ADD COLUMN IF NOT EXISTS conversation_id uuid REFERENCES public.conversations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS followup_config_id uuid,
  ADD COLUMN IF NOT EXISTS followup_config_fingerprint text,
  ADD COLUMN IF NOT EXISTS followup_phone text,
  ADD COLUMN IF NOT EXISTS followup_phone_number_id text,
  ADD COLUMN IF NOT EXISTS followup_provider_message_id text,
  ADD COLUMN IF NOT EXISTS followup_source_message_id uuid,
  ADD COLUMN IF NOT EXISTS followup_reason text,
  ADD COLUMN IF NOT EXISTS claim_token uuid,
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS send_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS failure_reason text,
  ADD COLUMN IF NOT EXISTS usage_month date,
  ADD COLUMN IF NOT EXISTS usage_category text CHECK (usage_category IN ('service','utility')),
  ADD COLUMN IF NOT EXISTS usage_state text;
ALTER TABLE public.automation_pending_executions ALTER COLUMN automation_id DROP NOT NULL;
ALTER TABLE public.automation_pending_executions DROP CONSTRAINT IF EXISTS automation_pending_executions_status_check;
ALTER TABLE public.automation_pending_executions ADD CONSTRAINT automation_pending_executions_status_check
  CHECK (status IN ('pending','running','done','failed','awaiting_confirmation','scheduled','claimed','sending','sent','delivered','cancelled','expired','blocked','unknown'));
ALTER TABLE public.automation_pending_executions DROP CONSTRAINT IF EXISTS pending_execution_kind_check;
ALTER TABLE public.automation_pending_executions ADD CONSTRAINT pending_execution_kind_check CHECK (
  (execution_kind='automation' AND automation_id IS NOT NULL AND status IN ('pending','running','done','failed')) OR
  (execution_kind='followup' AND automation_id IS NULL AND followup_reason IS NOT NULL AND followup_reason IN ('requested_reminder','no_reply')));
CREATE UNIQUE INDEX IF NOT EXISTS followup_source_once ON public.automation_pending_executions(account_id, followup_source_message_id)
  WHERE execution_kind='followup';
CREATE UNIQUE INDEX IF NOT EXISTS followup_one_active_conversation ON public.automation_pending_executions(account_id, conversation_id)
  WHERE execution_kind='followup' AND status IN ('awaiting_confirmation','scheduled','pending','claimed','sending','unknown');
CREATE INDEX IF NOT EXISTS followup_usage_lookup ON public.automation_pending_executions(account_id, usage_month, usage_state)
  WHERE execution_kind='followup';
CREATE INDEX IF NOT EXISTS followup_due ON public.automation_pending_executions(status,run_at)
  WHERE execution_kind='followup';
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS followup_opted_out boolean NOT NULL DEFAULT false;
ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS followup_id uuid UNIQUE REFERENCES public.automation_pending_executions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS outbound_category text CHECK (outbound_category IN ('service','utility','authentication','marketing'));

CREATE TABLE IF NOT EXISTS public.followup_settings (
  account_id uuid PRIMARY KEY REFERENCES public.accounts(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  utility_template_id uuid REFERENCES public.message_templates(id) ON DELETE SET NULL,
  template_language text NOT NULL DEFAULT 'en' CHECK (template_language ~ '^(en|hi|kn)(_[A-Z]{2})?$'),
  template_variables jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(template_variables)='array'
    AND jsonb_array_length(template_variables)<=2 AND template_variables <@ '["customer_name","business_name"]'::jsonb),
  utility_monthly_limit integer NOT NULL DEFAULT 0 CHECK (utility_monthly_limit BETWEEN 0 AND 1000000),
  service_monthly_limit integer NOT NULL DEFAULT 0 CHECK (service_monthly_limit BETWEEN 0 AND 1000000),
  reviewed_customer_reminder boolean NOT NULL DEFAULT false
);
ALTER TABLE public.followup_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS followup_settings_read ON public.followup_settings;
CREATE POLICY followup_settings_read ON public.followup_settings FOR SELECT USING (is_account_member(account_id,'admin'));
DROP POLICY IF EXISTS followup_settings_write ON public.followup_settings;
GRANT SELECT ON public.followup_settings TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.followup_settings FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.followup_settings TO service_role;
REVOKE ALL ON public.automation_pending_executions FROM anon, authenticated;

-- Account usage must survive the legacy queue's ON DELETE CASCADE user FK.
-- Deliberately no FK to the execution or message; one immutable reservation key.
CREATE TABLE public.followup_usage (
  execution_id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  usage_month date NOT NULL,
  category text NOT NULL CHECK (category IN ('service','utility')),
  state text NOT NULL CHECK (state IN ('reserved','accepted','released')),
  phone_number_id text NOT NULL,
  provider_message_id text
);
CREATE INDEX followup_usage_month ON public.followup_usage(account_id,usage_month,category,state);
ALTER TABLE public.followup_usage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.followup_usage FROM anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON public.followup_usage TO service_role;

CREATE OR REPLACE FUNCTION public.followup_config_hash(w public.whatsapp_config)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path=public AS $$
  SELECT md5(concat_ws('|', w.id::text, w.account_id::text, w.user_id::text,
    w.phone_number_id, w.waba_id, w.access_token, w.status));
$$;

CREATE OR REPLACE FUNCTION public.ai_followup_tool(
  p_account_id uuid, p_actor_user_id uuid, p_conversation_id uuid, p_message_id uuid,
  p_tool text, p_arguments jsonb DEFAULT '{}'
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE c public.conversations%ROWTYPE; w public.whatsapp_config%ROWTYPE;
  m public.messages%ROWTYPE; contact public.contacts%ROWTYPE;
  f public.automation_pending_executions%ROWTYPE; delay integer; reason text;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' OR NOT EXISTS (
    SELECT 1 FROM profiles WHERE account_id=p_account_id AND user_id=p_actor_user_id
      AND account_role IN ('owner','admin','agent')) THEN RAISE EXCEPTION 'Unauthorized' USING ERRCODE='42501'; END IF;
  SELECT * INTO c FROM conversations WHERE id=p_conversation_id AND account_id=p_account_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Conversation unavailable' USING ERRCODE='42501'; END IF;
  SELECT * INTO contact FROM contacts WHERE id=c.contact_id AND account_id=p_account_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Customer unavailable' USING ERRCODE='42501'; END IF;
  SELECT * INTO w FROM whatsapp_config WHERE account_id=p_account_id AND user_id=p_actor_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Configuration unavailable' USING ERRCODE='42501'; END IF;
  SELECT * INTO m FROM messages WHERE conversation_id=c.id AND sender_type='customer' ORDER BY created_at DESC,id DESC LIMIT 1;
  IF m.id IS NULL OR m.id IS DISTINCT FROM p_message_id OR m.content_type IS DISTINCT FROM 'text' THEN
    RAISE EXCEPTION 'Stale customer context' USING ERRCODE='42501'; END IF;
  IF p_arguments IS NULL OR jsonb_typeof(p_arguments)<>'object' THEN RAISE EXCEPTION 'Invalid arguments' USING ERRCODE='22023'; END IF;
  -- A CRM confirmation must still reach migration 043 when no follow-up matches.
  IF p_tool='confirm' AND NOT EXISTS (
    SELECT 1 FROM automation_pending_executions WHERE execution_kind='followup' AND account_id=p_account_id
      AND conversation_id=c.id AND contact_id=contact.id
      AND context->>'confirmation_code'=lower(substr(btrim(m.content_text),9))
  ) THEN RETURN jsonb_build_object('status','followup_not_found'); END IF;
  IF p_tool='cancel_followup' THEN
    IF p_arguments<>'{}'::jsonb THEN RAISE EXCEPTION 'Invalid arguments' USING ERRCODE='22023'; END IF;
    SELECT * INTO f FROM automation_pending_executions WHERE account_id=p_account_id AND conversation_id=c.id
      AND contact_id=contact.id AND execution_kind='followup' ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('status','followup_not_found'); END IF;
    IF f.status IN ('sent','delivered') THEN RETURN jsonb_build_object('status','followup_already_sent'); END IF;
    IF f.status IN ('sending','unknown') THEN RETURN jsonb_build_object('status','followup_in_progress'); END IF;
    IF f.status='cancelled' THEN RETURN jsonb_build_object('status','followup_cancelled'); END IF;
    IF f.status NOT IN ('awaiting_confirmation','scheduled','pending','claimed') THEN RETURN jsonb_build_object('status','followup_not_pending'); END IF;
    UPDATE automation_pending_executions SET status='cancelled',failure_reason='cancelled' WHERE id=f.id;
    RETURN jsonb_build_object('status','followup_cancelled');
  END IF;
  IF c.assigned_agent_id IS NOT NULL OR c.ai_autoreply_disabled OR contact.followup_opted_out OR w.status<>'connected'
    OR NOT EXISTS (SELECT 1 FROM ai_configs WHERE account_id=p_account_id AND is_active AND auto_reply_enabled)
    OR NOT EXISTS (SELECT 1 FROM followup_settings WHERE account_id=p_account_id AND enabled AND reviewed_customer_reminder)
  THEN RETURN jsonb_build_object('status','followup_unavailable'); END IF;
  IF p_tool='confirm' THEN
    IF p_arguments<>'{}'::jsonb OR btrim(m.content_text)!~*'^CONFIRM [a-f0-9]{12}$' THEN RAISE EXCEPTION 'Confirmation required' USING ERRCODE='22023'; END IF;
    SELECT * INTO f FROM automation_pending_executions WHERE execution_kind='followup' AND account_id=p_account_id
      AND conversation_id=c.id AND contact_id=contact.id AND context->>'confirmation_code'=lower(substr(btrim(m.content_text),9)) FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('status','followup_not_found'); END IF;
    IF f.status IN ('scheduled','pending','claimed') THEN RETURN jsonb_build_object('status','followup_scheduled','run_at',f.run_at); END IF;
    IF f.status<>'awaiting_confirmation' OR (f.context->>'confirmation_expires')::timestamptz<now() THEN
      RETURN jsonb_build_object('status','followup_confirmation_expired'); END IF;
    UPDATE automation_pending_executions SET status='scheduled',
      run_at=clock_timestamp()+make_interval(mins=>(context->>'delay_minutes')::integer),
      context=context||jsonb_build_object('baseline_message_at',m.created_at)
      WHERE id=f.id RETURNING * INTO f;
    RETURN jsonb_build_object('status','followup_scheduled','run_at',f.run_at);
  END IF;
  IF p_tool IS DISTINCT FROM 'schedule_followup' OR p_arguments-'delay_minutes'-'reason'<>'{}'::jsonb
    OR jsonb_typeof(p_arguments->'delay_minutes') IS DISTINCT FROM 'number'
    OR (p_arguments->>'delay_minutes')!~'^[0-9]{1,5}$'
    OR jsonb_typeof(p_arguments->'reason') IS DISTINCT FROM 'string'
    OR (p_arguments->>'reason') NOT IN ('requested_reminder','no_reply') THEN
    RAISE EXCEPTION 'Invalid arguments' USING ERRCODE='22023'; END IF;
  delay:=(p_arguments->>'delay_minutes')::integer; reason:=p_arguments->>'reason';
  IF delay NOT BETWEEN 5 AND 43200 THEN RAISE EXCEPTION 'Invalid delay' USING ERRCODE='22023'; END IF;
  UPDATE automation_pending_executions SET status='expired',failure_reason='confirmation_expired'
    WHERE execution_kind='followup' AND account_id=p_account_id AND conversation_id=c.id
      AND status='awaiting_confirmation' AND (context->>'confirmation_expires')::timestamptz<now();
  SELECT * INTO f FROM automation_pending_executions WHERE execution_kind='followup' AND account_id=p_account_id
    AND conversation_id=c.id AND status IN ('awaiting_confirmation','scheduled','pending','claimed','sending','unknown') LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO automation_pending_executions(automation_id,execution_kind,account_id,user_id,contact_id,conversation_id,
      next_step_position,status,run_at,followup_config_id,followup_config_fingerprint,followup_phone,
      followup_source_message_id,followup_phone_number_id,followup_reason,context)
    VALUES(NULL,'followup',p_account_id,p_actor_user_id,contact.id,c.id,0,'awaiting_confirmation',now()+make_interval(mins=>delay),
      w.id,followup_config_hash(w),contact.phone,m.id,w.phone_number_id,reason,
      jsonb_build_object('confirmation_code',substr(replace(gen_random_uuid()::text,'-',''),1,12),
        'confirmation_expires',now()+interval '15 minutes','delay_minutes',delay))
    ON CONFLICT DO NOTHING RETURNING * INTO f;
    IF f.id IS NULL THEN RETURN jsonb_build_object('status','followup_already_pending'); END IF;
  END IF;
  IF f.status='awaiting_confirmation' THEN RETURN jsonb_build_object('status','followup_confirmation_required',
    'code',f.context->>'confirmation_code','delay_minutes',(f.context->>'delay_minutes')::integer,'reason',f.followup_reason); END IF;
  RETURN jsonb_build_object('status','followup_already_pending');
END; $$;

CREATE OR REPLACE FUNCTION public.claim_due_followups(p_limit integer DEFAULT 20)
RETURNS TABLE(id uuid, claim_token uuid) LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
BEGIN
  UPDATE automation_pending_executions q SET status='unknown',failure_reason='provider_outcome_unknown'
    WHERE q.execution_kind='followup' AND q.status='sending' AND q.send_started_at<clock_timestamp()-interval '5 minutes';
  UPDATE automation_pending_executions q SET status='expired',failure_reason='confirmation_expired'
    WHERE q.execution_kind='followup' AND q.status='awaiting_confirmation'
      AND (q.context->>'confirmation_expires')::timestamptz<clock_timestamp();
  UPDATE automation_pending_executions q SET status='pending'
    WHERE q.id IN (SELECT x.id FROM automation_pending_executions x WHERE execution_kind='followup'
      AND status='scheduled' AND run_at<=clock_timestamp() ORDER BY run_at LIMIT least(greatest(p_limit,1),50) FOR UPDATE SKIP LOCKED);
  RETURN QUERY UPDATE automation_pending_executions q SET status='claimed',claimed_at=clock_timestamp(),claim_token=gen_random_uuid()
    WHERE q.id IN (SELECT x.id FROM automation_pending_executions x WHERE execution_kind='followup'
      AND (status='pending' OR (status='claimed' AND claimed_at<clock_timestamp()-interval '5 minutes'))
      ORDER BY run_at LIMIT least(greatest(p_limit,1),50) FOR UPDATE SKIP LOCKED) RETURNING q.id,q.claim_token;
END; $$;

-- The final invocation (p_begin=true) is the irreversible send authorization.
-- Cancellation wins before this transaction; after it, cancellation reports too late.
CREATE OR REPLACE FUNCTION public.followup_attention(p_account_id uuid,p_conversation_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE agent uuid;
BEGIN
  SELECT p.user_id INTO agent FROM profiles p JOIN ai_configs cfg ON cfg.account_id=p.account_id
    AND cfg.handoff_agent_id=p.user_id
    WHERE p.account_id=p_account_id AND p.account_role IN ('owner','admin','agent');
  -- Reuse assignment and its existing notification trigger. Delivery is unconfirmed.
  UPDATE conversations SET ai_autoreply_disabled=true,assigned_agent_id=agent,
    ai_handoff_summary='An automated reminder could not be sent safely. Please review the follow-up queue.'
    WHERE id=p_conversation_id AND account_id=p_account_id AND assigned_agent_id IS NULL AND NOT ai_autoreply_disabled;
END; $$;

CREATE OR REPLACE FUNCTION public.prepare_followup(p_id uuid,p_token uuid,p_begin boolean DEFAULT false,p_snapshot text DEFAULT NULL,p_body text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE f public.automation_pending_executions%ROWTYPE; c public.conversations%ROWTYPE;
  contact public.contacts%ROWTYPE; w public.whatsapp_config%ROWTYPE; s public.followup_settings%ROWTYPE;
  t public.message_templates%ROWTYPE; last_inbound timestamptz; v_category text; snapshot text;
  reason text; allowance integer; used integer; month date; payload jsonb;
BEGIN
  SELECT * INTO f FROM automation_pending_executions WHERE id=p_id AND execution_kind='followup' FOR UPDATE;
  IF NOT FOUND OR f.status<>'claimed' OR f.claim_token IS DISTINCT FROM p_token THEN RETURN jsonb_build_object('status','not_claimed'); END IF;
  SELECT * INTO c FROM conversations WHERE id=f.conversation_id AND account_id=f.account_id FOR SHARE;
  SELECT * INTO contact FROM contacts WHERE id=f.contact_id AND account_id=f.account_id FOR SHARE;
  SELECT * INTO w FROM whatsapp_config WHERE id=f.followup_config_id AND account_id=f.account_id FOR SHARE;
  SELECT * INTO s FROM followup_settings WHERE account_id=f.account_id FOR UPDATE;
  IF c.id IS NULL OR contact.id IS NULL OR c.contact_id IS DISTINCT FROM contact.id THEN reason:='failed_ownership';
  ELSIF w.id IS NULL OR w.status<>'connected' OR followup_config_hash(w) IS DISTINCT FROM f.followup_config_fingerprint
    OR contact.phone IS DISTINCT FROM f.followup_phone THEN reason:='failed_configuration';
  ELSIF c.assigned_agent_id IS NOT NULL OR c.ai_autoreply_disabled THEN reason:='skipped_human_handoff';
  ELSIF contact.followup_opted_out THEN reason:='skipped_opted_out';
  ELSIF s.account_id IS NULL OR NOT s.enabled OR NOT s.reviewed_customer_reminder THEN reason:='failed_configuration';
  ELSIF NOT EXISTS (SELECT 1 FROM profiles WHERE account_id=f.account_id AND user_id=f.user_id AND account_role IN ('owner','admin','agent'))
    OR NOT EXISTS (SELECT 1 FROM ai_configs WHERE account_id=f.account_id AND is_active AND auto_reply_enabled)
    THEN reason:='failed_configuration';
  ELSIF EXISTS (SELECT 1 FROM automations WHERE account_id=f.account_id AND is_active AND trigger_type IN ('new_message_received','keyword_match'))
    OR EXISTS (SELECT 1 FROM flow_runs WHERE account_id=f.account_id AND conversation_id=c.id AND status='active')
    THEN reason:='skipped_automation_ownership';
  ELSIF f.run_at<clock_timestamp()-interval '24 hours' THEN reason:='expired';
  END IF;
  SELECT max(created_at) INTO last_inbound FROM messages WHERE conversation_id=f.conversation_id AND sender_type='customer';
  IF reason IS NULL AND (last_inbound IS NULL OR last_inbound>clock_timestamp()+interval '1 minute') THEN reason:='failed_configuration'; END IF;
  IF reason IS NULL AND f.followup_reason='no_reply' AND last_inbound>(f.context->>'baseline_message_at')::timestamptz THEN reason:='skipped_customer_replied'; END IF;
  v_category:=CASE WHEN last_inbound>clock_timestamp()-interval '24 hours'+interval '30 seconds' THEN 'service' ELSE 'utility' END;
  IF reason IS NULL AND v_category='utility' THEN
    SELECT * INTO t FROM message_templates WHERE id=s.utility_template_id AND account_id=f.account_id;
    IF t.id IS NULL THEN reason:='blocked_template_missing';
    ELSIF t.status<>'APPROVED' OR t.category<>'Utility' OR t.meta_template_id IS NULL
      OR t.language IS DISTINCT FROM s.template_language THEN reason:='blocked_template_invalid'; END IF;
  END IF;
  IF reason IS NOT NULL THEN
    UPDATE automation_pending_executions SET status=CASE WHEN reason LIKE 'skipped_%' THEN 'cancelled' WHEN reason='expired' THEN 'expired' ELSE 'blocked' END,
      failure_reason=reason WHERE id=f.id;
    IF reason LIKE 'blocked_%' OR reason='failed_configuration' THEN
      PERFORM followup_attention(f.account_id,f.conversation_id);
    END IF;
    RETURN jsonb_build_object('status','blocked','reason',reason);
  END IF;
  payload:=jsonb_build_object('category',v_category,'to',contact.phone,'customer_name',contact.name,
    'business_name',(SELECT name FROM accounts WHERE id=f.account_id),'phone_number_id',w.phone_number_id,'waba_id',w.waba_id,
    'language',s.template_language,'template',CASE WHEN v_category='utility' THEN to_jsonb(t) ELSE NULL END,
    'variables',s.template_variables);
  snapshot:=md5(payload::text||followup_config_hash(w));
  IF NOT p_begin THEN RETURN jsonb_build_object('status','ready','snapshot',snapshot,'payload',payload,'access_token',w.access_token); END IF;
  IF snapshot IS DISTINCT FROM p_snapshot OR p_body IS NULL OR length(p_body) NOT BETWEEN 1 AND 4096 THEN
    UPDATE automation_pending_executions SET status='blocked',failure_reason='failed_preparation_changed' WHERE id=f.id;
    RETURN jsonb_build_object('status','blocked'); END IF;
  month:=date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC')::date;
  allowance:=CASE WHEN v_category='utility' THEN s.utility_monthly_limit ELSE s.service_monthly_limit END;
  SELECT count(*) INTO used FROM followup_usage u
    WHERE u.account_id=f.account_id AND u.usage_month=month
      AND u.state IN ('reserved','accepted') AND u.category=v_category;
  IF used>=allowance THEN
    UPDATE automation_pending_executions SET status='blocked',failure_reason='blocked_quota_exceeded' WHERE id=f.id;
    PERFORM followup_attention(f.account_id,f.conversation_id);
    RETURN jsonb_build_object('status','blocked','reason','blocked_quota_exceeded'); END IF;
  INSERT INTO messages(conversation_id,sender_type,content_type,content_text,template_name,status,followup_id,outbound_category,ai_generated)
    VALUES(c.id,'bot',CASE WHEN v_category='utility' THEN 'template' ELSE 'text' END,p_body,
      CASE WHEN v_category='utility' THEN t.name ELSE NULL END,'sending',f.id,v_category,true);
  INSERT INTO followup_usage(execution_id,account_id,usage_month,category,state,phone_number_id)
    VALUES(f.id,f.account_id,month,v_category,'reserved',w.phone_number_id);
  UPDATE automation_pending_executions SET status='sending',send_started_at=clock_timestamp(),usage_month=month,usage_category=v_category,usage_state='reserved' WHERE id=f.id;
  RETURN jsonb_build_object('status','authorized','access_token',w.access_token);
END; $$;

CREATE OR REPLACE FUNCTION public.finish_followup(p_id uuid,p_token uuid,p_outcome text,p_provider_id text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE f public.automation_pending_executions%ROWTYPE;
BEGIN
  SELECT * INTO f FROM automation_pending_executions WHERE id=p_id AND execution_kind='followup' FOR UPDATE;
  IF NOT FOUND OR f.claim_token IS DISTINCT FROM p_token THEN RETURN false; END IF;
  IF f.status IN ('sent','delivered') THEN RETURN true; END IF;
  IF f.status NOT IN ('claimed','sending','unknown') THEN RETURN false; END IF;
  IF p_outcome='accepted' AND p_provider_id IS NOT NULL AND length(p_provider_id) BETWEEN 1 AND 512 THEN
    UPDATE followup_usage SET state='accepted',provider_message_id=p_provider_id WHERE execution_id=f.id AND account_id=f.account_id;
    UPDATE messages SET message_id=p_provider_id,status=CASE WHEN status IN ('delivered','read') THEN status ELSE 'sent' END WHERE followup_id=f.id;
    UPDATE automation_pending_executions SET status='sent',usage_state='accepted',failure_reason=NULL,
      followup_provider_message_id=p_provider_id WHERE id=f.id;
    UPDATE conversations SET last_message_text=(SELECT content_text FROM messages WHERE followup_id=f.id),
      last_message_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=f.conversation_id AND account_id=f.account_id;
  ELSIF p_outcome='rejected' AND f.status='sending' THEN
    UPDATE followup_usage SET state='released' WHERE execution_id=f.id AND account_id=f.account_id AND state='reserved';
    UPDATE messages SET status='failed' WHERE followup_id=f.id AND message_id IS NULL;
    UPDATE automation_pending_executions SET status='failed',failure_reason='failed_provider',usage_state='released' WHERE id=f.id;
  ELSIF p_outcome='preparation_failed' AND f.status='claimed' THEN
    UPDATE automation_pending_executions SET status='blocked',failure_reason='failed_configuration' WHERE id=f.id;
    PERFORM followup_attention(f.account_id,f.conversation_id);
  ELSE
    UPDATE automation_pending_executions SET status='unknown',failure_reason='provider_outcome_unknown' WHERE id=f.id;
  END IF;
  RETURN true;
END; $$;

CREATE OR REPLACE FUNCTION public.followup_delivery_status(p_phone_number_id text,p_provider_id text,p_followup_id uuid,p_status text)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE f public.automation_pending_executions%ROWTYPE; msg public.messages%ROWTYPE;
BEGIN
  SELECT q.* INTO f FROM automation_pending_executions q LEFT JOIN messages m ON m.followup_id=q.id
    WHERE q.execution_kind='followup' AND q.status IN ('sending','unknown','sent','delivered','failed')
      AND (q.id=p_followup_id OR (p_followup_id IS NULL AND q.followup_provider_message_id=p_provider_id))
      AND q.followup_phone_number_id=p_phone_number_id
    FOR UPDATE OF q;
  IF p_status IS NULL OR p_status NOT IN ('sent','delivered','read','failed') OR p_provider_id IS NULL THEN RETURN false; END IF;
  IF NOT FOUND THEN
    -- Account usage remains reconcilable if a user/conversation was deleted.
    UPDATE followup_usage SET state='accepted',provider_message_id=p_provider_id
      WHERE phone_number_id=p_phone_number_id
        AND (execution_id=p_followup_id OR (p_followup_id IS NULL AND provider_message_id=p_provider_id))
        AND (provider_message_id IS NULL OR provider_message_id=p_provider_id);
    RETURN FOUND;
  END IF;
  SELECT * INTO msg FROM messages WHERE followup_id=f.id FOR UPDATE;
  IF NOT FOUND THEN
    UPDATE followup_usage SET state='accepted',provider_message_id=p_provider_id
      WHERE execution_id=f.id AND account_id=f.account_id AND (provider_message_id IS NULL OR provider_message_id=p_provider_id);
    RETURN FOUND;
  END IF;
  IF msg.message_id IS NOT NULL AND msg.message_id<>p_provider_id THEN RETURN false; END IF;
  IF msg.status='read' OR (msg.status='delivered' AND p_status<>'read') OR (msg.status='failed' AND f.usage_state='accepted') THEN RETURN true; END IF;
  UPDATE messages SET message_id=p_provider_id,status=p_status WHERE id=msg.id;
  UPDATE followup_usage SET state='accepted',provider_message_id=p_provider_id WHERE execution_id=f.id AND account_id=f.account_id;
  UPDATE automation_pending_executions SET status=CASE WHEN p_status IN ('delivered','read') THEN 'delivered' ELSE p_status END,
    usage_state='accepted',followup_provider_message_id=p_provider_id,
    failure_reason=CASE WHEN p_status='failed' THEN 'failed_delivery' ELSE NULL END WHERE id=f.id;
  RETURN true;
END; $$;

-- Explicit STOP is handled without an LLM. This affects follow-ups only.
CREATE OR REPLACE FUNCTION public.followup_stop_on_inbound() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
BEGIN
  IF NEW.sender_type='customer' AND upper(btrim(NEW.content_text)) IN ('STOP','UNSUBSCRIBE') THEN
    UPDATE contacts contact SET followup_opted_out=true FROM conversations c
      WHERE c.id=NEW.conversation_id AND contact.id=c.contact_id AND contact.account_id=c.account_id;
    UPDATE automation_pending_executions SET status='cancelled',failure_reason='skipped_opted_out'
      WHERE execution_kind='followup' AND conversation_id=NEW.conversation_id
        AND status IN ('awaiting_confirmation','scheduled','pending','claimed');
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS followup_stop_on_inbound ON public.messages;
CREATE TRIGGER followup_stop_on_inbound AFTER INSERT ON public.messages FOR EACH ROW EXECUTE FUNCTION public.followup_stop_on_inbound();

-- Existing message RLS permits tenant writes. Protect these new server-only links
-- so a client cannot attach its own message to an unrelated queued execution.
CREATE OR REPLACE FUNCTION public.guard_followup_message() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' AND (
    NEW.followup_id IS NOT NULL OR NEW.outbound_category IS NOT NULL OR
    (TG_OP='UPDATE' AND OLD.followup_id IS NOT NULL)
  ) THEN RAISE EXCEPTION 'Follow-up messages are server managed' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER guard_followup_message BEFORE INSERT OR UPDATE ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.guard_followup_message();

REVOKE ALL ON FUNCTION public.followup_config_hash(public.whatsapp_config) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.followup_attention(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.followup_attention(uuid,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.ai_followup_tool(uuid,uuid,uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.claim_due_followups(integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.prepare_followup(uuid,uuid,boolean,text,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.finish_followup(uuid,uuid,text,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.followup_delivery_status(text,text,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.followup_config_hash(public.whatsapp_config), public.ai_followup_tool(uuid,uuid,uuid,uuid,text,jsonb),
  public.claim_due_followups(integer),public.prepare_followup(uuid,uuid,boolean,text,text),public.finish_followup(uuid,uuid,text,text),
  public.followup_delivery_status(text,text,uuid,text) TO service_role;
COMMIT;
