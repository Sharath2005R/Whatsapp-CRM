-- Apply after rag-bootstrap.sql and tools-bootstrap.sql in an EMPTY disposable DB only.
ALTER TABLE whatsapp_config ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  ADD COLUMN phone_number_id text DEFAULT '123', ADD COLUMN waba_id text DEFAULT '777',
  ADD COLUMN access_token text DEFAULT 'fixture-cipher', ADD COLUMN status text DEFAULT 'connected';
ALTER TABLE conversations ADD COLUMN last_message_text text, ADD COLUMN last_message_at timestamptz,
  ADD COLUMN updated_at timestamptz DEFAULT now();
ALTER TABLE messages ADD COLUMN message_id text, ADD COLUMN template_name text,
  ADD COLUMN status text DEFAULT 'sent' CHECK (status IN ('sending','sent','delivered','read','failed')),
  ADD COLUMN ai_generated boolean DEFAULT false;
CREATE UNIQUE INDEX messages_provider_once ON messages(conversation_id,message_id) WHERE message_id IS NOT NULL;
CREATE TABLE message_templates(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid REFERENCES accounts(id),
  name text, category text, status text, meta_template_id text, language text,
  body_text text, header_type text, header_content text, buttons jsonb);
CREATE TABLE automation_pending_executions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id uuid NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id), account_id uuid NOT NULL REFERENCES accounts(id),
  contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL, log_id uuid, parent_step_id uuid,
  branch text, next_step_position integer NOT NULL, context jsonb DEFAULT '{}',
  status text NOT NULL CHECK(status IN ('pending','running','done','failed')),
  run_at timestamptz NOT NULL, created_at timestamptz DEFAULT clock_timestamp());
CREATE TABLE automation_steps(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), automation_id uuid REFERENCES automations(id),
  parent_step_id uuid, position integer, step_type text, step_config jsonb);
CREATE TABLE flow_runs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),account_id uuid,conversation_id uuid,status text);
ALTER TABLE automation_pending_executions ENABLE ROW LEVEL SECURITY;
UPDATE contacts SET phone='919876543210';
