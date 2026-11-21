-- Eliminar una auditoría de inventario (solo si aún no aplicó ajuste).
-- Las auditorías aprobadas se conservan porque sus deltas ya movieron stock.
-- El borrado arrastra las líneas hijas para no dejar huérfanos y es idempotente
-- para que la cola offline pueda reintentarlo sin error.

begin;

create or replace function public.palmyra_delete_audit(p_audit_id uuid, p_company_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'private', 'pg_temp'
as $function$
declare
  v_auth uuid := auth.uid();
  v_row public.inventory_audits%rowtype;
begin
  if v_auth is null then raise exception 'authentication_required'; end if;
  if not private.has_company_access(p_company_id) then raise exception 'company_access_denied'; end if;
  if not private.has_permission(p_company_id, 'inventory.manage') then raise exception 'permission_denied'; end if;

  select * into v_row
  from public.inventory_audits
  where id = p_audit_id and company_id = p_company_id
  for update;

  if not found then
    return jsonb_build_object('success', true, 'already_deleted', true);
  end if;

  if v_row.status = 'approved' then
    raise exception 'audit_already_approved';
  end if;

  delete from public.inventory_audit_items where audit_id = p_audit_id;
  delete from public.inventory_audits where id = p_audit_id and company_id = p_company_id;

  return jsonb_build_object('success', true, 'already_deleted', false);
end;
$function$;

revoke all on function public.palmyra_delete_audit(uuid, uuid) from public, anon;
grant execute on function public.palmyra_delete_audit(uuid, uuid) to authenticated;

notify pgrst, 'reload schema';

commit;
