-- PALMYRA final onboarding runtime: one company per account, Cuba defaults, plan billing invoice.

create or replace function public.palmyra_onboard_company(
  p_name text,p_slug text,p_country_code bpchar default 'CU',p_default_currency_code bpchar default 'CUP',
  p_timezone text default 'America/Havana',p_warehouse_name text default 'Almacén principal',
  p_plan_code text default 'starter',p_employee_name text default null,p_employee_code text default null
) returns jsonb
language plpgsql security definer
set search_path to 'public','private','pg_temp'
as $$
declare
  v_user uuid:=auth.uid(); v_company_id uuid; v_warehouse_id uuid; v_employee_id uuid; v_employee_role_id uuid;
  v_plan public.plans%rowtype; v_subscription_id uuid; v_trial_ends timestamptz; v_request_id uuid; v_invoice jsonb;
  v_now timestamptz:=timezone('utc',now()); v_plan_code text:=lower(trim(coalesce(p_plan_code,'starter')));
begin
  if v_user is null then raise exception 'authentication_required'; end if;
  if exists(select 1 from public.company_memberships where user_id=v_user) then raise exception 'company_already_exists'; end if;
  if length(trim(coalesce(p_name,'')))<2 or length(trim(p_name))>160 then raise exception 'invalid_company_name'; end if;
  if lower(trim(coalesce(p_slug,''))) !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' then raise exception 'invalid_company_slug'; end if;
  if not exists(select 1 from public.currencies where code=upper(trim(coalesce(p_default_currency_code,'CUP'))) and active) then raise exception 'invalid_company_currency'; end if;
  if length(trim(coalesce(p_warehouse_name,'')))<2 or length(trim(p_warehouse_name))>120 then raise exception 'invalid_warehouse_name'; end if;
  if v_plan_code not in ('starter','growth','pro') then raise exception 'invalid_plan'; end if;

  select * into v_plan from public.plans where code=v_plan_code and active limit 1;
  if not found then raise exception 'plan_not_available'; end if;

  select (public.create_company_authenticated(
    trim(p_name),lower(trim(p_slug)),upper(coalesce(p_country_code,'CU')),
    upper(coalesce(p_default_currency_code,'CUP')),trim(coalesce(p_timezone,'America/Havana')),
    trim(p_warehouse_name)
  )->>'company_id')::uuid into v_company_id;

  select id into v_warehouse_id from public.warehouses
  where company_id=v_company_id and code='ALM-01' order by created_at asc limit 1;

  if v_plan.code='starter' then
    v_trial_ends:=v_now+interval '90 days';
    insert into public.subscriptions(company_id,plan_id,status,starts_at,trial_ends_at,current_period_start,current_period_end,cancelled_at,updated_at)
    values(v_company_id,v_plan.id,'trialing',v_now,v_trial_ends,v_now,v_trial_ends,null,v_now)
    returning id into v_subscription_id;
    update public.companies set account_status='active',active=true,updated_at=v_now where id=v_company_id;
  else
    insert into public.plan_requests(company_id,requested_plan_id,requested_by,whatsapp_phone,status,requested_at,payment_method,payment_provider)
    values(v_company_id,v_plan.id,v_user,'55581669','pending',v_now,'manual_cash','manual_cash')
    returning id into v_request_id;
    update public.companies set account_status='pending_payment',active=true,updated_at=v_now where id=v_company_id;
    v_invoice:=public.create_open_invoice_for_plan_request(v_request_id);
  end if;

  if p_employee_name is not null and length(trim(p_employee_name))>0 then
    select id into v_employee_role_id from public.roles where company_id is null and key='employee' and is_system limit 1;
    if v_employee_role_id is null then raise exception 'employee_role_not_found'; end if;
  end if;

  if nullif(trim(coalesce(p_employee_name,''))) is not null then
    select (public.create_employee_secure(
      v_company_id,coalesce(nullif(trim(p_employee_code),''),'EMP-001'),
      trim(p_employee_name),0,v_employee_role_id,array[v_warehouse_id]::uuid[]
    )->>'id')::uuid into v_employee_id;
  end if;

  return jsonb_build_object(
    'company_id',v_company_id,'warehouse_id',v_warehouse_id,'employee_id',v_employee_id,
    'subscription_id',v_subscription_id,'plan_code',v_plan.code,'request_id',v_request_id,
    'invoice',v_invoice,'account_status',case when v_plan.code='starter' then 'active' else 'pending_payment' end,
    'trial_ends_at',v_trial_ends
  );
end;
$$;

revoke all on function public.palmyra_onboard_company(text,text,bpchar,bpchar,text,text,text,text,text) from public,anon;
grant execute on function public.palmyra_onboard_company(text,text,bpchar,bpchar,text,text,text,text,text) to authenticated;
