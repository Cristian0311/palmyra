-- PALMYRA subscription lifecycle: two-day grace period.
alter table public.subscriptions
  add column if not exists grace_ends_at timestamptz;

create or replace function public.process_subscription_expirations()
returns jsonb
language plpgsql
security definer
set search_path to 'public','private','pg_temp'
as $$
declare
  v_now timestamptz:=timezone('utc',now());
  v_grace_started integer:=0;
  v_expired integer:=0;
begin
  update public.subscriptions s
  set status='past_due',
      grace_ends_at=coalesce(s.grace_ends_at,coalesce(s.trial_ends_at,s.current_period_end)+interval '2 days'),
      updated_at=v_now
  where s.status in ('trialing','active')
    and coalesce(s.trial_ends_at,s.current_period_end)<=v_now;
  get diagnostics v_grace_started=row_count;

  update public.subscriptions s
  set status='expired',updated_at=v_now
  where s.status='past_due'
    and coalesce(s.grace_ends_at,coalesce(s.trial_ends_at,s.current_period_end)+interval '2 days')<=v_now;
  get diagnostics v_expired=row_count;

  update public.companies c
  set account_status='pending_payment',updated_at=v_now
  where c.account_status='active'
    and exists(
      select 1 from public.subscriptions s
      where s.company_id=c.id
        and s.status='expired'
        and s.updated_at>=v_now-interval '2 minutes'
    );

  return jsonb_build_object('ok',true,'grace_started',v_grace_started,'expired',v_expired,'processed_at',v_now);
end;
$$;

revoke all on function public.process_subscription_expirations() from public,anon,authenticated;
grant execute on function public.process_subscription_expirations() to service_role;
