-- PALMYRA: keep onboarding's legacy password parameter backward-compatible,
-- but report the real account-password state instead of claiming configuration.
-- Administrator POS access uses the PALMYRA account password; no separate POS
-- password is stored or required.

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
  v_account_password_configured boolean := false;
begin
  if v_user is null then raise exception 'authentication_required'; end if;
  if v_payment_method not in ('manual_cash','manual_bank_transfer') then raise exception 'invalid_payment_method'; end if;

  select u.encrypted_password is not null and length(u.encrypted_password) > 0
    into v_account_password_configured
  from auth.users u
  where u.id=v_user;

  v_result := public.palmyra_onboard_company(
    p_name,p_slug,p_country_code,p_default_currency_code,p_timezone,
    p_warehouse_name,p_plan_code,p_employee_name,p_employee_code
  );

  v_request_id := nullif(v_result->>'request_id','')::uuid;

  if v_request_id is not null then
    update public.plan_requests
       set payment_method=v_payment_method,
           payment_provider=v_payment_method,
           note=case
             when v_payment_method='manual_bank_transfer' then 'Cliente seleccionó transferencia bancaria.'
             else 'Cliente seleccionó pago en efectivo.'
           end
     where id=v_request_id;
  end if;

  return v_result || jsonb_build_object(
    'payment_method',v_payment_method,
    'admin_pos_password_configured',v_account_password_configured
  );
end;
$function$;

revoke all on function public.palmyra_onboard_company_with_payment_v2(text,text,character,character,text,text,text,text,text,text,text) from public,anon;
grant execute on function public.palmyra_onboard_company_with_payment_v2(text,text,character,character,text,text,text,text,text,text,text) to authenticated;
