-- Fix invitation acceptance: pgcrypto is installed in the extensions schema,
-- which is not included in accept_company_invitation's previous search_path.
-- Qualify digest explicitly to avoid "function digest(text, text) does not exist".
CREATE OR REPLACE FUNCTION public.accept_company_invitation(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'private', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_hash text;
  v public.company_invitations%rowtype;
  wid uuid;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'authentication_required';
  END IF;
  IF p_token IS NULL OR length(trim(p_token)) < 16 THEN
    RAISE EXCEPTION 'invitation_invalid_or_expired';
  END IF;

  v_hash := encode(extensions.digest(trim(p_token), 'sha256'), 'hex');

  SELECT *
  INTO v
  FROM public.company_invitations
  WHERE token_hash = v_hash
    AND status = 'pending'
    AND expires_at > timezone('utc', now())
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'invitation_invalid_or_expired';
  END IF;

  IF lower(coalesce(auth.jwt()->>'email', '')) <> lower(v.email) THEN
    RAISE EXCEPTION 'invitation_email_mismatch';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.company_memberships WHERE user_id = v_user
  ) THEN
    RAISE EXCEPTION 'company_membership_exists';
  END IF;

  IF v.employee_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.employees e
    WHERE e.id = v.employee_id
      AND e.company_id = v.company_id
      AND e.user_id IS NOT NULL
      AND e.user_id <> v_user
  ) THEN
    RAISE EXCEPTION 'employee_already_linked';
  END IF;

  INSERT INTO public.company_memberships(company_id, user_id, status, is_owner)
  VALUES (v.company_id, v_user, 'active', false);

  INSERT INTO public.user_roles(user_id, company_id, role_id)
  VALUES (v_user, v.company_id, v.role_id)
  ON CONFLICT (user_id, company_id, role_id) DO NOTHING;

  DELETE FROM public.user_locations
  WHERE user_id = v_user AND company_id = v.company_id;

  FOR wid IN SELECT unnest(v.warehouse_ids)
  LOOP
    INSERT INTO public.user_locations(user_id, company_id, warehouse_id, is_default)
    VALUES (v_user, v.company_id, wid, wid = v.warehouse_ids[1]);
  END LOOP;

  UPDATE public.profiles
  SET active_company_id = v.company_id
  WHERE id = v_user;

  IF v.employee_id IS NOT NULL THEN
    UPDATE public.employees
    SET user_id = v_user,
        login_email = lower(auth.jwt()->>'email'),
        active = true,
        role_id = v.role_id,
        updated_at = timezone('utc', now())
    WHERE id = v.employee_id AND company_id = v.company_id;
  END IF;

  UPDATE public.company_invitations
  SET status = 'accepted',
      accepted_by = v_user,
      accepted_at = timezone('utc', now()),
      updated_at = timezone('utc', now())
  WHERE id = v.id;

  RETURN jsonb_build_object('company_id', v.company_id, 'employee_id', v.employee_id);
END;
$function$;

-- Migration staging data must never be directly exposed through client roles.
-- Service-role/owner workflows can still access these tables for controlled migration.
ALTER TABLE public.legacy_pos_migration_staging ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.legacy_pos_migration_map ENABLE ROW LEVEL SECURITY;
