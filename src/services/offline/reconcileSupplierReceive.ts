import type { InventoryLevel } from '../../types';
import { getOfflineQueue } from '../offlineQueue';
import { pullBranchInventoryFromSupabase } from '../supabaseSync';
import { useStore } from '../../store/useStore';

export async function reconcileSupplierReceiveCanonical(supabase: any, orderId: string): Promise<void> {

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
