import { getSupabase } from '../../lib/supabase';
import { useStore } from '../../store/useStore';
import type { OfflineQueueItem } from '../offlineQueue';
import type { Transaction, CashRegisterSession, Customer, ReturnItem, InventoryLevel } from '../../types';
import {
  getOfflineQueue,
  removeFromOfflineQueue,
  isOfflineQueueItemRemoved,
  clearOfflineQueueRemovalMark,
  setOfflineQueueMemory,
  persistOfflineQueueSnapshot
} from '../offlineQueue';
import {
  callOpenSessionRPCWithId, callProcessTransactionRPC, callVoidTransactionRPC, callCancelSessionRPC,
  callCompleteReturnRPC, callTransferInventoryRPC, callTransferInventoryBulkRPC, callReceiveSupplierOrderRPC,
  callStartInventoryAuditRPC, callSaveInventoryAuditCountRPC, callRequestInventoryAuditRecountRPC, callApproveInventoryAuditRPC,
  callBankInternalTransferRPC, callDeleteBankInternalTransferRPC, callDeleteBankTransactionRPC, callDeleteBankCardRPC, callProcessBankTransactionRPC,
  setBankCardBalanceToSupabase, pullBranchInventoryFromSupabase,
  pushCashSessionToSupabase, deleteProductFromSupabase,
  pushBranchToSupabase, deleteBranchFromSupabase, pushCategoryToSupabase, deleteCategoryFromSupabase, deleteSupplierFromSupabase,
  pushProductToSupabase, pushUserToSupabase, pushWarrantyToSupabase, pushTimeShiftToSupabase, deleteBankCardFromSupabase,
  pushQuoteToSupabase, pushBankCardToSupabase, pushReturnToSupabase,
  pushSupplierToSupabase, pushSupplierOrderToSupabase, pushInventoryAuditToSupabase,
  pushSalarySettlementToSupabase, pushInventoryToSupabase,
  pushCashMovementToSupabase, deleteCashMovementFromSupabase, pushCashSessionMetadataToSupabase,
  applyInventoryAdjustmentToSupabase, reconcileInventoryToSupabase
} from '../supabaseSync';
import { addSyncLog } from '../../utils/syncLogger';
import { getActiveTenant } from '../tenant';
import { reconcileBankCanonical } from './reconcileBank';
import { replaceWarehouseInventory, replaceWarehousesInventory } from './reconcileInventory';
import { reconcileSupplierReceiveCanonical } from './reconcileSupplierReceive';
class PermanentSyncError extends Error {
  permanent = true;
}

