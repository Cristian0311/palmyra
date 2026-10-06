-- PALMYRA runtime permission/schema reconciliation for current v1 SaaS schema.
-- RLS remains the authorization boundary; these grants only allow PostgREST
-- to reach the tables so the existing company/permission policies can decide
-- which rows/operations are actually allowed.

grant select on public.cash_registers to authenticated;
grant select, insert, update on public.products to authenticated;
grant select, update on public.cash_sessions to authenticated;

alter table public.cash_sessions
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid,
  add column if not exists delete_reason text;

create index if not exists idx_cash_sessions_not_deleted
  on public.cash_sessions (company_id, cash_register_id, opened_at)
  where deleted_at is null;

comment on column public.cash_sessions.deleted_at is
  'Soft-delete timestamp for audit/history; null means active historical record.';
comment on column public.cash_sessions.deleted_by is
  'Authenticated user that soft-deleted the cash session.';
comment on column public.cash_sessions.delete_reason is
  'Reason recorded when a cash session is soft-deleted.';
