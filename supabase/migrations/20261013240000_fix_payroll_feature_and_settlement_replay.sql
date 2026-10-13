begin;

-- Payroll settlements are part of the cash-close workflow in PALMYRA. Ciudadela
-- already supports employee salaries/commissions, so expose the feature key used
-- by the database plan gate instead of failing valid shift closures.
update public.plans
set features = jsonb_set(
  jsonb_set(
    features,
    '{features}',
    case
      when coalesce(features->'features','[]'::jsonb) @> '["Gestión salarial"]'::jsonb
        then coalesce(features->'features','[]'::jsonb)
      else coalesce(features->'features','[]'::jsonb) || '["Gestión salarial"]'::jsonb
    end,
    true
  ),
  '{feature_keys}',
  case
    when coalesce(features->'feature_keys','[]'::jsonb) @> '["payroll"]'::jsonb
      then coalesce(features->'feature_keys','[]'::jsonb)
    else coalesce(features->'feature_keys','[]'::jsonb) || '["payroll"]'::jsonb
  end,
  true
)
where code='pro' and active=true
  and jsonb_typeof(features)='object';

-- Replay a salary settlement by its actual business key, not only its generated
-- item UUID. The database guarantees one item per (payroll_run_id, employee_id).
do $$
declare
  v_definition text;
  v_fixed text;
begin
  v_definition := pg_get_functiondef(
    'public.palmyra_record_salary_settlement(uuid,jsonb)'::regprocedure
  );
  v_fixed := replace(
    v_definition,
    'on conflict(id) do update set
    employee_id=excluded.employee_id,',
    'on conflict(payroll_run_id,employee_id) do update set
    id=public.payroll_items.id,
    employee_id=excluded.employee_id,'
  );
  v_fixed := replace(
    v_fixed,
    '    details=excluded.details;',
    '    details=excluded.details returning id into v_item_id;'
  );

  if position('on conflict(payroll_run_id,employee_id) do update set' in v_fixed)=0
     or position('returning id into v_item_id' in v_fixed)=0 then
    if position('on conflict(payroll_run_id,employee_id) do update set' in v_definition)=0
       or position('returning id into v_item_id' in v_definition)=0 then
      raise exception 'Could not safely locate salary settlement upsert';
    end if;
  end if;

  if v_fixed <> v_definition then execute v_fixed; end if;
end;
$$;

commit;