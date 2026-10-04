-- A pending upgrade request never suspends a company that still has an
-- active/trial subscription. Normalize legacy rows left by older versions.
update public.companies c
set account_status='active',
    active=true,
    updated_at=timezone('utc',now())
where c.account_status='pending_payment'
  and exists (
    select 1
    from public.plan_requests pr
    where pr.company_id=c.id
      and pr.status='pending'
  )
  and exists (
    select 1
    from public.subscriptions s
    where s.company_id=c.id
      and (
        (s.status='trialing' and (s.trial_ends_at is null or s.trial_ends_at > timezone('utc',now())))
        or
        (s.status='active' and (s.current_period_end is null or s.current_period_end > timezone('utc',now())))
      )
  );
