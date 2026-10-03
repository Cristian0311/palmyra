-- PALMYRA restrict plan changes to company owners

create or replace function public.select_company_plan(p_company_id uuid,p_plan_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public','private','pg_temp'
as $$
declare
  v_user uuid:=auth.uid();
  v_plan public.plans%rowtype;
  v_company public.companies%rowtype;
  v_sub public.subscriptions%rowtype;
  v_request public.plan_requests%rowtype;
  v_is_owner boolean:=false;
  v_employee_count integer;
  v_warehouse_count integer;
  v_product_count integer;
  v_product_limit integer;
  v_employee_limit integer;
  v_warehouse_limit integer;
  v_has_subscription boolean;
  v_now timestamptz:=timezone('utc',now());
begin
  if v_user is null then raise exception 'authentication_required'; end if;
  select c.* into v_company from public.companies c
  where c.id=p_company_id and c.active and private.has_company_access(c.id) limit 1;
  if not found then raise exception 'company_access_denied'; end if;

  select exists(
    select 1 from public.company_memberships cm
    where cm.company_id=p_company_id and cm.user_id=v_user and cm.status='active' and cm.is_owner=true
  ) or v_company.created_by=v_user into v_is_owner;
  if not v_is_owner then raise exception 'owner_required'; end if;

  select * into v_plan from public.plans p where p.id=p_plan_id and p.active limit 1;
  if not found or v_plan.code='trial' then raise exception 'invalid_plan'; end if;

  select count(*)::int into v_employee_count from public.employees e where e.company_id=p_company_id and e.active;
  select count(*)::int into v_warehouse_count from public.warehouses w where w.company_id=p_company_id and w.active;
  select count(*)::int into v_product_count from public.products p where p.company_id=p_company_id and p.status<>'archived';

  v_employee_limit:=coalesce((v_plan.limits->>'employees')::int,999999);
  v_warehouse_limit:=coalesce((v_plan.limits->>'warehouses')::int,999999);
  v_product_limit:=coalesce((v_plan.limits->>'products')::int,999999);
  if v_warehouse_count>v_warehouse_limit then raise exception 'plan_warehouse_limit'; end if;
  if v_employee_count>v_employee_limit then raise exception 'plan_employee_limit'; end if;
  if v_product_count>v_product_limit then raise exception 'plan_product_limit'; end if;

  select * into v_sub from public.subscriptions where company_id=p_company_id order by updated_at desc limit 1;
  v_has_subscription:=v_sub.id is not null;

  if v_plan.code='starter' and not v_has_subscription then
    insert into public.subscriptions(company_id,plan_id,status,starts_at,trial_ends_at,current_period_start,current_period_end,cancelled_at,updated_at)
    values(p_company_id,v_plan.id,'trialing',v_now,v_now+interval '90 days',v_now,v_now+interval '90 days',null,v_now)
    on conflict(company_id) do update set
      plan_id=excluded.plan_id,status='trialing',starts_at=excluded.starts_at,trial_ends_at=excluded.trial_ends_at,
      current_period_start=excluded.current_period_start,current_period_end=excluded.current_period_end,
      cancelled_at=null,updated_at=excluded.updated_at;
    update public.companies set account_status='active',active=true,updated_at=v_now where id=p_company_id;
    return jsonb_build_object('status','active','plan_code','starter','trial_ends_at',to_jsonb(v_now+interval '90 days'));
  end if;

  if v_plan.code='starter' and v_has_subscription then
    insert into public.plan_requests(company_id,requested_plan_id,requested_by,status,requested_at,note)
    values(p_company_id,v_plan.id,v_user,'pending',v_now,'Cambio a Starter; sin nueva prueba gratuita.');
    update public.companies set account_status='pending_payment',active=true,updated_at=v_now where id=p_company_id;
    return jsonb_build_object('status','pending_payment','plan_code','starter');
  end if;

  select * into v_request from public.plan_requests pr
  where pr.company_id=p_company_id and pr.status='pending' order by pr.requested_at desc limit 1;

  if v_request.id is null then
    insert into public.plan_requests(company_id,requested_plan_id,requested_by,whatsapp_phone,status,requested_at)
    values(p_company_id,v_plan.id,v_user,'55581669','pending',v_now) returning * into v_request;
  else
    update public.plan_requests
    set requested_plan_id=v_plan.id,requested_by=v_user,requested_at=v_now,status='pending',note=null,approved_at=null,approved_by=null
    where id=v_request.id returning * into v_request;
  end if;

  update public.plan_requests set status='cancelled',note='Solicitud sustituida por otra selección de plan.'
  where company_id=p_company_id and status='pending' and id<>v_request.id;

  update public.companies set account_status='pending_payment',active=true,updated_at=v_now where id=p_company_id;

  return jsonb_build_object('status','pending_payment','plan_code',v_plan.code,'plan_name',v_plan.name,'request_id',v_request.id);
end;
$$;

revoke all on function public.select_company_plan(uuid,uuid) from public,anon;
grant execute on function public.select_company_plan(uuid,uuid) to authenticated;


-- Final billing-aware implementation: requests create an open invoice and use the active cash provider.
create or replace function public.select_company_plan(p_company_id uuid,p_plan_id uuid)
returns jsonb language plpgsql security definer
set search_path to 'public','private','pg_temp'
as $$
declare
  v_user uuid:=auth.uid(); v_plan public.plans%rowtype; v_company public.companies%rowtype;
  v_sub public.subscriptions%rowtype; v_request public.plan_requests%rowtype; v_is_owner boolean:=false;
  v_employee_count integer; v_warehouse_count integer; v_product_count integer;
  v_product_limit integer; v_employee_limit integer; v_warehouse_limit integer;
  v_has_subscription boolean; v_now timestamptz:=timezone('utc',now());
begin
  if v_user is null then raise exception 'authentication_required'; end if;
  select c.* into v_company from public.companies c where c.id=p_company_id and c.active and private.has_company_access(c.id) limit 1;
  if not found then raise exception 'company_access_denied'; end if;
  select exists(select 1 from public.company_memberships cm where cm.company_id=p_company_id and cm.user_id=v_user and cm.status='active' and cm.is_owner=true) or v_company.created_by=v_user into v_is_owner;
  if not v_is_owner then raise exception 'owner_required'; end if;
  select * into v_plan from public.plans p where p.id=p_plan_id and p.active limit 1;
  if not found or v_plan.code='trial' then raise exception 'invalid_plan'; end if;
  select count(*)::int into v_employee_count from public.employees e where e.company_id=p_company_id and e.active;
  select count(*)::int into v_warehouse_count from public.warehouses w where w.company_id=p_company_id and w.active;
  select count(*)::int into v_product_count from public.products p where p.company_id=p_company_id and p.status<>'archived';
  v_employee_limit:=coalesce((v_plan.limits->>'employees')::int,999999);
  v_warehouse_limit:=coalesce((v_plan.limits->>'warehouses')::int,999999);
  v_product_limit:=coalesce((v_plan.limits->>'products')::int,999999);
  if v_warehouse_count>v_warehouse_limit then raise exception 'plan_warehouse_limit'; end if;
  if v_employee_count>v_employee_limit then raise exception 'plan_employee_limit'; end if;
  if v_product_count>v_product_limit then raise exception 'plan_product_limit'; end if;
  select * into v_sub from public.subscriptions where company_id=p_company_id order by updated_at desc limit 1;
  v_has_subscription:=v_sub.id is not null;
  if v_plan.code='starter' and not v_has_subscription then
    insert into public.subscriptions(company_id,plan_id,status,starts_at,trial_ends_at,current_period_start,current_period_end,cancelled_at,updated_at)
    values(p_company_id,v_plan.id,'trialing',v_now,v_now+interval '90 days',v_now,v_now+interval '90 days',null,v_now)
    on conflict(company_id) do update set plan_id=excluded.plan_id,status='trialing',starts_at=excluded.starts_at,trial_ends_at=excluded.trial_ends_at,current_period_start=excluded.current_period_start,current_period_end=excluded.current_period_end,cancelled_at=null,updated_at=excluded.updated_at;
    update public.companies set account_status='active',active=true,updated_at=v_now where id=p_company_id;
    return jsonb_build_object('status','active','plan_code','starter','trial_ends_at',v_now+interval '90 days');
  end if;
  if v_plan.code='starter' and v_has_subscription then
    insert into public.plan_requests(company_id,requested_plan_id,requested_by,status,requested_at,note,payment_method,payment_provider)
    values(p_company_id,v_plan.id,v_user,'pending',v_now,'Cambio a Starter; sin nueva prueba gratuita.','manual_cash','manual_cash') returning * into v_request;
  else
    select * into v_request from public.plan_requests pr where pr.company_id=p_company_id and pr.status='pending' order by pr.requested_at desc limit 1;
    if v_request.id is null then
      insert into public.plan_requests(company_id,requested_plan_id,requested_by,whatsapp_phone,status,requested_at,payment_method,payment_provider)
      values(p_company_id,v_plan.id,v_user,'55581669','pending',v_now,'manual_cash','manual_cash') returning * into v_request;
    else
      update public.plan_requests set requested_plan_id=v_plan.id,requested_by=v_user,requested_at=v_now,status='pending',note=null,approved_at=null,approved_by=null,payment_method='manual_cash',payment_provider='manual_cash' where id=v_request.id returning * into v_request;
    end if;
    update public.plan_requests set status='cancelled',note='Solicitud sustituida por otra selección.' where company_id=p_company_id and status='pending' and id<>v_request.id;
  end if;
  update public.companies set account_status='pending_payment',active=true,updated_at=v_now where id=p_company_id;
  return jsonb_build_object('status','pending_payment','plan_code',v_plan.code,'plan_name',v_plan.name,'request_id',v_request.id,'payment_method','manual_cash','payment_provider','manual_cash','invoice',public.create_open_invoice_for_plan_request(v_request.id));
end;
$$;
revoke all on function public.select_company_plan(uuid,uuid) from public,anon;
grant execute on function public.select_company_plan(uuid,uuid) to authenticated;
