CREATE OR REPLACE FUNCTION public.palmyra_close_cash_session(
  p_session_id uuid,
  p_company_id uuid,
  p_closed_at timestamptz,
  p_physical_cash numeric,
  p_expected_cash numeric,
  p_difference numeric,
  p_notes text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_auth uuid := auth.uid();
  v_row public.cash_sessions%rowtype;
  v_employee_can_close boolean := false;
BEGIN
  IF v_auth IS NULL THEN
    RAISE EXCEPTION 'authentication_required';
  END IF;

  IF NOT private.has_company_access(p_company_id) THEN
    RAISE EXCEPTION 'company_access_denied';
  END IF;

  SELECT *
    INTO v_row
    FROM public.cash_sessions
   WHERE id = p_session_id
     AND company_id = p_company_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'cash_session_not_found';
  END IF;

  IF v_row.status = 'closed' THEN
    RETURN jsonb_build_object('success', true, 'already_closed', true, 'settlement_id', null);
  END IF;

  /*
   * A POS employee can be authenticated through the company account while
   * selecting an employee profile/PIN in the POS. In that case auth.uid()
   * belongs to the account that opened the shift, while the permission is
   * attached to cash_sessions.employee_id -> employees.role_id.
   * Only allow this fallback for the same authenticated opener and an active
   * employee whose assigned role explicitly grants cash.close.
   */
  IF v_row.employee_id IS NOT NULL AND v_row.opened_by = v_auth THEN
    SELECT EXISTS (
      SELECT 1
        FROM public.employees e
        JOIN public.roles r ON r.id = e.role_id
        JOIN public.role_permissions rp ON rp.role_id = r.id
        JOIN public.permissions p ON p.id = rp.permission_id
       WHERE e.id = v_row.employee_id
         AND e.company_id = p_company_id
         AND e.active = true
         AND p.key = private.normalize_permission_key('cash.close')
         AND (r.is_system OR r.company_id = p_company_id)
    ) INTO v_employee_can_close;
  END IF;

  IF NOT private.has_permission(p_company_id, 'cash.close')
     AND NOT v_employee_can_close THEN
    RAISE EXCEPTION 'permission_denied';
  END IF;

  IF p_physical_cash IS NULL OR p_physical_cash < 0 THEN
    RAISE EXCEPTION 'invalid_physical_cash';
  END IF;

  UPDATE public.cash_sessions
     SET status = 'closed',
         closed_at = COALESCE(p_closed_at, timezone('utc', now())),
         closed_by = v_auth,
         physical_cash = p_physical_cash,
         expected_cash = p_expected_cash,
         difference = COALESCE(p_difference, 0)
   WHERE id = p_session_id
     AND company_id = p_company_id;

  RETURN jsonb_build_object('success', true, 'already_closed', false, 'settlement_id', null);
END;
$function$;
