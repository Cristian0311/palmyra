-- PALMYRA SaaS account, device and billing reconciliation

-- One authenticated SaaS account may belong to exactly one company.
create unique index if not exists company_memberships_one_company_per_user_uidx on public.company_memberships(user_id);

-- Direct company creation is no longer a client API; only the onboarding RPC calls it internally.
revoke all on function public.create_company_authenticated(text,text,bpchar,bpchar,text,text) from public,anon,authenticated;
grant execute on function public.create_company_authenticated(text,text,bpchar,bpchar,text,text) to service_role;

-- POS settings are stored independently from any public web catalog.
create table if not exists public.company_settings (
  company_id uuid primary key references public.companies(id) on delete cascade,
  settings jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default timezone('utc',now())
);
alter table public.company_settings enable row level security;
drop policy if exists company_settings_select on public.company_settings;
create policy company_settings_select on public.company_settings for select to authenticated using (private.has_company_access(company_id));
drop policy if exists company_settings_insert on public.company_settings;
create policy company_settings_insert on public.company_settings for insert to authenticated with check (private.has_permission(company_id,'settings.manage'));
drop policy if exists company_settings_update on public.company_settings;
create policy company_settings_update on public.company_settings for update to authenticated using (private.has_permission(company_id,'settings.manage')) with check (private.has_permission(company_id,'settings.manage'));
revoke all on public.company_settings from anon;
grant select,insert,update on public.company_settings to authenticated;

-- Session-aware devices.
alter table public.devices add column if not exists session_id uuid;
create index if not exists devices_company_user_active_idx on public.devices(company_id,user_id,active,last_seen_at desc);
create index if not exists devices_session_idx on public.devices(session_id);
create unique index if not exists devices_company_user_fingerprint_uidx on public.devices(company_id,user_id,fingerprint) where user_id is not null and fingerprint is not null;

-- Billing invoices.
create table if not exists public.billing_invoices (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  subscription_id uuid references public.subscriptions(id) on delete set null,
  plan_request_id uuid references public.plan_requests(id) on delete set null,
  invoice_number text not null,
  period_start timestamptz not null, period_end timestamptz not null, due_at timestamptz not null,
  amount numeric not null check (amount >= 0), currency_code bpchar not null,
  status text not null default 'open' check (status in ('open','paid','void')),
  paid_at timestamptz, external_reference text,
  created_at timestamptz not null default timezone('utc',now()),
  updated_at timestamptz not null default timezone('utc',now()),
  unique(company_id,invoice_number)
);
alter table public.billing_invoices enable row level security;
drop policy if exists billing_invoices_owner_read on public.billing_invoices;
create policy billing_invoices_owner_read on public.billing_invoices for select to authenticated using (exists(select 1 from public.company_memberships cm where cm.company_id=billing_invoices.company_id and cm.user_id=auth.uid() and cm.status='active' and cm.is_owner=true));
revoke all on public.billing_invoices from anon;
grant select on public.billing_invoices to authenticated;

-- The public web catalog API is removed.
drop function if exists public.get_public_catalog(text);
drop table if exists public.company_catalogs cascade;

-- The old company switching API is removed.
drop function if exists public.set_active_company(uuid);

-- Cron job for subscription expiry.
create extension if not exists pg_cron with schema extensions;
create or replace function public.process_subscription_expirations() returns jsonb language plpgsql security definer set search_path to 'public','private','pg_temp' as $$
declare v_now timestamptz:=timezone('utc',now()); v_trial integer:=0; v_paid integer:=0;
begin
  update public.subscriptions set status='expired',updated_at=v_now where status='trialing' and coalesce(trial_ends_at,current_period_end)<=v_now;
  get diagnostics v_trial=row_count;
  update public.subscriptions set status='expired',updated_at=v_now where status='active' and trial_ends_at is null and current_period_end<=v_now;
  get diagnostics v_paid=row_count;
  update public.companies c set account_status='pending_payment',updated_at=v_now where c.account_status='active' and exists(select 1 from public.subscriptions s where s.company_id=c.id and s.status='expired' and s.updated_at>=v_now-interval '2 minutes');
  return jsonb_build_object('ok',true,'trial_expired',v_trial,'paid_expired',v_paid,'processed_at',v_now);
end; $$;
revoke all on function public.process_subscription_expirations() from public,anon,authenticated;
grant execute on function public.process_subscription_expirations() to service_role;
do $block$ declare v_job_id bigint; begin if to_regclass('cron.job') is not null then for v_job_id in select jobid from cron.job where jobname='palmyra-subscription-expiration' loop perform cron.unschedule(v_job_id); end loop; perform cron.schedule('palmyra-subscription-expiration','*/15 * * * *','select public.process_subscription_expirations();'); end if; end $block$;

-- Important: onboarding, invitation, device and plan functions are intentionally maintained by the PALMYRA runtime migrations before this reconciliation.