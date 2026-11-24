-- Garantía por producto (warranty_days): columna nueva + RPC dedicado.
-- Aditivo y reversible:
--   reversa = drop function public.sync_product_warranty_secure(uuid,uuid,integer);
--             alter table public.products drop column warranty_days;
-- El RPC se mantiene separado de sync_product_secure para no tocar esa función
-- compleja; el cliente lo llama después del push del producto y tolera su ausencia.

begin;

alter table public.products
  add column if not exists warranty_days integer not null default 0;

create or replace function public.sync_product_warranty_secure(
  p_company_id uuid,
  p_product_id uuid,
  p_warranty_days integer default 0
) returns jsonb
language plpgsql
security definer
set search_path to 'public','private','pg_temp'
as $function$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null or not private.has_permission(p_company_id,'products.manage') then
    raise exception 'permission_denied';
  end if;
  if p_warranty_days is null or p_warranty_days < 0 or p_warranty_days > 36500 then
    raise exception 'invalid_warranty_days';
  end if;

  update public.products
     set warranty_days = p_warranty_days,
         updated_at = now()
   where id = p_product_id
     and company_id = p_company_id;

  if not found then
    raise exception 'product_not_found';
  end if;

  return jsonb_build_object('success', true);
end;
$function$;

revoke execute on function public.sync_product_warranty_secure(uuid,uuid,integer) from public;
revoke execute on function public.sync_product_warranty_secure(uuid,uuid,integer) from anon;
grant execute on function public.sync_product_warranty_secure(uuid,uuid,integer) to authenticated;

commit;
