-- Move a cash session's business date atomically with its linked sales and cash movements.
-- This is an online-only, permission-checked operation; it never replays sale registration.

create or replace function public.palmyra_update_cash_session_business_date(
  p_session_id uuid,
  p_company_id uuid,
  p_new_opened_at timestamptz,
  p_new_business_date date
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'private', 'pg_temp'
as $function$
declare
  v_user uuid := auth.uid();
  v_session record;
  v_delta interval;
  v_sales_updated integer := 0;
  v_movements_updated integer := 0;
  v_warranties_updated integer := 0;
  v_payroll_runs_updated integer := 0;
begin
  if v_user is null then
    raise exception 'authentication_required';
  end if;
  if p_session_id is null or p_company_id is null or p_new_opened_at is null or p_new_business_date is null then
    raise exception 'invalid_cash_session_date';
  end if;
  if not private.has_company_access(p_company_id) then
    raise exception 'company_access_denied';
  end if;
  if not private.has_permission(p_company_id, 'cash.close') then
    raise exception 'permission_denied';
  end if;

  select cs.id, cs.opened_at, cs.closed_at, cr.warehouse_id
  into v_session
  from public.cash_sessions cs
  join public.cash_registers cr on cr.id = cs.cash_register_id
  where cs.id = p_session_id
    and cs.company_id = p_company_id
    and cs.deleted_at is null
  for update of cs;

  if not found then
    raise exception 'cash_session_not_found';
  end if;

  v_delta := p_new_opened_at - v_session.opened_at;

  if v_delta = interval '0 seconds' then
    return jsonb_build_object(
      'success', true, 'id', p_session_id, 'sales_updated', 0,
      'cash_movements_updated', 0, 'warranties_updated', 0, 'payroll_runs_updated', 0, 'already_current', true
    );
  end if;

  update public.cash_sessions
  set opened_at = opened_at + v_delta,
      closed_at = case when closed_at is null then null else closed_at + v_delta end
  where id = p_session_id and company_id = p_company_id;

  -- Link older offline sales without a cash_session_id only when they belong
  -- to this branch and fall inside this session's original time window.
  update public.sales s
  set created_at = s.created_at + v_delta,
      cash_session_id = p_session_id
  where s.company_id = p_company_id
    and (
      s.cash_session_id = p_session_id
      or (
        s.warehouse_id = v_session.warehouse_id
        and s.cash_session_id is null
        and s.created_at >= v_session.opened_at
        and (v_session.closed_at is null or s.created_at <= v_session.closed_at)
      )
    );
  get diagnostics v_sales_updated = row_count;

  update public.cash_movements
  set created_at = created_at + v_delta
  where company_id = p_company_id and cash_session_id = p_session_id;
  get diagnostics v_movements_updated = row_count;

  -- Warranty validity follows the purchase sale; creation timestamps do not.
  update public.warranties w
  set starts_at = case when w.starts_at is null then null else w.starts_at + v_delta end,
      expires_at = case when w.expires_at is null then null else w.expires_at + v_delta end
  where w.company_id = p_company_id
    and w.sale_item_id in (
      select si.id
      from public.sale_items si
      join public.sales s on s.id = si.sale_id
      where s.company_id = p_company_id and s.cash_session_id = p_session_id
    );
  get diagnostics v_warranties_updated = row_count;

  -- Salary settlements are stored as payroll_items whose details.session_id
  -- identifies the cash shift. Keep their one-day payroll period aligned.
  update public.payroll_runs pr
  set period_start = p_new_business_date,
      period_end = p_new_business_date,
      updated_at = timezone('utc', now())
  where pr.company_id = p_company_id
    and pr.id in (
      select distinct pi.payroll_run_id
      from public.payroll_items pi
      where pi.company_id = p_company_id
        and pi.details->>'session_id' = p_session_id::text
    );
  get diagnostics v_payroll_runs_updated = row_count;

  return jsonb_build_object(
    'success', true, 'id', p_session_id,
    'delta_seconds', extract(epoch from v_delta),
    'sales_updated', v_sales_updated,
    'cash_movements_updated', v_movements_updated,
    'warranties_updated', v_warranties_updated,
    'payroll_runs_updated', v_payroll_runs_updated
  );
end;
$function$;

revoke all on function public.palmyra_update_cash_session_business_date(uuid, uuid, timestamptz, date) from public, anon;
grant execute on function public.palmyra_update_cash_session_business_date(uuid, uuid, timestamptz, date) to authenticated;
