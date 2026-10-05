create or replace function public.select_company_plan_with_payment(
  p_company_id uuid,
  p_plan_id uuid,
  p_payment_method text default 'manual_cash'
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $function$
declare
  v_user uuid := auth.uid();
  v_result jsonb;
  v_request_id uuid;
  v_payment_method text := lower(trim(coalesce(p_payment_method,'manual_cash')));
  v_owner boolean := false;
begin
  if v_user is null then
    raise exception 'authentication_required';
  end if;

  select exists(
    select 1
    from public.company_memberships cm
    where cm.company_id = p_company_id
      and cm.user_id = v_user
      and cm.status = 'active'
      and cm.is_owner = true
  ) or exists(
    select 1
    from public.companies c
    where c.id = p_company_id
      and c.active = true
      and c.created_by = v_user
  )
  into v_owner;

  if not coalesce(v_owner, false) then
    raise exception 'owner_required';
  end if;

  if v_payment_method not in ('manual_cash','manual_bank_transfer') then
    raise exception 'invalid_payment_method';
  end if;

  v_result := public.select_company_plan(p_company_id,p_plan_id);

  select pr.id into v_request_id
  from public.plan_requests pr
  where pr.company_id = p_company_id
    and pr.status = 'pending'
  order by pr.requested_at desc
  limit 1;

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

  return v_result || jsonb_build_object('payment_method',v_payment_method);
end;
$function$;
