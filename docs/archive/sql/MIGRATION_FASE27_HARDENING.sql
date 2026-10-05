-- OmniSync Fase 27: hardening RPC/RLS/sync
-- Idempotente: puede ejecutarse después de la migración base.

ALTER TABLE public.cash_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_repair_backup_20260926 DISABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.inventory_repair_backup_20260926 FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.rls_auto_enable() FROM PUBLIC, anon, authenticated;

ALTER FUNCTION public.open_cash_session_v2(text,text,text,numeric,timestamptz,text[],text) SET search_path = public, pg_temp;
ALTER FUNCTION public.open_cash_session_v3(text,text,text,text,numeric,timestamptz,text[],text) SET search_path = public, pg_temp;
ALTER FUNCTION public.process_pos_transaction_v2(text,text,text,timestamptz,numeric,numeric,numeric,jsonb,jsonb,text,text,text,text) SET search_path = public, pg_temp;
ALTER FUNCTION public.close_cash_session_v2(text,jsonb,timestamptz,text,jsonb) SET search_path = public, pg_temp;
ALTER FUNCTION public.receive_supplier_order_v2(text,text) SET search_path = public, pg_temp;
ALTER FUNCTION public.complete_return_v2(text,text) SET search_path = public, pg_temp;
ALTER FUNCTION public.void_pos_transaction_v2(text,text,text) SET search_path = public, pg_temp;
ALTER FUNCTION public.apply_inventory_adjustment_v2(text,text,text,text,integer,integer,text,text) SET search_path = public, pg_temp;
ALTER FUNCTION public.cancel_cash_session_v2(text,text,text) SET search_path = public, pg_temp;
ALTER FUNCTION public.process_inventory_transfer_v2(text,text,text,text,jsonb,text) SET search_path = public, pg_temp;
ALTER FUNCTION public.reconcile_inventory_v2(text,text,text,text,integer,integer,integer,text) SET search_path = public, pg_temp;
ALTER FUNCTION public.complete_inventory_audit_v2(text,text,text,jsonb,text) SET search_path = public, pg_temp;
ALTER FUNCTION public.update_updated_at_column() SET search_path = public, pg_temp;

CREATE OR REPLACE VIEW public.data_integrity_alerts WITH (security_invoker=true) AS
SELECT 'TRANSACTION_WITHOUT_SESSION'::text AS alert_type, transactions.id AS entity_id, transactions.date AS entity_date, 'Venta sin turno asociado registrado'::text AS description
FROM public.transactions
WHERE transactions.session_id IS NULL AND transactions.deleted_at IS NULL
UNION ALL
SELECT 'TRANSACTION_WITH_DELETED_SESSION'::text AS alert_type, t.id AS entity_id, t.date AS entity_date, 'Venta vinculada a turno eliminado lógicamente'::text AS description
FROM public.transactions t JOIN public.cash_sessions s ON t.session_id=s.id
WHERE s.deleted_at IS NOT NULL AND t.deleted_at IS NULL;

CREATE OR REPLACE VIEW public.shift_audit_view WITH (security_invoker=true) AS
SELECT s.id AS session_id,s.opened_at,s.closed_at,s.worker_name,s.branch_id,s.status,
COALESCE(sum(t.total),(0)::numeric) AS computed_total_sales,count(t.id) AS sales_count
FROM public.cash_sessions s
LEFT JOIN public.transactions t ON t.session_id=s.id AND t.deleted_at IS NULL
WHERE s.deleted_at IS NULL
GROUP BY s.id,s.opened_at,s.closed_at,s.worker_name,s.branch_id,s.status;

