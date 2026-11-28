/**
 * Contrato de sincronización offline.
 *
 * La cola durable ya garantiza idempotencia y dependencias. Este módulo añade
 * lo que faltaba para operar durante días sin red: versión de esquema por
 * operación, una secuencia monotónica por dispositivo (independiente del reloj
 * local) y una lectura única de la salud de la cola.
 */
import type { OfflineActionType, OfflineQueueItem } from '../offlineQueueTypes';

export const SYNC_PROTOCOL_VERSION = 2;
export const OFFLINE_ITEM_SCHEMA_VERSION = 1;

/** Días sin sincronizar antes de avisar y antes de considerar los datos fríos. */
export const OFFLINE_WARNING_DAYS = 20;
export const OFFLINE_WINDOW_DAYS = 30;

export type OfflineQueueHealth = {
  total: number;
  pending: number;
  failed: number;
  conflicts: number;
  oldestQueuedAt: string | null;
  lastError: string | null;
};

export type OfflineFreshness = {
  lastSyncAt: string | null;
  daysSinceSync: number | null;
  state: 'fresh' | 'warning' | 'stale' | 'unknown';
};

export type OfflinePendingOperation = {
  id: string;
  actionId: string;
  type: string;
  label: string;
  status: 'pending' | 'processing' | 'failed';
  queuedAt: string | null;
  lastError: string | null;
};

/* ---------------------------------------------------------------------------
 * Causa legible de un rechazo del servidor
 * ------------------------------------------------------------------------- */

/**
 * Contrato mínimo que este módulo sabe leer de un elemento de cola. Se declara
 * aquí (y no se importa desde `offlineQueue`) para que la traducción de errores
 * sea usable desde el motor de sincronización, desde el replay y desde tests
 * puros sin arrastrar IndexedDB, Supabase ni el store.
 */
export type SyncFailureCarrier = {
  type?: string;
  /** Estado de la cola; solo lectura para el mensaje (las conflictivas ya no reintentan). */
  status?: string;
  actionId?: string;
  id?: string;
  data?: unknown;
  retryCount?: number;
  lastError?: string;
  /** Causa legible persistida (contrato: cadena no vacía). */
  failureReason?: string;
  /** Código canónico del rechazo ('invalid_warehouse', ...). */
  failureCode?: string;
  /** Marca temporal ISO del último intento fallido. */
  failureAt?: string;
  /** 'permanent' deja la operación como conflicto definitivo; 'transient' se reintenta. */
  failureKind?: string;
};

/**
 * Rechazos del servidor que NO se arreglan reintentando: la fila objetivo ya no
 * existe o el acceso está denegado por contrato. Cada RPC valida
 * `public.warehouses ... and active` (ver
 * supabase/migrations/20261126120000_warehouses_always_operational.sql:99 y las
 * previas), así que un almacén dado de baja rechaza para siempre la operación
 * encolada contra él.
 *
 * Las claves son literales SQL (`raise exception 'invalid_warehouse'`) y, cuando
 * Postgres envuelve el raise, también aparecen dentro del mensaje del error.
 */
