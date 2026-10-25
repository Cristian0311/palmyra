-- Allow editing an existing product whose category was deliberately deactivated,
-- but only when the sync keeps that exact category assignment unchanged.
-- Changing to an inactive/foreign category remains rejected.
do $migration$
declare
  v_definition text;
  v_old text := $old$if p_category_id is not null and not exists(
    select 1 from public.categories
    where id=p_category_id and company_id=p_company_id and active
  ) then raise exception 'invalid_category'; end if;$old$;
  v_new text := $new$if p_category_id is not null
    and not exists(
      select 1 from public.categories
      where id=p_category_id and company_id=p_company_id and active
    )
    and not exists(
      select 1
      from public.categories c
      join public.products p on p.id=p_product_id
        and p.company_id=p_company_id
        and p.category_id=c.id
      where c.id=p_category_id
        and c.company_id=p_company_id
        and c.active=false
    )
  then raise exception 'invalid_category'; end if;$new$;
begin
  select pg_get_functiondef(
    'public.sync_product_secure(uuid,uuid,uuid,uuid,text,text,text,text,numeric,numeric,numeric,numeric,boolean,numeric,text,boolean,boolean,jsonb,jsonb,jsonb)'::regprocedure
  ) into v_definition;
  if position(v_old in v_definition)=0 then
    raise exception 'Expected category validation block not found; migration aborted without changing sync_product_secure';
  end if;
  v_definition := replace(v_definition, v_old, v_new);
  execute v_definition;
end;
$migration$;
