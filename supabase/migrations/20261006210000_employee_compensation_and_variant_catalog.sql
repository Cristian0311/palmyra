-- PALMYRA employee compensation and product variant persistence
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

create or replace function public.set_employee_compensation(
  p_company_id uuid,p_employee_id uuid,p_compensation_type text,p_sales_percentage numeric
) returns jsonb
language plpgsql security definer
set search_path=public,private,extensions,pg_temp
as $$
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;
  if not private.has_permission(p_company_id,'employees.manage') then raise exception 'permission_denied'; end if;
  if p_compensation_type not in ('fixed_product','sales_percentage') then raise exception 'invalid_compensation_type'; end if;
  if p_sales_percentage < 0 or p_sales_percentage > 100 then raise exception 'invalid_sales_percentage'; end if;
  if not exists(select 1 from public.employees where id=p_employee_id and company_id=p_company_id) then raise exception 'employee_not_found'; end if;
  update public.employees
  set compensation_type=p_compensation_type,
      sales_percentage=case when p_compensation_type='sales_percentage' then p_sales_percentage else 0 end,
      updated_at=timezone('utc',now())
  where id=p_employee_id and company_id=p_company_id;
  return jsonb_build_object('success',true,'employee_id',p_employee_id);
end $$;

revoke all on function public.set_employee_compensation(uuid,uuid,text,numeric) from public,anon;
grant execute on function public.set_employee_compensation(uuid,uuid,text,numeric) to authenticated;

create function public.create_employee_pos_secure(
 p_company_id uuid,p_employee_id uuid,p_employee_code text,p_full_name text,p_base_salary numeric,
 p_role_id uuid,p_warehouse_ids uuid[],p_pos_password text,p_compensation_type text,p_sales_percentage numeric
) returns jsonb
language plpgsql security definer
set search_path=public,private,extensions,pg_temp
as $$
declare v_result jsonb; v_id uuid;
begin
 if p_compensation_type not in ('fixed_product','sales_percentage') then raise exception 'invalid_compensation_type'; end if;
 if p_sales_percentage < 0 or p_sales_percentage > 100 then raise exception 'invalid_sales_percentage'; end if;
 v_result:=public.create_employee_pos_secure(p_company_id,p_employee_id,p_employee_code,p_full_name,p_base_salary,p_role_id,p_warehouse_ids,p_pos_password);
 v_id:=(v_result->>'id')::uuid;
 update public.employees
 set compensation_type=p_compensation_type,
     sales_percentage=case when p_compensation_type='sales_percentage' then p_sales_percentage else 0 end,
     updated_at=timezone('utc',now())
 where id=v_id and company_id=p_company_id;
 return v_result;
end $$;

revoke all on function public.create_employee_pos_secure(uuid,uuid,text,text,numeric,uuid,uuid[],text,text,numeric) from public,anon;
grant execute on function public.create_employee_pos_secure(uuid,uuid,text,text,numeric,uuid,uuid[],text,text,numeric) to authenticated;
