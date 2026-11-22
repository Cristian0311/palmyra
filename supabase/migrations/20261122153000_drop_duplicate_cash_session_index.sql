begin;

-- idx_cash_movements_cash_movements_cash_session_id_fkey (cash_session_id) es
-- prefijo exacto de cash_movements_session_created_idx (cash_session_id,
-- created_at), que además ordena por fecha para el arqueo. El índice suelto solo
-- añade coste de escritura.
drop index if exists public.idx_cash_movements_cash_movements_cash_session_id_fkey;

commit;
