-- PALMYRA: idempotent product archival for offline multi-device sync.
-- Replaying the same delete after another device archived/removed the product
-- must succeed instead of leaving a permanent queue item.

create or replace function public.palmyra_archive_product(
  p_company_id uuid,
  p_product_id uuid
) returns jsonb
language plpgsql
security definer
set search_path=public,private,pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_status text;
begin
  if v_user is null then raise exception 'authentication_required'; end if;
  if not private.has_permission(p_company_id,'products.manage') then
    raise exception 'permission_denied';
  end if;

  select status into v_status
  from public.products
  where id=p_product_id and company_id=p_company_id;

  if v_status is null then
    return jsonb_build_object('success',true,'product_id',p_product_id,'already_absent',true);
  end if;

  if v_status='archived' then
    return jsonb_build_object('success',true,'product_id',p_product_id,'already_archived',true);
  end if;

  update public.products
     set status='archived',
         updated_at=timezone('utc',now())
   where id=p_product_id
     and company_id=p_company_id;

  return jsonb_build_object('success',true,'product_id',p_product_id,'archived',true);
end;
$$;

revoke all on function public.palmyra_archive_product(uuid,uuid) from public,anon;
grant execute on function public.palmyra_archive_product(uuid,uuid) to authenticated;
