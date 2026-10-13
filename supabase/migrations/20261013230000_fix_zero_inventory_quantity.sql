begin;
do $$
declare
  v_definition text;
  v_fixed text;
begin
  v_definition := pg_get_functiondef(
    'public.palmyra_adjust_inventory(uuid,uuid,uuid,uuid,uuid,numeric,numeric,numeric,text)'::regprocedure
  );
  v_fixed := replace(
    v_definition,
    'v_next:=greatest(p_min_quantity,v_current+p_delta);',
    'v_next:=greatest(0::numeric,v_current+p_delta);'
  );
  if v_fixed = v_definition then
    if position('v_next:=greatest(0::numeric,v_current+p_delta);' in v_definition) = 0 then
      raise exception 'Expected inventory quantity calculation was not found';
    end if;
  else
    execute v_fixed;
  end if;
end;
$$;
commit;