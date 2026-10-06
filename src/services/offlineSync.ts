/**
 * Offline synchronization engine.
 *
 * The durable queue itself lives in offlineQueue.ts so the application store can
 * enqueue operations without importing the replay engine or Supabase adapters.
 */
import { getSupabase, checkSupabaseReachability } from '../lib/supabase';
import { useStore } from '../store/useStore';
import type { OfflineActionType, OfflineQueueItem } from './offlineQueue';
import type { Transaction, CashRegisterSession, Customer, ReturnItem, InventoryLevel } from '../types';
import {
  getOfflineQueue,
  waitForOfflineQueueReady,
  getOfflineQueueCount,
  getOfflineConflictCount,
  removeFromOfflineQueue,
  isOfflineQueueItemRemoved,
  clearOfflineQueueRemovalMark,
  setOfflineQueueMemory,
  persistOfflineQueueSnapshot
} from './offlineQueue';
import {
  callOpenSessionRPCWithId, callProcessTransactionRPC, callVoidTransactionRPC, callCancelSessionRPC,
  callCompleteReturnRPC, callTransferInventoryRPC, callTransferInventoryBulkRPC, callReceiveSupplierOrderRPC,
  callStartInventoryAuditRPC, callSaveInventoryAuditCountRPC, callRequestInventoryAuditRecountRPC, callApproveInventoryAuditRPC,
  callBankInternalTransferRPC, callDeleteBankInternalTransferRPC, callDeleteBankTransactionRPC, callDeleteBankCardRPC, callProcessBankTransactionRPC,
  setBankCardBalanceToSupabase, pullBranchInventoryFromSupabase,
  pushCashSessionToSupabase, deleteProductFromSupabase,
  pushBranchToSupabase, deleteBranchFromSupabase, pushCategoryToSupabase, deleteCategoryFromSupabase, deleteSupplierFromSupabase,
  pushProductToSupabase, pushUserToSupabase, pushWarrantyToSupabase, pushTimeShiftToSupabase,
  pushQuoteToSupabase, pushBankCardToSupabase, pushReturnToSupabase,
  pushSupplierToSupabase, pushSupplierOrderToSupabase, pushInventoryAuditToSupabase,
  pushSalarySettlementToSupabase, pushInventoryToSupabase,
  applyInventoryAdjustmentToSupabase, reconcileInventoryToSupabase
} from './supabaseSync';
import { addSyncLog } from '../utils/syncLogger';
import { getActiveTenant } from './tenant';
import { reconcileBankCanonical } from './offline/reconcileBank';
import { replaceWarehouseInventory, replaceWarehousesInventory } from './offline/reconcileInventory';
import { processQueueItem } from './offline/processQueueItem';
import { reconcileSupplierReceiveCanonical } from './offline/reconcileSupplierReceive';



let isProcessingQueue = false;

