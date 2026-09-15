-- Scope the atomic claim itself, not only the preceding application read.
-- The legacy RPC is retained for rolling upgrades; new AI dispatch uses this one.
BEGIN;

CREATE OR REPLACE FUNCTION public.claim_ai_reply_slot_for_account(
  p_account_id uuid,
  p_contact_id uuid,
  conversation_id uuid,
  max_replies integer
)
RETURNS boolean
LANGUAGE sql SECURITY INVOKER SET search_path = public
AS $$
  WITH claimed AS (
    UPDATE public.conversations AS c
    SET ai_reply_count = c.ai_reply_count + 1
    WHERE c.id = conversation_id
      AND c.account_id = p_account_id
      AND c.contact_id = p_contact_id
      AND EXISTS (SELECT 1 FROM public.contacts AS contact
                  WHERE contact.id = p_contact_id AND contact.account_id = p_account_id)
      AND c.assigned_agent_id IS NULL
      AND c.ai_autoreply_disabled = false
      AND c.ai_reply_count < max_replies
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM claimed);
$$;

REVOKE ALL ON FUNCTION public.claim_ai_reply_slot_for_account(uuid, uuid, uuid, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_ai_reply_slot_for_account(uuid, uuid, uuid, integer)
  TO service_role;

COMMIT;
