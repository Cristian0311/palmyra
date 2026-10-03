-- PALMYRA fix employee time-shift RLS tenant predicate

drop policy if exists employee_time_shifts_insert on public.employee_time_shifts;
drop policy if exists employee_time_shifts_update on public.employee_time_shifts;

create policy employee_time_shifts_insert
on public.employee_time_shifts
for insert to authenticated
with check (
  private.has_permission(company_id,'employees.manage')
  or exists (
    select 1
    from public.employees e
    where e.id=employee_time_shifts.employee_id
      and e.company_id=employee_time_shifts.company_id
      and e.user_id=auth.uid()
      and e.active
  )
);

create policy employee_time_shifts_update
on public.employee_time_shifts
for update to authenticated
using (
  private.has_permission(company_id,'employees.manage')
  or exists (
    select 1
    from public.employees e
    where e.id=employee_time_shifts.employee_id
      and e.company_id=employee_time_shifts.company_id
      and e.user_id=auth.uid()
      and e.active
  )
)
with check (
  private.has_permission(company_id,'employees.manage')
  or exists (
    select 1
    from public.employees e
    where e.id=employee_time_shifts.employee_id
      and e.company_id=employee_time_shifts.company_id
      and e.user_id=auth.uid()
      and e.active
  )
);