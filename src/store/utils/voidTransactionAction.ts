import type { AppState } from '../storeTypes';
import { buildLocalVoidTransactionPatch, canVoidSales } from './localVoidTransaction';
import { isCloudBusinessSyncAllowed } from '../../services/localPlanMode';

type Dependencies = {
  get: () => AppState;
  set: (patch: Partial<AppState> | ((state: AppState) => Partial<AppState>)) => void;
  ready: () => Promise<unknown>;
  enqueue: (data: { id: string; remoteId: string; userId: string; reason: string }) => Promise<unknown>;
  remove: (id: string) => void;
  resolveId: (id: string) => Promise<string>;
  hasPendingSale: (id: string) => boolean;
  online: () => boolean;
  rpc: (id: string, userId: string, reason: string) => Promise<{ success: boolean; error?: string; errorCode?: string }>;
  reconcile: (branchId: string) => Promise<boolean>;
  flush: () => Promise<unknown>;
};

/** Serialized per sale, durable intent first; reconciliation can never turn a confirmed void into failure. */
export function createVoidTransactionAction(deps: Dependencies) {
  const inFlight = new Map<string, Promise<boolean>>();
  return (id: string, reason?: string): Promise<boolean> => {
    if (inFlight.has(id)) return inFlight.get(id)!;
    const run = async () => {
      const state = deps.get();
      const tx = state.transactions.find(t => t.id === id);
      if (!tx || !canVoidSales(state.currentUser, tx.branchId)) {
        state.addNotification('No tienes permiso para anular ventas en este almacén.', 'warning');
        return false;
      }
      if (tx.deletedAt) return true;
      if (tx.status === 'refunded' || String(tx.notes || '').startsWith('AJUSTE_')) {
        state.addNotification('Este registro no es una venta pendiente de anular.', 'warning');
        return false;
      }
      const finalReason = reason?.trim();
      if (!finalReason || finalReason.length < 3) {
        state.addNotification('Indica el motivo de la anulación (mínimo 3 caracteres).', 'warning');
        return false;
      }
      // Unlinked bank payments cannot be reversed safely: never guess an account.
      if (tx.payments.some(p => p.method === 'transfer') && !state.bankTransactions.some(b =>
        [tx.id, tx.remoteId].includes(b.transactionId) && b.type === 'payment_received')) {
        state.addNotification('La venta bancaria no tiene un cobro vinculado verificable. Requiere conciliación administrativa antes de anular.', 'warning');
        return false;
      }
      const audit = { userId: state.currentUser!.id, reason: finalReason.slice(0, 500), date: new Date().toISOString() };
      let applied = false;
      let confirmed = false;
      try {
        // Preflight balances before writing an intent that cannot be fulfilled.
        buildLocalVoidTransactionPatch(state, tx, audit);
        await deps.ready();
        const remoteId = await deps.resolveId(tx.remoteId || id);
        await deps.enqueue({ id, remoteId, userId: audit.userId, reason: audit.reason });
        if (deps.online() && !deps.hasPendingSale(id)) {
          let result: Awaited<ReturnType<Dependencies['rpc']>>;
          try { result = await deps.rpc(remoteId, audit.userId, audit.reason); }
          catch { result = { success: false }; }
          if (!result.success && ['P0001', '23503', '23505', '23514', '42501', '42883', '22P02', 'IDEMPOTENCY_CONFLICT'].includes(result.errorCode || '')) {
            deps.remove(id);
            state.addNotification(result.error || 'La anulación fue rechazada; no se modificó la venta.', 'error');
            return false;
          }
          confirmed = result.success;
        }
        deps.set(current => buildLocalVoidTransactionPatch(current, tx, audit));
        applied = true;
        await deps.flush();
        if (confirmed) {
          // Retain the queue entry until reconciliation succeeds, so a reload or
          // lost response retries the same remote sale, never restores locally twice.
          let reconciled = false;
          try { reconciled = await deps.reconcile(tx.branchId); } catch { /* retry via outbox */ }
          if (reconciled) { await deps.flush(); deps.remove(id); }
          else state.addNotification('Venta anulada. Inventario y saldos pendientes de sincronizar.', 'warning');
        } else {
          state.addNotification(
            isCloudBusinessSyncAllowed()
              ? 'Anulación guardada localmente, pendiente de validación del servidor.'
              : 'Venta anulada en este dispositivo. El plan Gratis no la sincroniza con la nube.',
            'info'
          );
        }
        return true;
      } catch (error) {
        state.addNotification(applied || confirmed
          ? 'Anulación registrada; conserva este dispositivo hasta completar la sincronización.'
          : `No se pudo anular: ${error instanceof Error ? error.message : 'error de persistencia'}`, 'warning');
        return applied || confirmed;
      }
    };
    const promise = run().finally(() => inFlight.delete(id));
    inFlight.set(id, promise);
    return promise;
  };
}
