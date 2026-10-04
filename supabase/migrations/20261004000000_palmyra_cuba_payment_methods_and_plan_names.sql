-- PALMYRA: Cuba payment methods for plan acquisition + canonical plan names

update public.plans
set name = case code when 'starter' then 'Oasis' when 'growth' then 'Caravana' when 'pro' then 'Ciudadela' else name end,
features = case code
when 'starter' then jsonb_build_object('description','Para comenzar a vender y controlar lo esencial sin complicaciones.','features',jsonb_build_array('Punto de venta','Inventario y caja','Clientes y proveedores','Reportes básicos','Modo offline'))
when 'growth' then jsonb_build_object('description','Para negocios que ya mueven mercancía entre varios puntos y necesitan más control.','features',jsonb_build_array('Compras y recepción','Transferencias entre almacenes','Reportes avanzados','Equipo con roles','Operación multi-almacén'))
when 'pro' then jsonb_build_object('description','Para empresas con mayor estructura, más ubicaciones y análisis profundo.','features',jsonb_build_array('Analítica avanzada','7 almacenes operativos','10 empleados + administrador','300 productos/SKUs','Soporte prioritario'))
else features end
where code in ('starter','growth','pro');

create or replace function public.select_company_plan_with_payment(p_company_id uuid,p_plan_id uuid,p_payment_method text default 'manual_cash')
returns jsonb language plpgsql security definer set search_path to public,private,pg_temp as $function$
declare v_result jsonb; v_request_id uuid; v_payment_method text:=lower(trim(coalesce(p_payment_method,'manual_cash')));
begin
if v_payment_method not in ('manual_cash','manual_bank_transfer') then raise exception 'invalid_payment_method'; end if;
v_result:=public.select_company_plan(p_company_id,p_plan_id);
select pr.id into v_request_id from public.plan_requests pr where pr.company_id=p_company_id and pr.status='pending' order by pr.requested_at desc limit 1;
if v_request_id is not null then
update public.plan_requests set payment_method=v_payment_method,payment_provider=v_payment_method,
note=case when v_payment_method='manual_bank_transfer' then 'Cliente seleccionó transferencia bancaria.' else 'Cliente seleccionó pago en efectivo.' end where id=v_request_id;
end if;
return v_result || jsonb_build_object('payment_method',v_payment_method);
end;
$function$;

create or replace function public.palmyra_onboard_company_with_payment(
p_name text,p_slug text,p_country_code bpchar default 'CU',p_default_currency_code bpchar default 'CUP',
p_timezone text default 'America/Havana',p_warehouse_name text default 'Almacén principal',p_plan_code text default 'starter',
p_employee_name text default null,p_employee_code text default null,p_payment_method text default 'manual_cash')
returns jsonb language plpgsql security definer set search_path to public,private,pg_temp as $function$
declare v_result jsonb; v_request_id uuid; v_payment_method text:=lower(trim(coalesce(p_payment_method,'manual_cash')));
begin
if v_payment_method not in ('manual_cash','manual_bank_transfer') then raise exception 'invalid_payment_method'; end if;
v_result:=public.palmyra_onboard_company(p_name,p_slug,p_country_code,p_default_currency_code,p_timezone,p_warehouse_name,p_plan_code,p_employee_name,p_employee_code);
v_request_id:=nullif(v_result->>'request_id','')::uuid;
if v_request_id is not null then
update public.plan_requests set payment_method=v_payment_method,payment_provider=v_payment_method,
note=case when v_payment_method='manual_bank_transfer' then 'Cliente seleccionó transferencia bancaria.' else 'Cliente seleccionó pago en efectivo.' end where id=v_request_id;
end if;
return v_result || jsonb_build_object('payment_method',v_payment_method);
end;
$function$;

revoke all on function public.select_company_plan_with_payment(uuid,uuid,text) from public;
grant execute on function public.select_company_plan_with_payment(uuid,uuid,text) to authenticated;
revoke all on function public.palmyra_onboard_company_with_payment(text,text,bpchar,bpchar,text,text,text,text,text,text) from public;
grant execute on function public.palmyra_onboard_company_with_payment(text,text,bpchar,bpchar,text,text,text,text,text,text) to authenticated;