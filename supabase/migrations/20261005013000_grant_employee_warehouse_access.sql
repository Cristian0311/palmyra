-- Keep RLS as the authorization boundary while exposing the table
-- to authenticated users for Team/warehouse-access management.
grant select, insert, update, delete
on table public.employee_warehouse_access
to authenticated;
