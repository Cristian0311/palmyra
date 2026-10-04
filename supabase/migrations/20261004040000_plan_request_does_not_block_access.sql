-- A plan-change request must not suspend the current company.
-- Access remains on the current subscription until a platform admin approves
-- the requested plan. Approval still replaces the subscription and activates it.

create or replace function public.has_pending_plan_request(p_company_id uuid)
returns boolean
language plpgsql
security definer
set search_path to 'public','private','pg_temp'
as $function$
begin
  if auth.uid() is null then
    raise exception 'authentication_required';
  end if;
  if not exists (
    select 1
    from public.companies c
    where c.id = p_company_id
      and c.active
      and private.has_company_access(c.id)
  ) then
    raise exception 'company_access_denied';
  end if;
  return exists (
    select 1 from public.plan_requests pr
    where pr.company_id = p_company_id and pr.status = 'pending'
  );
end;
$function$;

revoke all on function public.has_pending_plan_request(uuid) from public, anon;
grant execute on function public.has_pending_plan_request(uuid) to authenticated;

create or replace function public.select_company_plan(p_company_id uuid, p_plan_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public','private','pg_temp'
as $function$
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

  select c.* into v_company
  from public.companies c
  where c.id=p_company_id
    and c.active
    and private.has_company_access(c.id)
  limit 1;

  if not found then raise exception 'company_access_denied'; end if;

  select exists(
    select 1 from public.company_memberships cm
    where cm.company_id=p_company_id
      and cm.user_id=v_user
      and cm.status='active'
      and cm.is_owner=true
  ) or v_company.created_by=v_user into v_is_owner;

  if not v_is_owner then raise exception 'owner_required'; end if;

  select * into v_plan from public.plans where id=p_plan_id and active limit 1;
  if not found or v_plan.code='trial' then raise exception 'invalid_plan'; end if;

  select count(*)::int into v_employee_count from public.employees e
    where e.company_id=p_company_id and e.active;
  select count(*)::int into v_warehouse_count from public.warehouses w
    where w.company_id=p_company_id and w.active;
  select count(*)::int into v_product_count from public.products p
    where p.company_id=p_company_id and p.status<>'archived';

  v_employee_limit:=coalesce((v_plan.limits->>'employees')::int,999999);
  v_warehouse_limit:=coalesce((v_plan.limits->>'warehouses')::int,999999);
  v_product_limit:=coalesce((v_plan.limits->>'products')::int,999999);

  if v_warehouse_count>v_warehouse_limit then raise exception 'plan_warehouse_limit'; end if;
  if v_employee_count>v_employee_limit then raise exception 'plan_employee_limit'; end if;
  if v_product_count>v_product_limit then raise exception 'plan_product_limit'; end if;

  select * into v_sub from public.subscriptions
    where company_id=p_company_id order by updated_at desc limit 1;
  v_has_subscription:=v_sub.id is not null;

  if v_plan.code='starter' and not v_has_subscription then
    insert into public.subscriptions(
      company_id,plan_id,status,starts_at,trial_ends_at,
      current_period_start,current_period_end,cancelled_at,updated_at
    )
    values(
      p_company_id,v_plan.id,'trialing',v_now,v_now+interval '90 days',
      v_now,v_now+interval '90 days',null,v_now
    )
    on conflict(company_id) do update set
      plan_id=excluded.plan_id,status='trialing',starts_at=excluded.starts_at,
      trial_ends_at=excluded.trial_ends_at,current_period_start=excluded.current_period_start,
      current_period_end=excluded.current_period_end,cancelled_at=null,updated_at=excluded.updated_at;

    update public.companies set account_status='active',active=true,updated_at=v_now
      where id=p_company_id;

    return jsonb_build_object('status','active','plan_code','starter','trial_ends_at',v_now+interval '90 days');
  end if;

  if v_plan.code='starter' and v_has_subscription then
    insert into public.plan_requests(
      company_id,requested_plan_id,requested_by,status,requested_at,note,
      payment_method,payment_provider
    )
    values(
      p_company_id,v_plan.id,v_user,'pending',v_now,
      'Cambio a Starter; sin nueva prueba gratuita.','manual_cash','manual_cash'
    );

    update public.companies set account_status='active',active=true,updated_at=v_now
      where id=p_company_id;

    return jsonb_build_object('status','pending_payment','plan_code','starter','access_status','active');
  end if;

  select * into v_request from public.plan_requests pr
    where pr.company_id=p_company_id and pr.status='pending'
    order by pr.requested_at desc limit 1;

  if v_request.id is null then
    insert into public.plan_requests(
      company_id,requested_plan_id,requested_by,whatsapp_phone,status,
      requested_at,payment_method,payment_provider
    )
    values(
      p_company_id,v_plan.id,v_user,'55581669','pending',
      v_now,'manual_cash','manual_cash'
    )
    returning * into v_request;
  else
    update public.plan_requests set
      requested_plan_id=v_plan.id,requested_by=v_user,requested_at=v_now,
      status='pending',note=null,approved_at=null,approved_by=null,
      payment_method='manual_cash',payment_provider='manual_cash'
    where id=v_request.id returning * into v_request;
  end if;

  update public.plan_requests set
    status='cancelled',note='Solicitud sustituida por otra selección de plan.'
  where company_id=p_company_id and status='pending' and id<>v_request.id;

  update public.companies set account_status='active',active=true,updated_at=v_now
    where id=p_company_id;

  return jsonb_build_object(
    'status','pending_payment','plan_code',v_plan.code,'plan_name',v_plan.name,
    'request_id',v_request.id,'payment_method','manual_cash',
    'payment_provider','manual_cash','access_status','active'
  );
end;
$function$;

revoke all on function public.select_company_plan(uuid,uuid) from anon;
grant execute on function public.select_company_plan(uuid,uuid) to authenticated;

create or replace function public.reject_plan_request(p_request_id uuid, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public','private','pg_temp'
as $function$
declare
  v_user uuid:=auth.uid();
  v_company uuid;
  v_now timestamptz:=timezone('utc',now());
  v_sub public.subscriptions%rowtype;
  v_should_block boolean:=false;
begin
  if v_user is null
     or not exists(select 1 from public.platform_admins pa where pa.user_id=v_user)
  then raise exception 'permission_denied'; end if;

  update public.plan_requests
    set status='rejected',approved_at=v_now,approved_by=v_user,
        note=left(nullif(trim(p_note),''),500)
  where id=p_request_id and status='pending'
  returning company_id into v_company;

  if v_company is null then raise exception 'plan_request_not_found'; end if;

  select * into v_sub from public.subscriptions
    where company_id=v_company order by updated_at desc limit 1;

  v_should_block :=
    (v_sub.status='trialing' and v_sub.trial_ends_at is not null and v_sub.trial_ends_at<=v_now)
    or
    (v_sub.status='active' and v_sub.current_period_end is not null and v_sub.current_period_end<=v_now);

  update public.companies
    set account_status=case when v_should_block then 'pending_payment' else 'active' end,
        active=true,updated_at=v_now
  where id=v_company;

  return jsonb_build_object(
    'ok',true,'company_id',v_company,
    'access_status',case when v_should_block then 'pending_payment' else 'active' end
  );
end;
$function$;

revoke all on function public.reject_plan_request(uuid,text) from anon;
grant execute on function public.reject_plan_request(uuid,text) to authenticated;

