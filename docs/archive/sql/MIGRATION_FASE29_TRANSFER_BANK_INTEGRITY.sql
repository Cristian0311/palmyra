-- FASE 29: integridad de transferencias y cuentas bancarias
-- Repetible: usa IF NOT EXISTS / CREATE OR REPLACE.
-- Después de aplicar: NOTIFY pgrst, 'reload schema';

ALTER TABLE public.inventory_transfers
  ADD COLUMN IF NOT EXISTS batch_id text;

CREATE INDEX IF NOT EXISTS idx_inventory_transfers_batch_id
  ON public.inventory_transfers(batch_id);

DROP FUNCTION IF EXISTS public.process_inventory_transfer_v2(text,text,text,text,jsonb,text);

CREATE OR REPLACE FUNCTION public.process_inventory_transfer_v2(
  p_operation_id text,
  p_batch_id text,
  p_product_id text,
  p_from_branch_id text,
  p_to_branch_id text,
  p_variants jsonb,
  p_user_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v RECORD;
  src public.inventory%ROWTYPE;
  first_branch text;
  second_branch text;
BEGIN
  IF NULLIF(btrim(p_operation_id),'') IS NULL THEN
    RAISE EXCEPTION 'ID de operación requerido' USING ERRCODE='P0001';
  END IF;
  IF NULLIF(btrim(p_product_id),'') IS NULL THEN
    RAISE EXCEPTION 'Producto requerido' USING ERRCODE='P0001';
  END IF;
  IF p_from_branch_id=p_to_branch_id THEN
    RAISE EXCEPTION 'Origen y destino no pueden coincidir' USING ERRCODE='P0001';
  END IF;

  IF EXISTS (SELECT 1 FROM public.inventory_transfers WHERE operation_id=p_operation_id) THEN
    RETURN jsonb_build_object('success',true,'operation_id',p_operation_id,
      'batch_id',p_batch_id,'already_existed',true);
  END IF;

  IF p_from_branch_id<p_to_branch_id THEN
    first_branch:=p_from_branch_id; second_branch:=p_to_branch_id;
  ELSE
    first_branch:=p_to_branch_id; second_branch:=p_from_branch_id;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('transfer:'||p_product_id||':'||first_branch));
  PERFORM pg_advisory_xact_lock(hashtext('transfer:'||p_product_id||':'||second_branch));

  FOR v IN
    SELECT COALESCE(x.variant_label,'') AS variant_label,SUM(x.quantity)::integer AS quantity
    FROM jsonb_to_recordset(p_variants) AS x(variant_label text,quantity integer)
    GROUP BY COALESCE(x.variant_label,'')
  LOOP
    IF v.quantity<=0 THEN
      RAISE EXCEPTION 'Cantidad inválida en transferencia' USING ERRCODE='P0001';
    END IF;
    SELECT * INTO src FROM public.inventory
    WHERE product_id=p_product_id AND branch_id=p_from_branch_id
      AND COALESCE(variant_label,'')=v.variant_label
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'No existe stock origen para variante %',v.variant_label USING ERRCODE='P0001';
    END IF;
    IF src.quantity<v.quantity THEN
      RAISE EXCEPTION 'Stock insuficiente en origen: disponible %, requerido %',src.quantity,v.quantity USING ERRCODE='P0001';
    END IF;
  END LOOP;

  FOR v IN
    SELECT COALESCE(x.variant_label,'') AS variant_label,SUM(x.quantity)::integer AS quantity
    FROM jsonb_to_recordset(p_variants) AS x(variant_label text,quantity integer)
    GROUP BY COALESCE(x.variant_label,'')
  LOOP
    UPDATE public.inventory SET quantity=quantity-v.quantity
    WHERE product_id=p_product_id AND branch_id=p_from_branch_id
      AND COALESCE(variant_label,'')=v.variant_label;

    INSERT INTO public.inventory_movements(
      product_id,branch_id,variant_label,quantity_delta,movement_type,reference_id,user_id,metadata
    ) VALUES (
      p_product_id,p_from_branch_id,v.variant_label,-v.quantity,'TRANSFER_OUT',
      p_operation_id,NULLIF(p_user_id,'system'),jsonb_build_object('batch_id',p_batch_id)
    );

    UPDATE public.inventory SET quantity=quantity+v.quantity
    WHERE product_id=p_product_id AND branch_id=p_to_branch_id
      AND COALESCE(variant_label,'')=v.variant_label;

    IF NOT FOUND THEN
      INSERT INTO public.inventory(product_id,branch_id,variant_label,quantity,min_quantity,id)
      VALUES(p_product_id,p_to_branch_id,v.variant_label,v.quantity,5,gen_random_uuid()::text);
    END IF;

    INSERT INTO public.inventory_movements(
      product_id,branch_id,variant_label,quantity_delta,movement_type,reference_id,user_id,metadata
    ) VALUES (
      p_product_id,p_to_branch_id,v.variant_label,v.quantity,'TRANSFER_IN',
      p_operation_id,NULLIF(p_user_id,'system'),jsonb_build_object('batch_id',p_batch_id)
    );
  END LOOP;

  INSERT INTO public.inventory_transfers(
    id,operation_id,batch_id,product_id,product_name,
    from_branch_id,from_branch_name,to_branch_id,to_branch_name,
    variant_label,quantity,variants,date,user_id,status
  )
  SELECT
    p_operation_id,p_operation_id,NULLIF(btrim(p_batch_id),''),
    p_product_id,p.name,p_from_branch_id,bf.name,p_to_branch_id,bt.name,
    COALESCE((
      SELECT string_agg(
        CASE WHEN COALESCE(x.variant_label,'')='' THEN 'Producto Base' ELSE x.variant_label END
        || ': ' || x.quantity, ', '
        ORDER BY CASE WHEN COALESCE(x.variant_label,'')='' THEN 0 ELSE 1 END,x.variant_label
      )
      FROM (
        SELECT COALESCE(y.variant_label,'') variant_label,SUM(y.quantity)::integer quantity
        FROM jsonb_to_recordset(p_variants) y(variant_label text,quantity integer)
        GROUP BY COALESCE(y.variant_label,'')
      ) x
    ),'Producto Base'),
    (SELECT COALESCE(SUM(quantity),0)
     FROM jsonb_to_recordset(p_variants) AS x(variant_label text,quantity integer)),
    p_variants,NOW(),NULLIF(p_user_id,'system'),'completed'
  FROM public.products p
  JOIN public.branches bf ON bf.id=p_from_branch_id
  JOIN public.branches bt ON bt.id=p_to_branch_id
  WHERE p.id=p_product_id;

  RETURN jsonb_build_object('success',true,'operation_id',p_operation_id,'batch_id',p_batch_id);
END
$function$;

