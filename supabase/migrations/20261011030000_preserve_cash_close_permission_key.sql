-- Preserve cash.close as its own permission key.
-- Mapping it to settings.manage caused has_permission(company, 'cash.close')
-- to reject roles that explicitly granted cash.close without settings.manage.
CREATE OR REPLACE FUNCTION private.normalize_permission_key(p_key text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path TO 'pg_catalog', 'public', 'private'
AS $function$
  SELECT CASE lower(trim(coalesce(p_key,'')))
    WHEN 'pos.use' THEN 'pos.access'
    WHEN 'pos_access' THEN 'pos.access'
    WHEN 'reports_access' THEN 'reports.view'
    WHEN 'inventory.adjust' THEN 'inventory.manage'
    WHEN 'inventory.transfer' THEN 'inventory.manage'
    WHEN 'cash.open' THEN 'pos.access'
    WHEN 'cash.manage' THEN 'settings.manage'
    WHEN 'sales.refund' THEN 'settings.manage'
    WHEN 'quotes.manage' THEN 'quotes.manage'
    WHEN 'purchases.manage' THEN 'suppliers.manage'
    WHEN 'payroll.manage' THEN 'settings.manage'
    WHEN 'audit.view' THEN 'reports.view'
    ELSE lower(trim(coalesce(p_key,'')))
  END;
$function$;