const PERMANENT_REJECTION_MESSAGES: Record<string, string> = {
  invalid_warehouse:
    'El almacén de esta operación ya no está disponible (se dio de baja). La operación no se aplicó; repítela en el almacén correcto.',
  warehouse_not_assigned:
    'El almacén de esta operación dejó de estar asignado a tu cuenta. Pide a un administrador que te reasigne el almacén y repite la operación.',
  location_access_denied:
    'Tu cuenta perdió el acceso al almacén de esta operación. Pide a un administrador que te reasigne el almacén y repite la operación.',
  invalid_product:
    'El producto de esta operación ya no está vigente en la empresa (se archivó o se eliminó). La operación no se aplicó; vuelve a hacerla con un producto activo.',
  invalid_variant:
    'La variante seleccionada ya no está disponible. Vuelve a registrar la operación con una variante vigente.',
  invalid_cash_session:
    'El turno de caja de esta operación ya no está abierto o pertenece a otro almacén. Cierra o abre el turno correcto y repite la operación.',
  cash_session_not_found:
    'El turno de caja indicado ya no existe en la nube. Repite la operación sobre el turno vigente.',
  sale_not_found:
    'La venta original ya no existe en la nube, así que esta operación derivada no puede aplicarse.',
  return_not_found:
    'La devolución original ya no existe en la nube, así que no se puede completar su cierre.',
  transfer_not_found:
    'El traslado original ya no existe en la nube, así que no se puede recibir ni cancelar.',
  employee_not_found:
    'El trabajador indicado ya no existe en la empresa, así que esta operación no puede aplicarse.',
  company_access_denied:
    'Esta cuenta ya no pertenece a la empresa dueña de la operación, por lo que el servidor la rechazó de forma definitiva.',
  insufficient_stock:
    'No hay stock suficiente en el almacén para aplicar esta operación. Ajusta las existencias y vuelve a intentarla.',
  insufficient_component_stock:
    'No hay stock suficiente de algún componente del producto. Repón las existencias y vuelve a intentarla.',
  stock_record_missing:
    'No existe la ficha de existencias de este producto en ese almacén. Registra su inventario y vuelve a intentarlo.',
  variant_stock_record_missing:
    'No existe la ficha de existencias de esta variante en ese almacén. Registra su inventario y vuelve a intentarlo.',
  plan_employee_limit:
    'La empresa alcanzó el límite de trabajadores de su plan; esta alta no se aplicó.',
  plan_warehouse_limit:
    'La empresa alcanzó el límite de almacenes de su plan; este almacén no se creó.',
  plan_product_limit:
    'La empresa alcanzó el límite de productos de su plan; este producto no se creó.',
  plan_feature_required:
    'El plan actual no habilita esta función; la operación no se aplicó.',
  serial_not_available:
    'El número de serie seleccionado ya no está disponible; la operación no se aplicó.',
  total_mismatch:
    'El total de la venta no coincide con sus artículos, así que el servidor la rechazó definitivamente.',
  payment_total_mismatch:
    'El total cobrado no coincide con el total de la venta, así que el servidor la rechazó definitivamente.',
  operation_id_required:
    'La operación no llevaba un identificador válido, así que el servidor no pudo registrarla.'
};

/** Alias corto para los códigos que este módulo reconoce como rechazo definitivo. */
export const PERMANENT_SYNC_ERROR_CODES = Object.keys(PERMANENT_REJECTION_MESSAGES);

/**
 * Rechazos que solo son definitivos para operaciones de inventario. Un traslado
 * ya aplicado o una recepción repetida pueden reintentarse sin dañar datos, así
 * que no se marcan aquí: los clasifica el llamador según el tipo.
 */
const INVENTORY_ONLY_PERMANENT_CODES = new Set([
  'invalid_transfer',
  'invalid_operation_id',
  'INVALID_OPERATION_ID'
]);

/** Códigos SQL estructurales: la fila o el permiso no existen, nunca va a pasar. */
const STRUCTURAL_SQL_CODES = new Set([
  '23503', '23505', '23514', '42501', '42883', '22003', '22P02', '22007',
  'IDEMPOTENCY_CONFLICT'
]);

/** Texto de red/transporte: siempre transitorio, jamás causa terminal. */
const TRANSIENT_MESSAGE_RE =
  /failed to fetch|network ?error|fetch failed|load failed|econn|enotfound|etimedout|timed? ?out|abort|timeout|supabase no (?:está|est[áa] )?(?:disponible|configurado|accesible)|no se pudo conectar|temporarily|unavailable|service unavailable|gateway/i;

/** HTTP 429/5xx y errores de transporte nunca terminan una operación. */
const TRANSIENT_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);

