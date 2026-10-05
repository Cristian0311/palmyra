-- Add dedicated FK-leading indexes identified by Supabase performance advisor.
-- These are non-destructive and use IF NOT EXISTS for safe replay.
create index if not exists billing_invoices_plan_request_idx on public.billing_invoices (plan_request_id);
create index if not exists billing_invoices_subscription_idx on public.billing_invoices (subscription_id);
create index if not exists company_fiscal_reservations_company_idx on public.company_fiscal_reservations (company_id);
create index if not exists company_invitations_employee_fk_idx on public.company_invitations (employee_id);
create index if not exists employee_time_shifts_created_by_idx on public.employee_time_shifts (created_by);
create index if not exists employee_time_shifts_employee_fk_idx on public.employee_time_shifts (employee_id);
create index if not exists employee_time_shifts_warehouse_fk_idx on public.employee_time_shifts (warehouse_id);
create index if not exists product_kit_components_component_product_idx on public.product_kit_components (component_product_id);
create index if not exists product_kit_components_component_variant_idx on public.product_kit_components (component_variant_id);
create index if not exists product_kit_components_kit_product_fk_idx on public.product_kit_components (kit_product_id);
create index if not exists product_serials_product_fk_idx on public.product_serials (product_id);
create index if not exists product_serials_sale_item_fk_idx on public.product_serials (sale_item_id);
create index if not exists product_serials_variant_fk_idx on public.product_serials (variant_id);
create index if not exists sales_return_items_variant_fk_idx on public.sales_return_items (variant_id);
create index if not exists stock_balances_variant_fk_idx on public.stock_balances (variant_id);
create index if not exists stock_movements_variant_fk_idx on public.stock_movements (variant_id);
create index if not exists supplier_products_product_fk_idx on public.supplier_products (product_id);
create index if not exists supplier_products_supplier_fk_idx on public.supplier_products (supplier_id);
create index if not exists transfer_items_variant_fk_idx on public.transfer_items (variant_id);
create index if not exists variant_stock_balances_product_fk_idx on public.variant_stock_balances (product_id);
create index if not exists variant_stock_balances_variant_fk_idx on public.variant_stock_balances (variant_id);
create index if not exists variant_stock_balances_warehouse_fk_idx on public.variant_stock_balances (warehouse_id);
