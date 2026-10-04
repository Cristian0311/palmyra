-- PALMYRA: employee warehouse access grants + product warehouse invariant.
grant select on table public.employee_warehouse_access to authenticated;
revoke all on table public.employee_warehouse_access from anon;

create or replace function private.enforce_product_warehouse()
returns trigger
language plpgsql
security definer
set search_path to 'public','private','pg_temp'
as $$
begin
  if new.company_id is null then
    raise exception 'product_company_required';
  end if;
  if not exists (
    select 1 from public.warehouses
    where company_id=new.company_id and active
  ) then
    raise exception 'product_warehouse_required';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_product_requires_warehouse on public.products;
create trigger trg_product_requires_warehouse
before insert or update of company_id on public.products
for each row execute function private.enforce_product_warehouse();
