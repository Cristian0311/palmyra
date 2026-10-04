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

async function reconcileBankCanonical(): Promise<void> {
  try {
    const { pullBankDataFromSupabase } = await import('./supabaseSync');
    const remote = await pullBankDataFromSupabase();
    if (remote.success) {
      useStore.setState({
        bankCards: remote.bankCards,
        bankTransactions: remote.bankTransactions
      });
    }
  } catch (e) {
    console.warn('[bank] No se pudo reconciliar el estado bancario canónico:', e);
  }
}

async function reconcileSupplierReceiveCanonical(supabase: any, orderId: string): Promise<void> {
  try {
    const { data: remoteOrder, error } = await supabase
      .from('supplier_orders')
      .select('*')
      .eq('id', orderId)
      .maybeSingle();
    if (error) throw error;

    if (remoteOrder) {
      useStore.setState(state => ({
        supplierOrders: (state.supplierOrders || []).map(order =>
          order.id === orderId
            ? { ...order, status: remoteOrder.status || order.status }
            : order
        )
      }));
    }

    // El inventario local puede haber sido incrementado de forma optimista
    // mientras estaba offline; refrescamos la sucursal para devolverlo al
    // estado que realmente existe en Supabase.
    const branchId = remoteOrder?.branch_id;
    if (branchId) {
      const inventoryRes = await pullBranchInventoryFromSupabase(branchId);
      if (!inventoryRes.success) {
        throw new Error(inventoryRes.message || 'No se pudo reconciliar el inventario de la recepción.');
      }
      const pendingRows = getOfflineQueue().filter(q => {
        const d = q.data || {};
        return (
          (q.type === 'transfer' && (d.fromBranchId === branchId || d.toBranchId === branchId)) ||
          (q.type === 'transfer_bulk' && (d.fromBranchId === branchId || d.toBranchId === branchId)) ||
          (q.type === 'transaction' && d.branchId === branchId) ||
          ((q.type === 'inventory_adjustment' || q.type === 'inventory_reconcile') && d.branchId === branchId)
        );
      });
      const pendingKeys = new Set<string>();
      for (const q of pendingRows) {
        const d = q.data || {};
        if (q.type === 'transaction') {
          for (const line of Array.isArray(d.items) ? d.items : []) {
            const productId = typeof line?.product === 'string' ? line.product : line?.product?.id;
            if (productId) pendingKeys.add(`${productId}:${branchId}:${line?.variantLabel || line?.variant_label || ''}`);
          }
        } else if (q.type === 'transfer') {
          for (const line of Array.isArray(d.variants) ? d.variants : []) {
            if (d.productId) pendingKeys.add(`${d.productId}:${branchId}:${line?.variantLabel || line?.variant_label || ''}`);
          }
        } else if (q.type === 'transfer_bulk') {
          for (const op of Array.isArray(d.items) ? d.items : []) {
            for (const line of Array.isArray(op?.variants) ? op.variants : []) {
              if (op?.productId) pendingKeys.add(`${op.productId}:${branchId}:${line?.variantLabel || line?.variant_label || ''}`);
            }
          }
        } else if (d.productId) {
          pendingKeys.add(`${d.productId}:${branchId}:${d.variantLabel || ''}`);
        }
      }
      useStore.setState(state => {
        const otherBranches = (state.inventory || []).filter(item => item.branchId !== branchId);
        const byKey = new Map<string, InventoryLevel>((inventoryRes.inventory as InventoryLevel[]).map(item => [
          `${item.productId}:${item.branchId}:${item.variantLabel || ''}`, item
        ]));
        for (const localRow of state.inventory || []) {
          const key = `${localRow.productId}:${localRow.branchId}:${localRow.variantLabel || ''}`;
          if (pendingKeys.has(key)) byKey.set(key, localRow);
        }
        return { inventory: [...otherBranches, ...Array.from(byKey.values())] };
      });
    }
  } catch (e) {
    console.warn('[supplier_receive] No se pudo reconciliar la orden/stock canónico:', e);
  }
}

