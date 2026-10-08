begin;

-- Product/employee/warehouse plan limits are enforced atomically by
-- private.enforce_plan_limit() triggers. The duplicated plan_entity_limit_ok()
-- calls inside RLS caused permission failures during offline replay.
drop policy if exists products_insert on public.products;
create policy products_insert on public.products
for insert to authenticated
with check (private.has_permission(company_id, 'products.manage'));

drop policy if exists products_update on public.products;
create policy products_update on public.products
for update to authenticated
using (private.has_permission(company_id, 'products.manage'))
with check (private.has_permission(company_id, 'products.manage'));

drop policy if exists employees_insert on public.employees;
create policy employees_insert on public.employees
for insert to authenticated
with check (private.has_permission(company_id, 'employees.manage'));

drop policy if exists employees_update on public.employees;
create policy employees_update on public.employees
for update to authenticated
using (private.has_permission(company_id, 'employees.manage'))
with check (private.has_permission(company_id, 'employees.manage'));

drop policy if exists warehouses_insert on public.warehouses;
create policy warehouses_insert on public.warehouses
for insert to authenticated
with check (private.has_permission(company_id, 'settings.manage'));

drop policy if exists warehouses_update on public.warehouses;
create policy warehouses_update on public.warehouses
for update to authenticated
using (private.has_permission(company_id, 'settings.manage'))
with check (private.has_permission(company_id, 'settings.manage'));

commit;
