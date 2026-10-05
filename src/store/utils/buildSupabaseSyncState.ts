import type { AppState } from "../storeTypes";
import { getOfflineQueue } from "../../services/offlineQueue";
import { replaceRemoteRecords } from "./replaceRemoteRecords";
import { mergeUnique } from "./syncMerges";

type SyncSnapshot = any;

/**
 * Reconciles a full Supabase snapshot with local state while preserving durable
 * offline operations until the server confirms them.
 */
export function buildSupabaseSyncState(
  data: SyncSnapshot,
  state: AppState
): Partial<AppState> {

// --- 1. Sucursales ---
const offlineQueueSnapshot = getOfflineQueue();
const offlineQueuedBranchItems = offlineQueueSnapshot.filter(i => i.type === 'branch');
const offlineQueuedBranchIds = new Set(offlineQueuedBranchItems.map(i => i.data.id));
const offlineDeletedBranchIds = new Set(offlineQueueSnapshot.filter(i => i.type === 'branch_delete').map(i => i.data?.id).filter(Boolean));

const mergedBranches = mergeUnique(data.branches, state.branches || [], { offlineIds: offlineQueuedBranchIds });

// Purge: Si recibimos datos de Supabase, eliminar locales que no estén en Supabase Y no estén en la cola offline
const finalBranches = (data.branches && data.branches.length > 0)
  ? mergedBranches.filter(b =>
      !offlineDeletedBranchIds.has(b.id) &&
      (data.branches.some((sb: any) => sb.id === b.id) ||
      offlineQueuedBranchIds.has(b.id))
    )
  : mergedBranches.filter(b => !offlineDeletedBranchIds.has(b.id));

const validBranchIds = new Set(finalBranches.map(b => b.id));

let nextBranchId = state.currentBranchId;
if (!nextBranchId || !validBranchIds.has(nextBranchId)) {
  nextBranchId = finalBranches[0]?.id || '';
}

// --- 2. Transacciones ---
const offlineQueuedTxIds = new Set(
  getOfflineQueue().filter(i => i.type === 'transaction' || i.type === 'void_transaction').map(i => i.data.id)
);
const offlinePendingTxIds = new Set(
  (state.transactions || []).filter((tx: any) => tx.offlinePending === true).map((tx: any) => tx.id)
);
const mergedTransactionsRaw = replaceRemoteRecords(
  data.transactions,
  state.transactions || [],
  new Set([...offlineQueuedTxIds, ...offlinePendingTxIds])
);
// Nunca purgar una venta local únicamente porque una lectura remota
// todavía no la devuelve. Entre commits/realtime/reconexiones puede
// existir una ventana de consistencia y esa purga era precisamente la
// causa de que un ticket apareciera en Reportes y luego desapareciera.
// Supabase sigue siendo la autoridad: cuando llega el mismo ID remoto,
// mergeUnique lo reemplaza con la versión del servidor.
const mergedTransactions = mergedTransactionsRaw;

// --- 3. Sesiones ---
const offlineQueuedSessionIds = new Set(
  getOfflineQueue().filter(i => i.type === 'cash_session').map(i => i.data.id)
);
const mergedCashSessionsRaw = replaceRemoteRecords(data.cashSessions, state.cashSessions || [], offlineQueuedSessionIds);
const mergedCashSessions = Array.isArray(data.cashSessions) && data.cashSessions.length > 0
  ? mergedCashSessionsRaw.filter(cs => data.cashSessions.some((ss: any) => ss.id === cs.id) || offlineQueuedSessionIds.has(cs.id))
  : mergedCashSessionsRaw;

// --- 4. Clientes ---
const customerQueue = getOfflineQueue();
const offlineQueuedCustomerIds = new Set(
  customerQueue
    .filter(i => i.type === 'customer' || i.type === 'customer_delete')
    .map(i => i.data?.id)
    .filter(Boolean)
);
const offlineDeletedCustomerIds = new Set(
  customerQueue
    .filter(i => i.type === 'customer_delete')
    .map(i => String(i.data?.id || ''))
    .filter(Boolean)
);
const mergedCustomers = replaceRemoteRecords(data.customers, state.customers || [], offlineQueuedCustomerIds)
  .filter(customer => !offlineDeletedCustomerIds.has(String(customer.id)));

// --- 5. Devoluciones ---
const offlineQueuedReturnIds = new Set(
  getOfflineQueue().filter(i => i.type === 'return' || i.type === 'return_complete').map(i => i.data.id)
);
const mergedReturnsRaw = replaceRemoteRecords(data.returns, state.returns || [], offlineQueuedReturnIds);
const mergedReturns = Array.isArray(data.returns) && data.returns.length > 0
  ? mergedReturnsRaw.filter(r => data.returns.some((sr: any) => sr.id === r.id) || offlineQueuedReturnIds.has(r.id))
  : mergedReturnsRaw;

// --- 6. Inventario (Deduplicación por combinación única) ---
// An empty inventory response during reconnect is not authoritative:
// keep the last local snapshot instead of blanking the POS.
const hasRemoteInventory = Array.isArray(data.inventory) && data.inventory.length > 0;
const baseInv = hasRemoteInventory ? data.inventory : (state.inventory || []);
const invMap = new Map<string, InventoryLevel>();
baseInv.forEach(inv => {
  const key = `${inv.productId}_${inv.branchId}_${inv.variantLabel || ''}`;
  invMap.set(key, inv);
});

// Si una operación de inventario sigue en la cola, su valor local es el
// estado que todavía no está confirmado por Supabase. Conservamos esa fila
// durante el merge para evitar que un snapshot remoto anterior la revierta.
const pendingInventoryKeys = new Set<string>();
getOfflineQueue().forEach(i => {
  const d = i.data || {};

  if (i.type === 'inventory_adjustment' || i.type === 'inventory_reconcile' || i.type === 'inventory') {
    pendingInventoryKeys.add(`${d.productId}_${d.branchId}_${d.variantLabel || ''}`);
    return;
  }

  if (i.type === 'transaction') {
    const branchId = d.branchId;
    for (const saleItem of Array.isArray(d.items) ? d.items : []) {
      const product = typeof saleItem?.product === 'string' ? saleItem.product : saleItem?.product?.id;
      if (!product || !branchId) continue;
      const label = saleItem?.variantLabel || saleItem?.variant_label || '';
      pendingInventoryKeys.add(`${product}_${branchId}_${label}`);
      const components = typeof saleItem?.product === 'object'
        ? (saleItem.product?.kitComponents || saleItem.product?.kitItems || [])
        : [];
      for (const component of Array.isArray(components) ? components : []) {
        if (component?.productId) {
          pendingInventoryKeys.add(`${component.productId}_${branchId}_`);
        }
      }
    }
    return;
  }

  if (i.type === 'transfer' || i.type === 'transfer_bulk') {
    const operations = i.type === 'transfer'
      ? [{ productId: d.productId, variants: d.variants }]
      : (Array.isArray(d.items) ? d.items : []);
    for (const op of operations) {
      const productId = op?.productId;
      for (const v of Array.isArray(op?.variants) ? op.variants : []) {
        const label = v?.variantLabel ?? v?.variant_label ?? '';
        if (!productId) continue;
        pendingInventoryKeys.add(`${productId}_${d.fromBranchId}_${label}`);
        pendingInventoryKeys.add(`${productId}_${d.toBranchId}_${label}`);
      }
    }
    return;
  }

  if (i.type === 'return' || i.type === 'return_complete') {
    const req = i.type === 'return'
      ? d
      : (state.returns || []).find((r: any) => r.id === d.id);
    if (!req) return;
    const originalTx = (state.transactions || []).find((tx: any) => tx.id === req.transactionId);
    const branchId = req.branchId || originalTx?.branchId;
    if (!branchId) return;
    const label = req.variantLabel || '';
    if (req.type === 'refund') {
      pendingInventoryKeys.add(`${req.productId}_${branchId}_${label}`);
    }
    if (req.type === 'warranty_exchange' && req.replacementProductId) {
      pendingInventoryKeys.add(`${req.replacementProductId}_${branchId}_`);
    }
    return;
  }

  if (i.type === 'supplier_receive') {
    const order = (state.supplierOrders || []).find((o: any) => o.id === d.id);
    for (const item of Array.isArray(order?.items) ? order.items : []) {
      pendingInventoryKeys.add(`${item.productId}_${order.branchId}_${item.variantLabel || ''}`);
    }
  }
});

// Si una operación todavía está pendiente, su snapshot local ya
// incluye el movimiento optimista. No basta con conservar la fila:
// debemos conservar también SU CANTIDAD para que un pull remoto
// retrasado no haga retroceder visualmente el inventario.
const localInventoryByKey = new Map<string, InventoryLevel>();
for (const localInv of state.inventory || []) {
  const key = `${localInv.productId}_${localInv.branchId}_${localInv.variantLabel || ''}`;
  if (pendingInventoryKeys.has(key)) localInventoryByKey.set(key, localInv);
}
for (const [key, localInv] of localInventoryByKey) {
  invMap.set(key, localInv);
}

let mergedInventory = Array.from(invMap.values()).filter(inv =>
  !inv.branchId || validBranchIds.has(inv.branchId)
);
if (data.inventory && data.inventory.length > 0) {
  const supabaseInvKeys = new Set(
    data.inventory.map((si: any) =>
      `${si.product_id || si.productId}_${si.branch_id || si.branchId}_${si.variant_label || si.variantLabel || ''}`
    )
  );
  mergedInventory = mergedInventory.filter(inv => {
    const key = `${inv.productId}_${inv.branchId}_${inv.variantLabel || ''}`;
    return supabaseInvKeys.has(key) || pendingInventoryKeys.has(key);
  });
}

// --- 7. Otros (Deduplicación simple por ID o clave única) ---
const pendingProductIds = new Set(getOfflineQueue().filter(i => i.type === 'product').map(i => i.data?.id).filter(Boolean));
 const pendingProductDeleteIds = new Set(getOfflineQueue().filter(i => i.type === 'product_delete').map(i => i.data?.id).filter(Boolean));
const pendingCategoryIds = new Set(getOfflineQueue().filter(i => i.type === 'category').map(i => i.data?.id).filter(Boolean));
const pendingCategoryDeleteIds = new Set(getOfflineQueue().filter(i => i.type === 'category_delete').map(i => i.data?.id).filter(Boolean));
const mergedProducts = mergeUnique(data.products, state.products || []);
// A successful remote snapshot may omit a newly-created offline product.
// Keep it until its durable product operation is confirmed remotely.
const finalProducts = (Array.isArray(data.products) && data.products.length > 0)
  ? mergedProducts.filter(p => !pendingProductDeleteIds.has(p.id) && (data.products.some((sp: any) => sp.id === p.id) || pendingProductIds.has(p.id)))
  : mergedProducts;

const mergedCategories = mergeUnique(data.categories, state.categories || []);
const finalCategories = (Array.isArray(data.categories) && data.categories.length > 0)
  ? mergedCategories.filter(c => !pendingCategoryDeleteIds.has(c.id) && (data.categories.some((sc: any) => sc.id === c.id) || pendingCategoryIds.has(c.id)))
  : mergedCategories.filter(c => !pendingCategoryDeleteIds.has(c.id));

const pendingUserIds = new Set(getOfflineQueue().filter(i => i.type === 'user').map(i => String(i.data?.id || i.actionId)));
const mergedUsers = mergeUnique(data.users, state.users || []);
// Conservar también usuarios creados/editados offline hasta que su
// operación durable sea confirmada por Supabase.
const finalUsers = (Array.isArray(data.users) && data.users.length > 0)
  ? mergedUsers.filter(u =>
      data.users.some((su: any) => su.id === u.id) ||
      pendingUserIds.has(String(u.id)) ||
      u.id.startsWith('admin-') ||
      u.id.startsWith('employee-')
    )
  : mergedUsers;

const mergedBankCards = replaceRemoteRecords(data.bankCards, state.bankCards || [], new Set(getOfflineQueue().filter(i => i.type === 'bank_card').map(i => String(i.data?.id || i.actionId))));
const mergedBankTransactions = replaceRemoteRecords(data.bankTransactions, state.bankTransactions || [], new Set(getOfflineQueue().filter(i => i.type === 'bank_transaction' || i.type === 'bank_transaction_delete' || i.type === 'bank_internal_transfer_delete').map(i => String(i.data?.id || i.data?.operationId || i.actionId))));
const supplierQueue = getOfflineQueue();
const pendingSupplierIds = new Set(supplierQueue.filter(i => i.type === 'supplier').map(i => String(i.data?.id || i.actionId)));
const deletedSupplierIds = new Set(supplierQueue.filter(i => i.type === 'supplier_delete').map(i => String(i.data?.id || i.actionId)));
const mergedSuppliers = replaceRemoteRecords(data.suppliers, state.suppliers || [], new Set([...pendingSupplierIds, ...deletedSupplierIds]));
const filteredSuppliers = mergedSuppliers.filter(s => !deletedSupplierIds.has(String(s.id)));
const mergedSupplierOrders = replaceRemoteRecords(data.supplierOrders, state.supplierOrders || [], new Set(getOfflineQueue().filter(i => i.type === 'supplier_order').map(i => String(i.data?.id || i.actionId))));
const mergedCurrencies = mergeUnique(data.currencies, state.currencies || [], { idKey: 'code' });
const pendingTransferIds = new Set<string>();
for (const q of getOfflineQueue()) {
  if (q.type === 'transfer') {
    pendingTransferIds.add(String(q.data?.id || q.data?.operationId || q.actionId));
  } else if (q.type === 'transfer_bulk') {
    for (const op of Array.isArray(q.data?.items) ? q.data.items : []) {
      if (op?.operationId) pendingTransferIds.add(String(op.operationId));
    }
  }
}
const mergedTransfers = replaceRemoteRecords(
  data.transfers,
  state.transfers || [],
  pendingTransferIds
);
const mergedWarranties = replaceRemoteRecords(data.warranties, state.warranties || [], new Set(getOfflineQueue().filter(i => i.type === 'warranty').map(i => String(i.data?.id || i.actionId))));
const mergedQuotes = replaceRemoteRecords(data.quotes, state.quotes || [], new Set(getOfflineQueue().filter(i => i.type === 'quote').map(i => String(i.data?.id || i.actionId))));
const mergedTimeShifts = replaceRemoteRecords(data.timeShifts, state.timeShifts || [], new Set(getOfflineQueue().filter(i => i.type === 'time_shift').map(i => String(i.data?.id || i.actionId))));
const mergedSalarySettlements = replaceRemoteRecords(data.salarySettlements, state.salarySettlements || [], new Set(getOfflineQueue().filter(i => i.type === 'salary_settlement').map(i => String(i.data?.id || i.actionId))));

const updatedCurrentUser = state.currentUser
  ? (finalUsers.find((u: any) => u.id === state.currentUser?.id) || state.currentUser)
  : null;

return {
  products: finalProducts,
  categories: finalCategories,
  inventory: mergedInventory,
  branches: finalBranches,
  currentBranchId: nextBranchId,
  users: finalUsers,
  currentUser: updatedCurrentUser,
  bankCards: mergedBankCards,
  bankTransactions: mergedBankTransactions,
  customers: mergedCustomers,
  suppliers: filteredSuppliers,
  supplierOrders: mergedSupplierOrders,
  currencies: mergedCurrencies,
  transactions: mergedTransactions,
  cashSessions: mergedCashSessions,
  transfers: mergedTransfers,
  warranties: mergedWarranties,
  returns: mergedReturns,
  quotes: mergedQuotes,
  timeShifts: mergedTimeShifts,
  salarySettlements: mergedSalarySettlements,
  receiptConfig: data.receiptConfig ? { ...state.receiptConfig, ...data.receiptConfig } : state.receiptConfig,
  storeConfig: data.storeConfig ? { ...state.storeConfig, ...data.storeConfig } : state.storeConfig,
  lastTurnNumber: data.lastTurnNumber !== undefined ? Math.max(state.lastTurnNumber, data.lastTurnNumber) : state.lastTurnNumber
};
}
