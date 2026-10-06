-- Harden product price writes: price belongs to the company-owned product even if
-- the product is being restored/edited during the same catalog workflow.
create or replace function public.set_product_price(
  p_company_id uuid,
  p_product_id uuid,
  p_currency_code character,
  p_price numeric
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_user uuid := auth.uid();
  v_now timestamptz := timezone('utc',now());
  v_id uuid;
begin
  if v_user is null then raise exception 'authentication_required'; end if;
  if not private.has_permission(p_company_id,'products.manage') then raise exception 'permission_denied'; end if;
  if p_price is null or p_price < 0 then raise exception 'invalid_price'; end if;
  if not exists(select 1 from public.currencies where code=p_currency_code and active) then raise exception 'invalid_currency'; end if;
  if not exists(select 1 from public.products where id=p_product_id and company_id=p_company_id) then raise exception 'invalid_product'; end if;

  update public.product_prices
  set valid_to=v_now
  where company_id=p_company_id
    and product_id=p_product_id
    and currency_code=p_currency_code
    and valid_to is null
    and valid_from < v_now;

  insert into public.product_prices(company_id,product_id,currency_code,price,valid_from)
  values(p_company_id,p_product_id,p_currency_code,round(p_price,6),v_now)
  returning id into v_id;

  insert into public.audit_logs(company_id,user_id,action,entity_type,entity_id,metadata,created_at)
  values(p_company_id,v_user,'product.price_changed','product',p_product_id,
         jsonb_build_object('currency_code',p_currency_code,'price',p_price),v_now);
  return v_id;
end;
$function$;

grant execute on function public.set_product_price(uuid,uuid,character,numeric) to authenticated;