function canonicalizeRejectionKey(raw: unknown): string {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Extrae el código de rechazo del servidor. Prioriza el campo explícito y, si no
 * viene (Postgres devuelve el `raise exception` dentro del mensaje), busca los
 * literales conocidos. Nunca inventa un código: si no hay ninguno, devuelve ''.
 */
export function extractSyncErrorCode(codeOrMessage: unknown, message?: unknown): string {
  const explicit = canonicalizeRejectionKey(codeOrMessage);
  if (explicit && PERMANENT_REJECTION_MESSAGES[explicit]) return explicit;
  const haystack = [codeOrMessage, message]
    .map(value => (typeof value === 'string' || typeof value === 'number' ? String(value) : ''))
    .join(' ')
    .toLowerCase();
  for (const code of Object.keys(PERMANENT_REJECTION_MESSAGES)) {
    if (haystack.includes(code)) return code;
  }
  if (explicit) return explicit;
  return '';
}

/**
 * Traducción única de un rechazo a español operativo. Devuelve siempre texto
 * legible: el usuario nunca debe ver `invalid_warehouse` en crudo. Si el código
 * no es conocido pero llega un mensaje útil, se conserva ese mensaje normalizado.
 */
export function describeSyncFailure(codeOrMessage: unknown, type?: string): string {
  const rawCode = typeof codeOrMessage === 'string' || typeof codeOrMessage === 'number'
    ? String(codeOrMessage)
    : '';
  const rawMessage = typeof codeOrMessage === 'object' && codeOrMessage !== null
    ? String((codeOrMessage as { message?: unknown }).message ?? '')
    : '';
  const code = extractSyncErrorCode(rawCode || rawMessage, rawMessage || undefined);
  const label = type ? describeOfflineQueueType(type) : 'La operación';
  const known = PERMANENT_REJECTION_MESSAGES[code];
  if (known) return `${label}: ${known}`;
  if (TRANSIENT_MESSAGE_RE.test(`${rawCode} ${rawMessage}`)) {
    return `${label}: no hay conexión estable con la nube todavía. La operación sigue guardada y se reintentará sola.`;
  }
  const cleaned = `${rawMessage || rawCode}`.replace(/\s+/g, ' ').trim();
  if (cleaned) return `${label}: ${cleaned}`;
  return `${label}: el servidor rechazó la operación sin devolver un motivo. Reintenta la sincronización.`;
}

/**
 * Clasificación terminal de un rechazo. `permanent` significa "dejar de
 * reintentar y mostrar la causa"; `transient` significa "conservar y reintentar".
 * Una duda se resuelve SIEMPRE como transitoria: descartar trabajo del usuario
 * por un código mal interpretado cuesta stock real.
 */
export function isPermanentSyncRejection(
  input: {
    code?: unknown;
    message?: unknown;
    status?: unknown;
    type?: string;
    conflict?: boolean;
  } = {}
): boolean {
  if (input.conflict === true) return true;
  const status = Number(input.status);
  if (Number.isFinite(status) && TRANSIENT_STATUS_CODES.has(status)) return false;
  const code = extractSyncErrorCode(input.code, input.message);
  if (!code) return false;
  if (STRUCTURAL_SQL_CODES.has(String(input.code || '').trim().toUpperCase())) return true;
  if (PERMANENT_REJECTION_MESSAGES[code]) {
    // `insufficient_stock` sí puede corregirse (reponer y reintentar), así que
    // no saca la operación de la cola: solo explica la causa al operador.
    if (code === 'insufficient_stock' || code === 'insufficient_component_stock') return false;
    return true;
  }
  if (INVENTORY_ONLY_PERMANENT_CODES.has(code)) {
    const type = String(input.type || '');
    return type.startsWith('inventory') || type.startsWith('transfer');
  }
  return false;
}

export const QUEUE_TYPE_LABELS: Record<OfflineActionType, string> = {
  transaction: 'Venta',
  void_transaction: 'Anulación de venta',
  return: 'Devolución',
  return_complete: 'Cierre de devolución',
  cash_session: 'Turno de caja',
  cash_movement: 'Movimiento de caja',
  cash_movement_delete: 'Borrado de movimiento de caja',
  salary_settlement: 'Liquidación de salario',
  product: 'Producto',
  product_delete: 'Borrado de producto',
  inventory: 'Inventario',
  inventory_adjustment: 'Ajuste de inventario',
  inventory_reconcile: 'Conciliación de inventario',
  inventory_audit: 'Auditoría de inventario',
  audit_start: 'Inicio de auditoría',
  audit_complete: 'Conteo de auditoría',
  audit_recount: 'Recuento de auditoría',
  audit_approve: 'Aprobación de auditoría',
  audit_delete: 'Borrado de auditoría',
  transfer: 'Transferencia',
  transfer_bulk: 'Transferencia múltiple',
  transfer_receive: 'Recepción de transferencia',
  transfer_cancel: 'Cancelación de transferencia',
  supplier: 'Proveedor',
  supplier_order: 'Orden de compra',
  supplier_receive: 'Recepción de compra',
  customer: 'Cliente',
  customer_delete: 'Borrado de cliente',
  bank_card: 'Cuenta o tarjeta',
  bank_card_delete: 'Borrado de cuenta o tarjeta',
  bank_card_balance: 'Saldo bancario',
  bank_transaction: 'Movimiento bancario',
  bank_transaction_delete: 'Borrado de movimiento bancario',
  bank_internal_transfer: 'Transferencia bancaria',
  bank_internal_transfer_delete: 'Borrado de transferencia bancaria',
  branch: 'Sucursal',
  branch_delete: 'Borrado de sucursal',
  category: 'Categoría',
  category_delete: 'Borrado de categoría',
  user: 'Usuario',
  user_delete: 'Borrado de usuario',
  employee_create: 'Alta de empleado',
  employee_update: 'Edición de empleado',
  employee_status: 'Estado de empleado',
  employee_delete: 'Baja de empleado',
  invitation_revoke: 'Revocar invitación',
  team_role_upsert: 'Rol del equipo',
  team_compensation_settings: 'Compensación del equipo',
  quote: 'Cotización',
  quote_delete: 'Borrado de cotización',
  supplier_delete: 'Borrado de proveedor',
  warranty: 'Garantía',
  time_shift: 'Turno de personal',
  currency: 'Moneda',
  currency_rate: 'Tasa de cambio',
  store_config: 'Configuración de la empresa',
  receipt_config: 'Configuración del ticket',
  catalog_config: 'Configuración del catálogo',
  device_access_revoke: 'Revocar enlace de acceso'
};

export function describeOfflineQueueType(type: string): string {
  const key = String(type || '');
  // Una fila de un bundle viejo puede traer un tipo que ya no está en la unión.
  const label = QUEUE_TYPE_LABELS[key as OfflineActionType];
  if (label) return label;
  const readable = key.replace(/_/g, ' ').trim();
  if (!readable) return 'Operación';
  return readable.charAt(0).toUpperCase() + readable.slice(1);
}

function queueStatusRank(status: OfflineQueueItem['status']): number {
  if (status === 'conflict') return 4;
  if (status === 'processing') return 3;
  if (status === 'failed') return 2;
  return 1;
}

function queueItemTime(item: OfflineQueueItem): number {
  const parsed = Date.parse(String(item.queuedAt || item.timestamp || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

/** El actionId es la clave idempotente; dos filas con la misma clave son la misma operación. */
export function offlineQueueItemKey(item: Pick<OfflineQueueItem, 'id' | 'type' | 'actionId'>): string {
  const actionId = String(item.actionId || '');
  return actionId ? `${item.type}:${actionId}` : `${item.type}:id:${item.id}`;
}

/**
 * Clave idempotente explícita de una operación. Es exactamente la misma que usa
 * la deduplicación (`tipo:actionId`), se persiste con el elemento y sobrevive a
 * recargas y cierres: el reintento de un envío interrumpido reutiliza la clave
 * y el servidor no puede registrar la operación dos veces.
 */
export function offlineIdempotencyKey(
  item: Pick<OfflineQueueItem, 'id' | 'type' | 'actionId' | 'idempotencyKey'>
): string {
  const stored = String(item.idempotencyKey || '').trim();
  if (stored) return stored;
  return offlineQueueItemKey(item);
}

function preferredQueueItem(candidate: OfflineQueueItem, current: OfflineQueueItem): boolean {
  const rankDiff = queueStatusRank(candidate.status) - queueStatusRank(current.status);
  if (rankDiff !== 0) return rankDiff > 0;
  const timeDiff = queueItemTime(candidate) - queueItemTime(current);
  if (timeDiff !== 0) return timeDiff > 0;
  const retryDiff = Number(candidate.retryCount || 0) - Number(current.retryCount || 0);
  if (retryDiff !== 0) return retryDiff > 0;
  return String(candidate.id) > String(current.id);
}

/**
 * Clave idempotente de la operación. `enqueueOfflineItem` actualiza por
 * `type+actionId`, pero la cola también se reconcilia desde IndexedDB y el
 * respaldo localStorage; si una migración interrumpida o una carrera entre
 * pestañas deja filas repetidas, el contador debe medir operaciones y no filas.
 */
export function dedupeOfflineQueueItems(items: OfflineQueueItem[]): OfflineQueueItem[] {
  const byKey = new Map<string, OfflineQueueItem>();
  const order: string[] = [];
  for (const item of items) {
    if (!item || !item.id) continue;
    const key = offlineQueueItemKey(item);
    const current = byKey.get(key);
    if (!current) {
      byKey.set(key, item);
      order.push(key);
      continue;
    }
    if (preferredQueueItem(item, current)) byKey.set(key, item);
  }
  return order.map(key => byKey.get(key)).filter((item): item is OfflineQueueItem => Boolean(item));
}

export function listPendingOfflineOperations(
  items: OfflineQueueItem[],
  limit = 5
): OfflinePendingOperation[] {
  const pending = dedupeOfflineQueueItems(items)
    .filter(item => item.status !== 'conflict')
    .sort((a, b) => queueItemTime(a) - queueItemTime(b));
  const safeLimit = Math.max(0, Math.trunc(Number(limit) || 0));
  return pending.slice(0, safeLimit).map(item => {
    const queuedAt = item.queuedAt || item.timestamp || null;
    const queuedMs = queuedAt ? Date.parse(String(queuedAt)) : NaN;
    return {
      id: item.id,
      actionId: item.actionId,
      type: item.type,
      label: describeOfflineQueueType(item.type),
      status: item.status === 'conflict' ? 'pending' : (item.status || 'pending'),
      queuedAt: Number.isFinite(queuedMs) ? new Date(queuedMs).toISOString() : null,
      lastError: item.lastError ? String(item.lastError) : null
    };
  });
}

function timestampOf(item: Pick<OfflineQueueItem, 'timestamp'>): number {
  const parsed = Date.parse(String(item.timestamp || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Orden estable: primero la secuencia del dispositivo y, solo para elementos
 * heredados sin secuencia, la marca de tiempo. Nunca se ordena por reloj entre
 * dos dispositivos distintos.
 */
export function compareOfflineQueueItems(a: OfflineQueueItem, b: OfflineQueueItem): number {
  const seqA = Number(a.deviceSequence);
  const seqB = Number(b.deviceSequence);
  if (Number.isFinite(seqA) && Number.isFinite(seqB) && seqA !== seqB) return seqA - seqB;
  const byTime = timestampOf(a) - timestampOf(b);
  if (byTime !== 0) return byTime;
  return String(a.id || '').localeCompare(String(b.id || ''));
}

export function normalizeOfflineQueueItem(
  item: OfflineQueueItem,
  options?: { deviceId?: string; deviceSequence?: number }
): OfflineQueueItem {
  const normalized: OfflineQueueItem = {
    ...item,
    schemaVersion: Number(item.schemaVersion) || OFFLINE_ITEM_SCHEMA_VERSION,
    queuedAt: item.queuedAt || item.timestamp || new Date(0).toISOString(),
    // La clave idempotente se materializa al hidratar, de modo que incluso un
    // elemento heredado sin ella la conserve en el siguiente reintento.
    idempotencyKey: offlineIdempotencyKey(item),
  };
  const deviceId = item.deviceId || options?.deviceId;
  if (deviceId) normalized.deviceId = deviceId;
  const sequence = Number.isFinite(Number(options?.deviceSequence))
    ? Number(options?.deviceSequence)
    : Number(item.deviceSequence);
  if (Number.isFinite(sequence) && sequence > 0) normalized.deviceSequence = sequence;
  return normalized;
}

const MAX_FAILURE_REASON_CHARS = 480;
const MAX_FAILURE_DETAIL_CHARS = 900;

/** Quita corchetes de código SQL y sufijos HTTP para que la causa sea legible. */
function stripDiagnosticNoise(text: string): string {
  return String(text || '')
    .replace(/\s*\[[A-Za-z0-9_]{3,}\]/g, '')
    .replace(/\s*HTTP \d{3}/g, '')
    .replace(/\s*·\s*Intento \d+:.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function clampText(value: unknown, max: number): string {
  const text = String(value ?? '').trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Construye la causa persistida de un intento fallido. Es el punto único donde
 * se decide qué ve el operador: nunca un código crudo del servidor.
 */
export function buildSyncFailure(
  item: SyncFailureCarrier,
  error: unknown,
  options: { permanent?: boolean; now?: number } = {}
): {
  failureCode: string;
  failureReason: string;
  failureAt: string;
  failureKind: 'permanent' | 'transient';
  lastError: string;
} {
  const source = (error && typeof error === 'object')
    ? error as { message?: unknown; code?: unknown; status?: unknown; statusCode?: unknown; details?: unknown; hint?: unknown; permanent?: boolean }
    : null;
  const rawCode = source?.code ?? (typeof error === 'string' ? error : undefined);
  const rawMessage = source?.message ?? (typeof error === 'string' ? error : '');
  const code = extractSyncErrorCode(rawCode, rawMessage);
  const permanent = options.permanent ?? source?.permanent === true;
  const kind: 'permanent' | 'transient' = permanent ? 'permanent' : 'transient';
  const attempts = Math.max(0, Math.trunc(Number(item?.retryCount || 0))) + 1;
  const label = describeOfflineQueueType(String(item?.type || ''));
  const reason = clampText(describeSyncFailure(code || rawMessage || '', item?.type), MAX_FAILURE_REASON_CHARS);
  const at = new Date(Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now()).toISOString();
  const detailParts = [
    reason,
    code ? `[${code}]` : '',
    rawCode && !code ? `[${String(rawCode)}]` : '',
    (source?.status ?? source?.statusCode) ? `HTTP ${source?.status || source?.statusCode}` : '',
    source?.details ? `— ${typeof source.details === 'string' ? source.details : JSON.stringify(source.details)}` : '',
    source?.hint ? `— ${typeof source.hint === 'string' ? source.hint : JSON.stringify(source.hint)}` : '',
  ].filter(Boolean);
  const lastError = clampText(detailParts.join(' '), MAX_FAILURE_DETAIL_CHARS) ||
    `${label}: fallo sin detalle devuelto por el servidor.`;
  return {
    failureCode: code || (rawCode ? String(rawCode) : ''),
    // La causa legible siempre existe: si el servidor no habló, lo decimos.
    failureReason: reason || `${label}: el servidor rechazó la operación sin devolver un motivo.`,
    failureAt: at,
    failureKind: kind,
    // `lastError` conserva el intento N para que el panel diga cuántos reintentos hay.
    lastError: `${lastError} · intento ${attempts}`,
  };
}

/**
 * Persiste la causa del fallo en el elemento de cola. No borra ni muta la
 * operación: solo anota por qué va mal y si el siguiente paso es reintentar o
 * revisar. Se usa desde el motor de sincronización (fuera del bloque try/catch
 * para que un fallo de anotación jamás tape el error original).
 */
export function withPersistedSyncFailure<T extends SyncFailureCarrier>(
  item: T,
  error: unknown,
  options: { permanent?: boolean; now?: number } = {}
): T & {
  failureCode: string;
  failureReason: string;
  failureAt: string;
  failureKind: 'permanent' | 'transient';
  lastError: string;
} {
  const failure = buildSyncFailure(item, error, options);
  return { ...item, ...failure };
}

/**
 * Causa legible de un elemento pendiente/fallido, con fallback honesto: si una
 * versión anterior de la app dejó el elemento sin causa registrada, se nombra el
 * tipo de operación, los reintentos y el último error crudo conocido en lugar de
 * devolver un callejón sin salida.
 */
export function describeQueueItemFailure(
  item: SyncFailureCarrier,
  options: { now?: number } = {}
): string {
  const label = describeOfflineQueueType(String(item?.type || ''));
  const attempts = Math.max(0, Math.trunc(Number(item?.retryCount || 0)));
  const retryNote = attempts > 0 ? ` Lleva ${attempts} reintento${attempts === 1 ? '' : 's'}.` : '';
  const reference = shortActionRef(item?.actionId || item?.id);
  const labelPrefix = `${label}${reference ? ` ${reference}` : ''}`;
  const reason = stripDiagnosticNoise(item?.failureReason || '');
  const when = Date.parse(String(item?.failureAt || ''));
  const minutes = Number.isFinite(when)
    ? Math.max(0, Math.round(((Number.isFinite(Number(options?.now)) ? Number(options.now) : Date.now()) - when) / 60_000))
    : null;
  if (reason) {
    const code = String(item?.failureCode || '').trim();
    // La causa ya nombra la operación: no se duplica la etiqueta.
    const alreadyLabelled = reason.startsWith(`${label}:`);
    const body = alreadyLabelled ? reason.slice(label.length + 2).trim() : reason;
    const stamp = minutes !== null
      ? ` (hace ${minutes < 60 ? `${minutes} min` : `${Math.round(minutes / 60)} h`})`
      : '';
    const terminal = item?.failureKind === 'permanent'
      ? ' No se volverá a reintentar: repite la operación o descártala desde el Monitor de Logs.'
      : ' Sigue guardada y se reintentará automáticamente.';
    return `${labelPrefix}: ${body}${stamp}${retryNote}${terminal}${code ? ` Código: ${code}.` : ''}`;
  }

  const legacyError = stripDiagnosticNoise(item?.lastError || '');
  if (legacyError) {
    const translated = describeSyncFailure(legacyError, item?.type);
    // `describeSyncFailure` repite la etiqueta cuando el crudo ya la contenía.
    const body = translated.startsWith(`${label}: `) ? translated.slice(label.length + 2) : translated;
    return `${labelPrefix}: ${body}${retryNote}`;
  }
  return `${labelPrefix}: sigue ${(item?.status === 'conflict' || item?.failureKind === 'permanent') ? 'en conflicto' : 'pendiente'} sin causa registrada${retryNote}. Abre Configuración > Monitor de Logs para ver el evento técnico y vuelve a sincronizar.`;
}

function shortActionRef(actionId: unknown): string {
  const raw = String(actionId || '').trim();
  if (!raw) return '';
  const tail = raw.includes(':') ? (raw.split(':').pop() || raw) : raw;
  return `#${tail.length > 12 ? tail.slice(0, 8) : tail}`;
}

/**
 * Asigna secuencias solo a elementos heredados, en su orden actual. El
 * resultado es determinista y no reescribe operaciones que ya tienen una.
 */
export function assignMissingDeviceSequences(
  items: OfflineQueueItem[],
  startSequence = 0
): { items: OfflineQueueItem[]; lastSequence: number } {
  let sequence = Math.max(0, Math.floor(Number(startSequence) || 0));
  const ordered = [...items].sort(compareOfflineQueueItems);
  const replacements = new Map<string, OfflineQueueItem>();
  const used = new Set<number>();

  for (const item of ordered) {
    const existing = Number(item.deviceSequence);
    if (Number.isFinite(existing) && existing > 0) used.add(existing);
  }

  for (const item of ordered) {
    const existing = Number(item.deviceSequence);
    if (Number.isFinite(existing) && existing > 0) continue;
    do { sequence += 1; } while (used.has(sequence));
    used.add(sequence);
    replacements.set(item.id, normalizeOfflineQueueItem(item, { deviceSequence: sequence }));
  }

  let lastSequence = sequence;
  for (const value of used) {
    if (value > lastSequence) lastSequence = value;
  }
  return {
    items: items.map(item => replacements.get(item.id) || item),
    lastSequence
  };
}

export function summarizeOfflineQueue(items: OfflineQueueItem[]): OfflineQueueHealth {
  const distinct = dedupeOfflineQueueItems(items);
  const conflicts = distinct.filter(item => item.status === 'conflict');
  // Un conflicto no se reintenta solo; por eso no cuenta como pendiente.
  const pendingItems = distinct.filter(item => item.status !== 'conflict');
  const failed = pendingItems.filter(item => item.status === 'failed');

  let oldest = Number.POSITIVE_INFINITY;
  for (const item of pendingItems) {
    const time = timestampOf(item);
    if (time > 0 && time < oldest) oldest = time;
  }

  const diagnostic = conflicts[0] || failed[0] || null;

  return {
    total: distinct.length,
    pending: pendingItems.length,
    failed: failed.length,
    conflicts: conflicts.length,
    oldestQueuedAt: Number.isFinite(oldest) ? new Date(oldest).toISOString() : null,
    lastError: diagnostic?.lastError ? String(diagnostic.lastError) : null
  };
}

export function evaluateOfflineFreshness(
  lastSyncAt: string | null | undefined,
  now: number = Date.now()
): OfflineFreshness {
  const parsed = Date.parse(String(lastSyncAt || ''));
  if (!Number.isFinite(parsed)) {
    return { lastSyncAt: null, daysSinceSync: null, state: 'unknown' };
  }
  const days = Math.max(0, (now - parsed) / 86_400_000);
  const state: OfflineFreshness['state'] =
    days >= OFFLINE_WINDOW_DAYS ? 'stale' : days >= OFFLINE_WARNING_DAYS ? 'warning' : 'fresh';
  return {
    lastSyncAt: new Date(parsed).toISOString(),
    daysSinceSync: Math.floor(days),
    state
  };
}
