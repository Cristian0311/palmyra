-- PALMYRA: preserve requested payment method when approving plan requests.
-- Applied directly to production Supabase on 2026-10-05.
-- Idempotent CREATE OR REPLACE; no destructive data operations.

create or replace function public.approve_plan_request(p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'private', 'pg_temp'
as $function$
declare
  v_now timestamptz := timezone('utc', now());
  v_req public.plan_requests%rowtype;
  v_user uuid := auth.uid();
  v_plan public.plans%rowtype;
  v_sub public.subscriptions%rowtype;
  v_invoice text;
  v_payment_id uuid;
  v_payment_method text;
  v_payment_provider text;
begin
  if v_user is null or not exists (select 1 from public.platform_admins where user_id = v_user) then
    raise exception 'permission_denied';
  end if;

  select * into v_req from public.plan_requests
  where id = p_request_id and status = 'pending'
  for update;
  if not found then raise exception 'plan_request_not_found'; end if;

  select * into v_plan from public.plans
  where id = v_req.requested_plan_id and active limit 1;
  if not found or v_plan.code = 'trial' then raise exception 'invalid_paid_plan'; end if;

  v_payment_method := case
    when lower(trim(coalesce(v_req.payment_method, ''))) = 'manual_bank_transfer'
      then 'manual_bank_transfer'
    else 'manual_cash'
  end;

  v_payment_provider := case
    when lower(trim(coalesce(v_req.payment_provider, ''))) = 'manual_bank_transfer'
      then 'manual_bank_transfer'
    else v_payment_method
  end;

  insert into public.subscriptions(
    company_id, plan_id, status, starts_at, trial_ends_at,
    current_period_start, current_period_end, cancelled_at, updated_at
  )
  values(
    v_req.company_id, v_plan.id, 'active', v_now, null,
    v_now, v_now + interval '30 days', null, v_now
  )
  on conflict(company_id) do update set
    plan_id = excluded.plan_id, status = excluded.status,
    starts_at = excluded.starts_at, trial_ends_at = null,
    current_period_start = excluded.current_period_start,
    current_period_end = excluded.current_period_end,
    cancelled_at = null, updated_at = excluded.updated_at
  returning * into v_sub;

  v_invoice := 'PAL-' || to_char(v_now, 'YYYYMM') || '-' ||
    lpad((select count(*) + 1 from public.billing_invoices where company_id = v_req.company_id)::text, 5, '0');

  insert into public.billing_invoices(
    company_id, subscription_id, plan_request_id, invoice_number,
    period_start, period_end, due_at, amount, currency_code, status,
    paid_at, external_reference
  )
  values(
    v_req.company_id, v_sub.id, v_req.id, v_invoice,
    v_now, v_now + interval '30 days', v_now, v_plan.monthly_price,
    v_plan.billing_currency_code, 'paid', v_now,
    v_payment_method || ':plan_request:' || v_req.id
  )
  on conflict(company_id, invoice_number) do nothing;

  insert into public.billing_payments(
    company_id, subscription_id, amount, currency_code, status,
    external_reference, paid_at, payment_method, payment_provider, metadata
  )
  values(
    v_req.company_id, v_sub.id, v_plan.monthly_price,
    v_plan.billing_currency_code, 'paid',
    v_payment_method || ':plan_request:' || v_req.id,
    v_now, v_payment_method, v_payment_provider,
    jsonb_build_object('plan_request_id', v_req.id, 'approved_by', v_user)
  )
  returning id into v_payment_id;

  update public.plan_requests
  set status = 'approved', approved_at = v_now, approved_by = v_user
  where id = v_req.id;

  update public.companies
  set account_status = 'active', active = true, updated_at = v_now
  where id = v_req.company_id;

  return jsonb_build_object(
    'ok', true, 'company_id', v_req.company_id,
    'plan_code', v_plan.code, 'plan_name', v_plan.name,
    'invoice_number', v_invoice, 'payment_id', v_payment_id,
    'payment_method', v_payment_method, 'currency_code', v_plan.billing_currency_code
  );
end;
$function$;
