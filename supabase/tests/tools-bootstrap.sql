-- Extends rag-bootstrap.sql ONLY in an empty, disposable test database.
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE PUBLICATION supabase_realtime;
ALTER TABLE accounts ADD COLUMN default_currency text DEFAULT 'INR';
ALTER TABLE profiles ADD COLUMN full_name text;
ALTER TABLE contacts ADD COLUMN name text, ADD COLUMN company text, ADD COLUMN phone text;
ALTER TABLE conversations ADD COLUMN ai_handoff_summary text;
ALTER TABLE ai_configs ADD COLUMN is_active boolean DEFAULT true,
  ADD COLUMN auto_reply_enabled boolean DEFAULT true,
  ADD COLUMN auto_reply_max_per_conversation integer DEFAULT 20,
  ADD COLUMN handoff_agent_id uuid;
CREATE TABLE whatsapp_config (account_id uuid PRIMARY KEY REFERENCES accounts(id), user_id uuid REFERENCES auth.users(id));
CREATE TABLE messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid REFERENCES conversations(id), sender_type text,
  content_type text DEFAULT 'text', content_text text, created_at timestamptz DEFAULT clock_timestamp());
CREATE TABLE automations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid,
  is_active boolean, trigger_type text);
CREATE TABLE pipelines (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid REFERENCES accounts(id));
CREATE TABLE pipeline_stages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), pipeline_id uuid REFERENCES pipelines(id), position integer DEFAULT 0);
CREATE TABLE deals (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid REFERENCES accounts(id),
  user_id uuid REFERENCES auth.users(id), pipeline_id uuid REFERENCES pipelines(id),
  stage_id uuid REFERENCES pipeline_stages(id), contact_id uuid REFERENCES contacts(id),
  conversation_id uuid REFERENCES conversations(id), title text NOT NULL, notes text,
  currency text, status text DEFAULT 'open', updated_at timestamptz DEFAULT now());
ALTER TABLE deals ENABLE ROW LEVEL SECURITY;
CREATE POLICY deals_select ON deals FOR SELECT USING (is_account_member(account_id));
CREATE POLICY deals_insert ON deals FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'));
CREATE POLICY deals_update ON deals FOR UPDATE USING (is_account_member(account_id, 'agent'));
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
CREATE POLICY contacts_select ON contacts FOR SELECT USING (is_account_member(account_id));
INSERT INTO whatsapp_config SELECT account_id, user_id FROM profiles WHERE account_role = 'admin';
INSERT INTO ai_configs(account_id) SELECT id FROM accounts;
INSERT INTO pipelines SELECT '50000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001';
INSERT INTO pipeline_stages SELECT '60000000-0000-0000-0000-000000000001', id, 0 FROM pipelines;
INSERT INTO conversations(id, account_id, contact_id) VALUES
 ('30000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000002');
UPDATE contacts SET name = 'Asha', company = 'Example', phone = 'private';
