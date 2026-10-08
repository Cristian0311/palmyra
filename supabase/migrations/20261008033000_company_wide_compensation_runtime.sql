-- Company-wide compensation is authoritative.
-- New or updated employees inherit the current company compensation mode/rate.
-- The admin account is handled in the application user mapping because it is
-- not stored in public.employees.

create or replace function public.apply_company_compensation_to_employee()
returns trigger
language plpgsql
security definer
set search_path to 'public','private','pg_temp'
as $$
declare
  v_mode text;
  v_rate numeric;
begin
  select coalesce(cs.mode,'fixed_product'), coalesce(cs.percent_rate,0)
    into v_mode, v_rate
  from public.compensation_settings cs
  where cs.company_id = new.company_id
  limit 1;

  new.compensation_type := case when v_mode='sales_percent' then 'sales_percentage' else 'fixed_product' end;
  new.sales_percentage := case when v_mode='sales_percent' then greatest(0,least(100,v_rate)) else 0 end;
  return new;
end;
$$;

drop trigger if exists trg_apply_company_compensation_to_employee on public.employees;
create trigger trg_apply_company_compensation_to_employee
before insert or update of company_id on public.employees
for each row execute function public.apply_company_compensation_to_employee();

update public.employees e
set compensation_type = case when cs.mode='sales_percent' then 'sales_percentage' else 'fixed_product' end,
    sales_percentage = case when cs.mode='sales_percent' then greatest(0,least(100,cs.percent_rate)) else 0 end,
    updated_at = timezone('utc',now())
from public.compensation_settings cs
where cs.company_id=e.company_id;