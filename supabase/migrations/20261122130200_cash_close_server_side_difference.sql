begin;

-- Cierre de turno: el descuadre ya no se confía al cliente.
--
-- (aplicada en producción el 2026-11-22; reescrita a partir del pg_get_functiondef real)
--
-- palmyra_close_cash_session (última versión: 20261011024000) escribe
-- expected_cash = p_expected_cash y difference = coalesce(p_difference, 0) tal
-- cual llegan. Cualquier sesión autenticada con cash.close puede cerrar el turno
-- con un expected_cash o un difference arbitrarios, y ese descuadre alimenta
-- reportes, arqueos y nómina. El cliente (src/services/supabaseSync/rpc.ts ->
-- callCloseSessionRPC y cashMutations.ts, que además escribe la fila por tabla)
-- calcula el esperado en local: si el cálculo local es correcto, la validación
-- de abajo no cambia nada; si no, el cierre falla de forma visible.
--
-- Cambios: se deriva difference del par (physical_cash, expected_cash) cuando el
-- esperado viene informado, y se rechaza un descuadre incoherente.
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
  v_difference numeric;
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

  IF p_expected_cash IS NOT NULL AND p_expected_cash < 0 THEN
    RAISE EXCEPTION 'invalid_expected_cash';
  END IF;

  -- Descuadre derivado en servidor; se tolera un céntimo de redondeo.
  IF p_expected_cash IS NULL THEN
    v_difference := COALESCE(p_difference, 0);
  ELSE
    v_difference := ROUND(p_physical_cash - p_expected_cash, 6);

    IF p_difference IS NOT NULL AND ABS(p_difference - v_difference) > 0.01 THEN
      RAISE EXCEPTION 'cash_difference_mismatch';
    END IF;
  END IF;

  UPDATE public.cash_sessions
     SET status = 'closed',
         closed_at = COALESCE(p_closed_at, timezone('utc', now())),
         closed_by = v_auth,
         physical_cash = p_physical_cash,
         expected_cash = p_expected_cash,
         difference = v_difference
   WHERE id = p_session_id
     AND company_id = p_company_id;

  RETURN jsonb_build_object('success', true, 'already_closed', false, 'settlement_id', null);
END;
$function$;

revoke all on function public.palmyra_close_cash_session(uuid, uuid, timestamptz, numeric, numeric, numeric, text)
  from public, anon;
grant execute on function public.palmyra_close_cash_session(uuid, uuid, timestamptz, numeric, numeric, numeric, text)
  to authenticated;

commit;
