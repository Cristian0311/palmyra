/**
 * Protección del trabajo offline frente a snapshots remotos retrasados.
 *
 * Un pull remoto puede llegar mientras una venta, un ajuste o un cierre de caja
 * todavía vive solo en la cola durable. Estas funciones deciden qué filas
 * locales conservan su versión hasta que Supabase confirme la operación.
 */
import type { OfflineQueueItem } from '../../services/offlineQueueTypes';
import type { InventoryLevel } from '../../types';

type QueueLike = Pick<OfflineQueueItem, 'type' | 'data'>;

export function inventoryProtectionKey(
  productId: unknown,
  branchId: unknown,
  variantLabel?: unknown
): string {
  return `${String(productId ?? '')}_${String(branchId ?? '')}_${String(variantLabel ?? '')}`;
}

function queueId(item: QueueLike): string {
  return String(item.data?.id ?? item.data?.operationId ?? item.data?.actionId ?? '');
}

export function collectPendingInventoryKeys(
  queue: QueueLike[],
  context?: {
    transactions?: any[];
    returns?: any[];
    supplierOrders?: any[];
  }
): Set<string> {
  const keys = new Set<string>();

  for (const item of queue) {
    const data = item.data || {};

    if (item.type === 'inventory_adjustment' || item.type === 'inventory_reconcile' || item.type === 'inventory') {
      keys.add(inventoryProtectionKey(data.productId, data.branchId, data.variantLabel));
      continue;
    }

    if (item.type === 'transaction') {
      const branchId = data.branchId;
      for (const saleItem of Array.isArray(data.items) ? data.items : []) {
        const product = typeof saleItem?.product === 'string' ? saleItem.product : saleItem?.product?.id;
        if (!product || !branchId) continue;
        const label = saleItem?.variantLabel || saleItem?.variant_label || '';
        keys.add(inventoryProtectionKey(product, branchId, label));
        const components = typeof saleItem?.product === 'object'
          ? (saleItem.product?.kitComponents || saleItem.product?.kitItems || [])
          : [];
        for (const component of Array.isArray(components) ? components : []) {
          if (component?.productId) keys.add(inventoryProtectionKey(component.productId, branchId, ''));
        }
      }
      continue;
    }

    if (item.type === 'transfer' || item.type === 'transfer_bulk') {
      const operations = item.type === 'transfer'
        ? [{ productId: data.productId, variants: data.variants }]
        : (Array.isArray(data.items) ? data.items : []);
      for (const operation of operations) {
        const productId = operation?.productId;
        if (!productId) continue;
        for (const variant of Array.isArray(operation?.variants) ? operation.variants : []) {
          const label = variant?.variantLabel ?? variant?.variant_label ?? '';
          keys.add(inventoryProtectionKey(productId, data.fromBranchId, label));
          keys.add(inventoryProtectionKey(productId, data.toBranchId, label));
        }
      }
      continue;
    }

    if (item.type === 'transfer_receive' || item.type === 'transfer_cancel') {
      for (const row of Array.isArray(data?.rows) ? data.rows : []) {
        if (!row?.productId || !row?.branchId) continue;
        keys.add(inventoryProtectionKey(row.productId, row.branchId, row.variantLabel || ''));
      }
      continue;
    }

    if (item.type === 'void_transaction') {
      // The local stock was already returned when the void was accepted. Keep
      // those rows local until the outbox replays, instead of letting a
      // pre-void remote snapshot take the units away again.
      const saleId = String(data.id ?? '');
      const remoteId = String(data.remoteId ?? data.remote_id ?? '');
      const sale = (context?.transactions || []).find((entry: any) =>
        String(entry?.id) === saleId || (remoteId && String(entry?.remoteId) === remoteId));
      if (!sale) continue;
      for (const saleItem of Array.isArray(sale.items) ? sale.items : []) {
        const productId = typeof saleItem?.product === 'string' ? saleItem.product : saleItem?.product?.id;
        if (!productId) continue;
        keys.add(inventoryProtectionKey(productId, sale.branchId, saleItem?.variantLabel || ''));
        const components = typeof saleItem?.product === 'object'
          ? (saleItem.product?.kitComponents || saleItem.product?.kitItems || [])
          : [];
        for (const component of Array.isArray(components) ? components : []) {
          if (component?.productId) keys.add(inventoryProtectionKey(component.productId, sale.branchId, ''));
        }
      }
      continue;
    }

    if (item.type === 'return' || item.type === 'return_complete') {
      const request = item.type === 'return'
        ? data
        : (context?.returns || []).find((entry: any) => String(entry?.id) === String(data.id));
      if (!request) continue;
      const originalTransaction = (context?.transactions || []).find(
        (entry: any) => String(entry?.id) === String(request.transactionId)
      );
      const branchId = request.branchId || originalTransaction?.branchId;
      if (!branchId) continue;
      const label = request.variantLabel || '';
      if (request.type === 'refund') keys.add(inventoryProtectionKey(request.productId, branchId, label));
      if (request.type === 'warranty_exchange' && request.replacementProductId) {
        keys.add(inventoryProtectionKey(request.replacementProductId, branchId, ''));
      }
      continue;
    }

    if (item.type === 'supplier_receive') {
      const order = (context?.supplierOrders || []).find((entry: any) => String(entry?.id) === String(data.id));
      for (const line of Array.isArray(order?.items) ? order.items : []) {
        keys.add(inventoryProtectionKey(line.productId, order.branchId, line.variantLabel || ''));
      }
    }
  }

  return keys;
}

