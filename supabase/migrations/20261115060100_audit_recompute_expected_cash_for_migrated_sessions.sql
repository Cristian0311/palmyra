begin;

-- Auditoría 2026-11-15 (aplicada en producción con SUPABASE_APPLY_A_MIGRATION,
-- idempotency key: palmyra-audit-2026-11-15-expected-cash).
--
-- 15 turnos cerrados migrados desde MARÉ quedaron con expected_cash = 0 aunque
-- tenían ventas cobradas en efectivo, por lo que los reportes mostraban un
-- "sobrante" igual al total del turno. El esperado se recalcula SOLO con datos
-- ya almacenados y los valores anteriores quedan en metadata.financial_repair.
with recalc as (
  select cs.id,
         cs.expected_cash as prev_expected,
         cs.difference as prev_difference,
         round(
           coalesce(cs.opening_amount, 0)
           + coalesce((
               select sum(p.amount * coalesce(p.exchange_rate, 1))
               from public.payments p
               join public.sales s on s.id = p.sale_id
               where s.cash_session_id = cs.id
                 and s.status = 'completed'
                 and p.method = 'cash'
             ), 0)
           + coalesce((
               select sum(case when m.movement_type = 'income' then m.amount else -m.amount end)
               from public.cash_movements m
               where m.cash_session_id = cs.id
             ), 0)
         , 2) as calc
  from public.cash_sessions cs
  where cs.deleted_at is null
    and cs.status = 'closed'
    and coalesce(cs.expected_cash, 0) = 0
)
update public.cash_sessions cs
set expected_cash = r.calc,
    difference = coalesce(cs.physical_cash, 0) - r.calc,
    metadata = jsonb_set(
      coalesce(cs.metadata, '{}'::jsonb),
      '{financial_repair}',
      jsonb_build_object(
        'previous_expected_cash', r.prev_expected,
        'previous_difference', r.prev_difference,
        'repaired_at', timezone('utc', now())
      ),
      true
    )
from recalc r
where cs.id = r.id
  and r.calc > 0;

commit;
