-- PALMYRA POS sync hardening
-- Database migration already applied as:
-- 20261006160805_pos_sync_cash_register_and_sale_hardening
--
-- This repository source keeps the durable cash-register provisioning RPC used
-- by offline POS replay. Sales use UUID remote IDs in the application layer,
-- with legacy queued tickets converted to a UUID before calling the canonical
-- sale RPC.

create or replace function public.ensure_cash_register_secure(
  p_company_id uuid,
  p_warehouse_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, private, pg_temp
as $function$
declare
  v_user uuid := auth.uid();
  v_register uuid;
begin
  if v_user is null then
    raise exception 'authentication_required';
  end if;

  if not private.has_company_access(p_company_id) then
    raise exception 'company_access_denied';
  end if;

  if not (
    private.has_permission(p_company_id,'pos.access')
    or private.has_permission(p_company_id,'cash.open')
    or private.has_permission(p_company_id,'settings.manage')
  ) then
    raise exception 'permission_denied';
  end if;

  if not exists(
    select 1
    from public.warehouses
    where id=p_warehouse_id
      and company_id=p_company_id
      and active
  ) then
    raise exception 'invalid_warehouse';
  end if;

  perform pg_advisory_xact_lock(
    hashtext(p_company_id::text || ':' || p_warehouse_id::text)
  );

  select id
    into v_register
  from public.cash_registers
  where company_id=p_company_id
    and warehouse_id=p_warehouse_id
    and active
  order by id
  limit 1;

  if v_register is not null then
    return v_register;
  end if;

  insert into public.cash_registers(
    id,company_id,warehouse_id,code,name,active
  )
  values(
    gen_random_uuid(),
    p_company_id,
    p_warehouse_id,
    'CAJA-' || upper(left(p_warehouse_id::text,6)),
    'Caja principal',
    true
  )
  returning id into v_register;

  return v_register;
end;
$function$;

revoke all on function public.ensure_cash_register_secure(uuid,uuid)
  from public,anon;
grant execute on function public.ensure_cash_register_secure(uuid,uuid)
  to authenticated;
