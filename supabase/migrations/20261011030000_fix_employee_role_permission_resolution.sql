CREATE OR REPLACE FUNCTION private.has_permission(p_company_id uuid, p_permission_key text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'private'
AS $function$
  SELECT
    EXISTS (
      SELECT 1
      FROM public.user_roles ur
      JOIN public.roles r ON r.id = ur.role_id
      JOIN public.role_permissions rp ON rp.role_id = r.id
      JOIN public.permissions p ON p.id = rp.permission_id
      WHERE ur.company_id = p_company_id
        AND ur.user_id = auth.uid()
        AND p.key = private.normalize_permission_key(p_permission_key)
        AND (r.is_system OR r.company_id = p_company_id)
    )
    OR EXISTS (
      SELECT 1
      FROM public.employees e
      JOIN public.roles r ON r.id = e.role_id
      JOIN public.role_permissions rp ON rp.role_id = r.id
      JOIN public.permissions p ON p.id = rp.permission_id
      WHERE e.company_id = p_company_id
        AND e.user_id = auth.uid()
        AND e.active = true
        AND p.key = private.normalize_permission_key(p_permission_key)
        AND (r.is_system OR r.company_id = p_company_id)
    );
$function$;