export async function processQueueItem(supabase: any, item: OfflineQueueItem): Promise<boolean> {
  const { type, data } = item;
  switch (type) {
    case 'cash_movement': {
      const movement = data as {
        id:string; sessionId:string; type:'income'|'expense'; amount:number; currencyCode:string; description?:string
      };
      const ok = await pushCashMovementToSupabase({
        id: movement.id,
        sessionId: movement.sessionId,
        type: movement.type,
        amount: Math.abs(Number(movement.amount)||0),
        currencyCode: movement.currencyCode,
        description: movement.description || ''
      });
      if (!ok) throw new Error('No se pudo sincronizar el movimiento de caja.');
      return true;
    }
    case 'cash_movement_delete': {
      const movement = data as { id:string; sessionId:string };
      const ok = await deleteCashMovementFromSupabase({ id: movement.id, sessionId: movement.sessionId });
      if (!ok) throw new Error('No se pudo sincronizar la eliminación del movimiento de caja.');
      return true;
    }
    case 'cash_session': {
      const session = data as CashRegisterSession & { __operation?: 'open' | 'close' | 'cancel' | 'snapshot'; settlement?: any; closedAt?: string };

      // Compatibilidad con snapshots de versiones anteriores: si todavía existe
      // una operación cash_session que contiene movimientos, los reescribimos
      // mediante la API idempotente de movimientos para no perderlos al migrar
      // de snapshots completos a operaciones independientes.
      const syncLegacySessionMovements = async () => {
        for (const movement of session.movements || []) {
          const ok = await pushCashMovementToSupabase({
            id: movement.id,
            sessionId: session.id,
            type: movement.type,
            amount: Math.abs(Number(movement.amount) || 0),
            currencyCode: movement.currencyCode,
            description: movement.description || ''
          });
          if (!ok) throw new Error('No se pudo sincronizar un movimiento de caja del turno.');
        }
      };
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

        // Compatibilidad con snapshots antiguos: sus movimientos deben existir
        // antes de cerrar el turno, porque el RPC de movimientos exige una sesión abierta.
        await syncLegacySessionMovements();

        const res = await (await import('../supabaseSync')).callCloseSessionRPC(
          session.id,
          session.closingBalances || [],
          session.closedAt || new Date().toISOString(),
          session.notes || '',
          recalculatedSettlement,
          Number.isFinite(Number(session.expectedBalance)) ? Number(session.expectedBalance) : undefined
        );
        if (!res.success) throw new Error(res.error || 'No se pudo cerrar el turno');

        // El cierre remoto y el metadata del turno son confirmaciones separadas.
        // Guardamos el metadata después del cierre para que Reportes pueda reconstruir
        // descuadres/liquidaciones incluso después de reiniciar el dispositivo.
        const metadataOk = await pushCashSessionMetadataToSupabase(session);
        if (!metadataOk) throw new Error('El cierre fue confirmado, pero el metadata del turno aún no pudo sincronizarse.');
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

      // Un snapshot administrativo solo cambia metadata. Usamos el RPC
      // protegido para no depender del UPDATE de cash_sessions bajo RLS.
      const synced = await pushCashSessionMetadataToSupabase(session);
      if (!synced) throw new Error('El snapshot del turno no fue confirmado en Supabase.');
      await syncLegacySessionMovements();
      return true;
    }
    case 'audit_start': {
      const d = data;
      const res = await (await import('../supabaseSync')).callStartInventoryAuditRPC(
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
      const res = await (await import('../supabaseSync')).callRequestInventoryAuditRecountRPC(d.id, d.userId, d.notes || '');
      if (!res.success) throw new Error(res.error || 'No se pudo solicitar el recuento');
      return true;
    }
    case 'audit_approve': {
      const d = data;
      const res = await (await import('../supabaseSync')).callApproveInventoryAuditRPC(d.id, d.userId, d.notes || '');
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
    case 'bank_internal_transfer': {
      const res = await callBankInternalTransferRPC(data as any);
      if (!res.success) throw new Error(res.error || 'No se pudo sincronizar la transferencia bancaria interna.');
      return true;
    }
    case 'bank_internal_transfer_delete': {
      const res = await callDeleteBankInternalTransferRPC(String(data?.operationId || ''));
      if (!res.success) throw new Error(res.error || 'No se pudo eliminar la transferencia bancaria interna.');
      return true;
    }
    case 'bank_transaction_delete': {
      const res = await callDeleteBankTransactionRPC(String(data?.id || ''));
      if (!res.success) throw new Error(res.error || 'No se pudo eliminar el movimiento bancario.');
      return true;
    }
    case 'inventory': {
      const ok = await pushInventoryToSupabase(data as any);
      if (!ok) throw new Error('No se pudo sincronizar el stock pendiente.');
      return true;
    }
    case 'inventory_adjustment': {
      const res = await applyInventoryAdjustmentToSupabase(data as any);
      if (!res.success) {
        if (res.conflict) {
          await useStore.getState().refreshBranchInventory();
          throw new PermanentSyncError(res.error || 'Conflicto de ajuste de inventario.');
        }
        throw new Error(res.error || 'No se pudo sincronizar el ajuste de inventario.');
      }
      if (Number.isFinite(Number(res.data?.quantity))) {
        useStore.setState(state => ({
          inventory: state.inventory.map(item =>
            item.productId === data.productId &&
            item.branchId === data.branchId &&
            (item.variantLabel || '') === (data.variantLabel || '')
              ? { ...item, quantity: Number(res.data.quantity) }
              : item
          )
        }));
      }
      return true;
    }
    case 'inventory_reconcile': {
      const res = await reconcileInventoryToSupabase(data as any);
      if (!res.success) {
        if (res.conflict) {
          await useStore.getState().refreshBranchInventory();
          throw new PermanentSyncError(res.error || 'Conflicto de reconciliación de inventario.');
        }
        throw new Error(res.error || 'No se pudo sincronizar la reconciliación de inventario.');
      }
      if (Number.isFinite(Number(res.data?.quantity))) {
        useStore.setState(state => ({
          inventory: state.inventory.map(item =>
            item.productId === data.productId &&
            item.branchId === data.branchId &&
            (item.variantLabel || '') === (data.variantLabel || '')
              ? { ...item, quantity: Number(res.data.quantity), minQuantity: data.minQuantity ?? item.minQuantity }
              : item
          )
        }));
      }
      return true;
    }
    case 'transfer': {
      const res = await callTransferInventoryRPC(data as any);
      if (!res.success) throw new Error(res.error || 'No se pudo sincronizar la transferencia de inventario.');
      const results = await Promise.all([
        pullBranchInventoryFromSupabase(data.fromBranchId),
        pullBranchInventoryFromSupabase(data.toBranchId)
      ]);
      if (results.some(x => !x.success)) throw new Error('Transferencia confirmada, pero no se pudo reconciliar el inventario.');
      replaceWarehousesInventory(
        data.fromBranchId,
        results[0].inventory || [],
        data.toBranchId,
        results[1].inventory || []
      );
      return true;
    }
    case 'transfer_bulk': {
      const res = await callTransferInventoryBulkRPC(data as any);
      if (!res.success) throw new Error(res.error || 'No se pudo sincronizar el traslado múltiple.');
      const results = await Promise.all([
        pullBranchInventoryFromSupabase(data.fromBranchId),
        pullBranchInventoryFromSupabase(data.toBranchId)
      ]);
      if (results.some(x => !x.success)) throw new Error('Traslado confirmado, pero no se pudo reconciliar el inventario.');
      replaceWarehousesInventory(
        data.fromBranchId,
        results[0].inventory || [],
        data.toBranchId,
        results[1].inventory || []
      );
      return true;
    }
    case 'supplier_receive': {
      const res = await callReceiveSupplierOrderRPC(String(data?.id || ''), String(data?.userId || ''));
      if (!res.success) throw new Error(res.error || 'No se pudo recibir la orden de compra.');
      await reconcileSupplierReceiveCanonical(supabase, String(data?.id || ''));
      return true;
    }
    case 'audit_complete': {
      const res = await callSaveInventoryAuditCountRPC(
        String(data?.id || ''),
        String(data?.userId || ''),
        Array.isArray(data?.items) ? data.items : [],
        data?.notes || ''
      );
      if (!res.success) throw new Error(res.error || 'No se pudo sincronizar el conteo de auditoría.');
      return true;
    }
    case 'return': {
      const ok = await pushReturnToSupabase(data as ReturnItem);
      if (!ok) throw new Error('No se pudo sincronizar la devolución pendiente.');
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
      try {
        const ok = await pushProductToSupabase(data as any, { queueOnTransientFailure: false });
        if (!ok) throw new Error('No se pudo sincronizar el producto pendiente: la conexión todavía no está disponible.');
        return true;
      } catch (error: any) {
        const detail = String(error?.message || 'No se pudo sincronizar el producto pendiente.');
        if (error?.permanent) {
          throw new PermanentSyncError(detail);
        }
        throw error;
      }
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
    case 'bank_card_delete': {
      const ok = await deleteBankCardFromSupabase(String(data?.id || ''));
      if (!ok) throw new Error('No se pudo sincronizar la eliminación de la cuenta bancaria.');
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
        const permanentCodes = new Set(['P0001','23503','23505','23502','23514','42501','42883','22P02','22003','22007','IDEMPOTENCY_CONFLICT']);
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
      const isUuid = (value: unknown) =>
        typeof value === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
      const remoteSaleId =
        [res.data?.remote_id, transaction.remoteId, transaction.id].find((candidate) => isUuid(candidate)) || null;

      const persistedQuery = remoteSaleId
        ? supabase.from('sales').select('id,status,total,warehouse_id').eq('id',remoteSaleId).maybeSingle()
        : Promise.resolve({data:null,error:null});
      const { data: persisted, error: verifyError } = await persistedQuery;
      if (verifyError) throw verifyError;
      if (!persisted || persisted.status === 'refunded' || persisted.status === 'cancelled') {
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
            ? (state.transactions || []).map(t => t.id === transaction.id ? { ...t, ...transaction, ...(persisted?.id ? { remoteId: persisted.id } : {}), offlinePending: false } : t)
            : [{ ...transaction, ...(persisted?.id ? { remoteId: persisted.id } : {}), offlinePending: false }, ...(state.transactions || [])]
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
        replaceWarehouseInventory(persistedVoid.warehouse_id, inventoryRes.inventory);
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
          replaceWarehouseInventory(saleRow.warehouse_id, inventoryRes.inventory || []);
        }
      }
      return true;
    }
    case 'receipt_config':
    case 'store_config':
    case 'catalog_config': {
      // La tabla legacy public.settings ya no existe en el esquema actual.
      // Persistimos estos ajustes dentro del registro tenant-scoped de company_settings
      // para que la sincronización offline nunca quede reintentando contra una tabla inexistente.
      const { companyId } = await getActiveTenant();
      const key = type === 'receipt_config' ? 'receipt_config' : type === 'catalog_config' ? 'catalog_config' : 'store_config';
      const { data: current, error: readError } = await supabase
        .from('company_settings')
        .select('settings')
        .eq('company_id', companyId)
        .maybeSingle();
      if (readError) throw readError;
      const currentSettings = (current?.settings && typeof current.settings === 'object') ? current.settings : {};
      const incomingConfig = (data && typeof data === 'object') ? data : {};
      const mergedSettings = { ...currentSettings, [key]: { ...(currentSettings as any)?.[key], ...incomingConfig } };
      const { error } = await supabase
        .from('company_settings')
        .upsert({ company_id: companyId, settings: mergedSettings, updated_at: new Date().toISOString() }, { onConflict: 'company_id' });
      if (error) throw error;
      return true;
    }
    default: throw new PermanentSyncError(`Tipo de operación offline no soportado: ${String(type)}`);
  }
}
