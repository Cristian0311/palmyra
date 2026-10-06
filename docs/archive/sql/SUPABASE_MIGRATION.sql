-- ============================================================================
-- ACTUALIZACIÓN DE ESQUEMA MARÉ E-COMMERCE / POS SUPABASE
-- Incluye: Auditoría, Soft Delete, Idempotencia, RPCs Atómicos y Vistas de Integridad
-- ============================================================================

-- 1. TABLAS Y COLUMNAS FUNDAMENTALES

-- Usuarios y Sucursales
ALTER TABLE users ADD COLUMN IF NOT EXISTS supervisor_id TEXT REFERENCES users(id);
ALTER TABLE branches ADD COLUMN IF NOT EXISTS phone TEXT;

-- No imponer unicidad todavía: primero se deben auditar posibles duplicados existentes.
-- La vista duplicate_branch_candidates al final de esta migración permite revisarlos
-- sin borrar ni reasignar datos automáticamente.

-- Configuración y Contador Global de Turnos
CREATE TABLE IF NOT EXISTS settings (
  id TEXT PRIMARY KEY,
  store_config JSONB,
  catalog_config JSONB,
  receipt_config JSONB,
  currencies JSONB,
  last_turn_number INTEGER DEFAULT 0
);
ALTER TABLE settings ADD COLUMN IF NOT EXISTS last_turn_number INTEGER DEFAULT 0;

-- Columnas de Auditoría y Soft Delete en Transacciones y Turnos de Caja
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS deleted_by TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS delete_reason TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS idempotency_key TEXT UNIQUE;

ALTER TABLE cash_sessions ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE cash_sessions ADD COLUMN IF NOT EXISTS deleted_by TEXT;
ALTER TABLE cash_sessions ADD COLUMN IF NOT EXISTS delete_reason TEXT;
ALTER TABLE cash_sessions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

-- Inventario
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS variant_label TEXT;
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS min_quantity INTEGER DEFAULT 5;
ALTER TABLE products ADD COLUMN IF NOT EXISTS kit_components JSONB DEFAULT '[]'::jsonb;
-- Asegurar unicidad de variantes por sucursal
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'inventory_product_branch_variant_key'
  ) THEN
    ALTER TABLE inventory ADD CONSTRAINT inventory_product_branch_variant_key UNIQUE (product_id, branch_id, variant_label);
  END IF;
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

-- 2. TABLAS DE MÓDULOS EMPRESARIALES Y AUDITORÍA

-- Tabla de Auditoría Histórica Inmutable
CREATE TABLE IF NOT EXISTS audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  user_id TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  old_data JSONB,
  new_data JSONB,
  ip_address TEXT,
  meta JSONB
);

CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at);

-- Auditorías de Inventario Físico
CREATE TABLE IF NOT EXISTS inventory_audits (
  id TEXT PRIMARY KEY,
  date TIMESTAMPTZ NOT NULL,
  branch_id TEXT REFERENCES branches(id),
  user_id TEXT REFERENCES users(id),
  status TEXT NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL
);

