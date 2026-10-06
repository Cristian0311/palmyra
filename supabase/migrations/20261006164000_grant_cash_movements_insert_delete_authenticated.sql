-- PALMYRA: cash movement permissions.
-- RLS remains the authorization boundary.
grant insert, delete on public.cash_movements to authenticated;
