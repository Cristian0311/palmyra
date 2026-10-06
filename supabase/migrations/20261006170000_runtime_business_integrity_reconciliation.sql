-- Runtime reconciliation: keep production hardening reproducible from Git.
-- Safe/idempotent grants and permission catalog.
insert into public.permissions(key,name,description)
values
 ('cash.close','Cerrar caja','Cerrar y liquidar turnos de caja'),
 ('sales.refund','Gestionar devoluciones','Crear y completar devoluciones de ventas'),
 ('purchases.manage','Gestionar compras','Crear, modificar y recibir órdenes de compra'),
 ('inventory.transfer','Transferir inventario','Mover existencias entre almacenes')
on conflict (key) do update set name=excluded.name,description=excluded.description;

insert into public.role_permissions(role_id,permission_id)
select r.id,p.id
from public.roles r join public.permissions p on p.key in ('cash.close','sales.refund','purchases.manage','inventory.transfer')
where r.key='admin' and r.company_id is null
on conflict do nothing;

insert into public.role_permissions(role_id,permission_id)
select r.id,p.id
from public.roles r join public.permissions p on p.key='cash.close'
where r.key='employee' and r.company_id is null
on conflict do nothing;

grant select,insert,update,delete on public.categories to authenticated;
grant select,insert,update,delete on public.warehouses to authenticated;
grant select,insert,update,delete on public.suppliers to authenticated;
grant select,insert,update,delete on public.purchase_orders to authenticated;
grant select,insert,update,delete on public.purchase_items to authenticated;
grant select,insert,update,delete on public.product_variants to authenticated;
grant select,update on public.sales to authenticated;
grant select on public.cash_registers to authenticated;
grant select,insert,update on public.products to authenticated;
grant select,update on public.cash_sessions to authenticated;
grant insert,delete on public.cash_movements to authenticated;
grant select,insert,update on public.product_barcodes to authenticated;

alter table public.cash_sessions
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid,
  add column if not exists delete_reason text;

create index if not exists idx_cash_sessions_not_deleted
  on public.cash_sessions (company_id,cash_register_id,opened_at)
  where deleted_at is null;

-- Business functions are managed by their dedicated hardening migrations.
-- This reconciliation migration is limited to additive grants/permissions/schema
-- drift so it can be safely replayed on an existing tenant database.
