-- FASE 28 - Estabilidad de sincronización offline/POS
-- Aplicar después de FASE 27. Incluye índices de FKs y endurece idempotencia.

-- Rendimiento: índices para las FKs calientes del POS/CRM.
CREATE INDEX IF NOT EXISTS idx_bank_transactions_card_id ON public.bank_transactions(card_id);
CREATE INDEX IF NOT EXISTS idx_cash_sessions_branch_id ON public.cash_sessions(branch_id);
CREATE INDEX IF NOT EXISTS idx_cash_sessions_user_id ON public.cash_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_idn_settlement_prices_product_id ON public.idn_settlement_prices(product_id);
CREATE INDEX IF NOT EXISTS idx_idn_settlement_prices_user_id ON public.idn_settlement_prices(user_id);
CREATE INDEX IF NOT EXISTS idx_inventory_branch_id ON public.inventory(branch_id);
CREATE INDEX IF NOT EXISTS idx_inventory_product_id ON public.inventory(product_id);
CREATE INDEX IF NOT EXISTS idx_inventory_audit_items_audit_id ON public.inventory_audit_items(audit_id);
CREATE INDEX IF NOT EXISTS idx_inventory_audit_items_product_id ON public.inventory_audit_items(product_id);
CREATE INDEX IF NOT EXISTS idx_inventory_audits_branch_id ON public.inventory_audits(branch_id);
CREATE INDEX IF NOT EXISTS idx_inventory_audits_user_id ON public.inventory_audits(user_id);
CREATE INDEX IF NOT EXISTS idx_inventory_movements_branch_id ON public.inventory_movements(branch_id);
CREATE INDEX IF NOT EXISTS idx_inventory_movements_product_id ON public.inventory_movements(product_id);
CREATE INDEX IF NOT EXISTS idx_inventory_transfers_from_branch_id ON public.inventory_transfers(from_branch_id);
CREATE INDEX IF NOT EXISTS idx_inventory_transfers_product_id ON public.inventory_transfers(product_id);
CREATE INDEX IF NOT EXISTS idx_inventory_transfers_to_branch_id ON public.inventory_transfers(to_branch_id);
CREATE INDEX IF NOT EXISTS idx_inventory_transfers_user_id ON public.inventory_transfers(user_id);
CREATE INDEX IF NOT EXISTS idx_products_category_id ON public.products(category_id);
CREATE INDEX IF NOT EXISTS idx_quotes_branch_id ON public.quotes(branch_id);
CREATE INDEX IF NOT EXISTS idx_quotes_customer_id ON public.quotes(customer_id);
CREATE INDEX IF NOT EXISTS idx_quotes_user_id ON public.quotes(user_id);
CREATE INDEX IF NOT EXISTS idx_returns_product_id ON public.returns(product_id);
CREATE INDEX IF NOT EXISTS idx_returns_transaction_id ON public.returns(transaction_id);
CREATE INDEX IF NOT EXISTS idx_salary_settlements_session_id ON public.salary_settlements(session_id);
CREATE INDEX IF NOT EXISTS idx_salary_settlements_user_id ON public.salary_settlements(user_id);
CREATE INDEX IF NOT EXISTS idx_supplier_orders_branch_id ON public.supplier_orders(branch_id);
CREATE INDEX IF NOT EXISTS idx_supplier_orders_supplier_id ON public.supplier_orders(supplier_id);
CREATE INDEX IF NOT EXISTS idx_time_shifts_user_id ON public.time_shifts(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_branch_id ON public.transactions(branch_id);
CREATE INDEX IF NOT EXISTS idx_transactions_customer_id ON public.transactions(customer_id);
CREATE INDEX IF NOT EXISTS idx_transactions_session_id ON public.transactions(session_id);
CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON public.transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_users_assigned_branch_id ON public.users(assigned_branch_id);
CREATE INDEX IF NOT EXISTS idx_users_branch_id ON public.users(branch_id);
CREATE INDEX IF NOT EXISTS idx_users_supervisor_id ON public.users(supervisor_id);
CREATE INDEX IF NOT EXISTS idx_warranties_customer_id ON public.warranties(customer_id);
CREATE INDEX IF NOT EXISTS idx_warranties_product_id ON public.warranties(product_id);
CREATE INDEX IF NOT EXISTS idx_warranties_transaction_id ON public.warranties(transaction_id);

-- Evita que una caché vieja de PostgREST quede sin refrescar después de DDL.
NOTIFY pgrst, 'reload schema';

-- process_pos_transaction_v2: el ID de la operación también queda registrado
-- en idempotency_key, además de la PK, para mantener una segunda barrera contra
-- reintentos/replays accidentales.
CREATE OR REPLACE FUNCTION public.process_pos_transaction_v2(
  p_id text, p_branch_id text, p_user_id text, p_date timestamptz,
  p_total numeric, p_tax numeric, p_discount numeric, p_items jsonb,
  p_payments jsonb, p_payment_method text, p_session_id text,
  p_customer_id text, p_notes text
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE v_req RECORD; v_inv inventory%ROWTYPE;
BEGIN
  IF NULLIF(btrim(p_id),'') IS NULL THEN RAISE EXCEPTION 'ID de transacción requerido'; END IF;
  IF EXISTS (SELECT 1 FROM transactions WHERE id=p_id OR idempotency_key=p_id) THEN
    RETURN jsonb_build_object('success',true,'id',p_id,'already_existed',true);
  END IF;
  IF p_session_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM cash_sessions WHERE id=p_session_id AND branch_id=p_branch_id AND status='open' AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'El turno % no está abierto o no pertenece a la sucursal %',p_session_id,p_branch_id;
  END IF;
  FOR v_req IN
    WITH raw AS (
      SELECT x.product_id, COALESCE(x.variant_label,'') variant_label, x.quantity required
      FROM jsonb_to_recordset(p_items) x(product_id text,quantity integer,variant_label text,is_kit boolean,kit_components jsonb)
      WHERE COALESCE(x.is_kit,false)=false
      UNION ALL
      SELECT c.product_id, '', c.quantity*x.quantity
      FROM jsonb_to_recordset(p_items) x(product_id text,quantity integer,variant_label text,is_kit boolean,kit_components jsonb)
      CROSS JOIN LATERAL jsonb_to_recordset(COALESCE(x.kit_components,'[]'::jsonb)) c(product_id text,quantity integer)
      WHERE COALESCE(x.is_kit,false)=true
    )
    SELECT product_id,variant_label,SUM(required)::integer required FROM raw GROUP BY product_id,variant_label ORDER BY product_id,variant_label
  LOOP
    IF v_req.required IS NULL OR v_req.required<=0 THEN RAISE EXCEPTION 'Cantidad inválida para producto %',v_req.product_id; END IF;
    PERFORM pg_advisory_xact_lock(hashtext('inventory:'||v_req.product_id||':'||p_branch_id||':'||v_req.variant_label));
    SELECT * INTO v_inv FROM inventory WHERE product_id=v_req.product_id AND branch_id=p_branch_id AND COALESCE(variant_label,'')=v_req.variant_label FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'No existe inventario para producto %',v_req.product_id; END IF;
    IF v_inv.quantity<v_req.required THEN RAISE EXCEPTION 'Stock insuficiente para producto %: disponible %, requerido %',v_req.product_id,v_inv.quantity,v_req.required; END IF;
    UPDATE inventory SET quantity=quantity-v_req.required WHERE id=v_inv.id;
  END LOOP;
  INSERT INTO transactions(id,idempotency_key,branch_id,user_id,date,total,tax,discount,items,payments,payment_method,session_id,customer_id,notes,status,created_at)
  VALUES(p_id,p_id,p_branch_id,p_user_id,p_date,p_total,p_tax,p_discount,p_items,p_payments,p_payment_method,p_session_id,p_customer_id,p_notes,'completed',NOW());
  INSERT INTO inventory_movements(product_id,branch_id,variant_label,quantity_delta,movement_type,reference_id,user_id,metadata)
  SELECT r.product_id,p_branch_id,r.variant_label,-r.required,
    CASE WHEN EXISTS (SELECT 1 FROM jsonb_to_recordset(p_items) x(product_id text,quantity integer,variant_label text,is_kit boolean,kit_components jsonb)
      WHERE x.is_kit=true AND EXISTS (SELECT 1 FROM jsonb_to_recordset(COALESCE(x.kit_components,'[]'::jsonb)) c(product_id text,quantity integer) WHERE c.product_id=r.product_id))
      THEN 'KIT_CONSUMPTION' ELSE 'SALE' END,
    p_id,p_user_id,NULL
  FROM (WITH raw AS (
    SELECT x.product_id,COALESCE(x.variant_label,'') variant_label,x.quantity required FROM jsonb_to_recordset(p_items) x(product_id text,quantity integer,variant_label text,is_kit boolean,kit_components jsonb) WHERE COALESCE(x.is_kit,false)=false
    UNION ALL
    SELECT c.product_id,'',c.quantity*x.quantity FROM jsonb_to_recordset(p_items) x(product_id text,quantity integer,variant_label text,is_kit boolean,kit_components jsonb) CROSS JOIN LATERAL jsonb_to_recordset(COALESCE(x.kit_components,'[]'::jsonb)) c(product_id text,quantity integer) WHERE COALESCE(x.is_kit,false)=true
  ) SELECT product_id,variant_label,SUM(required)::integer required FROM raw GROUP BY product_id,variant_label) r;
  INSERT INTO audit_log(user_id,action,entity_type,entity_id,meta) VALUES(p_user_id,'PROCESS_TRANSACTION','transaction',p_id,jsonb_build_object('total',p_total,'session_id',p_session_id));
  RETURN jsonb_build_object('success',true,'id',p_id);
END $function$;

-- Reconciliaciones: el chequeo de idempotencia se limita a la misma entidad,
-- evitando que una operación ID reutilizada en otro producto sea considerada ya aplicada.
CREATE OR REPLACE FUNCTION public.reconcile_inventory_v2(
  p_operation_id text,p_product_id text,p_branch_id text,p_variant_label text,
  p_expected_quantity integer,p_new_quantity integer,p_min_quantity integer,p_user_id text
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE v_inv inventory%ROWTYPE; v_variant text:=coalesce(p_variant_label,''); v_delta integer;
BEGIN
  IF NULLIF(btrim(p_operation_id),'') IS NULL THEN RAISE EXCEPTION 'ID de operación requerido'; END IF;
  IF EXISTS (SELECT 1 FROM inventory_movements WHERE reference_id=p_operation_id AND product_id=p_product_id AND branch_id=p_branch_id AND COALESCE(variant_label,'')=v_variant) THEN
    RETURN jsonb_build_object('success',true,'already_applied',true,'operation_id',p_operation_id);
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('inventory:'||p_product_id||':'||p_branch_id||':'||v_variant));
  SELECT * INTO v_inv FROM inventory WHERE product_id=p_product_id AND branch_id=p_branch_id AND COALESCE(variant_label,'')=v_variant FOR UPDATE;
  IF NOT FOUND THEN
    IF COALESCE(p_expected_quantity,0)<>0 THEN RETURN jsonb_build_object('success',false,'conflict',true,'message','El inventario ya no coincide con el valor visto offline.'); END IF;
    INSERT INTO inventory(id,product_id,branch_id,variant_label,quantity,min_quantity) VALUES(gen_random_uuid()::text,p_product_id,p_branch_id,v_variant,GREATEST(0,p_new_quantity),COALESCE(p_min_quantity,5)) RETURNING * INTO v_inv;
    v_delta:=GREATEST(0,p_new_quantity);
  ELSE
    IF v_inv.quantity<>COALESCE(p_expected_quantity,0) THEN RETURN jsonb_build_object('success',false,'conflict',true,'message',format('Conflicto: servidor tiene %, dispositivo esperaba %.',v_inv.quantity,p_expected_quantity)); END IF;
    v_delta:=GREATEST(0,p_new_quantity)-v_inv.quantity;
    UPDATE inventory SET quantity=GREATEST(0,p_new_quantity),min_quantity=COALESCE(p_min_quantity,v_inv.min_quantity) WHERE id=v_inv.id RETURNING * INTO v_inv;
  END IF;
  -- Incluso un delta cero necesita una marca durable para que el replay sea idempotente.
  INSERT INTO inventory_movements(product_id,branch_id,variant_label,quantity_delta,movement_type,reference_id,user_id)
  VALUES(p_product_id,p_branch_id,v_variant,v_delta,'RECONCILIATION',p_operation_id,p_user_id);
  RETURN jsonb_build_object('success',true,'quantity',v_inv.quantity,'operation_id',p_operation_id);
END $function$;

NOTIFY pgrst, 'reload schema';
