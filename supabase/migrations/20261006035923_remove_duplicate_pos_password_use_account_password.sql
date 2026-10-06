-- Keep administrator POS access tied to the PALMYRA account password.
-- The client no longer collects a separate POS password during onboarding.

create or replace function public.verify_pos_access_password(
  p_company_id uuid,
  p_user_id uuid,
  p_password text
) returns boolean
language plpgsql
security definer
set search_path to 'public','private','extensions','pg_temp'
as $function$
declare
  v_user uuid := auth.uid();
  v_hash text;
begin
  if v_user is null then
    raise exception 'authentication_required';
  end if;

  if p_user_id is distinct from v_user then
    return false;
  end if;

  if p_password is null or trim(p_password) = '' then
    return false;
  end if;

  if not exists (
    select 1
      from public.company_memberships cm
     where cm.company_id = p_company_id
       and cm.user_id = v_user
       and cm.status = 'active'
       and (
         cm.is_owner = true
         or exists (
           select 1
             from public.user_roles ur
             join public.roles r on r.id = ur.role_id
            where ur.company_id = cm.company_id
              and ur.user_id = cm.user_id
              and r.key = 'admin'
         )
       )
  ) then
    raise exception 'company_access_denied';
  end if;

  select u.encrypted_password
    into v_hash
    from auth.users u
   where u.id = v_user;

  if v_hash is null then
    return false;
  end if;

  return v_hash = extensions.crypt(trim(p_password), v_hash);
end;
$function$;

drop function if exists public.set_company_owner_pos_password(uuid,text);

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
set search_path to 'public','private','pg_temp'
as $function$
declare
  v_user uuid := auth.uid();
  v_result jsonb;
  v_request_id uuid;
  v_payment_method text := lower(trim(coalesce(p_payment_method,'manual_cash')));
begin
  if v_user is null then
    raise exception 'authentication_required';
  end if;

  if v_payment_method not in ('manual_cash','manual_bank_transfer') then
    raise exception 'invalid_payment_method';
  end if;

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
$function$;

revoke all on function public.verify_pos_access_password(uuid,uuid,text) from public;
grant execute on function public.verify_pos_access_password(uuid,uuid,text) to authenticated;

revoke all on function public.palmyra_onboard_company_with_payment_v2(text,text,character,character,text,text,text,text,text,text,text) from public;
grant execute on function public.palmyra_onboard_company_with_payment_v2(text,text,character,character,text,text,text,text,text,text,text) to authenticated;

alter table public.company_memberships
  drop column if exists pos_password_hash;
