-- PALMYRA RLS performance hardening.
-- Authorization semantics are intentionally preserved while avoiding
-- per-row evaluation of auth.uid()/permission helpers and overlapping
-- permissive SELECT policies.

alter policy "platform_admins_self_select" on public.platform_admins
  using ((select auth.uid()) = user_id);

alter policy "billing_invoices_owner_read" on public.billing_invoices
  using (
    exists (
      select 1
      from public.company_memberships cm
      where cm.company_id = billing_invoices.company_id
        and cm.user_id = (select auth.uid())
        and cm.status = 'active'::membership_status
        and cm.is_owner = true
    )
  );

alter policy "employee_time_shifts_insert" on public.employee_time_shifts
  with check (
    (select private.has_permission(company_id, 'employees.manage'::text))
    or exists (
      select 1
      from public.employees e
      where e.id = employee_time_shifts.employee_id
        and e.company_id = employee_time_shifts.company_id
        and e.user_id = (select auth.uid())
        and e.active
    )
  );

alter policy "employee_time_shifts_update" on public.employee_time_shifts
  using (
    (select private.has_permission(company_id, 'employees.manage'::text))
    or exists (
      select 1
      from public.employees e
      where e.id = employee_time_shifts.employee_id
        and e.company_id = employee_time_shifts.company_id
        and e.user_id = (select auth.uid())
        and e.active
    )
  )
  with check (
    (select private.has_permission(company_id, 'employees.manage'::text))
    or exists (
      select 1
      from public.employees e
      where e.id = employee_time_shifts.employee_id
        and e.company_id = employee_time_shifts.company_id
        and e.user_id = (select auth.uid())
        and e.active
    )
  );

drop policy if exists "employee_warehouse_access_manage" on public.employee_warehouse_access;
drop policy if exists "employee_warehouse_access_insert" on public.employee_warehouse_access;
drop policy if exists "employee_warehouse_access_update" on public.employee_warehouse_access;
drop policy if exists "employee_warehouse_access_delete" on public.employee_warehouse_access;

create policy "employee_warehouse_access_insert"
  on public.employee_warehouse_access
  for insert to authenticated
  with check ((select private.has_permission(company_id, 'employees.manage'::text)));

create policy "employee_warehouse_access_update"
  on public.employee_warehouse_access
  for update to authenticated
  using ((select private.has_permission(company_id, 'employees.manage'::text)))
  with check ((select private.has_permission(company_id, 'employees.manage'::text)));

create policy "employee_warehouse_access_delete"
  on public.employee_warehouse_access
  for delete to authenticated
  using ((select private.has_permission(company_id, 'employees.manage'::text)));

drop policy if exists "supplier_products_modify" on public.supplier_products;
drop policy if exists "supplier_products_insert" on public.supplier_products;
drop policy if exists "supplier_products_update" on public.supplier_products;
drop policy if exists "supplier_products_delete" on public.supplier_products;

create policy "supplier_products_insert"
  on public.supplier_products
  for insert to authenticated
  with check ((select private.has_permission(company_id, 'purchases.manage'::text)));

create policy "supplier_products_update"
  on public.supplier_products
  for update to authenticated
  using ((select private.has_permission(company_id, 'purchases.manage'::text)))
  with check ((select private.has_permission(company_id, 'purchases.manage'::text)));

create policy "supplier_products_delete"
  on public.supplier_products
  for delete to authenticated
  using ((select private.has_permission(company_id, 'purchases.manage'::text)));