export function collectPendingTransactionIds(queue: QueueLike[]): Set<string> {
  return new Set(
    queue
      .filter(item => item.type === 'transaction' || item.type === 'void_transaction')
      .map(queueId)
      .filter(Boolean)
  );
}

export function collectPendingCashSessionIds(queue: QueueLike[]): Set<string> {
  return new Set(
    queue
      .filter(item => item.type === 'cash_session')
      .map(queueId)
      .filter(Boolean)
  );
}

export function collectPendingTransferIds(queue: QueueLike[]): Set<string> {
  const ids = new Set<string>();
  for (const item of queue) {
    if (item.type === 'transfer') {
      ids.add(String(item.data?.id || item.data?.operationId || ''));
    } else if (item.type === 'transfer_bulk') {
      for (const operation of Array.isArray(item.data?.items) ? item.data.items : []) {
        if (operation?.operationId) ids.add(String(operation.operationId));
      }
    } else if (item.type === 'transfer_receive' || item.type === 'transfer_cancel') {
      for (const operationId of Array.isArray(item.data?.operationIds) ? item.data.operationIds : []) {
        if (operationId) ids.add(String(operationId));
      }
    }
  }
  ids.delete('');
  return ids;
}

export function mergeBranchInventory(
  remote: InventoryLevel[] | undefined,
  local: InventoryLevel[] | undefined,
  branchId: string,
  pendingInventoryKeys: Set<string>
): InventoryLevel[] {
  const merged = new Map<string, InventoryLevel>();

  for (const item of local || []) {
    const key = inventoryProtectionKey(item.productId, item.branchId, item.variantLabel);
    // Otras sucursales y las filas de esta sucursal con cambios pendientes
    // conservan siempre su versión local.
    if (!branchId || item.branchId !== branchId || pendingInventoryKeys.has(key)) {
      merged.set(key, item);
    }
  }

  for (const item of remote || []) {
    const key = inventoryProtectionKey(item.productId, item.branchId, item.variantLabel);
    if (pendingInventoryKeys.has(key) && merged.has(key)) continue;
    merged.set(key, item);
  }

  return Array.from(merged.values());
}

export function mergeBranchOperationalData(params: {
  remote: {
    inventory?: InventoryLevel[];
    transactions?: any[];
    cashSessions?: any[];
    transfers?: any[];
  };
  local: {
    inventory?: InventoryLevel[];
    transactions?: any[];
    cashSessions?: any[];
    transfers?: any[];
    returns?: any[];
    supplierOrders?: any[];
  };
  branchId: string;
  queue: QueueLike[];
}): {
  inventory: InventoryLevel[];
  transactions: any[];
  cashSessions: any[];
  transfers: any[];
} {
  const { remote, local, branchId, queue } = params;
  const pendingInventoryKeys = collectPendingInventoryKeys(queue, {
    transactions: local.transactions,
    returns: local.returns,
    supplierOrders: local.supplierOrders
  });
  const pendingTransactionIds = collectPendingTransactionIds(queue);
  const pendingCashSessionIds = collectPendingCashSessionIds(queue);
  const pendingTransferIds = collectPendingTransferIds(queue);

  const transactionMap = new Map<string, any>();
  for (const item of local.transactions || []) transactionMap.set(String(item.id), item);
  for (const item of remote.transactions || []) {
    const id = String(item.id);
    if (pendingTransactionIds.has(id) && transactionMap.has(id)) continue;
    transactionMap.set(id, item);
  }

  const sessionMap = new Map<string, any>();
  for (const item of local.cashSessions || []) sessionMap.set(String(item.id), item);
  for (const item of remote.cashSessions || []) {
    const id = String(item.id);
    const localSession = sessionMap.get(id);
    const remoteReopensClosed = localSession?.status === 'closed' && item?.status === 'open';
    if (localSession && (pendingCashSessionIds.has(id) || remoteReopensClosed)) continue;
    sessionMap.set(id, item);
  }

  const transferMap = new Map<string, any>();
  const transferKey = (item: any) => String(item?.id || item?.operationId || '');
  for (const item of local.transfers || []) transferMap.set(transferKey(item), item);
  for (const item of remote.transfers || []) {
    const id = transferKey(item);
    if (pendingTransferIds.has(id) && transferMap.has(id)) continue;
    transferMap.set(id, item);
  }

  return {
    inventory: mergeBranchInventory(remote.inventory, local.inventory, branchId, pendingInventoryKeys),
    transactions: Array.from(transactionMap.values()),
    cashSessions: Array.from(sessionMap.values()),
    transfers: Array.from(transferMap.values())
  };
}
