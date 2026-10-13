begin;
do $$
declare
  v_definition text;
  v_fixed text;
begin
  v_definition := pg_get_functiondef('private.company_has_plan_feature(uuid,text)'::regprocedure);
  v_fixed := replace(
    v_definition,
    'lower(trim(f.value)) = lower(trim(p_feature))',
    'lower(trim(f.value)) = lower(trim(p_feature))
           or (lower(trim(p_feature)) = ''payroll'' and lower(trim(f.value)) = ''gestión salarial'')'
  );
  if v_fixed = v_definition then
    if position('lower(trim(p_feature)) = ''payroll'' and lower(trim(f.value)) = ''gestión salarial''' in v_definition) = 0 then
      raise exception 'Could not safely locate plan feature matcher';
    end if;
  else
    execute v_fixed;
  end if;
end;
$$;
commit;