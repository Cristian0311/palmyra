begin;

-- Limpieza de índices redundantes detectados en la auditoría del 2026-11-22.
-- Cada uno duplica la cobertura de otro índice ya existente sobre las mismas
-- columnas en el mismo orden, así que solo costaba escrituras y espacio.
--
-- 1) (code, captured_at) ya está cubierto por el índice ÚNICO
--    exchange_rate_history_code_captured_at_key.
-- 2) product_barcodes_lookup_idx (company_id, barcode) WHERE active queda
--    cubierto por el único (company_id, barcode).
-- 3) La FK de subscriptions(company_id) no necesita índice propio porque
--    subscriptions_company_uq ya indexa company_id.
-- 4) El parcial (return_id, sale_item_id) WHERE sale_item_id IS NOT NULL es un
--    subconjunto del único completo (return_id, sale_item_id), que además es el
--    que usa ON CONFLICT en palmyra_create_return.
-- 5) plan_requests_one_pending_v3 (status=pending AND terms_version=3) es un
--    subconjunto de plan_requests_one_pending_per_company (status=pending).
drop index if exists public.exchange_rate_history_code_captured_at_idx;
drop index if exists public.product_barcodes_lookup_idx;
drop index if exists public.idx_subscriptions_subscriptions_company_id_fkey;
drop index if exists public.sales_return_items_return_sale_item_unique;
drop index if exists public.plan_requests_one_pending_v3;

commit;
