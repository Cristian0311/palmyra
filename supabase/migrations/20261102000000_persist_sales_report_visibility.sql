-- Persist report visibility per sale so it follows the account across devices.
-- This is deliberately separate from sale status, payments and inventory.
create or replace function public.palmyra_set_sale_report_hidden(
  p_sale_id uuid,
  p_company_id uuid,
  p_hidden boolean
) returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $function$
declare
  v_user uuid := auth.uid();
  v_updated_id uuid;
begin
  if v_user is null then
    raise exception 'authentication_required';
  end if;
  if not private.has_company_access(p_company_id) then
    raise exception 'company_access_denied';
  end if;
  if not private.has_permission(p_company_id, 'reports.view') then
    raise exception 'permission_denied';
  end if;
  if p_sale_id is null or p_hidden is null then
    raise exception 'invalid_report_visibility';
  end if;

  update public.sales
     set metadata = jsonb_set(
       coalesce(metadata, '{}'::jsonb),
       '{report_visibility}',
       jsonb_build_object(
         'hidden', p_hidden,
         'updated_at', timezone('utc', now()),
         'updated_by', v_user
       ),
       true
     )
   where id = p_sale_id
     and company_id = p_company_id
     and status = 'completed'
   returning id into v_updated_id;

  if v_updated_id is null then
    raise exception 'completed_sale_not_found';
  end if;

  return jsonb_build_object('success', true, 'sale_id', v_updated_id, 'hidden', p_hidden);
end;
$function$;

revoke all on function public.palmyra_set_sale_report_hidden(uuid, uuid, boolean) from public, anon;
grant execute on function public.palmyra_set_sale_report_hidden(uuid, uuid, boolean) to authenticated;
