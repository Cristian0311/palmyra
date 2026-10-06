-- PALMYRA: allow authenticated POS users to create authorized cash movements.
-- RLS remains responsible for company/role authorization.
grant insert on public.cash_movements to authenticated;
