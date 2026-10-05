-- PALMYRA POS hardening applied to production.
-- Keeps cash-session metadata durable and records sales atomically with stock, kit, variant and serial handling.
alter table public.cash_sessions
  add column if not exists metadata jsonb not null default '{}'::jsonb;

CREATE OR REPLACE FUNCTION public.palmyra_record_sale(p_sale_id uuid, p_company_id uuid, p_warehouse_id uuid, p_cash_session_id uuid, p_user_id uuid, p_total numeric, p_currency_code text, p_notes text, p_customer_id uuid, p_items jsonb, p_payments jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private', 'pg_temp'
AS $function$
declare
  v_auth uuid := auth.uid();
  v_existing public.sales%rowtype;
  v_employee uuid;
  v_currency text;
  v_company_default_currency text;
  v_cash_session_exists boolean := false;
  v_item jsonb;
  v_payment jsonb;
  v_product public.products%rowtype;
  v_component public.product_kit_components%rowtype;
  v_component_product public.products%rowtype;
  v_balance public.stock_balances%rowtype;
  v_variant_balance public.variant_stock_balances%rowtype;
  v_serial public.product_serials%rowtype;
  v_sale_item_id uuid;
  v_variant_id uuid;
  v_product_id uuid;
  v_qty numeric;
  v_unit_price numeric;
  v_discount numeric;
  v_tax numeric;
  v_line_total numeric;
  v_calc_total numeric := 0;
  v_paid_total numeric := 0;
  v_payment_amount numeric;
  v_exchange_rate numeric;
  v_method public.payment_method;
  v_component_qty numeric;

begin
  if v_auth is null then raise exception 'authentication_required'; end if;
  if not private.has_company_access(p_company_id) then raise exception 'company_access_denied'; end if;
  if not private.has_permission(p_company_id,'pos.access') then raise exception 'permission_denied'; end if;
  if p_sale_id is null then raise exception 'invalid_sale_id'; end if;
  if p_total is null or p_total <= 0 then raise exception 'invalid_total'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items)=0 then raise exception 'items_required'; end if;
  if p_payments is null or jsonb_typeof(p_payments) <> 'array' or jsonb_array_length(p_payments)=0 then raise exception 'payments_required'; end if;

  if not exists(
    select 1 from public.warehouses
    where id=p_warehouse_id and company_id=p_company_id and active
  ) then
    raise exception 'invalid_warehouse';
  end if;
  if not private.user_can_access_warehouse(v_auth,p_company_id,p_warehouse_id) then
    raise exception 'location_access_denied';
  end if;

  if p_cash_session_id is not null then
    select exists(
      select 1
      from public.cash_sessions cs
      join public.cash_registers cr on cr.id=cs.cash_register_id
      where cs.id=p_cash_session_id
        and cs.company_id=p_company_id
        and cr.warehouse_id=p_warehouse_id
        and cs.status='open'
    ) into v_cash_session_exists;
    if not v_cash_session_exists then raise exception 'invalid_cash_session'; end if;
  end if;

  select default_currency_code into v_company_default_currency
  from public.companies
  where id=p_company_id;

  v_currency := coalesce(nullif(trim(p_currency_code),''), v_company_default_currency);

  select e.id into v_employee
  from public.employees e
  where e.company_id=p_company_id
    and e.active
    and (e.id=p_user_id or e.user_id=p_user_id)
  order by (e.id=p_user_id) desc
  limit 1;
  select * into v_existing
  from public.sales
  where id=p_sale_id and company_id=p_company_id
  limit 1;

  if found then
    return jsonb_build_object('success',true,'id',v_existing.id,'already_existed',true);
  end if;

  for v_item in select value from jsonb_array_elements(p_items) loop
    v_product_id := nullif(v_item->>'product_id','')::uuid;
    v_qty := coalesce((v_item->>'quantity')::numeric,0);
    v_unit_price := coalesce((v_item->>'price')::numeric,0);
    v_discount := coalesce((v_item->>'discount')::numeric,0);
    v_tax := coalesce((v_item->>'tax')::numeric,0);

    if v_product_id is null or v_qty <= 0 then raise exception 'invalid_sale_item'; end if;
    if v_unit_price < 0 or v_discount < 0 or v_tax < 0 then raise exception 'invalid_item_values'; end if;

    select * into v_product
    from public.products
    where id=v_product_id and company_id=p_company_id and status='active'
    for share;
    if not found then raise exception 'invalid_product'; end if;

    v_variant_id := null;
    if nullif(trim(coalesce(v_item->>'variant_id',v_item->>'variantId','')),'') is not null then
      v_variant_id := coalesce(v_item->>'variant_id',v_item->>'variantId')::uuid;
    elsif nullif(trim(coalesce(v_item->>'variant_label',v_item->>'variantLabel','')),'') is not null then
      select id into v_variant_id
      from public.product_variants
      where company_id=p_company_id
        and product_id=v_product_id
        and name=coalesce(v_item->>'variant_label',v_item->>'variantLabel')
        and active
      limit 1;
      if v_variant_id is null then raise exception 'invalid_variant'; end if;
    end if;

    if v_variant_id is not null and not exists(
      select 1 from public.product_variants
      where id=v_variant_id and company_id=p_company_id and product_id=v_product_id and active
    ) then
      raise exception 'invalid_variant';
    end if;

    if v_product.track_serial then
      if v_qty <> 1 then raise exception 'serial_quantity_must_be_one'; end if;
      if nullif(trim(coalesce(v_item->>'serial_number',v_item->>'serialNumber','')),'') is null then
        raise exception 'serial_required';
      end if;
      select * into v_serial
      from public.product_serials
      where company_id=p_company_id
        and product_id=v_product_id
        and (variant_id is not distinct from v_variant_id)
        and serial_number=coalesce(v_item->>'serial_number',v_item->>'serialNumber')
        and status='available'
      limit 1
      for update;
      if not found then raise exception 'serial_not_available'; end if;
    elsif nullif(trim(coalesce(v_item->>'serial_number',v_item->>'serialNumber','')),'') is not null then
      raise exception 'serial_not_allowed';
    end if;

    v_line_total := round((v_qty*v_unit_price)-v_discount+v_tax,6);
    if v_line_total < 0 then raise exception 'invalid_line_total'; end if;
    v_calc_total := v_calc_total + v_line_total;

    if v_product.is_kit then
      if not exists(
        select 1 from public.product_kit_components
        where company_id=p_company_id and kit_product_id=v_product_id
      ) then
        raise exception 'kit_has_no_components';
      end if;

      for v_component in
        select * from public.product_kit_components
        where company_id=p_company_id and kit_product_id=v_product_id
      loop
        v_component_qty := v_component.quantity * v_qty;

        select * into v_component_product
        from public.products
        where id=v_component.component_product_id
          and company_id=p_company_id
          and status='active'
        for share;
        if not found then raise exception 'invalid_kit_component'; end if;
        if v_component_product.track_serial then raise exception 'kit_serial_component_unsupported'; end if;

        if v_component_product.track_stock then
          if v_component.component_variant_id is null then
            select * into v_balance
            from public.stock_balances
            where company_id=p_company_id
              and warehouse_id=p_warehouse_id
              and product_id=v_component.component_product_id
              and variant_id is null
            for update;
            if not found or v_balance.quantity < v_component_qty then
              raise exception 'insufficient_component_stock';
            end if;
          else
            select * into v_variant_balance
            from public.variant_stock_balances
            where company_id=p_company_id
              and warehouse_id=p_warehouse_id
              and product_id=v_component.component_product_id
              and variant_id=v_component.component_variant_id
            for update;
            if not found or v_variant_balance.quantity < v_component_qty then
              raise exception 'insufficient_component_stock';
            end if;
          end if;
        end if;
      end loop;

    elsif v_product.track_stock and not v_product.track_serial then
      if v_variant_id is null then
        select * into v_balance
        from public.stock_balances
        where company_id=p_company_id
          and warehouse_id=p_warehouse_id
          and product_id=v_product_id
          and variant_id is null
        for update;
        if not found or v_balance.quantity < v_qty then raise exception 'insufficient_stock'; end if;
      else
        select * into v_variant_balance
        from public.variant_stock_balances
        where company_id=p_company_id
          and warehouse_id=p_warehouse_id
          and product_id=v_product_id
          and variant_id=v_variant_id
        for update;
        if not found or v_variant_balance.quantity < v_qty then raise exception 'insufficient_stock'; end if;
      end if;
    end if;
  end loop;

  if abs(v_calc_total-p_total) > 0.01 then raise exception 'total_mismatch'; end if;

  for v_payment in select value from jsonb_array_elements(p_payments) loop
    begin
      v_payment_amount := (v_payment->>'amount')::numeric;
    exception when others then
      raise exception 'invalid_payment_amount';
    end;
    if v_payment_amount <= 0 then raise exception 'invalid_payment_amount'; end if;

    begin
      v_exchange_rate := coalesce((v_payment->>'exchange_rate')::numeric,(v_payment->>'exchangeRate')::numeric,1);
    exception when others then
      raise exception 'invalid_exchange_rate';
    end;
    if v_exchange_rate <= 0 then raise exception 'invalid_exchange_rate'; end if;

    v_method := case coalesce(v_payment->>'method','cash')
      when 'transfer' then 'bank_transfer'::public.payment_method
      when 'bank_transfer' then 'bank_transfer'::public.payment_method
      when 'card' then 'card'::public.payment_method
      when 'other' then 'other'::public.payment_method
      else 'cash'::public.payment_method
    end;

    if not exists(
      select 1 from public.currencies
      where code=coalesce(nullif(v_payment->>'currency_code',''),nullif(v_payment->>'currencyCode',''),v_currency)
        and active
    ) then
      raise exception 'invalid_payment_currency';
    end if;

    v_paid_total := v_paid_total + (v_payment_amount * v_exchange_rate);

    if v_method='cash' and p_cash_session_id is null then
      raise exception 'cash_session_required';
    end if;
  end loop;

  if abs(v_paid_total-p_total) > 0.05 then raise exception 'payment_total_mismatch'; end if;

  insert into public.sales(
    id,company_id,warehouse_id,cash_session_id,employee_id,seller_user_id,status,total,currency_code,
    client_name,notes,source_operation_id,customer_id,metadata
  )
  values(
    p_sale_id,p_company_id,p_warehouse_id,p_cash_session_id,v_employee,v_auth,'completed',
    round(p_total,6),v_currency,null,coalesce(left(trim(p_notes),1000),''),p_sale_id,p_customer_id,'{}'::jsonb
  );

  for v_item in select value from jsonb_array_elements(p_items) loop
    v_product_id := nullif(v_item->>'product_id','')::uuid;
    v_qty := (v_item->>'quantity')::numeric;
    v_unit_price := coalesce((v_item->>'price')::numeric,0);
    v_discount := coalesce((v_item->>'discount')::numeric,0);
    v_tax := coalesce((v_item->>'tax')::numeric,0);

    v_variant_id := null;
    if nullif(trim(coalesce(v_item->>'variant_id',v_item->>'variantId','')),'') is not null then
      v_variant_id := coalesce(v_item->>'variant_id',v_item->>'variantId')::uuid;
    elsif nullif(trim(coalesce(v_item->>'variant_label',v_item->>'variantLabel','')),'') is not null then
      select id into v_variant_id
      from public.product_variants
      where company_id=p_company_id and product_id=v_product_id
        and name=coalesce(v_item->>'variant_label',v_item->>'variantLabel') and active
      limit 1;
    end if;

    v_line_total := round((v_qty*v_unit_price)-v_discount+v_tax,6);
    insert into public.sale_items(
      id,sale_id,product_id,variant_id,quantity,unit_price,discount,tax,line_total,serial_number
    )
    values(
      gen_random_uuid(),p_sale_id,v_product_id,v_variant_id,v_qty,v_unit_price,v_discount,v_tax,
      v_line_total,
      nullif(coalesce(v_item->>'serial_number',v_item->>'serialNumber'),'')
    )
    returning id into v_sale_item_id;

    select * into v_product
    from public.products
    where id=v_product_id and company_id=p_company_id;

    if v_product.track_serial then
      update public.product_serials
      set status='sold',sale_item_id=v_sale_item_id,updated_at=timezone('utc',now())
      where company_id=p_company_id
        and product_id=v_product_id
        and (variant_id is not distinct from v_variant_id)
        and serial_number=coalesce(v_item->>'serial_number',v_item->>'serialNumber')
        and status='available';
      if not found then raise exception 'serial_not_available'; end if;
    elsif v_product.track_stock then
      if v_product.is_kit then
        for v_component in
          select * from public.product_kit_components
          where company_id=p_company_id and kit_product_id=v_product_id
        loop
          v_component_qty := v_component.quantity * v_qty;
          if v_component.component_variant_id is null then
            update public.stock_balances
            set quantity=quantity-v_component_qty,updated_at=timezone('utc',now())
            where company_id=p_company_id
              and warehouse_id=p_warehouse_id
              and product_id=v_component.component_product_id
              and variant_id is null;
          else
            update public.variant_stock_balances
            set quantity=quantity-v_component_qty,updated_at=timezone('utc',now())
            where company_id=p_company_id
              and warehouse_id=p_warehouse_id
              and product_id=v_component.component_product_id
              and variant_id=v_component.component_variant_id;
          end if;

          insert into public.stock_movements(
            id,company_id,warehouse_id,product_id,movement_type,quantity,reference_type,reference_id,
            created_by,occurred_at,variant_id,note
          )
          values(
            gen_random_uuid(),p_company_id,p_warehouse_id,v_component.component_product_id,'sale',
            -v_component_qty,'sale',p_sale_id,v_auth,timezone('utc',now()),v_component.component_variant_id,
            'Kit: '||v_product.name
          );
        end loop;
      else
        if v_variant_id is null then
          update public.stock_balances
          set quantity=quantity-v_qty,updated_at=timezone('utc',now())
          where company_id=p_company_id
            and warehouse_id=p_warehouse_id
            and product_id=v_product_id
            and variant_id is null;
        else
          update public.variant_stock_balances
          set quantity=quantity-v_qty,updated_at=timezone('utc',now())
          where company_id=p_company_id
            and warehouse_id=p_warehouse_id
            and product_id=v_product_id
            and variant_id=v_variant_id;
        end if;

        insert into public.stock_movements(
          id,company_id,warehouse_id,product_id,movement_type,quantity,reference_type,reference_id,
          created_by,occurred_at,variant_id,note
        )
        values(
          gen_random_uuid(),p_company_id,p_warehouse_id,v_product_id,'sale',-v_qty,'sale',p_sale_id,
          v_auth,timezone('utc',now()),v_variant_id,null
        );
      end if;
    end if;
  end loop;

  for v_payment in select value from jsonb_array_elements(p_payments) loop
    v_method := case coalesce(v_payment->>'method','cash')
      when 'transfer' then 'bank_transfer'::public.payment_method
      when 'bank_transfer' then 'bank_transfer'::public.payment_method
      when 'card' then 'card'::public.payment_method
      when 'other' then 'other'::public.payment_method
      else 'cash'::public.payment_method
    end;
    begin
      v_exchange_rate := coalesce((v_payment->>'exchange_rate')::numeric,(v_payment->>'exchangeRate')::numeric,1);
    exception when others then
      raise exception 'invalid_exchange_rate';
    end;
    insert into public.payments(
      id,company_id,sale_id,method,currency_code,amount,exchange_rate,reference,created_by
    )
    values(
      gen_random_uuid(),p_company_id,p_sale_id,v_method,
      coalesce(nullif(v_payment->>'currency_code',''),nullif(v_payment->>'currencyCode',''),v_currency),
      (v_payment->>'amount')::numeric,
      v_exchange_rate,
      nullif(v_payment->>'reference',''),
      v_auth
    );
  end loop;

  return jsonb_build_object('success',true,'id',p_sale_id,'already_existed',false);

exception when unique_violation then
  select * into v_existing from public.sales
  where id=p_sale_id and company_id=p_company_id
  limit 1;
  if found then
    return jsonb_build_object('success',true,'id',v_existing.id,'already_existed',true);
  end if;
  raise;
end;
$function$

