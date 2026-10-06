-- Give the company creator/Admin every currently defined platform permission,
-- and keep POS cash-opening permission explicit.

insert into public.permissions(id,key,name,description)
values(gen_random_uuid(),'cash.open','Abrir caja','Permite abrir y gestionar turnos de caja en el Punto de Venta.')
on conflict (key) do nothing;

insert into public.role_permissions(role_id,permission_id)
select r.id,p.id
from public.roles r
cross join public.permissions p
where r.name='Administrador'
  and r.is_system=true
  and not exists (
    select 1 from public.role_permissions rp
    where rp.role_id=r.id and rp.permission_id=p.id
  );