CREATE OR REPLACE FUNCTION public.open_cash_session_v3(p_session_id text,p_user_id text,p_worker_name text,p_branch_id text,p_opening_amount numeric,p_opened_at timestamptz,p_working_employee_ids text[],p_notes text)
RETURNS jsonb LANGUAGE plpgsql AS $function$
DECLARE v_next_turn integer; v_result jsonb; v_existing public.cash_sessions%rowtype;
BEGIN
  IF NULLIF(trim(p_session_id),'') IS NULL THEN RAISE EXCEPTION 'El ID del turno es obligatorio'; END IF;
  IF NULLIF(trim(p_branch_id),'') IS NULL THEN RAISE EXCEPTION 'La sucursal es obligatoria'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('cash-session:' || p_branch_id));
  SELECT * INTO v_existing FROM public.cash_sessions WHERE id=p_session_id FOR UPDATE;
  IF FOUND THEN
    IF v_existing.branch_id IS DISTINCT FROM p_branch_id OR v_existing.user_id IS DISTINCT FROM p_user_id THEN RAISE EXCEPTION 'El ID de turno ya pertenece a otra sesión'; END IF;
    RETURN row_to_json(v_existing)::jsonb;
  END IF;
  IF EXISTS (SELECT 1 FROM public.cash_sessions WHERE branch_id=p_branch_id AND status='open' AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'Ya existe un turno abierto para la sucursal %', p_branch_id USING ERRCODE='23505';
  END IF;
  INSERT INTO public.settings(id,last_turn_number) VALUES('global',1) ON CONFLICT(id) DO UPDATE SET last_turn_number=public.settings.last_turn_number+1 RETURNING last_turn_number INTO v_next_turn;
  INSERT INTO public.cash_sessions(id,user_id,worker_name,branch_id,opened_at,opening_balance,opening_amount,status,working_employee_ids,notes,created_at)
  VALUES(p_session_id,p_user_id,p_worker_name,p_branch_id,p_opened_at,p_opening_amount,p_opening_amount,'open',p_working_employee_ids,p_notes,NOW())
  RETURNING row_to_json(public.cash_sessions.*)::jsonb INTO v_result;
  INSERT INTO public.audit_log(user_id,action,entity_type,entity_id,new_data) VALUES(p_user_id,'OPEN_SESSION','cash_session',p_session_id,v_result);
  RETURN v_result;
END; $function$;

CREATE OR REPLACE FUNCTION public.close_cash_session_v2(p_session_id text,p_closing_balances jsonb,p_closed_at timestamptz,p_notes text,p_settlement_data jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $function$
DECLARE s record; v_settlement jsonb; v_settlement_id text;
BEGIN
  SELECT * INTO s FROM public.cash_sessions WHERE id=p_session_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Turno % no encontrado',p_session_id; END IF;
  IF s.status='closed' THEN
    SELECT row_to_json(ss.*)::jsonb INTO v_settlement FROM public.salary_settlements ss WHERE ss.session_id=p_session_id ORDER BY ss.created_at DESC LIMIT 1;
    RETURN jsonb_build_object('success',true,'session_id',p_session_id,'already_closed',true,'settlement',v_settlement,'settlement_id',CASE WHEN v_settlement IS NULL THEN NULL ELSE v_settlement->>'id' END);
  END IF;
  UPDATE public.cash_sessions SET status='closed',closed_at=p_closed_at,closing_balances=p_closing_balances,notes=p_notes,updated_at=NOW() WHERE id=p_session_id;
  SELECT id INTO v_settlement_id FROM public.salary_settlements WHERE session_id=p_session_id ORDER BY created_at DESC LIMIT 1;
  IF v_settlement_id IS NULL THEN
    v_settlement_id := COALESCE(NULLIF(p_settlement_data->>'id',''),'salary-'||p_session_id);
    INSERT INTO public.salary_settlements(id,user_id,user_name,session_id,base_salary,sales_goal,commissions,total,date,status,created_at)
    VALUES(v_settlement_id,p_settlement_data->>'userId',p_settlement_data->>'userName',p_session_id,COALESCE((p_settlement_data->>'baseSalary')::numeric,0),COALESCE((p_settlement_data->>'salesGoal')::numeric,0),COALESCE((p_settlement_data->>'commissions')::numeric,0),COALESCE((p_settlement_data->>'total')::numeric,0),p_closed_at,COALESCE(NULLIF(p_settlement_data->>'status',''),'pending'),NOW())
    ON CONFLICT(id) DO UPDATE SET user_id=EXCLUDED.user_id,user_name=EXCLUDED.user_name,session_id=EXCLUDED.session_id,base_salary=EXCLUDED.base_salary,sales_goal=EXCLUDED.sales_goal,commissions=EXCLUDED.commissions,total=EXCLUDED.total,date=EXCLUDED.date,status=EXCLUDED.status;
  END IF;
  INSERT INTO public.audit_log(user_id,action,entity_type,entity_id,meta) VALUES(p_settlement_data->>'userId','CLOSE_SESSION','cash_session',p_session_id,p_settlement_data);
  RETURN jsonb_build_object('success',true,'session_id',p_session_id,'settlement_id',v_settlement_id);
END; $function$;

CREATE OR REPLACE FUNCTION public.cancel_cash_session_v2(p_session_id text,p_user_id text,p_reason text)
RETURNS jsonb LANGUAGE plpgsql AS $function$
DECLARE v_session public.cash_sessions%rowtype; v_tx record; v_voided integer:=0;
BEGIN
  SELECT * INTO v_session FROM public.cash_sessions WHERE id=p_session_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Turno % no encontrado',p_session_id; END IF;
  IF v_session.status='cancelled' THEN RETURN jsonb_build_object('success',true,'session_id',p_session_id,'already_cancelled',true); END IF;
  FOR v_tx IN SELECT id FROM public.transactions WHERE session_id=p_session_id AND deleted_at IS NULL ORDER BY created_at,id LOOP
    PERFORM public.void_pos_transaction_v2(v_tx.id,COALESCE(p_user_id,'system'),COALESCE(NULLIF(p_reason,''),'Cancelación de turno')); v_voided:=v_voided+1;
  END LOOP;
  UPDATE public.cash_sessions SET status='cancelled',closed_at=COALESCE(closed_at,now()),delete_reason=COALESCE(NULLIF(p_reason,''),'Cancelación de turno'),deleted_at=NULL,deleted_by=NULL,notes=TRIM(COALESCE(notes,'')||' __CANCELLED__:turno_cancelado'),updated_at=now() WHERE id=p_session_id;
  INSERT INTO public.audit_log(user_id,action,entity_type,entity_id,meta) VALUES(COALESCE(p_user_id,'system'),'CANCEL_SESSION','cash_session',p_session_id,jsonb_build_object('reason',COALESCE(NULLIF(p_reason,''),'Cancelación de turno'),'transactions_voided',v_voided));
  RETURN jsonb_build_object('success',true,'session_id',p_session_id,'transactions_voided',v_voided);
END; $function$;

NOTIFY pgrst,'reload schema';