export async function processOfflineQueue(): Promise<{ processed: number; failed: number; remaining: number; conflicts: number; errors: Array<{ type: string; actionId: string; message: string; retryCount?: number }> }> {
  // Nunca inspeccionar una cola todavía no hidratada desde IndexedDB.
  await waitForOfflineQueueReady();
  if (isProcessingQueue || (typeof navigator !== 'undefined' && !navigator.onLine)) {
    return { processed: 0, failed: 0, remaining: getOfflineQueueCount(), conflicts: getOfflineConflictCount(), errors: [] };
  }
  const supabase = getSupabase();
  if (!supabase) return { processed: 0, failed: 0, remaining: getOfflineQueueCount(), conflicts: getOfflineConflictCount(), errors: [{ type: 'system', actionId: 'supabase', message: 'Supabase no está disponible en esta sesión.' }] };
  const reachability = await checkSupabaseReachability();
  if (!reachability.ok) {
    return { processed: 0, failed: 0, remaining: getOfflineQueueCount(), conflicts: getOfflineConflictCount(), errors: [{ type: 'network', actionId: 'connectivity', message: reachability.message || 'Supabase no está accesible todavía.' }] };
  }
  const allQueueAtStart = getOfflineQueue();
  const queueAtStart = allQueueAtStart.filter(item => item.status !== 'conflict');
  if (!queueAtStart.length) return { processed: 0, failed: 0, remaining: 0, conflicts: getOfflineConflictCount(), errors: [] };

  isProcessingQueue = true;
  // Procesamos una instantánea estable. Las operaciones que entren mientras
  // sincronizamos se reconcilian al final y nunca se pierden por reemplazar
  // memoryQueue con una instantánea vieja.
  // Orden estable por dependencias reales. No usamos una prioridad global:
  // hacerlo podría mover una corrección de inventario posterior a una venta
  // anterior. Solo adelantamos una operación cuando otra operación ENCOLADA
  // es una dependencia explícita de ella.
  const allQueued = new Map<string, OfflineQueueItem>();
  const blockedExistingIds = new Set(
    allQueueAtStart.filter(q => q.status === 'conflict').map(q => q.id)
  );
  const cashBySessionId = new Map<string, OfflineQueueItem[]>();
  for (const q of allQueueAtStart) {
    allQueued.set(q.type + ':' + q.actionId, q);
    if (q.type === 'cash_session' && q.data?.id) {
      const list = cashBySessionId.get(String(q.data.id)) || [];
      list.push(q);
      cashBySessionId.set(String(q.data.id), list);
    }
  }
  const dep = (type: OfflineActionType, id?: string | null) => id ? allQueued.get(type + ':' + id) : undefined;
  const cashOp = (sessionId: string | undefined, operation: 'open' | 'close' | 'cancel' | 'join' | 'snapshot') => {
    if (!sessionId) return undefined;
    const list = cashBySessionId.get(String(sessionId)) || [];
    return list.find(q => q.data?.__operation === operation ||
      (operation === 'open' && String(q.actionId).startsWith('cash-open:')) ||
      (operation === 'close' && String(q.actionId).startsWith('cash-close:')) ||
      (operation === 'cancel' && String(q.actionId).startsWith('cash-cancel:')) ||
      (operation === 'join' && String(q.actionId).startsWith('cash-join:'))
    );
  };
  const dependencies = (item: OfflineQueueItem): OfflineQueueItem[] => {
    const d: OfflineQueueItem[] = [];
    const data = item.data || {};
    const add = (x?: OfflineQueueItem) => { if (x && x.id !== item.id) d.push(x); };
    switch (item.type) {
      case 'product_delete': {
        const productId = String(data?.id || '');
        for (const queued of allQueued.values()) {
          if (queued.id === item.id) continue;
          const qd = queued.data || {};
          const matchesProduct =
            (queued.type === 'product' && String(qd.id || '') === productId) ||
            (queued.type === 'transaction' && Array.isArray(qd.items) && qd.items.some((line: any) => {
              const id = typeof line?.product === 'string' ? line.product : line?.product?.id || line?.productId || line?.product_id;
              return String(id || '') === productId;
            })) ||
            ((queued.type === 'transfer' || queued.type === 'inventory_adjustment' || queued.type === 'inventory_reconcile' || queued.type === 'return_complete') && String(qd.productId || '') === productId) ||
            (queued.type === 'transfer_bulk' && Array.isArray(qd.items) && qd.items.some((op: any) => String(op?.productId || '') === productId)) ||
            (queued.type === 'supplier_receive' && Array.isArray((useStore.getState().supplierOrders || []).find((o: any) => o.id === qd.id)?.items) && (useStore.getState().supplierOrders || []).find((o: any) => o.id === qd.id).items.some((line: any) => String(line?.productId || '') === productId));
          if (matchesProduct) add(queued);
        }
        break;
      }
      case 'cash_movement':
        add(cashOp(data.sessionId, 'open'));
        break;
      case 'cash_movement_delete':
        add(cashOp(data.sessionId, 'open'));
        break;
      case 'cash_session':
        if (data.__operation === 'open' || String(item.actionId).startsWith('cash-open:')) {
          add(dep('branch', data.branchId)); add(dep('user', data.userId));
        } else if (data.__operation === 'close' || data.__operation === 'cancel' ||
                   String(item.actionId).startsWith('cash-close:') ||
                   String(item.actionId).startsWith('cash-cancel:') ||
                   String(item.actionId).startsWith('cash-join:')) {
          add(cashOp(data.id, 'open'));
          if (data.__operation === 'close' || data.__operation === 'cancel' ||
              String(item.actionId).startsWith('cash-close:') || String(item.actionId).startsWith('cash-cancel:')) {
            // Un cierre/cancelación debe esperar a TODA operación de venta/liquidación
            // del turno que esté encolada. No dependemos del reloj local porque una
            // operación puede reintentarse horas después y recibir un timestamp nuevo.
            for (const candidate of queueAtStart) {
              if (candidate.type === 'transaction' && candidate.data?.sessionId === data.id) add(candidate);
            }
          }
        } else {
          add(cashOp(data.id, 'open'));
          // Las actualizaciones administrativas/auditorías deben ejecutarse
          // después de un cierre pendiente para que el cierre no pueda
          // sobrescribir de nuevo el estado de auditoría.
          if (String(item.actionId).startsWith('cash-snapshot:')) {
            add(cashOp(data.id, 'close'));
          }
        }
        break;
      case 'transaction':
        add(dep('branch', data.branchId)); add(dep('user', data.userId)); add(dep('customer', data.customerId));
        add(cashOp(data.sessionId, 'open'));
        for (const it of data.items || []) add(dep('product', typeof it?.product === 'string' ? it.product : it?.product?.id));
        break;
      case 'void_transaction': add(dep('transaction', data.id)); break;
      case 'return': add(dep('transaction', data.transactionId)); add(dep('product', data.productId)); add(dep('customer', data.customerId)); break;
      case 'return_complete': add(dep('return', data.id)); break;
      case 'inventory': case 'inventory_adjustment': case 'inventory_reconcile':
        add(dep('branch', data.branchId)); add(dep('product', data.productId)); break;
      case 'transfer_bulk':
        add(dep('branch', data.fromBranchId)); add(dep('branch', data.toBranchId)); add(dep('user', data.userId));
        for (const transferItem of Array.isArray(data.items) ? data.items : []) {
          add(dep('product', transferItem.productId));
        }
        break;
      case 'transfer':
        add(dep('product', data.productId)); add(dep('branch', data.fromBranchId)); add(dep('branch', data.toBranchId)); add(dep('user', data.userId)); break;
      case 'supplier_order': add(dep('supplier', data.supplierId)); add(dep('branch', data.branchId)); break;
      case 'supplier_receive': add(dep('supplier_order', data.id)); break;
      case 'inventory_audit': add(dep('branch', data.branchId)); add(dep('user', data.userId)); break;
      case 'audit_start':
        add(dep('branch', data.branchId)); add(dep('user', data.userId)); break;
      case 'audit_complete':
        add(dep('audit_start', 'audit-start:' + data.id));
        add(dep('branch', data.branchId)); add(dep('user', data.userId)); break;
      case 'audit_recount':
        add(dep('audit_start', 'audit-start:' + data.id));
        add(dep('audit_complete', 'audit:' + data.id));
        break;
      case 'audit_approve':
        add(dep('audit_start', 'audit-start:' + data.id));
        add(dep('audit_complete', 'audit:' + data.id));
        for (const candidate of queueAtStart) {
          if (candidate.type === 'audit_recount' && candidate.data?.id === data.id) add(candidate);
        }
        break;
      case 'branch_delete':
      case 'category_delete':
      case 'supplier_delete':
        break;
      case 'salary_settlement': add(cashOp(data.sessionId, 'close')); break;
      case 'bank_transaction': add(dep('bank_card', data.cardId)); add(dep('transaction', data.transactionId)); break;
      case 'bank_card_balance': add(dep('bank_card', data.id)); break;
      case 'time_shift': add(dep('user', data.userId)); break;
      case 'quote': add(dep('branch', data.branchId)); add(dep('user', data.userId)); add(dep('customer', data.customerId)); break;
      case 'warranty': add(dep('product', data.productId)); add(dep('transaction', data.transactionId)); add(dep('customer', data.customerId)); break;
      case 'user': add(dep('branch', data.branchId));  add(dep('user', data.supervisorId)); break;
      case 'product': add(dep('category', data.categoryId)); break;
      case 'customer_delete': break;
    }
    return d;
  };

  const sorted: OfflineQueueItem[] = [];
  const pending = new Set(queueAtStart.map(x => x.id));
  while (pending.size) {
    const ready = queueAtStart
      .filter(x => pending.has(x.id) && dependencies(x).every(d => !pending.has(d.id)))
      .sort((a,b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id));
    if (!ready.length) {
      // Cycle protection: preserve deterministic FIFO rather than deadlocking
      // the entire queue forever because of a malformed dependency graph.
      const fallback = queueAtStart.filter(x => pending.has(x.id)).sort((a,b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id));
      sorted.push(...fallback); break;
    }
    for (const item of ready) { sorted.push(item); pending.delete(item.id); }
  }
  const startById = new Map(sorted.map(item => [item.id, item]));
  let processed = 0, failed = 0;
  const errors: Array<{ type: string; actionId: string; message: string; retryCount?: number }> = [];
  const remainingFromRun: OfflineQueueItem[] = [];
  const handledIds = new Set<string>();
  const failedDependencyIds = new Set<string>();

  for (let index = 0; index < sorted.length; index++) {
    const item = sorted[index];
    const itemDependencies = dependencies(item);
    if (itemDependencies.some(d => failedDependencyIds.has(d.id) || blockedExistingIds.has(d.id))) {
      // Un padre falló o quedó en conflicto: el hijo permanece en cola y no se
      // ejecuta con un estado incompleto.
      remainingFromRun.push({ ...item, status: 'failed' });
      continue;
    }
    item.status = 'processing';
    try {
      await processQueueItem(supabase, item);
      processed++;
      handledIds.add(item.id);
      addSyncLog({ level:'success', source:'offline_queue', title:`Item sincronizado (${item.type})`, details:`Operación ${item.actionId} confirmada por Supabase.`, entityType:item.type, actionId:item.actionId });
    } catch (err:any) {
      failed++;
      item.retryCount = (item.retryCount || 0) + 1;
      const code = err?.code ? ` [${err.code}]` : '';
      const status = err?.status || err?.statusCode ? ` HTTP ${err?.status || err?.statusCode}` : '';
      const detail = err?.details ? ` — ${err.details}` : '';
      const hint = err?.hint ? ` — ${err.hint}` : '';
      item.lastError = `${err?.message || 'Error desconocido'}${code}${status}${detail}${hint}`;
      const permanent = err?.permanent === true;
      // Ninguna operación durable válida se abandona por cantidad de reintentos.
      // Una tablet puede permanecer offline muchas horas o días; el elemento
      // queda pendiente hasta una confirmación real o un rechazo explícitamente permanente.
      item.status = permanent ? 'conflict' : 'failed';
      failedDependencyIds.add(item.id);
      remainingFromRun.push(item);
      errors.push({ type: item.type, actionId: item.actionId, message: item.lastError, retryCount: item.retryCount });
      addSyncLog({ level:'error', source:'offline_queue', title:`Error al procesar item (${item.type})`, details:item.lastError, entityType:item.type, actionId:item.actionId, retryAttempt:item.retryCount, maxRetries:8 });
      // No detener toda la cola por un fallo transitorio. Solo quedan
      // bloqueados los elementos que dependan de esta operación mediante
      // failedDependencyIds; los demás turnos/ventas pueden continuar. Esto evita
      // que una incidencia del turno 1 congele el turno 2/3/4.

    }
  }

  // Conservar elementos de la instantánea que no fueron procesados por el corte
  // de dependencia anterior.
  const runRemainingIds = new Set(remainingFromRun.map(item => item.id));
  for (const item of sorted) {
    if (!handledIds.has(item.id) && !runRemainingIds.has(item.id)) remainingFromRun.push(item);
  }

  // Reconciliar con cambios hechos durante el procesamiento. Un enqueue nuevo
  // puede tener un ID distinto o actualizar el mismo actionId mientras la RPC
  // estaba en vuelo. En ambos casos debe sobrevivir a esta ejecución. Si el
  // usuario lo eliminó explícitamente, no lo reinsertamos.
  const currentAfterRun = getOfflineQueue();
  const currentById = new Map(currentAfterRun.map(item => [item.id, item]));
  const finalById = new Map<string, OfflineQueueItem>();
  for (const item of remainingFromRun) {
    if (!isOfflineQueueItemRemoved(item.id)) finalById.set(item.id, item);
  }

  for (const [id, current] of currentById) {
    if (isOfflineQueueItemRemoved(id)) continue;
    const original = startById.get(id);
    if (!original) {
      // Operación agregada mientras procesábamos.
      finalById.set(id, current);
      continue;
    }
    const changedDuringRun = current.timestamp !== original.timestamp ||
      current.actionId !== original.actionId ||
      JSON.stringify(current.data) !== JSON.stringify(original.data);
    if (changedDuringRun) {
      // Es una versión más reciente de la operación; no puede considerarse
      // completada por la versión antigua que estaba en vuelo.
      finalById.set(id, { ...current, status: 'pending' });
    } else if (!handledIds.has(id)) {
      // La operación sigue pendiente porque esta ejecución no llegó a confirmarla.
      finalById.set(id, current);
    }
  }

  const finalQueue = Array.from(finalById.values()).sort((a,b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id));
  for (const item of sorted) clearOfflineQueueRemovalMark(item.id);
  // Reconciliamos contra el estado final, no contra la instantánea inicial.
  // Esto evita que un enqueue concurrente sea borrado por el commit de la cola.
  try {
    await persistOfflineQueueSnapshot(finalQueue);
  } catch (persistenceError: any) {
    // El servidor puede haber confirmado la operación, pero si la cola local no
    // pudo persistir su nuevo estado, conservamos todas las operaciones de esta
    // ejecución para evitar una falsa sensación de sincronización. Las RPC son
    // idempotentes por sus IDs de operación.
    const durableFallback: OfflineQueueItem[] = queueAtStart.map(item => ({
      ...item,
      status: item.status === 'processing' ? 'pending' : item.status
    }));
    const fallbackById = new Map(durableFallback.map(item => [item.id, item]));
    for (const item of currentAfterRun) fallbackById.set(item.id, item);
    setOfflineQueueMemory(Array.from(fallbackById.values()));
    isProcessingQueue = false;
    const persistenceMessage = persistenceError?.message || 'Error de IndexedDB/localStorage. Las operaciones se conservaron para reintento.';
    errors.push({ type: 'offline_queue', actionId: 'persistence', message: persistenceMessage });
    addSyncLog({ level:'error', source:'offline_queue', title:'Cola local no pudo persistirse', details:persistenceMessage, entityType:'offline_queue' });
    return { processed, failed, remaining: getOfflineQueueCount(), conflicts: getOfflineConflictCount(), errors };
  }

  isProcessingQueue = false;
  return { processed, failed, remaining: finalQueue.filter(item => item.status !== 'conflict').length, conflicts: finalQueue.filter(item => item.status === 'conflict').length, errors };
}