CREATE OR REPLACE FUNCTION public.process_bank_internal_transfer_v2(
  p_operation_id text,
  p_from_card_id text,
  p_to_card_id text,
  p_amount numeric,
  p_target_amount numeric,
  p_date timestamptz,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_from public.bank_cards%ROWTYPE;
  v_to public.bank_cards%ROWTYPE;
  v_out_id text;
  v_in_id text;
BEGIN
  IF NULLIF(btrim(p_operation_id),'') IS NULL THEN
    RAISE EXCEPTION 'ID de operación requerido' USING ERRCODE='P0001';
  END IF;
  IF p_from_card_id IS NULL OR p_to_card_id IS NULL OR p_from_card_id=p_to_card_id THEN
    RAISE EXCEPTION 'Las cuentas bancaria de origen y destino deben ser diferentes' USING ERRCODE='P0001';
  END IF;
  IF COALESCE(p_amount,0)<=0 OR COALESCE(p_target_amount,0)<=0 THEN
    RAISE EXCEPTION 'El monto de transferencia debe ser mayor que 0' USING ERRCODE='P0001';
  END IF;

  SELECT * INTO v_from FROM public.bank_cards WHERE id=p_from_card_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'No existe la cuenta bancaria de origen' USING ERRCODE='P0001'; END IF;
  SELECT * INTO v_to FROM public.bank_cards WHERE id=p_to_card_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'No existe la cuenta bancaria de destino' USING ERRCODE='P0001'; END IF;

  SELECT id INTO v_out_id FROM public.bank_transactions
  WHERE reference=p_operation_id AND card_id=p_from_card_id AND id=p_operation_id||':OUT' LIMIT 1;
  SELECT id INTO v_in_id FROM public.bank_transactions
  WHERE reference=p_operation_id AND card_id=p_to_card_id AND id=p_operation_id||':IN' LIMIT 1;

  IF v_out_id IS NOT NULL AND v_in_id IS NOT NULL THEN
    RETURN jsonb_build_object('success',true,'operation_id',p_operation_id,'already_existed',true,
      'from_balance',v_from.balance,'to_balance',v_to.balance);
  END IF;
  IF v_out_id IS NOT NULL OR v_in_id IS NOT NULL THEN
    RAISE EXCEPTION 'La transferencia bancaria % quedó incompleta y no se puede repetir automáticamente',p_operation_id USING ERRCODE='P0001';
  END IF;

  IF v_from.balance < p_amount THEN
    RAISE EXCEPTION 'Saldo insuficiente en la cuenta de origen: disponible %, requerido %',v_from.balance,p_amount USING ERRCODE='P0001';
  END IF;

  UPDATE public.bank_cards SET balance=balance-p_amount WHERE id=p_from_card_id;
  UPDATE public.bank_cards SET balance=balance+p_target_amount WHERE id=p_to_card_id;

  v_out_id := p_operation_id||':OUT';
  v_in_id := p_operation_id||':IN';

  INSERT INTO public.bank_transactions(id,card_id,type,amount,date,reference,description,transaction_id)
  VALUES(v_out_id,p_from_card_id,'withdrawal',p_amount,COALESCE(p_date,NOW()),p_operation_id,
    'Transferencia bancaria a '||COALESCE(v_to.name,v_to.bank_name,'Cuenta destino')||
      CASE WHEN NULLIF(btrim(COALESCE(p_reason,'')),'') IS NOT NULL THEN ': '||p_reason ELSE '' END,
    p_operation_id);

  INSERT INTO public.bank_transactions(id,card_id,type,amount,date,reference,description,transaction_id)
  VALUES(v_in_id,p_to_card_id,'deposit',p_target_amount,COALESCE(p_date,NOW()),p_operation_id,
    'Transferencia bancaria desde '||COALESCE(v_from.name,v_from.bank_name,'Cuenta origen')||
      CASE WHEN NULLIF(btrim(COALESCE(p_reason,'')),'') IS NOT NULL THEN ': '||p_reason ELSE '' END,
    p_operation_id);

  INSERT INTO public.audit_log(user_id,action,entity_type,entity_id,new_data,meta)
  VALUES (
    NULLIF(current_setting('request.jwt.claim.sub', true),''),
    'BANK_INTERNAL_TRANSFER','bank_transfer',p_operation_id,
    jsonb_build_object('from_card_id',p_from_card_id,'to_card_id',p_to_card_id,'amount',p_amount,'target_amount',p_target_amount),
    jsonb_build_object('reason',p_reason)
  );

  RETURN jsonb_build_object('success',true,'operation_id',p_operation_id,
    'from_balance',v_from.balance-p_amount,'to_balance',v_to.balance+p_target_amount);
END
$function$;

CREATE OR REPLACE FUNCTION public.delete_bank_internal_transfer_v2(p_operation_id text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_out public.bank_transactions%ROWTYPE;
  v_in public.bank_transactions%ROWTYPE;
  v_from public.bank_cards%ROWTYPE;
  v_to public.bank_cards%ROWTYPE;
BEGIN
  IF NULLIF(btrim(p_operation_id),'') IS NULL THEN
    RAISE EXCEPTION 'ID de operación requerido' USING ERRCODE='P0001';
  END IF;

  SELECT * INTO v_out
  FROM public.bank_transactions
  WHERE (transaction_id=p_operation_id OR id=p_operation_id||':OUT')
    AND type='withdrawal'
  ORDER BY created_at DESC LIMIT 1
  FOR UPDATE;

  SELECT * INTO v_in
  FROM public.bank_transactions
  WHERE (transaction_id=p_operation_id OR id=p_operation_id||':IN')
    AND type='deposit'
  ORDER BY created_at DESC LIMIT 1
  FOR UPDATE;

  IF v_out.id IS NULL AND v_in.id IS NULL THEN
    RETURN jsonb_build_object('success',true,'operation_id',p_operation_id,'already_deleted',true);
  END IF;
  IF v_out.id IS NULL OR v_in.id IS NULL THEN
    RAISE EXCEPTION 'No se puede eliminar una transferencia bancaria incompleta: %',p_operation_id USING ERRCODE='P0001';
  END IF;

  IF v_out.card_id < v_in.card_id THEN
    SELECT * INTO v_from FROM public.bank_cards WHERE id=v_out.card_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'No existe la cuenta origen de la transferencia' USING ERRCODE='P0001'; END IF;
    SELECT * INTO v_to FROM public.bank_cards WHERE id=v_in.card_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'No existe la cuenta destino de la transferencia' USING ERRCODE='P0001'; END IF;
  ELSE
    SELECT * INTO v_to FROM public.bank_cards WHERE id=v_in.card_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'No existe la cuenta destino de la transferencia' USING ERRCODE='P0001'; END IF;
    SELECT * INTO v_from FROM public.bank_cards WHERE id=v_out.card_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'No existe la cuenta origen de la transferencia' USING ERRCODE='P0001'; END IF;
  END IF;

  IF v_to.balance < v_in.amount THEN
    RAISE EXCEPTION 'No se puede revertir la transferencia: el saldo destino (%) es menor que el crédito a revertir (%)',v_to.balance,v_in.amount USING ERRCODE='P0001';
  END IF;

  UPDATE public.bank_cards SET balance=balance+v_out.amount WHERE id=v_from.id;
  UPDATE public.bank_cards SET balance=balance-v_in.amount WHERE id=v_to.id;

  INSERT INTO public.audit_log(user_id,action,entity_type,entity_id,old_data,new_data)
  VALUES (
    NULLIF(current_setting('request.jwt.claim.sub', true),''),
    'BANK_INTERNAL_TRANSFER_DELETE','bank_transfer',p_operation_id,
    jsonb_build_object('out',to_jsonb(v_out),'in',to_jsonb(v_in)),
    jsonb_build_object('from_balance',v_from.balance+v_out.amount,'to_balance',v_to.balance-v_in.amount)
  );

  DELETE FROM public.bank_transactions WHERE id IN (v_out.id,v_in.id);

  RETURN jsonb_build_object('success',true,'operation_id',p_operation_id,
    'from_card_id',v_from.id,'to_card_id',v_to.id,
    'from_balance',v_from.balance+v_out.amount,'to_balance',v_to.balance-v_in.amount);
END
$function$;

CREATE OR REPLACE FUNCTION public.delete_bank_transaction_v2(p_transaction_id text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_tx public.bank_transactions%ROWTYPE;
  v_card public.bank_cards%ROWTYPE;
  v_new_balance numeric;
BEGIN
  IF NULLIF(btrim(p_transaction_id),'') IS NULL THEN
    RAISE EXCEPTION 'ID de movimiento requerido' USING ERRCODE='P0001';
  END IF;

  SELECT * INTO v_tx FROM public.bank_transactions WHERE id=p_transaction_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success',true,'transaction_id',p_transaction_id,'already_deleted',true);
  END IF;

  IF v_tx.transaction_id IS NOT NULL OR v_tx.id LIKE '%:OUT' OR v_tx.id LIKE '%:IN' THEN
    RETURN public.delete_bank_internal_transfer_v2(COALESCE(v_tx.transaction_id, regexp_replace(v_tx.id, ':(OUT|IN)$', '')));
  END IF;

  SELECT * INTO v_card FROM public.bank_cards WHERE id=v_tx.card_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'La cuenta bancaria del movimiento no existe' USING ERRCODE='P0001';
  END IF;

  IF v_tx.type IN ('withdrawal','supplier_payment') THEN
    v_new_balance := v_card.balance + v_tx.amount;
  ELSIF v_tx.type IN ('deposit','payment_received') THEN
    IF v_card.balance < v_tx.amount THEN
      RAISE EXCEPTION 'No se puede revertir el crédito: saldo actual % menor que %',v_card.balance,v_tx.amount USING ERRCODE='P0001';
    END IF;
    v_new_balance := v_card.balance - v_tx.amount;
  ELSE
    RAISE EXCEPTION 'Tipo de movimiento no soporta eliminación automática: %',v_tx.type USING ERRCODE='P0001';
  END IF;

  UPDATE public.bank_cards SET balance=v_new_balance WHERE id=v_card.id;

  INSERT INTO public.audit_log(user_id,action,entity_type,entity_id,old_data,new_data)
  VALUES (
    NULLIF(current_setting('request.jwt.claim.sub', true),''),
    'BANK_TRANSACTION_DELETE','bank_transaction',v_tx.id,
    to_jsonb(v_tx),
    jsonb_build_object('card_id',v_card.id,'balance_before',v_card.balance,'balance_after',v_new_balance)
  );

  DELETE FROM public.bank_transactions WHERE id=v_tx.id;

  RETURN jsonb_build_object('success',true,'transaction_id',v_tx.id,'card_id',v_card.id,'balance',v_new_balance);
END
$function$;

CREATE OR REPLACE FUNCTION public.delete_bank_card_safe_v2(p_card_id text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_card public.bank_cards%ROWTYPE;
  v_count integer;
BEGIN
  SELECT * INTO v_card FROM public.bank_cards WHERE id=p_card_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success',true,'already_deleted',true,'card_id',p_card_id);
  END IF;

  SELECT count(*) INTO v_count FROM public.bank_transactions WHERE card_id=p_card_id;
  IF v_count > 0 THEN
    RAISE EXCEPTION 'No se puede eliminar la cuenta: conserva % movimiento(s) bancario(s). Desactívala en lugar de borrarla.',v_count USING ERRCODE='P0001';
  END IF;

  INSERT INTO public.audit_log(user_id,action,entity_type,entity_id,old_data)
  VALUES (
    NULLIF(current_setting('request.jwt.claim.sub', true),''),
    'BANK_CARD_DELETE','bank_card',v_card.id,to_jsonb(v_card)
  );

  DELETE FROM public.bank_cards WHERE id=p_card_id;
  RETURN jsonb_build_object('success',true,'card_id',p_card_id);
END
$function$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_transactions_card_reference
  ON public.bank_transactions(card_id,reference)
  WHERE reference IS NOT NULL AND btrim(reference)<>'';

CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_cards_account_number
  ON public.bank_cards(account_number)
  WHERE account_number IS NOT NULL AND btrim(account_number)<>'';

ALTER TABLE public.bank_cards DROP CONSTRAINT IF EXISTS bank_cards_balance_nonnegative;
ALTER TABLE public.bank_cards ADD CONSTRAINT bank_cards_balance_nonnegative CHECK (balance >= 0);

ALTER TABLE public.bank_transactions DROP CONSTRAINT IF EXISTS bank_transactions_amount_positive;
ALTER TABLE public.bank_transactions ADD CONSTRAINT bank_transactions_amount_positive CHECK (amount > 0);

CREATE OR REPLACE FUNCTION public.process_bank_transaction_v2(
  p_id text,
  p_card_id text,
  p_type text,
  p_amount numeric,
  p_date timestamptz,
  p_reference text,
  p_description text,
  p_transaction_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_card public.bank_cards%ROWTYPE;
  v_existing public.bank_transactions%ROWTYPE;
  v_new_balance numeric;
BEGIN
  IF NULLIF(btrim(p_id),'') IS NULL THEN RAISE EXCEPTION 'ID de movimiento requerido' USING ERRCODE='P0001'; END IF;
  IF p_card_id IS NULL THEN RAISE EXCEPTION 'Cuenta bancaria requerida' USING ERRCODE='P0001'; END IF;
  IF COALESCE(p_amount,0)<=0 THEN RAISE EXCEPTION 'El importe debe ser mayor que 0' USING ERRCODE='P0001'; END IF;
  IF p_type NOT IN ('deposit','withdrawal','payment_received','supplier_payment') THEN
    RAISE EXCEPTION 'Tipo de movimiento bancario no soportado: %',p_type USING ERRCODE='P0001';
  END IF;

  SELECT * INTO v_existing FROM public.bank_transactions WHERE id=p_id FOR UPDATE;
  IF FOUND THEN
    RETURN jsonb_build_object('success',true,'already_existed',true,'transaction_id',v_existing.id,
      'card_id',v_existing.card_id,'balance',(SELECT balance FROM public.bank_cards WHERE id=v_existing.card_id));
  END IF;

  SELECT * INTO v_card FROM public.bank_cards WHERE id=p_card_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'La cuenta bancaria no existe' USING ERRCODE='P0001'; END IF;

  IF p_reference IS NOT NULL AND btrim(p_reference)<>'' THEN
    SELECT * INTO v_existing FROM public.bank_transactions
    WHERE card_id=p_card_id AND reference=p_reference
    ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
    IF FOUND THEN
      RETURN jsonb_build_object('success',true,'already_existed',true,'transaction_id',v_existing.id,
        'card_id',v_existing.card_id,'balance',v_card.balance);
    END IF;
  END IF;

  IF p_type IN ('withdrawal','supplier_payment') THEN
    IF v_card.balance < p_amount THEN
      RAISE EXCEPTION 'Saldo insuficiente en la cuenta: disponible %, requerido %',v_card.balance,p_amount USING ERRCODE='P0001';
    END IF;
    v_new_balance := v_card.balance-p_amount;
  ELSE
    v_new_balance := v_card.balance+p_amount;
  END IF;

  UPDATE public.bank_cards SET balance=v_new_balance WHERE id=p_card_id;

  INSERT INTO public.bank_transactions(
    id,card_id,type,amount,date,reference,description,transaction_id
  ) VALUES (
    p_id,p_card_id,p_type,p_amount,COALESCE(p_date,NOW()),NULLIF(btrim(p_reference),''),
    COALESCE(p_description,''),NULLIF(btrim(p_transaction_id),'')
  );

  RETURN jsonb_build_object('success',true,'transaction_id',p_id,'card_id',p_card_id,'balance',v_new_balance);
END
$function$;

NOTIFY pgrst,'reload schema';


-- FASE 29B: bank transaction atomicity final
-- Reaplica las RPC despues de cualquier definicion anterior del mismo archivo.
CREATE OR REPLACE FUNCTION public.process_bank_transaction_v2(
  p_id text,p_card_id text,p_type text,p_amount numeric,p_date timestamptz,
  p_reference text,p_description text,p_transaction_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_card public.bank_cards%ROWTYPE; v_existing public.bank_transactions%ROWTYPE;
  v_new_balance numeric; v_user_id text;
BEGIN
  IF NULLIF(btrim(p_id),'') IS NULL THEN RAISE EXCEPTION 'ID de movimiento requerido' USING ERRCODE='P0001'; END IF;
  IF p_card_id IS NULL THEN RAISE EXCEPTION 'Cuenta bancaria requerida' USING ERRCODE='P0001'; END IF;
  IF COALESCE(p_amount,0)<=0 THEN RAISE EXCEPTION 'El importe debe ser mayor que 0' USING ERRCODE='P0001'; END IF;
  IF p_type NOT IN ('deposit','withdrawal','payment_received','supplier_payment') THEN
    RAISE EXCEPTION 'Tipo de movimiento bancario no soportado: %',p_type USING ERRCODE='P0001';
  END IF;
  SELECT * INTO v_existing FROM public.bank_transactions WHERE id=p_id FOR UPDATE;
  IF FOUND THEN
    RETURN jsonb_build_object('success',true,'already_existed',true,'transaction_id',v_existing.id,'card_id',v_existing.card_id,
      'balance',(SELECT balance FROM public.bank_cards WHERE id=v_existing.card_id));
  END IF;
  SELECT * INTO v_card FROM public.bank_cards WHERE id=p_card_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'La cuenta bancaria no existe' USING ERRCODE='P0001'; END IF;
  IF p_reference IS NOT NULL AND btrim(p_reference)<>'' THEN
    SELECT * INTO v_existing FROM public.bank_transactions WHERE card_id=p_card_id AND reference=p_reference
      ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
    IF FOUND THEN
      RETURN jsonb_build_object('success',true,'already_existed',true,'transaction_id',v_existing.id,'card_id',v_existing.card_id,'balance',v_card.balance);
    END IF;
  END IF;
  IF p_type IN ('withdrawal','supplier_payment') THEN
    IF v_card.balance < p_amount THEN RAISE EXCEPTION 'Saldo insuficiente en la cuenta: disponible %, requerido %',v_card.balance,p_amount USING ERRCODE='P0001'; END IF;
    v_new_balance := v_card.balance-p_amount;
  ELSE
    v_new_balance := v_card.balance+p_amount;
  END IF;
  UPDATE public.bank_cards SET balance=v_new_balance WHERE id=p_card_id;
  INSERT INTO public.bank_transactions(id,card_id,type,amount,date,reference,description,transaction_id)
  VALUES(p_id,p_card_id,p_type,p_amount,COALESCE(p_date,NOW()),NULLIF(btrim(p_reference),''),COALESCE(p_description,''),NULLIF(btrim(p_transaction_id),''));
  v_user_id := NULLIF(current_setting('request.jwt.claim.sub', true),'');
  INSERT INTO public.audit_log(user_id,action,entity_type,entity_id,meta)
  VALUES(v_user_id,'BANK_TRANSACTION_CREATE','bank_transaction',p_id,
    jsonb_build_object('card_id',p_card_id,'type',p_type,'amount',p_amount,'reference',NULLIF(btrim(p_reference),''),
      'transaction_id',NULLIF(btrim(p_transaction_id),''),'balance_after',v_new_balance));
  RETURN jsonb_build_object('success',true,'transaction_id',p_id,'card_id',p_card_id,'balance',v_new_balance);
END
$function$;

CREATE OR REPLACE FUNCTION public.delete_bank_transaction_v2(p_transaction_id text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_tx public.bank_transactions%ROWTYPE; v_card public.bank_cards%ROWTYPE;
  v_new_balance numeric; v_partner_id text;
BEGIN
  IF NULLIF(btrim(p_transaction_id),'') IS NULL THEN RAISE EXCEPTION 'ID de movimiento requerido' USING ERRCODE='P0001'; END IF;
  SELECT * INTO v_tx FROM public.bank_transactions WHERE id=p_transaction_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',true,'transaction_id',p_transaction_id,'already_deleted',true); END IF;
  IF v_tx.id LIKE '%:OUT' OR v_tx.id LIKE '%:IN' THEN
    RETURN public.delete_bank_internal_transfer_v2(regexp_replace(v_tx.id, ':(OUT|IN)$', ''));
  END IF;
  IF v_tx.transaction_id IS NOT NULL THEN
    SELECT id INTO v_partner_id FROM public.bank_transactions
    WHERE transaction_id=v_tx.transaction_id AND id<>v_tx.id
      AND ((v_tx.type IN ('withdrawal','supplier_payment') AND type IN ('deposit','payment_received'))
        OR (v_tx.type IN ('deposit','payment_received') AND type IN ('withdrawal','supplier_payment')))
    LIMIT 1 FOR UPDATE;
    IF v_partner_id IS NOT NULL THEN RETURN public.delete_bank_internal_transfer_v2(v_tx.transaction_id); END IF;
  END IF;
  SELECT * INTO v_card FROM public.bank_cards WHERE id=v_tx.card_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'La cuenta bancaria del movimiento no existe' USING ERRCODE='P0001'; END IF;
  IF v_tx.type IN ('withdrawal','supplier_payment') THEN
    v_new_balance := v_card.balance+v_tx.amount;
  ELSIF v_tx.type IN ('deposit','payment_received') THEN
    IF v_card.balance < v_tx.amount THEN RAISE EXCEPTION 'No se puede revertir el crédito: saldo actual % menor que %',v_card.balance,v_tx.amount USING ERRCODE='P0001'; END IF;
    v_new_balance := v_card.balance-v_tx.amount;
  ELSE
    RAISE EXCEPTION 'Tipo de movimiento no soporta eliminación automática: %',v_tx.type USING ERRCODE='P0001';
  END IF;
  UPDATE public.bank_cards SET balance=v_new_balance WHERE id=v_card.id;
  INSERT INTO public.audit_log(user_id,action,entity_type,entity_id,old_data,new_data)
  VALUES(NULLIF(current_setting('request.jwt.claim.sub', true),''),
    'BANK_TRANSACTION_DELETE','bank_transaction',v_tx.id,to_jsonb(v_tx),
    jsonb_build_object('card_id',v_card.id,'balance_before',v_card.balance,'balance_after',v_new_balance));
  DELETE FROM public.bank_transactions WHERE id=v_tx.id;
  RETURN jsonb_build_object('success',true,'transaction_id',v_tx.id,'card_id',v_card.id,'balance',v_new_balance);
END
$function$;

NOTIFY pgrst,'reload schema';


-- FASE 29C: sale void reverses bank income atomically
CREATE OR REPLACE FUNCTION public.process_bank_transaction_v2(
  p_id text,p_card_id text,p_type text,p_amount numeric,p_date timestamptz,
  p_reference text,p_description text,p_transaction_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_card public.bank_cards%ROWTYPE;
  v_existing public.bank_transactions%ROWTYPE;
  v_sale public.transactions%ROWTYPE;
  v_new_balance numeric;
  v_user_id text;
BEGIN
  IF NULLIF(btrim(p_id),'') IS NULL THEN RAISE EXCEPTION 'ID de movimiento requerido' USING ERRCODE='P0001'; END IF;
  IF p_card_id IS NULL THEN RAISE EXCEPTION 'Cuenta bancaria requerida' USING ERRCODE='P0001'; END IF;
  IF COALESCE(p_amount,0)<=0 THEN RAISE EXCEPTION 'El importe debe ser mayor que 0' USING ERRCODE='P0001'; END IF;
  IF p_type NOT IN ('deposit','withdrawal','payment_received','supplier_payment') THEN
    RAISE EXCEPTION 'Tipo de movimiento bancario no soportado: %',p_type USING ERRCODE='P0001';
  END IF;

  SELECT * INTO v_existing FROM public.bank_transactions WHERE id=p_id FOR UPDATE;
  IF FOUND THEN
    RETURN jsonb_build_object('success',true,'already_existed',true,'transaction_id',v_existing.id,'card_id',v_existing.card_id,
      'balance',(SELECT balance FROM public.bank_cards WHERE id=v_existing.card_id));
  END IF;

  IF p_transaction_id IS NOT NULL THEN
    SELECT * INTO v_sale FROM public.transactions WHERE id=p_transaction_id;
    IF FOUND AND (v_sale.deleted_at IS NOT NULL OR v_sale.status='refunded') THEN
      RAISE EXCEPTION 'No se puede crear un movimiento bancario para la venta anulada %',p_transaction_id USING ERRCODE='P0001';
    END IF;
  END IF;

  SELECT * INTO v_card FROM public.bank_cards WHERE id=p_card_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'La cuenta bancaria no existe' USING ERRCODE='P0001'; END IF;

  IF p_reference IS NOT NULL AND btrim(p_reference)<>'' THEN
    SELECT * INTO v_existing FROM public.bank_transactions
    WHERE card_id=p_card_id AND reference=p_reference
    ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
    IF FOUND THEN
      RETURN jsonb_build_object('success',true,'already_existed',true,'transaction_id',v_existing.id,'card_id',v_existing.card_id,'balance',v_card.balance);
    END IF;
  END IF;

  IF p_type IN ('withdrawal','supplier_payment') THEN
    IF v_card.balance < p_amount THEN
      RAISE EXCEPTION 'Saldo insuficiente en la cuenta: disponible %, requerido %',v_card.balance,p_amount USING ERRCODE='P0001';
    END IF;
    v_new_balance := v_card.balance-p_amount;
  ELSE
    v_new_balance := v_card.balance+p_amount;
  END IF;

  UPDATE public.bank_cards SET balance=v_new_balance WHERE id=p_card_id;
  INSERT INTO public.bank_transactions(id,card_id,type,amount,date,reference,description,transaction_id)
  VALUES(p_id,p_card_id,p_type,p_amount,COALESCE(p_date,NOW()),NULLIF(btrim(p_reference),''),
    COALESCE(p_description,''),NULLIF(btrim(p_transaction_id),''));

  v_user_id := NULLIF(current_setting('request.jwt.claim.sub', true),'');
  INSERT INTO public.audit_log(user_id,action,entity_type,entity_id,meta)
  VALUES(v_user_id,'BANK_TRANSACTION_CREATE','bank_transaction',p_id,
    jsonb_build_object('card_id',p_card_id,'type',p_type,'amount',p_amount,'reference',NULLIF(btrim(p_reference),''),
      'transaction_id',NULLIF(btrim(p_transaction_id),''),'balance_after',v_new_balance));

  RETURN jsonb_build_object('success',true,'transaction_id',p_id,'card_id',p_card_id,'balance',v_new_balance);
END
$function$;

CREATE OR REPLACE FUNCTION public.void_pos_transaction_v2(p_id text, p_user_id text, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  t RECORD; i RECORD; c RECORD; b RECORD; bt RECORD;
  qty integer; v_variant text; v_reversed_bank numeric;
BEGIN
  SELECT * INTO t FROM public.transactions WHERE id=p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Venta % no encontrada',p_id; END IF;
  IF t.deleted_at IS NOT NULL THEN RETURN jsonb_build_object('success',true,'id',p_id,'already_voided',true); END IF;

  FOR i IN SELECT * FROM jsonb_to_recordset(t.items) AS x(product_id text,quantity integer,variant_label text,is_kit boolean,kit_components jsonb) LOOP
    IF COALESCE(i.quantity,0)<=0 THEN RAISE EXCEPTION 'Cantidad inválida en venta %',p_id; END IF;
    IF COALESCE(i.is_kit,false) AND jsonb_array_length(COALESCE(i.kit_components,'[]'::jsonb))>0 THEN
      FOR c IN SELECT * FROM jsonb_to_recordset(i.kit_components) AS x(product_id text,quantity integer) LOOP
        qty:=c.quantity*i.quantity;
        PERFORM pg_advisory_xact_lock(hashtext('inventory:'||c.product_id||':'||t.branch_id||':'));
        UPDATE public.inventory SET quantity=quantity+qty WHERE product_id=c.product_id AND branch_id=t.branch_id AND COALESCE(variant_label,'')='';
        IF NOT FOUND THEN INSERT INTO public.inventory(id,product_id,branch_id,variant_label,quantity,min_quantity) VALUES(gen_random_uuid()::text,c.product_id,t.branch_id,'',qty,5); END IF;
        INSERT INTO public.inventory_movements(product_id,branch_id,variant_label,quantity_delta,movement_type,reference_id,user_id,metadata)
        VALUES(c.product_id,t.branch_id,'',qty,'KIT_RETURN',p_id,p_user_id,jsonb_build_object('kit_product_id',i.product_id));
      END LOOP;
    ELSE
      v_variant:=COALESCE(i.variant_label,'');
      PERFORM pg_advisory_xact_lock(hashtext('inventory:'||i.product_id||':'||t.branch_id||':'||v_variant));
      UPDATE public.inventory SET quantity=quantity+i.quantity WHERE product_id=i.product_id AND branch_id=t.branch_id AND COALESCE(variant_label,'')=v_variant;
      IF NOT FOUND THEN INSERT INTO public.inventory(id,product_id,branch_id,variant_label,quantity,min_quantity) VALUES(gen_random_uuid()::text,i.product_id,t.branch_id,v_variant,i.quantity,5); END IF;
      INSERT INTO public.inventory_movements(product_id,branch_id,variant_label,quantity_delta,movement_type,reference_id,user_id)
      VALUES(i.product_id,t.branch_id,v_variant,i.quantity,'VOID_RETURN',p_id,p_user_id);
    END IF;
  END LOOP;

  -- Reverse every sale-linked transfer income before marking the sale refunded.
  FOR b IN
    SELECT bc.*
    FROM public.bank_cards bc
    WHERE bc.id IN (
      SELECT DISTINCT bt.card_id
      FROM public.bank_transactions bt
      WHERE bt.transaction_id=p_id AND bt.type='payment_received'
    )
    ORDER BY bc.id
    FOR UPDATE
  LOOP
    v_reversed_bank := 0;
    FOR bt IN
      SELECT * FROM public.bank_transactions
      WHERE card_id=b.id AND transaction_id=p_id AND type='payment_received'
      ORDER BY id
      FOR UPDATE
    LOOP
      IF b.balance < bt.amount + v_reversed_bank THEN
        RAISE EXCEPTION 'No se puede anular la venta %: saldo insuficiente en % para revertir %',p_id,b.id,bt.amount USING ERRCODE='P0001';
      END IF;
      v_reversed_bank := v_reversed_bank + bt.amount;
    END LOOP;
    IF v_reversed_bank > 0 THEN
      UPDATE public.bank_cards SET balance=b.balance-v_reversed_bank WHERE id=b.id;
      DELETE FROM public.bank_transactions WHERE card_id=b.id AND transaction_id=p_id AND type='payment_received';
    END IF;
  END LOOP;

  UPDATE public.transactions SET deleted_at=NOW(),deleted_by=p_user_id,delete_reason=p_reason,status='refunded' WHERE id=p_id;
  INSERT INTO public.audit_log(user_id,action,entity_type,entity_id,meta)
  VALUES(p_user_id,'VOID_TRANSACTION','transaction',p_id,
    jsonb_build_object('reason',p_reason,'reversed_bank_income',true));

  RETURN jsonb_build_object('success',true,'id',p_id,'bank_reversed',true);
END
$function$;

NOTIFY pgrst,'reload schema';


-- FASE 29D: fix PL/pgSQL alias collision in sale void bank reversal
CREATE OR REPLACE FUNCTION public.void_pos_transaction_v2(p_id text, p_user_id text, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  t RECORD; i RECORD; c RECORD; b RECORD; bt RECORD;
  qty integer; v_variant text; v_reversed_bank numeric;
BEGIN
  SELECT * INTO t FROM public.transactions WHERE id=p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Venta % no encontrada',p_id; END IF;
  IF t.deleted_at IS NOT NULL THEN RETURN jsonb_build_object('success',true,'id',p_id,'already_voided',true); END IF;

  FOR i IN SELECT * FROM jsonb_to_recordset(t.items) AS item_row(product_id text,quantity integer,variant_label text,is_kit boolean,kit_components jsonb) LOOP
    IF COALESCE(i.quantity,0)<=0 THEN RAISE EXCEPTION 'Cantidad inválida en venta %',p_id; END IF;
    IF COALESCE(i.is_kit,false) AND jsonb_array_length(COALESCE(i.kit_components,'[]'::jsonb))>0 THEN
      FOR c IN SELECT * FROM jsonb_to_recordset(i.kit_components) AS component_row(product_id text,quantity integer) LOOP
        qty:=c.quantity*i.quantity;
        PERFORM pg_advisory_xact_lock(hashtext('inventory:'||c.product_id||':'||t.branch_id||':'));
        UPDATE public.inventory SET quantity=quantity+qty WHERE product_id=c.product_id AND branch_id=t.branch_id AND COALESCE(variant_label,'')='';
        IF NOT FOUND THEN INSERT INTO public.inventory(id,product_id,branch_id,variant_label,quantity,min_quantity) VALUES(gen_random_uuid()::text,c.product_id,t.branch_id,'',qty,5); END IF;
        INSERT INTO public.inventory_movements(product_id,branch_id,variant_label,quantity_delta,movement_type,reference_id,user_id,metadata)
        VALUES(c.product_id,t.branch_id,'',qty,'KIT_RETURN',p_id,p_user_id,jsonb_build_object('kit_product_id',i.product_id));
      END LOOP;
    ELSE
      v_variant:=COALESCE(i.variant_label,'');
      PERFORM pg_advisory_xact_lock(hashtext('inventory:'||i.product_id||':'||t.branch_id||':'||v_variant));
      UPDATE public.inventory SET quantity=quantity+i.quantity WHERE product_id=i.product_id AND branch_id=t.branch_id AND COALESCE(variant_label,'')=v_variant;
      IF NOT FOUND THEN INSERT INTO public.inventory(id,product_id,branch_id,variant_label,quantity,min_quantity) VALUES(gen_random_uuid()::text,i.product_id,t.branch_id,v_variant,i.quantity,5); END IF;
      INSERT INTO public.inventory_movements(product_id,branch_id,variant_label,quantity_delta,movement_type,reference_id,user_id)
      VALUES(i.product_id,t.branch_id,v_variant,i.quantity,'VOID_RETURN',p_id,p_user_id);
    END IF;
  END LOOP;

  FOR b IN
    SELECT bc.*
    FROM public.bank_cards bc
    WHERE bc.id IN (
      SELECT DISTINCT tx_row.card_id
      FROM public.bank_transactions tx_row
      WHERE tx_row.transaction_id=p_id AND tx_row.type='payment_received'
    )
    ORDER BY bc.id
    FOR UPDATE
  LOOP
    v_reversed_bank := 0;
    FOR bt IN
      SELECT tx_row.*
      FROM public.bank_transactions tx_row
      WHERE tx_row.card_id=b.id AND tx_row.transaction_id=p_id AND tx_row.type='payment_received'
      ORDER BY tx_row.id
      FOR UPDATE
    LOOP
      IF b.balance < bt.amount + v_reversed_bank THEN
        RAISE EXCEPTION 'No se puede anular la venta %: saldo insuficiente en % para revertir %',p_id,b.id,bt.amount USING ERRCODE='P0001';
      END IF;
      v_reversed_bank := v_reversed_bank + bt.amount;
    END LOOP;
    IF v_reversed_bank > 0 THEN
      UPDATE public.bank_cards SET balance=b.balance-v_reversed_bank WHERE id=b.id;
      DELETE FROM public.bank_transactions WHERE card_id=b.id AND transaction_id=p_id AND type='payment_received';
    END IF;
  END LOOP;

  UPDATE public.transactions SET deleted_at=NOW(),deleted_by=p_user_id,delete_reason=p_reason,status='refunded' WHERE id=p_id;
  INSERT INTO public.audit_log(user_id,action,entity_type,entity_id,meta)
  VALUES(p_user_id,'VOID_TRANSACTION','transaction',p_id,jsonb_build_object('reason',p_reason,'reversed_bank_income',true));

  RETURN jsonb_build_object('success',true,'id',p_id,'bank_reversed',true);
END
$function$;

NOTIFY pgrst,'reload schema';


-- FASE 29E: serialize bank income with sale void
CREATE OR REPLACE FUNCTION public.process_bank_transaction_v2(
  p_id text,p_card_id text,p_type text,p_amount numeric,p_date timestamptz,
  p_reference text,p_description text,p_transaction_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_card public.bank_cards%ROWTYPE; v_existing public.bank_transactions%ROWTYPE;
  v_sale public.transactions%ROWTYPE; v_new_balance numeric; v_user_id text;
BEGIN
  IF NULLIF(btrim(p_id),'') IS NULL THEN RAISE EXCEPTION 'ID de movimiento requerido' USING ERRCODE='P0001'; END IF;
  IF p_card_id IS NULL THEN RAISE EXCEPTION 'Cuenta bancaria requerida' USING ERRCODE='P0001'; END IF;
  IF COALESCE(p_amount,0)<=0 THEN RAISE EXCEPTION 'El importe debe ser mayor que 0' USING ERRCODE='P0001'; END IF;
  IF p_type NOT IN ('deposit','withdrawal','payment_received','supplier_payment') THEN
    RAISE EXCEPTION 'Tipo de movimiento bancario no soportado: %',p_type USING ERRCODE='P0001';
  END IF;

  SELECT * INTO v_existing FROM public.bank_transactions WHERE id=p_id FOR UPDATE;
  IF FOUND THEN
    RETURN jsonb_build_object('success',true,'already_existed',true,'transaction_id',v_existing.id,'card_id',v_existing.card_id,
      'balance',(SELECT balance FROM public.bank_cards WHERE id=v_existing.card_id));
  END IF;

  IF p_transaction_id IS NOT NULL THEN
    SELECT * INTO v_sale FROM public.transactions WHERE id=p_transaction_id FOR UPDATE;
    IF FOUND AND (v_sale.deleted_at IS NOT NULL OR v_sale.status='refunded') THEN
      RAISE EXCEPTION 'No se puede crear un movimiento bancario para la venta anulada %',p_transaction_id USING ERRCODE='P0001';
    END IF;
  END IF;

  SELECT * INTO v_card FROM public.bank_cards WHERE id=p_card_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'La cuenta bancaria no existe' USING ERRCODE='P0001'; END IF;

  IF p_reference IS NOT NULL AND btrim(p_reference)<>'' THEN
    SELECT * INTO v_existing FROM public.bank_transactions
    WHERE card_id=p_card_id AND reference=p_reference
    ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
    IF FOUND THEN
      RETURN jsonb_build_object('success',true,'already_existed',true,'transaction_id',v_existing.id,
        'card_id',v_existing.card_id,'balance',v_card.balance);
    END IF;
  END IF;

  IF p_type IN ('withdrawal','supplier_payment') THEN
    IF v_card.balance < p_amount THEN
      RAISE EXCEPTION 'Saldo insuficiente en la cuenta: disponible %, requerido %',v_card.balance,p_amount USING ERRCODE='P0001';
    END IF;
    v_new_balance := v_card.balance-p_amount;
  ELSE
    v_new_balance := v_card.balance+p_amount;
  END IF;

  UPDATE public.bank_cards SET balance=v_new_balance WHERE id=p_card_id;
  INSERT INTO public.bank_transactions(id,card_id,type,amount,date,reference,description,transaction_id)
  VALUES(p_id,p_card_id,p_type,p_amount,COALESCE(p_date,NOW()),NULLIF(btrim(p_reference),''),
    COALESCE(p_description,''),NULLIF(btrim(p_transaction_id),''));

  v_user_id := NULLIF(current_setting('request.jwt.claim.sub', true),'');
  INSERT INTO public.audit_log(user_id,action,entity_type,entity_id,meta)
  VALUES(v_user_id,'BANK_TRANSACTION_CREATE','bank_transaction',p_id,
    jsonb_build_object('card_id',p_card_id,'type',p_type,'amount',p_amount,'reference',NULLIF(btrim(p_reference),''),
      'transaction_id',NULLIF(btrim(p_transaction_id),''),'balance_after',v_new_balance));
  RETURN jsonb_build_object('success',true,'transaction_id',p_id,'card_id',p_card_id,'balance',v_new_balance);
END
$function$;

NOTIFY pgrst,'reload schema';


-- FASE 30: control formal de conteo fisico
ALTER TABLE public.inventory_audits
  ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'cycle_count',
  ADD COLUMN IF NOT EXISTS blind_count boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS snapshot_at timestamptz,
  ADD COLUMN IF NOT EXISTS submitted_at timestamptz,
  ADD COLUMN IF NOT EXISTS review_status text NOT NULL DEFAULT 'counting',
  ADD COLUMN IF NOT EXISTS counted_by text,
  ADD COLUMN IF NOT EXISTS reviewed_by text,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS recount_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS adjustment_posted_at timestamptz;

ALTER TABLE public.inventory_audit_items
  ADD COLUMN IF NOT EXISTS system_at_submission integer,
  ADD COLUMN IF NOT EXISTS adjustment_delta integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS count_cycle integer NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_inventory_audits_review_status ON public.inventory_audits(review_status);
CREATE INDEX IF NOT EXISTS idx_inventory_audits_branch_status ON public.inventory_audits(branch_id,status);

-- start_inventory_audit_v2 / save_inventory_audit_count_v2 / request_inventory_audit_recount_v2 /
-- approve_inventory_audit_v2: ver definiciones finales aplicadas en la BD de esta fase.
NOTIFY pgrst,'reload schema';


-- FASE 30B: accept camelCase count payloads used by the web client
CREATE OR REPLACE FUNCTION public.save_inventory_audit_count_v2(
  p_audit_id text,p_user_id text,p_items jsonb,p_notes text
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  a RECORD; i RECORD; current_qty integer; v_count integer;
  v_product_id text; v_product_name text; v_variant text; item_json jsonb;
BEGIN
  SELECT * INTO a FROM public.inventory_audits WHERE id=p_audit_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Auditoría % no encontrada',p_audit_id USING ERRCODE='P0001'; END IF;
  IF a.status='completed' OR COALESCE(a.review_status,'counting')='approved' THEN
    RETURN jsonb_build_object('success',true,'already_approved',true,'audit_id',p_audit_id);
  END IF;
  IF COALESCE(a.review_status,'counting') NOT IN ('counting','recount_requested') THEN
    RAISE EXCEPTION 'La auditoría no está disponible para conteo. Estado: %',COALESCE(a.review_status,'counting') USING ERRCODE='P0001';
  END IF;

  FOR i IN SELECT * FROM jsonb_to_recordset(COALESCE(p_items,'[]'::jsonb))
    AS x(product_id text,"productId" text,product_name text,"productName" text,variant_label text,"variantLabel" text,counted integer,actual integer)
  LOOP
    v_product_id:=COALESCE(i.product_id,i."productId");
    v_product_name:=COALESCE(i.product_name,i."productName",'Producto');
    v_variant:=COALESCE(i.variant_label,i."variantLabel",'');
    IF NULLIF(btrim(v_product_id),'') IS NULL THEN RAISE EXCEPTION 'Línea de conteo sin producto' USING ERRCODE='P0001'; END IF;
    IF i.counted IS NULL AND i.actual IS NULL THEN RAISE EXCEPTION 'Falta el conteo físico de %',v_product_name USING ERRCODE='P0001'; END IF;
    v_count:=GREATEST(0,COALESCE(i.counted,i.actual,0));

    SELECT quantity INTO current_qty FROM public.inventory
    WHERE product_id=v_product_id AND branch_id=a.branch_id AND COALESCE(variant_label,'')=v_variant FOR UPDATE;
    current_qty:=COALESCE(current_qty,0);

    UPDATE public.inventory_audit_items
    SET counted=v_count,actual=v_count,difference=v_count-expected,
        system_at_submission=current_qty,adjustment_delta=0,
        count_cycle=GREATEST(count_cycle,COALESCE(a.recount_count,0)+1)
    WHERE audit_id=p_audit_id AND product_id=v_product_id AND COALESCE(variant_label,'')=v_variant;

    IF NOT FOUND THEN
      INSERT INTO public.inventory_audit_items(
        id,audit_id,product_id,product_name,variant_label,expected,actual,counted,
        difference,system_at_submission,adjustment_delta,count_cycle
      ) VALUES(
        gen_random_uuid()::text,p_audit_id,v_product_id,v_product_name,v_variant,current_qty,v_count,v_count,
        v_count-current_qty,current_qty,0,COALESCE(a.recount_count,0)+1
      );
    END IF;
  END LOOP;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'productId',iai.product_id,'productName',iai.product_name,'variantLabel',iai.variant_label,
    'expected',iai.expected,'counted',iai.counted,'actual',iai.actual,'difference',iai.difference,
    'systemAtSubmission',iai.system_at_submission,'adjustmentDelta',iai.adjustment_delta,'countCycle',iai.count_cycle
  ) ORDER BY iai.product_name,iai.variant_label),'[]'::jsonb)
  INTO item_json FROM public.inventory_audit_items iai WHERE iai.audit_id=p_audit_id;

  UPDATE public.inventory_audits
  SET items=item_json,notes=COALESCE(p_notes,notes),submitted_at=NOW(),
      user_id=COALESCE(p_user_id,user_id),counted_by=COALESCE(p_user_id,counted_by),
      review_status='pending_approval'
  WHERE id=p_audit_id;

  INSERT INTO public.audit_log(user_id,action,entity_type,entity_id,meta)
  VALUES(p_user_id,'SUBMIT_INVENTORY_AUDIT','inventory_audit',p_audit_id,
    jsonb_build_object('items',jsonb_array_length(item_json),'submitted_at',NOW()));

  RETURN jsonb_build_object('success',true,'audit_id',p_audit_id,'review_status','pending_approval','items',item_json);
END
$function$;

NOTIFY pgrst,'reload schema';

-- FASE 31: return workflow metadata
ALTER TABLE public.returns
  ADD COLUMN IF NOT EXISTS branch_id text,
  ADD COLUMN IF NOT EXISTS replacement_product_id text,
  ADD COLUMN IF NOT EXISTS replacement_quantity integer,
  ADD COLUMN IF NOT EXISTS processed_by text,
  ADD COLUMN IF NOT EXISTS refund_status text NOT NULL DEFAULT 'not_required',
  ADD COLUMN IF NOT EXISTS refund_amount numeric,
  ADD COLUMN IF NOT EXISTS refund_currency_code text,
  ADD COLUMN IF NOT EXISTS refund_method text,
  ADD COLUMN IF NOT EXISTS refund_bank_card_id text,
  ADD COLUMN IF NOT EXISTS refund_transaction_id text,
  ADD COLUMN IF NOT EXISTS received_at timestamptz,
  ADD COLUMN IF NOT EXISTS refunded_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_returns_transaction ON public.returns(transaction_id);
CREATE INDEX IF NOT EXISTS idx_returns_refund_status ON public.returns(refund_status);
CREATE INDEX IF NOT EXISTS idx_returns_branch_status ON public.returns(branch_id,status);

NOTIFY pgrst,'reload schema';
