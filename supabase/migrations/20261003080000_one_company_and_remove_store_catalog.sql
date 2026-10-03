-- PALMYRA one-company-per-account + remove public web catalog

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

create unique index if not exists company_memberships_one_company_per_user_uidx
  on public.company_memberships(user_id);

drop function if exists public.set_active_company(uuid);
drop function if exists public.get_public_catalog(text);
drop table if exists public.company_catalogs cascade;

-- Store and receipt settings are now kept in company_settings, independent of web catalog features.