function isManualOfflineSyncEnabled(): boolean {
  try {
    const config = useStore.getState().storeConfig;
    return config?.manualOfflineSync === true;
  } catch {
    return false;
  }
}

export function initOfflineSyncWatcher(): () => void {
  if (typeof window === 'undefined') return () => {};
  let intervalId: any = null;
  const handleOnline = async () => {
    if (isManualOfflineSyncEnabled()) return;
    // Chrome can emit 'online' before DNS/TLS/Internet access to Supabase is
    // actually usable. Give the connection a short settling window and probe
    // the REST endpoint before touching the durable queue.
    await new Promise(resolve => setTimeout(resolve, 1200));
    const reachability = await checkSupabaseReachability(12000);
    if (!reachability.ok) return;
    const count = getOfflineQueueCount();
    if (!count) return;
    useStore.getState().addNotification(`Conexión detectada. Sincronizando ${count} operaciones pendientes...`, 'info');
    try {
      const res = await processOfflineQueue();
      if (res.remaining > 0 || res.conflicts > 0) {
        const details = [
          res.errors?.length ? res.errors.map(e => `${e.type} · ${e.actionId}: ${e.message}`).join('\n') : '',
          res.conflicts > 0 ? `${res.conflicts} operación(es) quedaron en conflicto y no se volverán a reintentar hasta resolverlas.` : ''
        ].filter(Boolean).join('\n');
        useStore.getState().addNotification(
          `Sincronización parcial: ${res.processed} procesadas; ${res.remaining} pendientes; ${res.conflicts} en conflicto.`,
          res.conflicts > 0 ? 'warning' : 'warning',
          details || undefined
        );
      } else if (res.processed > 0) {
        useStore.getState().addNotification(`Sincronización completada: ${res.processed} operaciones confirmadas.`, 'success');
      }
    } catch (e: any) {
      useStore.getState().addNotification(`No se pudo completar la sincronización: ${e?.message || 'error desconocido'}.`, 'error');
    }
  };
  const handleOffline = () => useStore.getState().addNotification('Sin conexión. El POS continúa trabajando offline.', 'warning');
  window.addEventListener('online', handleOnline);
  window.addEventListener('offline', handleOffline);
  intervalId = setInterval(() => { 
    if (navigator.onLine && getOfflineQueueCount() && !isProcessingQueue && !isManualOfflineSyncEnabled()) {
      processOfflineQueue().catch(() => {}); 
    }
  }, 30000);
  if (navigator.onLine && getOfflineQueueCount() && !isManualOfflineSyncEnabled()) processOfflineQueue().catch(() => {});
  return () => { window.removeEventListener('online', handleOnline); window.removeEventListener('offline', handleOffline); if (intervalId) clearInterval(intervalId); };
}