async function refreshTransferBranchesCanonical(
  supabase: any,
  branchIds: string[]
): Promise<void> {
  const ids = Array.from(new Set(branchIds.filter(Boolean)));
  if (!ids.length) return;
  const results = await Promise.all(ids.map((id) => pullBranchInventoryFromSupabase(id)));
  const failed = results.find((r) => !r.success);
  if (failed) throw new Error(failed.message || 'No se pudo actualizar el inventario de los almacenes.');
  const canonical = results.flatMap((r) => r.inventory || []);
  useStore.setState((state) => ({
    inventory: [
      ...(state.inventory || []).filter((item) => !ids.includes(item.branchId)),
      ...canonical
    ]
  }));
}
async function processQueueItem(supabase: any, item: OfflineQueueItem): Promise<boolean> {
  const { type, data } = item;
  switch (type) {
    case 'cash_session': {
      const session = data as CashRegisterSession & { __operation?: 'open' | 'close' | 'cancel' | 'snapshot'; settlement?: any; closedAt?: string };
      if (session.__operation === 'close') {
        const settlement = session.settlement;
        if (!settlement) throw new Error('Cierre offline sin liquidación asociada');

        // Las ventas offline ya fueron procesadas (o marcadas como conflicto)
        // antes del cierre por el grafo de dependencias. Recalculamos las
        // comisiones desde las ventas que realmente existen en Supabase para
        // que una venta rechazada no termine dentro de la liquidación salarial.
        const { data: persistedSales, error: salesError } = await supabase
          .from('sales')
          .select('id,status')
          .eq('cash_session_id', session.id);
        if (salesError) throw salesError;

        const completedSaleIds = (persistedSales || [])
          .filter((sale: any) => sale.status === 'completed')
          .map((sale: any) => sale.id);

        let commissions = 0;
        if (completedSaleIds.length) {
          const [itemsRes, productsRes] = await Promise.all([
            supabase.from('sale_items').select('product_id,quantity,line_total').in('sale_id', completedSaleIds),
            supabase.from('products').select('id,commission_fixed,commission_percent').eq('company_id', (await getActiveTenant()).companyId)
          ]);
          if (itemsRes.error) throw itemsRes.error;
          if (productsRes.error) throw productsRes.error;
          const productMap = new Map<string, any>((productsRes.data || []).map((p: any) => [p.id, p]));
          for (const saleItem of itemsRes.data || []) {
            const product = productMap.get(saleItem.product_id);
            if (!product) continue;
            const quantity = Number(saleItem.quantity) || 0;
            const lineTotal = Number(saleItem.line_total) || 0;
            const fixed = Number(product.commission_fixed) || 0;
            const percent = Number(product.commission_percent) || 0;
            commissions += (fixed * quantity) + (lineTotal * percent / 100);
          }
        }

        const discrepancyDeduction = Number(settlement.discrepancyDeduction) || 0;
        const recalculatedSettlement = {
          ...settlement,
          commissions,
          total: (Number(settlement.baseSalary) || 0) + commissions - discrepancyDeduction
        };

        const res = await (await import('./supabaseSync')).callCloseSessionRPC(
          session.id,
          session.closingBalances || [],
          session.closedAt || new Date().toISOString(),
          session.notes || '',
          recalculatedSettlement
        );
        if (!res.success) throw new Error(res.error || 'No se pudo cerrar el turno');
        return true;
      }
      if (session.__operation === 'cancel') {
        const res = await callCancelSessionRPC(session.id, session.userId || 'system', session.deleteReason || 'Cancelación de turno');
        if (!res.success) throw new Error(res.error || 'No se pudo cancelar el turno');
        return true;
      }
      if (session.__operation === 'open' || String(item.actionId).startsWith('cash-open:')) {
        const res = await callOpenSessionRPCWithId(session);
        if (res.success) {
          // Reconcile the optimistic local turn number with the authoritative
          // number assigned by Supabase. The server owns the global sequence.
          if (res.data?.turn_number != null) {
            useStore.setState(state => ({
              cashSessions: (state.cashSessions || []).map(s =>
                s.id === session.id ? { ...s, turnNumber: Number(res.data.turn_number) } : s
              ),
              lastTurnNumber: Math.max(state.lastTurnNumber || 0, Number(res.data.turn_number) || 0)
            }));
          }
          return true;
        }
        throw new Error(res.error || 'No se pudo abrir el turno en Supabase');
      }
      // Un snapshot nunca debe reabrir ni cerrar un turno por accidente.
      // Apertura/cierre/cancelación tienen sus propias operaciones. Aquí solo
      // reconciliamos metadatos de una sesión ya existente.
      const { data: remoteSession, error: remoteReadError } = await supabase
        .from('cash_sessions')
        .select('id,status,closed_at,deleted_at,deleted_by,delete_reason')
        .eq('id', session.id)
        .maybeSingle();
      if (remoteReadError) throw remoteReadError;

      if (remoteSession && remoteSession.status !== 'open' && session.status === 'open') {
        // El servidor ya tiene la autoridad final (cerrado/cancelado). El
        // snapshot local quedó obsoleto; se descarta sin reabrir el turno.
        return true;
      }

      // Usamos el mismo adaptador protegido que el flujo online: mezcla
      // movimientos/colaboradores y evita reabrir un turno cerrado.
      const synced = await pushCashSessionToSupabase(session);
      if (!synced) throw new Error('El snapshot del turno no fue confirmado en Supabase.');
      return true;
    }
    case 'audit_start': {
      const d = data;
      const res = await (await import('./supabaseSync')).callStartInventoryAuditRPC(
        d.id, d.branchId, d.userId, d.mode || 'cycle_count', d.blindCount === true, d.notes || ''
      );
      if (!res.success) throw new Error(res.error || 'No se pudo iniciar la auditoría');
      if (res.data?.already_exists && res.data?.audit_id && res.data.audit_id !== d.id) {
        useStore.setState(state => ({
          inventoryAudits: state.inventoryAudits.filter(a => a.id !== d.id)
        }));
        useStore.getState().addNotification('La auditoría offline no pudo abrirse porque ya existe otra auditoría activa en esta sucursal.', 'warning');
        throw new PermanentSyncError('Ya existe otra auditoría activa para esta sucursal.');
      }
      return true;
    }
    case 'audit_recount': {
      const d = data;
      const res = await (await import('./supabaseSync')).callRequestInventoryAuditRecountRPC(d.id, d.userId, d.notes || '');
      if (!res.success) throw new Error(res.error || 'No se pudo solicitar el recuento');
      return true;
    }
    case 'audit_approve': {
      const d = data;
      const res = await (await import('./supabaseSync')).callApproveInventoryAuditRPC(d.id, d.userId, d.notes || '');
      if (!res.success) throw new Error(res.error || 'No se pudo aprobar la auditoría');
      return true;
    }
    case 'branch_delete': {
      const id = String(data?.id || '');
      if (!id) throw new PermanentSyncError('Eliminación de almacén sin ID');
      const ok = await deleteBranchFromSupabase(id);
      if (!ok) throw new Error('No se pudo sincronizar la desactivación del almacén.');
      return true;
    }
    case 'category_delete': {
      const id = String(data?.id || '');
      if (!id) throw new PermanentSyncError('Eliminación de categoría sin ID');
      const ok = await deleteCategoryFromSupabase(id);
      if (!ok) throw new Error('No se pudo sincronizar la desactivación de la categoría.');
      return true;
    }
    case 'supplier_delete': {
      const id = String(data?.id || '');
      if (!id) throw new PermanentSyncError('Eliminación de proveedor sin ID');
      const ok = await deleteSupplierFromSupabase(id);
      if (!ok) throw new Error('No se pudo sincronizar la desactivación del proveedor.');
      return true;
    }
    case 'salary_settlement': {
      const ok = await pushSalarySettlementToSupabase(data as any);
      if (!ok) throw new Error('No se pudo sincronizar la liquidación pendiente.');
      return true;
    }
    case 'customer': {
      const customer = data as Customer;
      const { companyId } = await getActiveTenant();
      const { error } = await supabase.from('customers').upsert({
        id: customer.id,
        company_id: companyId,
        name: customer.name,
        phone: customer.phone || null,
        email: customer.email || null,
        tax_id: customer.taxId || null,
        active: true
      }, { onConflict: 'id' });
      if (error) throw error;
      return true;
    }
    case 'customer_delete': {
      const { companyId } = await getActiveTenant();
      const { error } = await supabase.from('customers').update({ active: false }).eq('id', data.id).eq('company_id', companyId);
      if (error) throw error;
      return true;
    }
    case 'branch': {
      const ok = await pushBranchToSupabase(data as any);
      if (!ok) throw new Error('No se pudo sincronizar el almacén pendiente.');
      return true;
    }
    case 'category': {
      const ok = await pushCategoryToSupabase(data as any);
      if (!ok) throw new Error('No se pudo sincronizar la categoría pendiente.');
      return true;
    }
    case 'product_delete': {
      const productId = String(data?.id || '');
      if (!productId) throw new PermanentSyncError('Eliminación de producto sin ID');
      const ok = await deleteProductFromSupabase(productId);
      if (!ok) throw new Error('No se pudo confirmar la eliminación del producto en Supabase');
      return true;
    }
    case 'product': {
      const ok = await pushProductToSupabase(data as any);
      if (!ok) throw new Error('No se pudo sincronizar el producto pendiente.');
      return true;
    }
    case 'user': {
      const ok = await pushUserToSupabase(data as any);
      if (!ok) throw new Error('No se pudo sincronizar el empleado pendiente.');
      return true;
    }
    case 'currency': { const c=data; const {error}=await supabase.from('currencies').upsert({code:c.code,name:c.name,symbol:c.symbol,rate_to_base:c.rateToBase,is_base:c.isBase},{onConflict:'code'}); if(error) throw error; return true; }
    case 'warranty': {
      const ok = await pushWarrantyToSupabase(data as any);
      if (!ok) throw new Error('No se pudo sincronizar la garantía pendiente.');
      return true;
    }
    case 'time_shift': {
      const ok = await pushTimeShiftToSupabase(data as any);
      if (!ok) throw new Error('No se pudo sincronizar el turno de trabajo pendiente.');
      return true;
    }
    case 'quote': {
      const ok = await pushQuoteToSupabase(data as any);
      if (!ok) throw new Error('No se pudo sincronizar la cotización pendiente.');
      return true;
    }
    case 'bank_card': {
      const ok = await pushBankCardToSupabase(data as any);
      if (!ok) throw new Error('No se pudo sincronizar la cuenta bancaria pendiente.');
      return true;
    }
    case 'bank_card_balance': {
      const d = data;
      const synced = await setBankCardBalanceToSupabase(
        d.id,
        Number(d.expectedBalance) || 0,
        Math.max(0, Number(d.newBalance) || 0)
      );
      if (!synced) {
        await reconcileBankCanonical();
        throw new PermanentSyncError('Conflicto de saldo bancario: otro movimiento cambió el saldo antes del ajuste.');
      }
      return true;
    }
    case 'bank_transaction': {
      const d = data;
      if (d.__operation === 'delete') {
        const res = await callDeleteBankTransactionRPC(d.id);
        if (!res.success) {
          const code = String(res.errorCode || '');
          if (['P0001','23503','23505','42501','22003','22P02'].includes(code)) {
            await reconcileBankCanonical();
            throw new PermanentSyncError(res.error || 'No se pudo eliminar el movimiento bancario');
          }
          throw new Error(res.error || 'No se pudo eliminar el movimiento bancario');
        }
        return true;
      }
      // Un ingreso generado por una venta nunca se procesa solo. Aunque su
      // dependencia haya quedado marcada como conflict, verificamos de nuevo
      // que la venta exista y siga válida en Supabase antes del banco.
      if (d.transactionId) {
        const { data: sale, error: saleError } = await supabase
          .from('sales')
          .select('id,status')
          .eq('id', d.transactionId)
          .maybeSingle();
        if (saleError) throw saleError;
        if (!sale || sale.status !== 'completed') {
          throw new Error('La venta asociada todavía no está confirmada en Supabase; el movimiento bancario permanece pendiente.');
        }
      }
      const res = await callProcessBankTransactionRPC(d);
      if (!res.success) {
        const code = String(res.errorCode || '');
        if (['P0001','23503','23505','42501','22003','22P02'].includes(code)) {
          await reconcileBankCanonical();
          throw new PermanentSyncError(res.error || 'No se pudo sincronizar el movimiento bancario');
        }
        throw new Error(res.error || 'No se pudo sincronizar el movimiento bancario');
      }
      return true;
    }
    case 'supplier': {
      const ok = await pushSupplierToSupabase(data as any);
      if (!ok) throw new Error('No se pudo sincronizar el proveedor pendiente.');
      return true;
    }
    case 'supplier_order': {
      const ok = await pushSupplierOrderToSupabase(data as any);
      if (!ok) throw new Error('No se pudo sincronizar la orden de compra pendiente.');
      return true;
    }
    case 'inventory_audit': {
      const ok = await pushInventoryAuditToSupabase(data as any);
      if (!ok) throw new Error('No se pudo sincronizar la auditoría de inventario pendiente.');
      return true;
    }
    case 'transaction': {
      const transaction = data as Transaction;
      const res = await callProcessTransactionRPC(transaction);
      if (!res.success) {
        // Solo códigos de negocio explícitamente irreversibles se consideran
        // conflictos permanentes. Un timeout, 5xx, PostgREST o pérdida de
        // conexión debe volver a intentarse aunque incluya metadata de error.
        const permanentCodes = new Set(['P0001','23503','23505','22P02','22003','22007','IDEMPOTENCY_CONFLICT']);
        if (res.errorCode && permanentCodes.has(String(res.errorCode))) {
          // La venta existía localmente por modo offline, pero Supabase la rechazó
          // definitivamente. No debe seguir apareciendo como completada ni dejar
          // garantías asociadas que puedan sincronizarse solas.
          useStore.setState(state => ({
            transactions: (state.transactions || []).filter(t => t.id !== transaction.id),
            warranties: (state.warranties || []).filter(w => w.transactionId !== transaction.id)
          }));

          // Cualquier garantía dependiente queda invalidada junto con la venta.
          for (const queued of getOfflineQueue()) {
            if (queued.type === 'warranty' && queued.data?.transactionId === transaction.id) {
              removeFromOfflineQueue(queued.id);
            }
          }

          // Recuperar el inventario real de la sucursal elimina el descuento
          // optimista que se aplicó mientras el dispositivo estaba offline.
          try {
            const branchId = transaction.branchId;
            if (branchId) {
              const inventoryRes = await pullBranchInventoryFromSupabase(branchId);
              if (inventoryRes.success) {
                useStore.setState(state => ({
                  inventory: [
                    ...(state.inventory || []).filter(item => item.branchId !== branchId),
                    ...inventoryRes.inventory
                  ]
                }));
              }
            }
            await useStore.getState().refreshBranchOperationalData();
          } catch (refreshError) {
            console.warn('[transaction] No se pudo reconciliar el estado local tras rechazo definitivo:', refreshError);
          }

          useStore.getState().addNotification(
            'Una venta realizada sin conexión fue rechazada por el servidor y no se confirmó.',
            'error',
            res.error || 'Revisa inventario, datos del producto o las reglas de la venta.'
          );
          throw new PermanentSyncError(res.error || 'La venta fue rechazada por Supabase');
        }
        throw new Error(res.error || 'No se pudo sincronizar la venta');
      }

      // No damos la operación por completada solo porque el HTTP/RPC respondió.
      // Confirmamos que la fila existe realmente en Supabase antes de retirar la
      // operación de IndexedDB. Así una respuesta incompleta o una caída durante
      // la confirmación nunca puede dejar una venta perdida y una cola vacía.
      const { data: persisted, error: verifyError } = await supabase
        .from('sales')
        .select('id,status,total,warehouse_id')
        .eq('id', transaction.id)
        .maybeSingle();
      if (verifyError) throw verifyError;
      if (!persisted || persisted.id !== transaction.id || persisted.status === 'refunded' || persisted.status === 'cancelled') {
        throw new Error('Supabase no confirmó la venta como completada después de procesarla');
      }

      // Al reintentar tras una caída, la RPC puede haber confirmado la venta
      // antes de que la tablet muriera. El replay debe restaurar el inventario
      // local desde el servidor y no volver a confiar en el snapshot offline.
      const branchId = persisted.warehouse_id || transaction.branchId;
      if (branchId) {
        const inventoryRes = await pullBranchInventoryFromSupabase(branchId);
        if (!inventoryRes.success) {
          throw new Error(inventoryRes.message || 'No se pudo reconciliar el inventario de la venta');
        }
        useStore.setState(state => ({
          inventory: [
            ...(state.inventory || []).filter(item => item.branchId !== branchId),
            ...inventoryRes.inventory
          ]
        }));
      }

      // La venta ya está confirmada en Supabase: quitar la marca local pendiente
      // antes de retirar su operación del outbox.
      useStore.setState(state => {
        const exists = (state.transactions || []).some(t => t.id === transaction.id);
        return {
          transactions: exists
            ? (state.transactions || []).map(t => t.id === transaction.id ? { ...t, ...transaction, offlinePending: false } : t)
            : [{ ...transaction, offlinePending: false }, ...(state.transactions || [])]
        };
      });
      return true;
    }
    case 'void_transaction': {
      const res = await callVoidTransactionRPC(data.id, data.userId, data.reason || 'Anulación de venta');
      if (!res.success) {
        const code = String(res.errorCode || '');
        if (['P0001','23503','23505','42501','22003','22P02','IDEMPOTENCY_CONFLICT'].includes(code)) {
          throw new PermanentSyncError(res.error || 'La anulación de la venta fue rechazada permanentemente.');
        }
        throw new Error(res.error || 'No se pudo anular la venta');
      }

      const { data: persistedVoid, error: voidReadError } = await supabase
        .from('sales')
        .select('id,status,warehouse_id')
        .eq('id', data.id)
        .maybeSingle();
      if (voidReadError) throw voidReadError;
      if (!persistedVoid || !['voided','refunded'].includes(persistedVoid.status)) {
        throw new Error('Supabase no confirmó la anulación de la venta');
      }
      if (persistedVoid.warehouse_id) {
        const inventoryRes = await pullBranchInventoryFromSupabase(persistedVoid.warehouse_id);
        if (!inventoryRes.success) throw new Error(inventoryRes.message || 'No se pudo reconciliar el inventario de la anulación');
        useStore.setState(state => ({
          inventory: [
            ...(state.inventory || []).filter(item => item.branchId !== persistedVoid.warehouse_id),
            ...inventoryRes.inventory
          ]
        }));
      }
      await reconcileBankCanonical();
      return true;
    }
    case 'return_complete': {
      const res = await callCompleteReturnRPC(data.id, data.userId);
      if (!res.success) {
        const code = String(res.errorCode || '');
        if (['P0001','23503','23505','42501','22003','22P02','IDEMPOTENCY_CONFLICT'].includes(code)) {
          throw new PermanentSyncError(res.error || 'La devolución fue rechazada permanentemente.');
        }
        throw new Error(res.error || 'No se pudo completar la devolución');
      }

      const { data: persistedReturn, error: returnReadError } = await supabase
        .from('sales_returns')
        .select('id,status,sale_id')
        .eq('id', data.id)
        .maybeSingle();
      if (returnReadError) throw returnReadError;
      if (!persistedReturn || persistedReturn.status !== 'completed') {
        throw new Error('Supabase no confirmó la devolución como completada');
      }
      if (persistedReturn.sale_id) {
        const { data: saleRow, error: saleReadError } = await supabase
          .from('sales')
          .select('warehouse_id')
          .eq('id', persistedReturn.sale_id)
          .maybeSingle();
        if (saleReadError) throw saleReadError;
        if (saleRow?.warehouse_id) {
          const inventoryRes = await pullBranchInventoryFromSupabase(saleRow.warehouse_id);
          if (!inventoryRes.success) throw new Error(inventoryRes.message || 'No se pudo reconciliar el inventario de la devolución');
          useStore.setState(state => ({
            inventory: [
              ...(state.inventory || []).filter(item => item.branchId !== saleRow.warehouse_id),
              ...(inventoryRes.inventory || [])
            ]
          }));
        }
      }
      return true;
    }
    case 'receipt_config': {
    case 'receipt_config': { const { error } = await supabase.from('settings').upsert({ id: 'global', receipt_config: data }); if (error) throw error; return true; }
    case 'store_config': {
      const { data: current, error: readError } = await supabase
        .from('settings')
        .select('store_config')
        .eq('id', 'global')
        .maybeSingle();
      if (readError) throw readError;
      const currentConfig = (current?.store_config && typeof current.store_config === 'object') ? current.store_config : {};
      const incomingConfig = (data && typeof data === 'object') ? data : {};
      const mergedConfig = { ...currentConfig, ...incomingConfig };
      const { error } = await supabase.from('settings').upsert({ id: 'global', store_config: mergedConfig });
      if (error) throw error;
      return true;
    }
    case 'catalog_config': { const { error } = await supabase.from('settings').upsert({ id: 'global', catalog_config: data }); if (error) throw error; return true; }
    default: throw new PermanentSyncError(`Tipo de operación offline no soportado: ${String(type)}`);
  }
}

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
      if (!permanent && (item.type === 'transaction' || item.type === 'cash_session' || item.type === 'transfer' || item.type === 'transfer_bulk' || item.type === 'return_complete')) {
        // Las operaciones críticas mantienen el orden temporal: una dependencia
        // fallida no permite que las posteriores la salten.
        for (let tail = index + 1; tail < sorted.length; tail++) remainingFromRun.push(sorted[tail]);
        break;
      }
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