CREATE TABLE IF NOT EXISTS inventory_audit_items (
  id TEXT PRIMARY KEY,
  audit_id TEXT REFERENCES inventory_audits(id) ON DELETE CASCADE,
  product_id TEXT REFERENCES products(id),
  product_name TEXT NOT NULL,
  variant_label TEXT,
  expected INTEGER NOT NULL,
  actual INTEGER NOT NULL,
  difference INTEGER NOT NULL,
  created_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Liquidaciones de Salario por Turno
CREATE TABLE IF NOT EXISTS salary_settlements (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  user_name TEXT NOT NULL,
  session_id TEXT REFERENCES cash_sessions(id),
  base_salary NUMERIC NOT NULL DEFAULT 0,
  commissions NUMERIC NOT NULL DEFAULT 0,
  discrepancy_deduction NUMERIC NOT NULL DEFAULT 0,
  total NUMERIC NOT NULL DEFAULT 0,
  sales_goal NUMERIC DEFAULT 0,
  date TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 3. POLÍTICAS DE SEGURIDAD (RLS)
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_audits ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_audit_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE salary_settlements ENABLE ROW LEVEL SECURITY;

DO $$ 
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Allow all for settings') THEN
    CREATE POLICY "Allow all for settings" ON settings FOR ALL USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Allow all for audit_log') THEN
    CREATE POLICY "Allow all for audit_log" ON audit_log FOR ALL USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Allow all for inventory_audits') THEN
    CREATE POLICY "Allow all for inventory_audits" ON inventory_audits FOR ALL USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Allow all for inventory_audit_items') THEN
    CREATE POLICY "Allow all for inventory_audit_items" ON inventory_audit_items FOR ALL USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Allow all for salary_settlements') THEN
    CREATE POLICY "Allow all for salary_settlements" ON salary_settlements FOR ALL USING (true);
  END IF;
END $$;

-- 4. VISTAS DE INTEGRIDAD Y AUDITORÍA DE DATOS

-- Vista de turnos con ventas calculadas desde base de datos
CREATE OR REPLACE VIEW shift_audit_view AS
SELECT 
  s.id AS session_id,
  s.opened_at,
  s.closed_at,
  s.worker_name,
  s.branch_id,
  s.status,
  COALESCE(SUM(t.total), 0) AS computed_total_sales,
  COUNT(t.id) AS sales_count
FROM cash_sessions s
LEFT JOIN transactions t ON t.session_id = s.id AND t.deleted_at IS NULL
WHERE s.deleted_at IS NULL
GROUP BY s.id, s.opened_at, s.closed_at, s.worker_name, s.branch_id, s.status;

-- Alertas de Integridad Referencial
CREATE OR REPLACE VIEW data_integrity_alerts AS
SELECT 
  'TRANSACTION_WITHOUT_SESSION' AS alert_type, 
  id AS entity_id, 
  date AS entity_date, 
  'Venta sin turno asociado registrado' AS description
FROM transactions 
WHERE session_id IS NULL AND deleted_at IS NULL
UNION ALL
SELECT 
  'TRANSACTION_WITH_DELETED_SESSION' AS alert_type, 
  t.id AS entity_id, 
  t.date AS entity_date, 
  'Venta vinculada a turno eliminado lógicamente' AS description
FROM transactions t 
JOIN cash_sessions s ON t.session_id = s.id 
WHERE s.deleted_at IS NOT NULL AND t.deleted_at IS NULL;

-- ==========================================================================
-- ESTABILIZACIÓN v3
-- Estas definiciones sustituyen las RPC antiguas sin borrar datos existentes.
-- Regla: una operación crítica se confirma una sola vez y el servidor es la
-- autoridad de inventario cuando existe conexión.
-- ============================================================================

-- Normalizar variantes: NULL y '' representan la misma variante.
UPDATE inventory SET variant_label = '' WHERE variant_label IS NULL;
ALTER TABLE inventory ALTER COLUMN variant_label SET DEFAULT '';

-- Si existen filas duplicadas de inventario para la misma clave lógica,
-- consolidarlas antes de crear la restricción. No se pierde cantidad: se suma.
DO $$
DECLARE r RECORD; keep_id TEXT;
BEGIN
  FOR r IN
    SELECT product_id, branch_id, COALESCE(variant_label,'') AS variant_key,
           COUNT(*) AS n
    FROM inventory
    GROUP BY product_id, branch_id, COALESCE(variant_label,'')
    HAVING COUNT(*) > 1
  LOOP
    SELECT id INTO keep_id FROM inventory
    WHERE product_id=r.product_id AND branch_id=r.branch_id
      AND COALESCE(variant_label,'')=r.variant_key
    ORDER BY id LIMIT 1;
    UPDATE inventory i SET
      quantity = (SELECT COALESCE(SUM(x.quantity),0) FROM inventory x
                  WHERE x.product_id=r.product_id AND x.branch_id=r.branch_id
                    AND COALESCE(x.variant_label,'')=r.variant_key),
      min_quantity = (SELECT COALESCE(MAX(x.min_quantity),0) FROM inventory x
                      WHERE x.product_id=r.product_id AND x.branch_id=r.branch_id
                        AND COALESCE(x.variant_label,'')=r.variant_key),
      variant_label = r.variant_key
    WHERE i.id=keep_id;
    DELETE FROM inventory
    WHERE product_id=r.product_id AND branch_id=r.branch_id
      AND COALESCE(variant_label,'')=r.variant_key AND id<>keep_id;
  END LOOP;
END $$;

DROP INDEX IF EXISTS idx_inventory_product_branch_variant;
CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_product_branch_variant
ON inventory(product_id, branch_id, COALESCE(variant_label,''));

-- Auditoría de movimientos: cada cambio de stock crítico queda trazable.
CREATE TABLE IF NOT EXISTS inventory_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  product_id TEXT NOT NULL REFERENCES products(id),
  branch_id TEXT NOT NULL REFERENCES branches(id),
  variant_label TEXT NOT NULL DEFAULT '',
  quantity_delta INTEGER NOT NULL,
  movement_type TEXT NOT NULL,
  reference_id TEXT,
  user_id TEXT,
  metadata JSONB DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_inventory_movements_product_branch
  ON inventory_movements(product_id, branch_id, created_at);
CREATE INDEX IF NOT EXISTS idx_inventory_movements_reference
  ON inventory_movements(reference_id);

-- Offline inventory RPCs need to record their audit movement under the
-- current custom-auth/anon architecture. Without this policy RLS rejects
-- valid transfer/reconciliation writes.
ALTER TABLE inventory_movements ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='inventory_movements' AND policyname='Public Full Access') THEN
    CREATE POLICY "Public Full Access" ON inventory_movements FOR ALL TO public USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Una sola liquidación por turno.
DO $$
BEGIN
  DELETE FROM salary_settlements a
  USING salary_settlements b
  WHERE a.session_id IS NOT NULL AND a.session_id=b.session_id
    AND a.created_at < b.created_at;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS idx_salary_settlement_session
  ON salary_settlements(session_id) WHERE session_id IS NOT NULL;

-- Una sola caja abierta por sucursal.
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_open_cash_session_branch
  ON cash_sessions(branch_id)
  WHERE status='open' AND deleted_at IS NULL;

-- Operaciones de transferencia: la clave se conserva entre reintentos.
ALTER TABLE inventory_transfers ADD COLUMN IF NOT EXISTS operation_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_transfers_operation
  ON inventory_transfers(operation_id) WHERE operation_id IS NOT NULL;

-- ==========================================================================
-- Apertura de turno: serialización por sucursal + rechazo de duplicados.
-- ==========================================================================
CREATE OR REPLACE FUNCTION open_cash_session_v2(
  p_user_id TEXT, p_worker_name TEXT, p_branch_id TEXT,
  p_opening_amount NUMERIC, p_opened_at TIMESTAMPTZ,
  p_working_employee_ids TEXT[], p_notes TEXT
) RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE v_next_turn INTEGER; v_session_id TEXT; v_result JSONB;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('cash-session:' || p_branch_id));
  IF EXISTS (SELECT 1 FROM cash_sessions WHERE branch_id=p_branch_id AND status='open' AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'Ya existe un turno abierto para la sucursal %', p_branch_id USING ERRCODE='23505';
  END IF;
  INSERT INTO settings(id,last_turn_number) VALUES('global',1)
  ON CONFLICT(id) DO UPDATE SET last_turn_number=settings.last_turn_number+1
  RETURNING last_turn_number INTO v_next_turn;
  v_session_id := 'Turno-' || v_next_turn;
  INSERT INTO cash_sessions(id,user_id,worker_name,branch_id,opened_at,opening_balance,opening_amount,status,working_employee_ids,notes,created_at)
  VALUES(v_session_id,p_user_id,p_worker_name,p_branch_id,p_opened_at,p_opening_amount,p_opening_amount,'open',p_working_employee_ids,p_notes,NOW())
  RETURNING row_to_json(cash_sessions.*)::jsonb INTO v_result;
  INSERT INTO audit_log(user_id,action,entity_type,entity_id,new_data)
  VALUES(p_user_id,'OPEN_SESSION','cash_session',v_session_id,v_result);
  RETURN v_result;
END $$;

-- ==========================================================================
-- Venta POS: valida stock, soporta kits y bloquea filas antes de descontar.
-- ==========================================================================
CREATE OR REPLACE FUNCTION process_pos_transaction_v2(
  p_id TEXT, p_branch_id TEXT, p_user_id TEXT, p_date TIMESTAMPTZ,
  p_total NUMERIC, p_tax NUMERIC, p_discount NUMERIC, p_items JSONB,
  p_payments JSONB, p_payment_method TEXT, p_session_id TEXT,
  p_customer_id TEXT, p_notes TEXT
) RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
  v_req RECORD; v_inv inventory%ROWTYPE;
BEGIN
  IF EXISTS (SELECT 1 FROM transactions WHERE id=p_id) THEN
    RETURN jsonb_build_object('success',true,'id',p_id,'already_existed',true);
  END IF;
  IF p_session_id IS NOT NULL AND NOT EXISTS
    (SELECT 1 FROM cash_sessions WHERE id=p_session_id AND branch_id=p_branch_id AND status='open' AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'El turno % no está abierto o no pertenece a la sucursal %',p_session_id,p_branch_id;
  END IF;

  -- Primero agregamos toda la necesidad de stock. Esto evita que dos líneas del
  -- mismo SKU se validen por separado y, al ordenar los locks, reduce deadlocks
  -- cuando dos POS venden varios productos en distinto orden.
  FOR v_req IN
    WITH raw AS (
      SELECT x.product_id, COALESCE(x.variant_label,'') AS variant_label, x.quantity AS required
      FROM jsonb_to_recordset(p_items)
        AS x(product_id TEXT, quantity INTEGER, variant_label TEXT, is_kit BOOLEAN, kit_components JSONB)
      WHERE COALESCE(x.is_kit,false)=false
      UNION ALL
      SELECT c.product_id, '' AS variant_label, (c.quantity * x.quantity) AS required
      FROM jsonb_to_recordset(p_items)
        AS x(product_id TEXT, quantity INTEGER, variant_label TEXT, is_kit BOOLEAN, kit_components JSONB)
      CROSS JOIN LATERAL jsonb_to_recordset(COALESCE(x.kit_components,'[]'::jsonb))
        AS c(product_id TEXT, quantity INTEGER)
      WHERE COALESCE(x.is_kit,false)=true
    )
    SELECT product_id, variant_label, SUM(required)::INTEGER AS required
    FROM raw
    GROUP BY product_id, variant_label
    ORDER BY product_id, variant_label
  LOOP
    IF v_req.required IS NULL OR v_req.required <= 0 THEN
      RAISE EXCEPTION 'Cantidad inválida para producto %',v_req.product_id;
    END IF;
    PERFORM pg_advisory_xact_lock(hashtext('inventory:'||v_req.product_id||':'||p_branch_id||':'||v_req.variant_label));
    SELECT * INTO v_inv FROM inventory
      WHERE product_id=v_req.product_id AND branch_id=p_branch_id
        AND COALESCE(variant_label,'')=v_req.variant_label FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'No existe inventario para producto %',v_req.product_id; END IF;
    IF v_inv.quantity < v_req.required THEN
      RAISE EXCEPTION 'Stock insuficiente para producto %: disponible %, requerido %',v_req.product_id,v_inv.quantity,v_req.required;
    END IF;
    UPDATE inventory SET quantity=quantity-v_req.required WHERE id=v_inv.id;
  END LOOP;

  INSERT INTO transactions(id,branch_id,user_id,date,total,tax,discount,items,payments,payment_method,session_id,customer_id,notes,status,created_at)
  VALUES(p_id,p_branch_id,p_user_id,p_date,p_total,p_tax,p_discount,p_items,p_payments,p_payment_method,p_session_id,p_customer_id,p_notes,'completed',NOW());

  INSERT INTO inventory_movements(product_id,branch_id,variant_label,quantity_delta,movement_type,reference_id,user_id,metadata)
  SELECT r.product_id,p_branch_id,r.variant_label,-r.required,
    CASE WHEN EXISTS (
      SELECT 1 FROM jsonb_to_recordset(p_items) x(product_id TEXT, quantity INTEGER, variant_label TEXT, is_kit BOOLEAN, kit_components JSONB)
      WHERE x.is_kit=true AND EXISTS (
        SELECT 1 FROM jsonb_to_recordset(COALESCE(x.kit_components,'[]'::jsonb)) c(product_id TEXT,quantity INTEGER) WHERE c.product_id=r.product_id
      )
    ) THEN 'KIT_CONSUMPTION' ELSE 'SALE' END,
    p_id,p_user_id,NULL
  FROM (
    WITH raw AS (
      SELECT x.product_id, COALESCE(x.variant_label,'') AS variant_label, x.quantity AS required
      FROM jsonb_to_recordset(p_items) x(product_id TEXT,quantity INTEGER,variant_label TEXT,is_kit BOOLEAN,kit_components JSONB)
      WHERE COALESCE(x.is_kit,false)=false
      UNION ALL
      SELECT c.product_id,'',(c.quantity*x.quantity)
      FROM jsonb_to_recordset(p_items) x(product_id TEXT,quantity INTEGER,variant_label TEXT,is_kit BOOLEAN,kit_components JSONB)
      CROSS JOIN LATERAL jsonb_to_recordset(COALESCE(x.kit_components,'[]'::jsonb)) c(product_id TEXT,quantity INTEGER)
      WHERE COALESCE(x.is_kit,false)=true
    ) SELECT product_id,variant_label,SUM(required)::INTEGER required FROM raw GROUP BY product_id,variant_label
  ) r;

  INSERT INTO audit_log(user_id,action,entity_type,entity_id,meta)
  VALUES(p_user_id,'PROCESS_TRANSACTION','transaction',p_id,jsonb_build_object('total',p_total,'session_id',p_session_id));
  RETURN jsonb_build_object('success',true,'id',p_id);
END $$;

-- ==========================================================================
-- Anulación: reversa exactamente los movimientos generados por la venta.
-- ==========================================================================
CREATE OR REPLACE FUNCTION void_pos_transaction_v2(p_id TEXT,p_user_id TEXT,p_reason TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE t RECORD; i RECORD; c RECORD; qty INTEGER;
BEGIN
  SELECT * INTO t FROM transactions WHERE id=p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Venta % no encontrada',p_id; END IF;
  IF t.deleted_at IS NOT NULL THEN RETURN jsonb_build_object('success',true,'id',p_id,'already_voided',true); END IF;

  FOR i IN SELECT * FROM jsonb_to_recordset(t.items) AS x(product_id TEXT, quantity INTEGER, variant_label TEXT, is_kit BOOLEAN, kit_components JSONB)
  LOOP
    IF COALESCE(i.is_kit,false) AND jsonb_array_length(COALESCE(i.kit_components,'[]'::jsonb))>0 THEN
      FOR c IN SELECT * FROM jsonb_to_recordset(i.kit_components) AS x(product_id TEXT, quantity INTEGER)
      LOOP
        qty:=c.quantity*i.quantity;
        UPDATE inventory SET quantity=quantity+qty WHERE product_id=c.product_id AND branch_id=t.branch_id AND COALESCE(variant_label,'')='';
        INSERT INTO inventory_movements(product_id,branch_id,variant_label,quantity_delta,movement_type,reference_id,user_id,metadata)
        VALUES(c.product_id,t.branch_id,'',qty,'KIT_RETURN',p_id,p_user_id,jsonb_build_object('kit_product_id',i.product_id));
      END LOOP;
    ELSE
      UPDATE inventory SET quantity=quantity+i.quantity WHERE product_id=i.product_id AND branch_id=t.branch_id AND COALESCE(variant_label,'')=COALESCE(i.variant_label,'');
      IF NOT FOUND THEN
        INSERT INTO inventory(id,product_id,branch_id,variant_label,quantity,min_quantity)
        VALUES(gen_random_uuid()::text,i.product_id,t.branch_id,COALESCE(i.variant_label,''),i.quantity,5);
      END IF;
      INSERT INTO inventory_movements(product_id,branch_id,variant_label,quantity_delta,movement_type,reference_id,user_id)
      VALUES(i.product_id,t.branch_id,COALESCE(i.variant_label,''),i.quantity,'VOID_RETURN',p_id,p_user_id);
    END IF;
  END LOOP;
  UPDATE transactions SET deleted_at=NOW(),deleted_by=p_user_id,delete_reason=p_reason,status='refunded' WHERE id=p_id;
  INSERT INTO audit_log(user_id,action,entity_type,entity_id,meta) VALUES(p_user_id,'VOID_TRANSACTION','transaction',p_id,jsonb_build_object('reason',p_reason));
  RETURN jsonb_build_object('success',true,'id',p_id);
END $$;

-- ==========================================================================
-- Cierre de turno: idempotente y sin liquidaciones duplicadas.
-- ==========================================================================
CREATE OR REPLACE FUNCTION close_cash_session_v2(
  p_session_id TEXT,p_closing_balances JSONB,p_closed_at TIMESTAMPTZ,p_notes TEXT,p_settlement_data JSONB
) RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE s RECORD; v_settlement JSONB; v_settlement_id TEXT;
BEGIN
  SELECT * INTO s FROM cash_sessions WHERE id=p_session_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Turno % no encontrado',p_session_id; END IF;
  IF s.status='closed' THEN
    SELECT row_to_json(ss.*)::jsonb INTO v_settlement FROM salary_settlements ss WHERE ss.session_id=p_session_id ORDER BY ss.created_at DESC LIMIT 1;
    RETURN jsonb_build_object('success',true,'session_id',p_session_id,'already_closed',true,'settlement',v_settlement,
      'settlement_id',CASE WHEN v_settlement IS NULL THEN NULL ELSE v_settlement->>'id' END);
  END IF;
  UPDATE cash_sessions SET status='closed',closed_at=p_closed_at,closing_balances=p_closing_balances,notes=p_notes,updated_at=NOW() WHERE id=p_session_id;
  SELECT id INTO v_settlement_id FROM salary_settlements WHERE session_id=p_session_id ORDER BY created_at DESC LIMIT 1;
  IF v_settlement_id IS NULL THEN
    v_settlement_id:=COALESCE(NULLIF(p_settlement_data->>'id',''),'salary-'||p_session_id);
    INSERT INTO salary_settlements(id,user_id,user_name,session_id,base_salary,commissions,total,date,status,created_at)
    VALUES(v_settlement_id,p_settlement_data->>'userId',p_settlement_data->>'userName',p_session_id,
      COALESCE((p_settlement_data->>'baseSalary')::numeric,0),COALESCE((p_settlement_data->>'commissions')::numeric,0),
      COALESCE((p_settlement_data->>'total')::numeric,0),p_closed_at,
      COALESCE(NULLIF(p_settlement_data->>'status',''),'pending'),NOW())
    ON CONFLICT (id) DO UPDATE SET user_id=EXCLUDED.user_id,user_name=EXCLUDED.user_name,session_id=EXCLUDED.session_id,
      base_salary=EXCLUDED.base_salary,commissions=EXCLUDED.commissions,total=EXCLUDED.total,
      date=EXCLUDED.date,status=EXCLUDED.status;
  END IF;
  INSERT INTO audit_log(user_id,action,entity_type,entity_id,meta)
  VALUES(p_settlement_data->>'userId','CLOSE_SESSION','cash_session',p_session_id,p_settlement_data);
  RETURN jsonb_build_object('success',true,'session_id',p_session_id,'settlement_id',v_settlement_id);
END $$;

-- Candidatos de sucursales duplicadas: revisar antes de cualquier eliminación.
CREATE OR REPLACE VIEW duplicate_branch_candidates AS
SELECT lower(translate(trim(name),'áéíóúÁÉÍÓÚüÜñÑ','aeiouAEIOUuUnN')) AS normalized_name,
       array_agg(id ORDER BY id) AS branch_ids, count(*) AS branch_count
FROM branches GROUP BY 1 HAVING count(*)>1;

ALTER TABLE returns ADD COLUMN IF NOT EXISTS branch_id TEXT;
ALTER TABLE returns ADD COLUMN IF NOT EXISTS replacement_product_id TEXT;
ALTER TABLE returns ADD COLUMN IF NOT EXISTS replacement_quantity INTEGER;
ALTER TABLE returns ADD COLUMN IF NOT EXISTS processed_by TEXT;

-- ==========================================================================
-- Devoluciones: valida el acumulado y nunca confunde cambio de garantía con
-- devolución del producto equivocado.
-- ===========================================================================
CREATE OR REPLACE FUNCTION complete_return_v2(p_return_id TEXT, p_user_id TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
  r RECORD; t RECORD; sold_qty INTEGER; already_returned INTEGER; replacement_qty INTEGER;
  inv_qty INTEGER; variant TEXT; branch TEXT;
BEGIN
  SELECT * INTO r FROM returns WHERE id=p_return_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Devolución % no encontrada',p_return_id; END IF;
  IF r.status='completed' THEN RETURN jsonb_build_object('success',true,'already_completed',true,'id',p_return_id); END IF;
  IF r.status<>'pending' THEN RAISE EXCEPTION 'La devolución % no está pendiente',p_return_id; END IF;
  -- Lock the original sale so two different return IDs for the same sale
  -- cannot validate the same remaining quantity concurrently.
  SELECT * INTO t FROM transactions WHERE id=r.transaction_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Venta original % no encontrada',r.transaction_id; END IF;
  branch := t.branch_id;
  variant := COALESCE(r.variant_label,'');

  SELECT COALESCE(SUM(x.quantity),0) INTO sold_qty
  FROM jsonb_to_recordset(t.items) AS x(product_id TEXT,quantity INTEGER,variant_label TEXT)
  WHERE x.product_id=r.product_id AND COALESCE(x.variant_label,'')=variant;
  IF sold_qty<=0 THEN RAISE EXCEPTION 'El producto % no pertenece a la venta original',r.product_id; END IF;

  SELECT COALESCE(SUM(quantity),0) INTO already_returned
  FROM returns
  WHERE transaction_id=r.transaction_id AND product_id=r.product_id
    AND COALESCE(variant_label,'')=variant AND id<>r.id
    AND status IN ('pending','approved','completed');
  IF already_returned + r.quantity > sold_qty THEN
    RAISE EXCEPTION 'Devolución excede lo vendido: vendido %, ya solicitado %, nuevo %',sold_qty,already_returned,r.quantity;
  END IF;

  IF r.type='refund' THEN
    UPDATE inventory SET quantity=quantity+r.quantity
    WHERE product_id=r.product_id AND branch_id=branch AND COALESCE(variant_label,'')=variant;
    IF NOT FOUND THEN
      INSERT INTO inventory(id,product_id,branch_id,variant_label,quantity,min_quantity)
      VALUES(gen_random_uuid()::text,r.product_id,branch,variant,r.quantity,5);
    END IF;
    INSERT INTO inventory_movements(product_id,branch_id,variant_label,quantity_delta,movement_type,reference_id,user_id)
    VALUES(r.product_id,branch,variant,r.quantity,'RETURN',r.id,p_user_id);
  ELSIF r.type='warranty_exchange' THEN
    replacement_qty := COALESCE(r.replacement_quantity, r.quantity);
    IF r.replacement_product_id IS NOT NULL THEN
      SELECT quantity INTO inv_qty FROM inventory WHERE product_id=r.replacement_product_id AND branch_id=branch AND COALESCE(variant_label,'')='' FOR UPDATE;
      IF inv_qty IS NULL THEN RAISE EXCEPTION 'No existe inventario para producto de reemplazo %',r.replacement_product_id; END IF;
      IF inv_qty < replacement_qty THEN RAISE EXCEPTION 'Stock insuficiente para reemplazo %: disponible %, requerido %',r.replacement_product_id,inv_qty,replacement_qty; END IF;
      UPDATE inventory SET quantity=quantity-replacement_qty WHERE product_id=r.replacement_product_id AND branch_id=branch AND COALESCE(variant_label,'')='';
      INSERT INTO inventory_movements(product_id,branch_id,variant_label,quantity_delta,movement_type,reference_id,user_id,metadata)
      VALUES(r.replacement_product_id,branch,'',-replacement_qty,'WARRANTY_EXCHANGE_OUT',r.id,p_user_id,jsonb_build_object('returned_product_id',r.product_id));
    END IF;
    -- El producto defectuoso no vuelve al inventario vendible automáticamente.
  END IF;

  UPDATE returns SET status='completed' WHERE id=p_return_id;
  INSERT INTO audit_log(user_id,action,entity_type,entity_id,meta)
  VALUES(p_user_id,'COMPLETE_RETURN','return',p_return_id,jsonb_build_object('transaction_id',r.transaction_id,'type',r.type));
  RETURN jsonb_build_object('success',true,'id',p_return_id);
END $$;

-- ==========================================================================
-- Transferencias: operación idempotente y atómica entre dos sucursales.
-- ===========================================================================
CREATE OR REPLACE FUNCTION process_inventory_transfer_v2(
  p_operation_id TEXT, p_product_id TEXT, p_from_branch_id TEXT,
  p_to_branch_id TEXT, p_variants JSONB, p_user_id TEXT
) RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE v RECORD; src inventory%ROWTYPE; first_branch TEXT; second_branch TEXT;
BEGIN
  IF p_from_branch_id=p_to_branch_id THEN RAISE EXCEPTION 'Origen y destino no pueden coincidir'; END IF;
  IF EXISTS (SELECT 1 FROM inventory_transfers WHERE operation_id=p_operation_id) THEN
    RETURN jsonb_build_object('success',true,'operation_id',p_operation_id,'already_existed',true);
  END IF;

  -- Aggregate repeated variants before validation/mutation.
  -- Also lock both branches in deterministic order to avoid A->B / B->A deadlocks.
  IF p_from_branch_id < p_to_branch_id THEN
    first_branch := p_from_branch_id; second_branch := p_to_branch_id;
  ELSE
    first_branch := p_to_branch_id; second_branch := p_from_branch_id;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('transfer:'||p_product_id||':'||first_branch));
  PERFORM pg_advisory_xact_lock(hashtext('transfer:'||p_product_id||':'||second_branch));

  FOR v IN
    SELECT COALESCE(x.variant_label,'') AS variant_label, SUM(x.quantity)::INTEGER AS quantity
    FROM jsonb_to_recordset(p_variants) AS x(variant_label TEXT, quantity INTEGER)
    GROUP BY COALESCE(x.variant_label,'')
  LOOP
    IF v.quantity<=0 THEN RAISE EXCEPTION 'Cantidad inválida en transferencia'; END IF;
    SELECT * INTO src FROM inventory WHERE product_id=p_product_id AND branch_id=p_from_branch_id
      AND COALESCE(variant_label,'')=v.variant_label FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'No existe stock origen para variante %',v.variant_label; END IF;
    IF src.quantity<v.quantity THEN RAISE EXCEPTION 'Stock insuficiente en origen: disponible %, requerido %',src.quantity,v.quantity; END IF;
  END LOOP;

  FOR v IN
    SELECT COALESCE(x.variant_label,'') AS variant_label, SUM(x.quantity)::INTEGER AS quantity
    FROM jsonb_to_recordset(p_variants) AS x(variant_label TEXT, quantity INTEGER)
    GROUP BY COALESCE(x.variant_label,'')
  LOOP
    UPDATE inventory SET quantity=quantity-v.quantity WHERE product_id=p_product_id AND branch_id=p_from_branch_id AND COALESCE(variant_label,'')=v.variant_label;
    INSERT INTO inventory_movements(product_id,branch_id,variant_label,quantity_delta,movement_type,reference_id,user_id)
    VALUES(p_product_id,p_from_branch_id,v.variant_label,-v.quantity,'TRANSFER_OUT',p_operation_id,p_user_id);
    UPDATE inventory SET quantity=quantity+v.quantity
      WHERE product_id=p_product_id AND branch_id=p_to_branch_id AND COALESCE(variant_label,'')=v.variant_label;
    IF NOT FOUND THEN
      INSERT INTO inventory(product_id,branch_id,variant_label,quantity,min_quantity,id)
      VALUES(p_product_id,p_to_branch_id,v.variant_label,v.quantity,5,gen_random_uuid()::text);
    END IF;
    INSERT INTO inventory_movements(product_id,branch_id,variant_label,quantity_delta,movement_type,reference_id,user_id)
    VALUES(p_product_id,p_to_branch_id,v.variant_label,v.quantity,'TRANSFER_IN',p_operation_id,p_user_id);
  END LOOP;

  INSERT INTO inventory_transfers(id,operation_id,product_id,product_name,from_branch_id,from_branch_name,to_branch_id,to_branch_name,variant_label,quantity,variants,date,user_id,status)
  SELECT p_operation_id,p_operation_id,p_product_id,p.name,p_from_branch_id,bf.name,p_to_branch_id,bt.name,
    COALESCE((SELECT string_agg(COALESCE(x.variant_label,'Base')||': '||x.quantity, ', ') FROM (SELECT COALESCE(y.variant_label,'') variant_label,SUM(y.quantity)::INTEGER quantity FROM jsonb_to_recordset(p_variants) y(variant_label TEXT,quantity INTEGER) GROUP BY COALESCE(y.variant_label,'')) x),'Base'),
    (SELECT COALESCE(SUM(quantity),0) FROM jsonb_to_recordset(p_variants) AS x(variant_label TEXT,quantity INTEGER)),
    p_variants,NOW(),NULLIF(p_user_id,'system'),'completed'
  FROM products p, branches bf, branches bt
  WHERE p.id=p_product_id AND bf.id=p_from_branch_id AND bt.id=p_to_branch_id;
  RETURN jsonb_build_object('success',true,'operation_id',p_operation_id);
END $$;

-- ==========================================================================
-- Recepción de proveedor: PENDING -> RECEIVED solo una vez.
-- ===========================================================================
CREATE OR REPLACE FUNCTION receive_supplier_order_v2(p_order_id TEXT,p_user_id TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE o RECORD; i RECORD; v RECORD; qty INTEGER; branch TEXT;
BEGIN
  SELECT * INTO o FROM supplier_orders WHERE id=p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Orden de proveedor % no encontrada',p_order_id; END IF;
  IF o.status='received' THEN RETURN jsonb_build_object('success',true,'already_received',true,'id',p_order_id); END IF;
  IF o.status<>'pending' THEN RAISE EXCEPTION 'La orden % no está pendiente',p_order_id; END IF;
  branch:=o.branch_id;
  FOR i IN SELECT * FROM jsonb_to_recordset(o.items) AS x(product_id TEXT,quantity INTEGER,variant_label TEXT)
  LOOP
    IF i.quantity<=0 THEN RAISE EXCEPTION 'Cantidad inválida en orden %',p_order_id; END IF;
    PERFORM pg_advisory_xact_lock(hashtext('inventory:'||i.product_id||':'||branch||':'||COALESCE(i.variant_label,'')));
    UPDATE inventory SET quantity=quantity+i.quantity
      WHERE product_id=i.product_id AND branch_id=branch AND COALESCE(variant_label,'')=COALESCE(i.variant_label,'');
    IF NOT FOUND THEN
      INSERT INTO inventory(id,product_id,branch_id,variant_label,quantity,min_quantity)
      VALUES(gen_random_uuid()::text,i.product_id,branch,COALESCE(i.variant_label,''),i.quantity,5);
    END IF;
    INSERT INTO inventory_movements(product_id,branch_id,variant_label,quantity_delta,movement_type,reference_id,user_id)
    VALUES(i.product_id,branch,COALESCE(i.variant_label,''),i.quantity,'PURCHASE',p_order_id,p_user_id);
  END LOOP;
  UPDATE supplier_orders SET status='received' WHERE id=p_order_id;
  INSERT INTO audit_log(user_id,action,entity_type,entity_id,meta)
  VALUES(p_user_id,'RECEIVE_SUPPLIER_ORDER','supplier_order',p_order_id,jsonb_build_object('branch_id',branch));
  RETURN jsonb_build_object('success',true,'id',p_order_id);
END $$;

-- ==========================================================================
-- Auditoría física: el servidor calcula la diferencia contra el stock real.
-- ===========================================================================
ALTER TABLE inventory_audits ADD COLUMN IF NOT EXISTS items JSONB DEFAULT '[]'::jsonb;
CREATE OR REPLACE FUNCTION complete_inventory_audit_v2(
  p_audit_id TEXT,p_branch_id TEXT,p_user_id TEXT,p_items JSONB,p_notes TEXT
) RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE a RECORD; i RECORD; current_qty INTEGER; actual_qty INTEGER; diff INTEGER;
BEGIN
  SELECT * INTO a FROM inventory_audits WHERE id=p_audit_id FOR UPDATE;
  IF FOUND AND a.status='completed' THEN RETURN jsonb_build_object('success',true,'already_completed',true,'id',p_audit_id); END IF;
  IF NOT FOUND THEN
    INSERT INTO inventory_audits(id,date,branch_id,user_id,status,notes,items)
    VALUES(p_audit_id,NOW(),p_branch_id,p_user_id,'pending',p_notes,p_items);
  END IF;
  DELETE FROM inventory_audit_items WHERE audit_id=p_audit_id;

  FOR i IN SELECT * FROM jsonb_to_recordset(p_items) AS x(product_id TEXT,product_name TEXT,variant_label TEXT,expected INTEGER,actual INTEGER,counted INTEGER)
  LOOP
    actual_qty:=GREATEST(0,COALESCE(i.actual,i.counted,0));
    SELECT quantity INTO current_qty FROM inventory WHERE product_id=i.product_id AND branch_id=p_branch_id AND COALESCE(variant_label,'')=COALESCE(i.variant_label,'') FOR UPDATE;
    current_qty:=COALESCE(current_qty,0);
    diff:=actual_qty-current_qty;
    INSERT INTO inventory_audit_items(id,audit_id,product_id,product_name,variant_label,expected,actual,difference)
    VALUES(gen_random_uuid()::text,p_audit_id,i.product_id,COALESCE(i.product_name,'Producto'),COALESCE(i.variant_label,''),current_qty,actual_qty,diff);
    IF current_qty=0 AND NOT EXISTS (SELECT 1 FROM inventory WHERE product_id=i.product_id AND branch_id=p_branch_id AND COALESCE(variant_label,'')=COALESCE(i.variant_label,'')) THEN
      INSERT INTO inventory(id,product_id,branch_id,variant_label,quantity,min_quantity)
      VALUES(gen_random_uuid()::text,i.product_id,p_branch_id,COALESCE(i.variant_label,''),actual_qty,5);
    ELSE
      UPDATE inventory SET quantity=actual_qty WHERE product_id=i.product_id AND branch_id=p_branch_id AND COALESCE(variant_label,'')=COALESCE(i.variant_label,'');
    END IF;
    IF diff<>0 THEN
      INSERT INTO inventory_movements(product_id,branch_id,variant_label,quantity_delta,movement_type,reference_id,user_id,metadata)
      VALUES(i.product_id,p_branch_id,COALESCE(i.variant_label,''),diff,'AUDIT',p_audit_id,p_user_id,jsonb_build_object('expected',current_qty,'actual',actual_qty));
    END IF;
  END LOOP;
  UPDATE inventory_audits SET status='completed',date=NOW(),user_id=p_user_id,notes=p_notes,items=p_items WHERE id=p_audit_id;
  INSERT INTO audit_log(user_id,action,entity_type,entity_id,meta)
  VALUES(p_user_id,'COMPLETE_INVENTORY_AUDIT','inventory_audit',p_audit_id,jsonb_build_object('branch_id',p_branch_id));
  RETURN jsonb_build_object('success',true,'id',p_audit_id);
END $$;

-- Auditoría de uso por sucursal para detectar duplicados como almacenes con el
-- mismo nombre sin eliminar automáticamente ninguno.
CREATE OR REPLACE VIEW branch_usage_audit AS
SELECT b.id,b.name,
  (SELECT COUNT(*) FROM inventory i WHERE i.branch_id=b.id) AS inventory_rows,
  (SELECT COALESCE(SUM(i.quantity),0) FROM inventory i WHERE i.branch_id=b.id) AS inventory_units,
  (SELECT COUNT(*) FROM transactions t WHERE t.branch_id=b.id AND t.deleted_at IS NULL) AS active_sales,
  (SELECT COUNT(*) FROM cash_sessions s WHERE s.branch_id=b.id AND s.deleted_at IS NULL) AS cash_sessions,
  (SELECT COUNT(*) FROM inventory_transfers x WHERE x.from_branch_id=b.id OR x.to_branch_id=b.id) AS transfers,
  (SELECT COUNT(*) FROM supplier_orders so WHERE so.branch_id=b.id) AS supplier_orders,
  (SELECT COUNT(*) FROM inventory_audits ia WHERE ia.branch_id=b.id) AS inventory_audits,
  (SELECT COUNT(*) FROM users u WHERE u.branch_id=b.id) AS users_count
FROM branches b;
        AS c(product_id TEXT, quantity INTEGER)
      WHERE COALESCE(x.is_kit,false)=true
    )
    SELECT product_id, variant_label, SUM(required)::INTEGER AS required
    FROM raw
    GROUP BY product_id, variant_label
    ORDER BY product_id, variant_label
  LOOP
    IF v_req.required IS NULL OR v_req.required <= 0 THEN
      RAISE EXCEPTION 'Cantidad inválida para producto %',v_req.product_id;
    END IF;
    PERFORM pg_advisory_xact_lock(hashtext('inventory:'||v_req.product_id||':'||p_branch_id||':'||v_req.variant_label));
    SELECT * INTO v_inv FROM inventory
      WHERE product_id=v_req.product_id AND branch_id=p_branch_id
        AND COALESCE(variant_label,'')=v_req.variant_label FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'No existe inventario para producto %',v_req.product_id; END IF;
    IF v_inv.quantity < v_req.required THEN
      RAISE EXCEPTION 'Stock insuficiente para producto %: disponible %, requerido %',v_req.product_id,v_inv.quantity,v_req.required;
    END IF;
    UPDATE inventory SET quantity=quantity-v_req.required WHERE id=v_inv.id;
  END LOOP;

  INSERT INTO transactions(id,branch_id,user_id,date,total,tax,discount,items,payments,payment_method,session_id,customer_id,notes,status,created_at)
  VALUES(p_id,p_branch_id,p_user_id,p_date,p_total,p_tax,p_discount,p_items,p_payments,p_payment_method,p_session_id,p_customer_id,p_notes,'completed',NOW());

  INSERT INTO inventory_movements(product_id,branch_id,variant_label,quantity_delta,movement_type,reference_id,user_id,metadata)
  SELECT r.product_id,p_branch_id,r.variant_label,-r.required,
    CASE WHEN EXISTS (
      SELECT 1 FROM jsonb_to_recordset(p_items) x(product_id TEXT, quantity INTEGER, variant_label TEXT, is_kit BOOLEAN, kit_components JSONB)
      WHERE x.is_kit=true AND EXISTS (
        SELECT 1 FROM jsonb_to_recordset(COALESCE(x.kit_components,'[]'::jsonb)) c(product_id TEXT,quantity INTEGER) WHERE c.product_id=r.product_id
      )
    ) THEN 'KIT_CONSUMPTION' ELSE 'SALE' END,
    p_id,p_user_id,NULL
  FROM (
    WITH raw AS (
      SELECT x.product_id, COALESCE(x.variant_label,'') AS variant_label, x.quantity AS required
      FROM jsonb_to_recordset(p_items) x(product_id TEXT,quantity INTEGER,variant_label TEXT,is_kit BOOLEAN,kit_components JSONB)
      WHERE COALESCE(x.is_kit,false)=false
      UNION ALL
      SELECT c.product_id,'',(c.quantity*x.quantity)
      FROM jsonb_to_recordset(p_items) x(product_id TEXT,quantity INTEGER,variant_label TEXT,is_kit BOOLEAN,kit_components JSONB)
      CROSS JOIN LATERAL jsonb_to_recordset(COALESCE(x.kit_components,'[]'::jsonb)) c(product_id TEXT,quantity INTEGER)
      WHERE COALESCE(x.is_kit,false)=true
    ) SELECT product_id,variant_label,SUM(required)::INTEGER required FROM raw GROUP BY product_id,variant_label
  ) r;

  INSERT INTO audit_log(user_id,action,entity_type,entity_id,meta)
  VALUES(p_user_id,'PROCESS_TRANSACTION','transaction',p_id,jsonb_build_object('total',p_total,'session_id',p_session_id));
  RETURN jsonb_build_object('success',true,'id',p_id);
END $$;

-- --------------------------------------------------------------------------
-- Inventario offline-first: nunca sincronizar un "stock absoluto" sin contexto.
-- Los POS envían operaciones idempotentes (delta) o una reconciliación protegida
-- por el valor que el empleado vio antes de hacer el conteo.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION apply_inventory_adjustment_v2(
  p_operation_id TEXT, p_product_id TEXT, p_branch_id TEXT, p_variant_label TEXT,
  p_delta INTEGER, p_min_quantity INTEGER, p_user_id TEXT, p_movement_type TEXT
) RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE v_inv inventory%ROWTYPE; v_variant TEXT := COALESCE(p_variant_label,'');
BEGIN
  IF EXISTS (SELECT 1 FROM inventory_movements WHERE reference_id=p_operation_id) THEN
    RETURN jsonb_build_object('success',true,'already_applied',true,'operation_id',p_operation_id);
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('inventory:'||p_product_id||':'||p_branch_id||':'||v_variant));
  SELECT * INTO v_inv FROM inventory
    WHERE product_id=p_product_id AND branch_id=p_branch_id AND COALESCE(variant_label,'')=v_variant FOR UPDATE;
  IF NOT FOUND THEN
    IF p_delta < 0 THEN RAISE EXCEPTION 'No existe inventario para producto %',p_product_id; END IF;
    INSERT INTO inventory(id,product_id,branch_id,variant_label,quantity,min_quantity)
    VALUES(gen_random_uuid()::text,p_product_id,p_branch_id,v_variant,p_delta,COALESCE(p_min_quantity,5))
    RETURNING * INTO v_inv;
  ELSE
    IF v_inv.quantity + p_delta < 0 THEN
      RAISE EXCEPTION 'Ajuste dejaría inventario negativo para producto %',p_product_id;
    END IF;
    UPDATE inventory SET quantity=v_inv.quantity+p_delta,min_quantity=COALESCE(p_min_quantity,v_inv.min_quantity)
    WHERE id=v_inv.id RETURNING * INTO v_inv;
  END IF;
  INSERT INTO inventory_movements(product_id,branch_id,variant_label,quantity_delta,movement_type,reference_id,user_id)
  VALUES(p_product_id,p_branch_id,v_variant,p_delta,COALESCE(NULLIF(p_movement_type,''),'ADJUSTMENT'),p_operation_id,p_user_id);
  RETURN jsonb_build_object('success',true,'quantity',v_inv.quantity,'operation_id',p_operation_id);
END $$;

CREATE OR REPLACE FUNCTION reconcile_inventory_v2(
  p_operation_id TEXT, p_product_id TEXT, p_branch_id TEXT, p_variant_label TEXT,
  p_expected_quantity INTEGER, p_new_quantity INTEGER, p_min_quantity INTEGER, p_user_id TEXT
) RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE v_inv inventory%ROWTYPE; v_variant TEXT := COALESCE(p_variant_label,''); v_delta INTEGER;
BEGIN
  IF EXISTS (SELECT 1 FROM inventory_movements WHERE reference_id=p_operation_id) THEN
    RETURN jsonb_build_object('success',true,'already_applied',true,'operation_id',p_operation_id);
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('inventory:'||p_product_id||':'||p_branch_id||':'||v_variant));
  SELECT * INTO v_inv FROM inventory
    WHERE product_id=p_product_id AND branch_id=p_branch_id AND COALESCE(variant_label,'')=v_variant FOR UPDATE;
  IF NOT FOUND THEN
    IF COALESCE(p_expected_quantity,0) <> 0 THEN
      RETURN jsonb_build_object('success',false,'conflict',true,'message','El inventario ya no coincide con el valor visto offline.');
    END IF;
    INSERT INTO inventory(id,product_id,branch_id,variant_label,quantity,min_quantity)
    VALUES(gen_random_uuid()::text,p_product_id,p_branch_id,v_variant,GREATEST(0,p_new_quantity),COALESCE(p_min_quantity,5))
    RETURNING * INTO v_inv;
    v_delta := GREATEST(0,p_new_quantity);
  ELSE
    IF v_inv.quantity <> COALESCE(p_expected_quantity,0) THEN
      RETURN jsonb_build_object('success',false,'conflict',true,'message',format('Conflicto: servidor tiene %, dispositivo esperaba %.',v_inv.quantity,p_expected_quantity));
    END IF;
    v_delta := GREATEST(0,p_new_quantity)-v_inv.quantity;
    UPDATE inventory SET quantity=GREATEST(0,p_new_quantity),min_quantity=COALESCE(p_min_quantity,v_inv.min_quantity)
    WHERE id=v_inv.id RETURNING * INTO v_inv;
  END IF;
  IF v_delta <> 0 THEN
    INSERT INTO inventory_movements(product_id,branch_id,variant_label,quantity_delta,movement_type,reference_id,user_id)
    VALUES(p_product_id,p_branch_id,v_variant,v_delta,'RECONCILIATION',p_operation_id,p_user_id);
  END IF;
  RETURN jsonb_build_object('success',true,'quantity',v_inv.quantity,'operation_id',p_operation_id);
END $$;


-- --------------------------------------------------------------------------
-- OmniSync repair: normalize duplicate inventory identities before the unique key.
-- Existing duplicate rows are backed up before consolidation.
-- Negative quantities are reported, not silently changed.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inventory_duplicate_repair_backup (
  repair_id UUID NOT NULL DEFAULT gen_random_uuid(),
  repaired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  id TEXT, product_id TEXT, branch_id TEXT, variant_label TEXT,
  quantity INTEGER, min_quantity INTEGER
);

CREATE TABLE IF NOT EXISTS inventory_negative_stock_review (
  id TEXT PRIMARY KEY,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  product_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  variant_label TEXT NOT NULL DEFAULT '',
  quantity INTEGER NOT NULL,
  min_quantity INTEGER NOT NULL DEFAULT 5,
  status TEXT NOT NULL DEFAULT 'pending'
);

INSERT INTO inventory_negative_stock_review(id, product_id, branch_id, variant_label, quantity, min_quantity)
SELECT i.id, i.product_id, i.branch_id, COALESCE(i.variant_label,''), i.quantity, COALESCE(i.min_quantity,5)
FROM inventory i
WHERE i.quantity < 0
ON CONFLICT (id) DO NOTHING;

DO $$
DECLARE r RECORD; keep_id TEXT; total_qty INTEGER; max_min INTEGER;
BEGIN
  FOR r IN
    SELECT product_id, branch_id, COALESCE(variant_label,'') AS variant_label
    FROM inventory GROUP BY 1,2,3 HAVING COUNT(*) > 1
  LOOP
    INSERT INTO inventory_duplicate_repair_backup(id, product_id, branch_id, variant_label, quantity, min_quantity)
    SELECT id, product_id, branch_id, COALESCE(variant_label,''), quantity, COALESCE(min_quantity,5)
    FROM inventory
    WHERE product_id=r.product_id AND branch_id=r.branch_id AND COALESCE(variant_label,'')=r.variant_label;

    SELECT id INTO keep_id FROM inventory
    WHERE product_id=r.product_id AND branch_id=r.branch_id AND COALESCE(variant_label,'')=r.variant_label
    ORDER BY id LIMIT 1;
    SELECT COALESCE(SUM(quantity),0), COALESCE(MAX(min_quantity),5) INTO total_qty,max_min
    FROM inventory
    WHERE product_id=r.product_id AND branch_id=r.branch_id AND COALESCE(variant_label,'')=r.variant_label;
    UPDATE inventory SET quantity=total_qty, min_quantity=max_min, variant_label=r.variant_label WHERE id=keep_id;
    DELETE FROM inventory
    WHERE product_id=r.product_id AND branch_id=r.branch_id AND COALESCE(variant_label,'')=r.variant_label AND id<>keep_id;
  END LOOP;
END $$;

UPDATE inventory SET variant_label='' WHERE variant_label IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS inventory_product_branch_variant_uidx
  ON inventory (product_id, branch_id, COALESCE(variant_label,''));

-- Apertura offline determinista: conserva el ID local para ventas encoladas.
CREATE OR REPLACE FUNCTION open_cash_session_v3(
  p_session_id TEXT, p_user_id TEXT, p_worker_name TEXT, p_branch_id TEXT,
  p_opening_amount NUMERIC, p_opened_at TIMESTAMPTZ,
  p_working_employee_ids TEXT[], p_notes TEXT
) RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE v_next_turn INTEGER; v_result JSONB;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('cash-session:' || p_branch_id));
  IF EXISTS (SELECT 1 FROM cash_sessions WHERE id=p_session_id) THEN
    SELECT row_to_json(cash_sessions.*)::jsonb INTO v_result FROM cash_sessions WHERE id=p_session_id;
    RETURN v_result;
  END IF;
  IF EXISTS (SELECT 1 FROM cash_sessions WHERE branch_id=p_branch_id AND status='open' AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'Ya existe un turno abierto para la sucursal %', p_branch_id USING ERRCODE='23505';
  END IF;
  INSERT INTO settings(id,last_turn_number) VALUES('global',1)
  ON CONFLICT(id) DO UPDATE SET last_turn_number=settings.last_turn_number+1
  RETURNING last_turn_number INTO v_next_turn;
  INSERT INTO cash_sessions(id,user_id,worker_name,branch_id,opened_at,opening_balance,opening_amount,status,working_employee_ids,notes,created_at)
  VALUES(p_session_id,p_user_id,p_worker_name,p_branch_id,p_opened_at,p_opening_amount,p_opening_amount,'open',p_working_employee_ids,p_notes,NOW())
  RETURNING row_to_json(cash_sessions.*)::jsonb INTO v_result;
  INSERT INTO audit_log(user_id,action,entity_type,entity_id,new_data)
  VALUES(p_user_id,'OPEN_SESSION','cash_session',p_session_id,v_result);
  RETURN v_result;
END $$;
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

-- FASE 27.2: idempotencia fuerte de transferencias offline.
-- Evita que dos replays concurrentes con el mismo operation_id puedan mover
-- inventario dos veces antes de que el RPC vea el registro existente.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'inventory_transfers_operation_id_key'
      AND conrelid = 'public.inventory_transfers'::regclass
  ) THEN
    ALTER TABLE public.inventory_transfers
      ADD CONSTRAINT inventory_transfers_operation_id_key UNIQUE (operation_id);
  END IF;
