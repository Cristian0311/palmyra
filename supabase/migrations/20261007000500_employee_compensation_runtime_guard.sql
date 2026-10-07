-- PALMYRA runtime repair: employee compensation columns must exist before
-- the 10-argument create_employee_pos_secure wrapper is used.
alter table public.employees
  add column if not exists compensation_type text not null default 'fixed_product',
  add column if not exists sales_percentage numeric not null default 0;

alter table public.employees drop constraint if exists employees_compensation_type_check;
alter table public.employees
  add constraint employees_compensation_type_check
  check (compensation_type in ('fixed_product','sales_percentage'));

alter table public.employees drop constraint if exists employees_sales_percentage_check;
alter table public.employees
  add constraint employees_sales_percentage_check
  check (sales_percentage >= 0 and sales_percentage <= 100);

update public.employees
set compensation_type = coalesce(compensation_type,'fixed_product'),
    sales_percentage = coalesce(sales_percentage,0)
where compensation_type is null or sales_percentage is null;
