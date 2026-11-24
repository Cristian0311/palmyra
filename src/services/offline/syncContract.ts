/**
 * Contrato de sincronización offline.
 *
 * La cola durable ya garantiza idempotencia y dependencias. Este módulo añade
 * lo que faltaba para operar durante días sin red: versión de esquema por
 * operación, una secuencia monotónica por dispositivo (independiente del reloj
 * local) y una lectura única de la salud de la cola.
 */
import type { OfflineQueueItem } from '../offlineQueueTypes';

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

const QUEUE_TYPE_LABELS: Record<string, string> = {
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
  bank_card_balance: 'Saldo bancario',
  bank_transaction: 'Movimiento bancario',
  bank_transaction_delete: 'Borrado de movimiento bancario',
  bank_internal_transfer: 'Transferencia bancaria',
  bank_internal_transfer_delete: 'Borrado de transferencia bancaria',
  branch: 'Sucursal',
  category: 'Categoría',
  user: 'Usuario',
  employee_create: 'Alta de empleado',
  employee_update: 'Edición de empleado',
  employee_status: 'Estado de empleado',
  employee_delete: 'Baja de empleado',
  team_role_upsert: 'Rol del equipo',
  team_compensation_settings: 'Compensación del equipo',
  quote: 'Cotización',
  warranty: 'Garantía',
  time_shift: 'Turno de personal',
  currency: 'Moneda',
  currency_rate: 'Tasa de cambio'
};

export function describeOfflineQueueType(type: string): string {
  const key = String(type || '');
  if (QUEUE_TYPE_LABELS[key]) return QUEUE_TYPE_LABELS[key];
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
