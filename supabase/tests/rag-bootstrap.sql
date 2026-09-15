-- Test fixture ONLY, for an empty, disposable Postgres/pgvector container.
-- Not an application migration and not a full Supabase bootstrap.
CREATE SCHEMA auth;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT current_user::text;
$$;
CREATE TABLE auth.users (id uuid PRIMARY KEY);
CREATE TYPE account_role_enum AS ENUM ('owner', 'admin', 'agent', 'viewer');
CREATE TABLE public.accounts (id uuid PRIMARY KEY, name text);
CREATE TABLE public.profiles (user_id uuid PRIMARY KEY REFERENCES auth.users(id),
  account_id uuid REFERENCES accounts(id), account_role account_role_enum);
CREATE TABLE public.contacts (id uuid PRIMARY KEY, account_id uuid REFERENCES accounts(id));
CREATE TABLE public.conversations (id uuid PRIMARY KEY, account_id uuid REFERENCES accounts(id),
  contact_id uuid REFERENCES contacts(id), assigned_agent_id uuid,
  ai_reply_count integer NOT NULL DEFAULT 0, ai_autoreply_disabled boolean NOT NULL DEFAULT false);
CREATE TABLE public.ai_configs (account_id uuid PRIMARY KEY REFERENCES accounts(id));

-- Same membership/role logic as migration 017. JWT identity is simulated through
-- the session claim; the actual knowledge RLS policies come from migration 030.
CREATE FUNCTION is_account_member(target_account_id uuid, min_role account_role_enum DEFAULT 'viewer')
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM profiles p WHERE p.user_id = auth.uid()
    AND p.account_id = target_account_id
    AND CASE p.account_role WHEN 'owner' THEN 4 WHEN 'admin' THEN 3 WHEN 'agent' THEN 2 WHEN 'viewer' THEN 1 END
      >= CASE min_role WHEN 'owner' THEN 4 WHEN 'admin' THEN 3 WHEN 'agent' THEN 2 WHEN 'viewer' THEN 1 END);
$$;
GRANT USAGE ON SCHEMA public, auth TO authenticated, anon, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated, service_role;
INSERT INTO accounts VALUES
 ('00000000-0000-0000-0000-000000000001', 'Business A'),
 ('00000000-0000-0000-0000-000000000002', 'Business B');
INSERT INTO auth.users VALUES
 ('10000000-0000-0000-0000-000000000001'),
 ('10000000-0000-0000-0000-000000000002'),
 ('10000000-0000-0000-0000-000000000003');
INSERT INTO profiles VALUES
 ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'admin'),
 ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000002', 'admin'),
 ('10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 'viewer');
INSERT INTO contacts VALUES
 ('20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001'),
 ('20000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000002');
INSERT INTO conversations(id, account_id, contact_id) VALUES
 ('30000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001');
