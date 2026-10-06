alter table public.company_memberships
  add column if not exists pos_password_hash text;

create or replace function public.set_company_owner_pos_password(
  p_company_id uuid,
  p_password text
) returns jsonb
language plpgsql
security definer
set search_path to 'public','private','extensions','pg_temp'
as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then raise exception 'authentication_required'; end if;
  if not private.has_permission(p_company_id,'settings.manage') then raise exception 'permission_denied'; end if;
  if p_password is null or trim(p_password) !~ '^[0-9]{4,8}$' then raise exception 'invalid_pos_password'; end if;

  update public.company_memberships
     set pos_password_hash = extensions.crypt(trim(p_password), extensions.gen_salt('bf',10))
   where company_id = p_company_id
     and user_id = v_user
     and is_owner = true
     and status = 'active';

  if not found then raise exception 'owner_membership_not_found'; end if;
  return jsonb_build_object('ok',true);
end;
$$;

create or replace function public.verify_pos_access_password(
  p_company_id uuid,
  p_user_id uuid,
  p_password text
) returns boolean
language plpgsql
security definer
set search_path to 'public','private','extensions','pg_temp'
as $$
declare v_hash text;
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;

  if not exists (
    select 1 from public.company_memberships
     where company_id = p_company_id
       and user_id = auth.uid()
       and status = 'active'
  ) then
    raise exception 'company_access_denied';
  end if;

  select cm.pos_password_hash into v_hash
  from public.company_memberships cm
  left join public.user_roles ur
    on ur.company_id = cm.company_id and ur.user_id = cm.user_id
  left join public.roles r on r.id = ur.role_id
  where cm.company_id = p_company_id
    and cm.user_id = p_user_id
    and cm.status = 'active'
    and (cm.is_owner = true or r.key = 'admin')
  limit 1;

  if v_hash is null or p_password is null or trim(p_password) = '' then return false; end if;
  return v_hash = extensions.crypt(trim(p_password), v_hash);
end;
$$;

create or replace function public.palmyra_onboard_company_with_payment_v2(
  p_name text,
  p_slug text,
  p_country_code character default 'CU',
  p_default_currency_code character default 'CUP',
  p_timezone text default 'America/Havana',
  p_warehouse_name text default 'Almacén principal',
  p_plan_code text default 'starter',
  p_employee_name text default null,
  p_employee_code text default null,
  p_payment_method text default 'manual_cash',
  p_admin_pos_password text default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public','private','extensions','pg_temp'
as $$
declare
  v_user uuid := auth.uid();
  v_result jsonb;
  v_company_id uuid;
  v_request_id uuid;
  v_payment_method text := lower(trim(coalesce(p_payment_method,'manual_cash')));
begin
  if v_user is null then raise exception 'authentication_required'; end if;
  if p_admin_pos_password is null or trim(p_admin_pos_password) !~ '^[0-9]{4,8}$' then raise exception 'invalid_pos_password'; end if;
  if v_payment_method not in ('manual_cash','manual_bank_transfer') then raise exception 'invalid_payment_method'; end if;

  v_result := public.palmyra_onboard_company(
    p_name,
    p_slug,
    p_country_code,
    p_default_currency_code,
    p_timezone,
    p_warehouse_name,
    p_plan_code,
    p_employee_name,
    p_employee_code
  );

  v_company_id := nullif(v_result->>'company_id','')::uuid;

  update public.company_memberships
     set pos_password_hash = extensions.crypt(trim(p_admin_pos_password), extensions.gen_salt('bf',10))
   where company_id = v_company_id
     and user_id = v_user
     and is_owner = true
     and status = 'active';

  if not found then raise exception 'owner_membership_not_found'; end if;

  v_request_id := nullif(v_result->>'request_id','')::uuid;

  if v_request_id is not null then
    update public.plan_requests
       set payment_method = v_payment_method,
           payment_provider = v_payment_method,
           note = case
             when v_payment_method = 'manual_bank_transfer' then 'Cliente seleccionó transferencia bancaria.'
             else 'Cliente seleccionó pago en efectivo.'
           end
     where id = v_request_id;
  end if;

  return v_result || jsonb_build_object(
    'payment_method',v_payment_method,
    'admin_pos_password_configured',true
  );
end;
$$;

grant execute on function public.verify_pos_access_password(uuid,uuid,text) to authenticated;
grant execute on function public.set_company_owner_pos_password(uuid,text) to authenticated;
grant execute on function public.palmyra_onboard_company_with_payment_v2(text,text,character,character,text,text,text,text,text,text,text) to authenticated;
