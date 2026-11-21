-- APPLIED 2026-11-20 to production (catalog metadata + entitlement helper only).
-- Gratis keeps its limits and permanence, but now includes commercial cloud backup.
-- This migration changes catalog metadata and the entitlement helper only; no
-- subscription, invoice or payment history is rewritten.
begin;

alter table public.plans drop constraint if exists plans_runtime_entitlements_check;

update public.plans set features =
  '{"description":"Gratis permanente. Incluye respaldo comercial en la nube.","storage_mode":"cloud_backup","cloud_backup":true,"features":["Punto de venta básico","Caja en efectivo","Inventario básico","Reportes básicos","Modo offline","Respaldo comercial en la nube"],"feature_keys":["pos","cash","inventory","offline","basic_reports","cloud_backup"]}'::jsonb
where code='free';

alter table public.plans add constraint plans_runtime_entitlements_check check (
  (code='free' and active and monthly_price=0 and trial_days=0 and billing_currency_code='USD'
    and (limits->>'warehouses')::int=1 and (limits->>'employees')::int=1 and (limits->>'products')::int=25
    and features->>'storage_mode'='cloud_backup' and features->>'cloud_backup'='true')
  or (code='starter' and active and monthly_price=10 and trial_days=0
    and (limits->>'warehouses')::int=1 and (limits->>'employees')::int=2 and (limits->>'products')::int=50
    and (features->'feature_keys') ? 'custom_roles')
  or (code='growth' and active and monthly_price=15 and trial_days=0
    and (limits->>'warehouses')::int=3 and (limits->>'employees')::int=4 and (limits->>'products')::int=150)
  or (code='pro' and active and monthly_price=25 and trial_days=0
    and (limits->>'warehouses')::int=7 and (limits->>'employees')::int=10 and (limits->>'products')::int=300)
  or (code='trial' and not active and monthly_price=0 and trial_days=0)
);

-- Backend entitlement helper: checks actual paid/trial/grace dates, never requests.
create or replace function private.company_has_plan_feature(p_company_id uuid,p_feature text)
returns boolean language sql stable security definer set search_path=public,private,pg_temp as $$
  select exists(select 1 from public.subscriptions s join public.plans p on p.id=s.plan_id
    join public.companies c on c.id=s.company_id
    where s.company_id=p_company_id and c.active and c.account_status<>'suspended'
    and (p.active or p.code='trial')
    and ((s.status='active' and (s.current_period_end is null or s.current_period_end>now()))
      or (s.status='trialing' and coalesce(s.trial_ends_at,s.current_period_end)>now())
      or (s.status in ('active','trialing','past_due') and coalesce(s.grace_ends_at,coalesce(s.trial_ends_at,s.current_period_end)+interval '2 days')>now()))
    and case lower(trim(p_feature))
      when 'roles' then p.code in ('starter','growth','pro','trial')
      when 'custom_roles' then p.code in ('starter','growth','pro','trial')
      when 'payroll' then p.code in ('growth','pro')
      when 'cloud_backup' then p.code in ('free','starter','growth','pro','trial')
      when 'pos' then true
      when 'cash' then true
      when 'inventory' then true
      when 'offline' then true
      when 'basic_reports' then true
      else (coalesce(p.features->'feature_keys','[]'::jsonb) ? lower(trim(p_feature)))
        or exists(select 1 from jsonb_array_elements_text(case when jsonb_typeof(p.features)='array' then p.features else coalesce(p.features->'features','[]'::jsonb) end) f(value) where lower(trim(f.value))=lower(trim(p_feature)))
    end);
$$;

commit;
