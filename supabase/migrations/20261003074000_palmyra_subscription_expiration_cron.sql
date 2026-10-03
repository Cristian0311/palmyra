-- PALMYRA automated subscription expiration
create extension if not exists pg_cron with schema extensions;

create or replace function public.process_subscription_expirations()
returns jsonb
language plpgsql
security definer
set search_path to 'public','private','pg_temp'
as $$
declare
  v_now timestamptz:=timezone('utc',now());
  v_trial integer:=0;
  v_paid integer:=0;
begin
  update public.subscriptions s
  set status='expired',updated_at=v_now
  where s.status='trialing'
    and coalesce(s.trial_ends_at,s.current_period_end)<=v_now;
  get diagnostics v_trial = row_count;

  update public.subscriptions s
  set status='expired',updated_at=v_now
  where s.status='active'
    and s.trial_ends_at is null
    and s.current_period_end<=v_now;
  get diagnostics v_paid = row_count;

  update public.companies c
  set account_status='pending_payment',updated_at=v_now
  where c.account_status='active'
    and exists(
      select 1 from public.subscriptions s
      where s.company_id=c.id
        and s.status='expired'
        and s.updated_at>=v_now-interval '2 minutes'
    );

  return jsonb_build_object(
    'ok',true,'trial_expired',v_trial,'paid_expired',v_paid,'processed_at',v_now
  );
end;
$$;

revoke all on function public.process_subscription_expirations() from public,anon,authenticated;
grant execute on function public.process_subscription_expirations() to service_role;

do $block$
declare v_job_id bigint;
begin
  for v_job_id in select jobid from cron.job where jobname='palmyra-subscription-expiration' loop
    perform cron.unschedule(v_job_id);
  end loop;

  perform cron.schedule(
    'palmyra-subscription-expiration',
    '*/15 * * * *',
    'select public.process_subscription_expirations();'
  );
end
$block$;