END $$;

-- FASE 27.2: el RPC de anulación bloquea cada SKU/variante antes de reponerlo,
-- evitando carreras entre anulaciones/devoluciones concurrentes.
CREATE OR REPLACE FUNCTION public.void_pos_transaction_v2(
  p_id text, p_user_id text, p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE t RECORD; i RECORD; c RECORD; qty integer; v_variant text;
BEGIN
  SELECT * INTO t FROM public.transactions WHERE id=p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Venta % no encontrada',p_id; END IF;
  IF t.deleted_at IS NOT NULL THEN
    RETURN jsonb_build_object('success',true,'id',p_id,'already_voided',true);
  END IF;
  FOR i IN SELECT * FROM jsonb_to_recordset(t.items) AS x(product_id text,quantity integer,variant_label text,is_kit boolean,kit_components jsonb) LOOP
    IF COALESCE(i.quantity,0)<=0 THEN RAISE EXCEPTION 'Cantidad inválida en venta %',p_id; END IF;
    IF COALESCE(i.is_kit,false) AND jsonb_array_length(COALESCE(i.kit_components,'[]'::jsonb))>0 THEN
      FOR c IN SELECT * FROM jsonb_to_recordset(i.kit_components) AS x(product_id text,quantity integer) LOOP
        qty:=c.quantity*i.quantity;
        PERFORM pg_advisory_xact_lock(hashtext('inventory:'||c.product_id||':'||t.branch_id||':'));
        UPDATE public.inventory SET quantity=quantity+qty WHERE product_id=c.product_id AND branch_id=t.branch_id AND COALESCE(variant_label,'')='';
        IF NOT FOUND THEN INSERT INTO public.inventory(id,product_id,branch_id,variant_label,quantity,min_quantity) VALUES(gen_random_uuid()::text,c.product_id,t.branch_id,'',qty,5); END IF;
        INSERT INTO public.inventory_movements(product_id,branch_id,variant_label,quantity_delta,movement_type,reference_id,user_id,metadata) VALUES(c.product_id,t.branch_id,'',qty,'KIT_RETURN',p_id,p_user_id,jsonb_build_object('kit_product_id',i.product_id));
      END LOOP;
    ELSE
      v_variant:=COALESCE(i.variant_label,'');
      PERFORM pg_advisory_xact_lock(hashtext('inventory:'||i.product_id||':'||t.branch_id||':'||v_variant));
      UPDATE public.inventory SET quantity=quantity+i.quantity WHERE product_id=i.product_id AND branch_id=t.branch_id AND COALESCE(variant_label,'')=v_variant;
      IF NOT FOUND THEN INSERT INTO public.inventory(id,product_id,branch_id,variant_label,quantity,min_quantity) VALUES(gen_random_uuid()::text,i.product_id,t.branch_id,v_variant,i.quantity,5); END IF;
      INSERT INTO public.inventory_movements(product_id,branch_id,variant_label,quantity_delta,movement_type,reference_id,user_id) VALUES(i.product_id,t.branch_id,v_variant,i.quantity,'VOID_RETURN',p_id,p_user_id);
    END IF;
  END LOOP;
  UPDATE public.transactions SET deleted_at=NOW(),deleted_by=p_user_id,delete_reason=p_reason,status='refunded' WHERE id=p_id;
  INSERT INTO public.audit_log(user_id,action,entity_type,entity_id,meta) VALUES(p_user_id,'VOID_TRANSACTION','transaction',p_id,jsonb_build_object('reason',p_reason));
  RETURN jsonb_build_object('success',true,'id',p_id);
END $function$;
