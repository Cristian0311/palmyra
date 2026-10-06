-- Supporting indexes for foreign keys reported by the Supabase performance advisor.
create index if not exists idx_devices_revoked_by
  on public.devices (revoked_by);

create index if not exists idx_support_requests_user_id
  on public.support_requests (user_id);
