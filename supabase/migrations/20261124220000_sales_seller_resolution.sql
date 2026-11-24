-- Resolución de vendedor en ventas materializadas desde la bandeja local.
--
-- Contexto: 147 ventas de MARE quedaron `failed` en local_change_inbox con
-- «cross_company_reference: sales.seller_user_id». Los APK antiguos guardaban
-- en `row.user_id` el id del EMPLEADO POS (que no tiene cuenta de usuario ni
-- company_membership) y el materializador lo copiaba tal cual a
-- sales.seller_user_id; el trigger de consistencia lo rechazaba porque
-- seller_user_id exige membresía activa.
--
-- Corrección en el borde de la tabla (válida para cualquier escritor, no solo
-- el materializador): antes del check de consistencia, un trigger normaliza
--   1. seller_user_id que no es membresía activa de la empresa:
--        - si coincide con un empleado de la empresa y employee_id viene
--          vacío, se mueve a employee_id;
--        - en cualquier caso, seller_user_id queda NULL.
--   2. employee_id que no existe en la empresa: queda NULL.
--
-- El nombre del trigger (`sales_aa_...`) es deliberado: PostgreSQL dispara los
-- triggers del mismo evento en orden alfabético por nombre, y este debe
-- ejecutarse antes de `sales_company_consistency`, que lanza la excepción.
--
-- Idempotente y reejecutable: solo crea/reemplaza función y trigger.
begin;

create or replace function private.resolve_sales_seller_ids()
returns trigger
language plpgsql
security definer
set search_path to public
as $function$
begin
  -- seller_user_id debe ser una membresía activa de la empresa; los equipos
  -- viejos mandaban aquí el id del empleado POS (sin cuenta de usuario).
  if new.seller_user_id is not null
     and not exists (
       select 1 from public.company_memberships cm
       where cm.company_id = new.company_id
         and cm.user_id = new.seller_user_id
         and cm.status = 'active'
     ) then
    if new.employee_id is null
       and exists (
         select 1 from public.employees e
         where e.id = new.seller_user_id
           and e.company_id = new.company_id
       ) then
      new.employee_id := new.seller_user_id;
    end if;
    new.seller_user_id := null;
  end if;

  -- employee_id debe existir en la empresa; si no, se descarta para no
  -- perder la venta por una referencia que ya no es válida.
  if new.employee_id is not null
     and not exists (
       select 1 from public.employees e
       where e.id = new.employee_id
         and e.company_id = new.company_id
     ) then
    new.employee_id := null;
  end if;

  return new;
end;
$function$;

revoke all on function private.resolve_sales_seller_ids() from public;

drop trigger if exists sales_aa_resolve_seller_ids on public.sales;
create trigger sales_aa_resolve_seller_ids
  before insert or update of seller_user_id, employee_id on public.sales
  for each row execute function private.resolve_sales_seller_ids();

commit;
