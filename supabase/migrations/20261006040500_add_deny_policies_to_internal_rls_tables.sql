-- Keep RLS-enabled internal tables closed to direct API access.
-- Security-definer service functions continue to operate as their owner.

do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='company_fiscal_reservations' and policyname='deny_direct_access'
  ) then
    execute 'create policy deny_direct_access on public.company_fiscal_reservations for all using (false) with check (false)';
  end if;

  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='company_fiscal_sequences' and policyname='deny_direct_access'
  ) then
    execute 'create policy deny_direct_access on public.company_fiscal_sequences for all using (false) with check (false)';
  end if;

  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='platform_support_settings' and policyname='deny_direct_access'
  ) then
    execute 'create policy deny_direct_access on public.platform_support_settings for all using (false) with check (false)';
  end if;

  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='support_requests' and policyname='deny_direct_access'
  ) then
    execute 'create policy deny_direct_access on public.support_requests for all using (false) with check (false)';
  end if;
end
$$;
