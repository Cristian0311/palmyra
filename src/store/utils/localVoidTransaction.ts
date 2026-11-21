import type { BankCard, BankTransaction, InventoryLevel, ReturnItem, Transaction, User } from '../../types';

export function canVoidSales(user: User | null | undefined, branchId: string): boolean {
  if (!user || user.isActive === false) return false;
  if (user.role === 'admin') return true;
  const branches = user.allowedWarehouseIds || user.allowedBranches || [user.warehouseId || user.branchId];
  return !!user.permissions?.includes('sales.refund') && branches.includes(branchId);
}

export function getRemainingVoidItems(transaction: Transaction, returns: ReturnItem[] = []) {
  const returned = new Map<string, number>();
  const key = (id: string, variant?: string) => JSON.stringify([id, variant || '']);
  for (const item of returns) {
    if (![transaction.id, transaction.remoteId].includes(item.transactionId) || item.status !== 'completed') continue;
    const k = key(item.productId, item.variantLabel);
    returned.set(k, (returned.get(k) || 0) + Math.max(0, Number(item.quantity) || 0));
  }
  return (transaction.items || []).map(item => {
    const productId = typeof item.product === 'string' ? item.product : item.product?.id;
    const k = key(productId, item.variantLabel);
    const quantity = Math.max(0, Number(item.quantity) || 0);
    const alreadyReturned = Math.min(quantity, returned.get(k) || 0);
    returned.set(k, Math.max(0, (returned.get(k) || 0) - alreadyReturned));
    return { ...item, quantity: quantity - alreadyReturned };
  });
}

type VoidState = {
  transactions: Transaction[];
  inventory: InventoryLevel[];
  bankTransactions: BankTransaction[];
  bankCards: BankCard[];
  returns?: ReturnItem[];
};

type VoidOptions = {
  /** Set to false when the server already reversed the bank and the local copy will be refreshed. */
  reverseBank?: boolean;
};

/** One atomic patch: the tombstone and restored quantities must be persisted together. */
export function buildLocalVoidTransactionPatch(
  state: VoidState,
  transaction: Transaction,
  audit = { userId: transaction.deletedBy || '', reason: transaction.deleteReason || 'Anulación', date: new Date().toISOString() },
  options: VoidOptions = {},
): Pick<VoidState, 'transactions' | 'inventory' | 'bankTransactions' | 'bankCards'> {
  const current = state.transactions.find(tx => tx.id === transaction.id);
  const unchanged = { transactions: state.transactions, inventory: state.inventory, bankTransactions: state.bankTransactions, bankCards: state.bankCards };
  if (!current || current.deletedAt || current.status === 'refunded') return unchanged;
  const inventory = [...state.inventory];
  const restore = (productId: string, qty: number, variantLabel?: string) => {
    if (!productId || qty <= 0) return;
    const index = inventory.findIndex(item => item.productId === productId && item.branchId === current.branchId && (item.variantLabel || '') === (variantLabel || ''));
    if (index >= 0) inventory[index] = { ...inventory[index], quantity: inventory[index].quantity + qty };
    else inventory.push({ productId, branchId: current.branchId, quantity: qty, minQuantity: 0, ...(variantLabel ? { variantLabel } : {}) });
  };
  for (const item of getRemainingVoidItems(current, state.returns)) {
    const product = item.product;
    if (typeof product === 'object' && product?.isKit && Array.isArray(product.kitComponents)) {
      for (const component of product.kitComponents) restore(component.productId, component.quantity * item.quantity);
    } else {
      restore(typeof product === 'string' ? product : product?.id, item.quantity, item.variantLabel);
    }
  }

  // Keep the original bank receipt for audit. Append one deterministic reversal.
  const receipts = state.bankTransactions.filter(bt =>
    [current.id, current.remoteId].includes(bt.transactionId) && bt.type === 'payment_received');
  const paidByCard = new Map<string, number>();
  for (const r of state.returns || []) {
    if ([current.id, current.remoteId].includes(r.transactionId) && r.refundStatus === 'paid' && r.refundMethod === 'transfer' && r.refundBankCardId) {
      paidByCard.set(r.refundBankCardId, (paidByCard.get(r.refundBankCardId) || 0) + (Number(r.refundAmount) || 0));
    }
  }
  const reversals: BankTransaction[] = [];
  const bankCards = options.reverseBank === false ? state.bankCards : state.bankCards.map(card => {
    const received = receipts.filter(bt => bt.cardId === card.id).reduce((sum, bt) => sum + Number(bt.amount || 0), 0);
    const amount = Math.max(0, received - (paidByCard.get(card.id) || 0));
    const id = `void:${current.id}:${card.id}`;
    if (!amount || state.bankTransactions.some(bt => bt.id === id)) return card;
    if (Number(card.balance || 0) < amount) throw new Error('Saldo bancario insuficiente para anular. No se modificó la venta.');
    reversals.push({ id, cardId: card.id, type: 'withdrawal', amount, date: audit.date, transactionId: current.id, reference: id, description: `Anulación: ${audit.reason}` });
    return { ...card, balance: Number(card.balance || 0) - amount };
  });
  return {
    inventory,
    bankCards,
    bankTransactions: [...state.bankTransactions, ...reversals],
    transactions: state.transactions.map(tx => tx.id === current.id ? { ...tx, deletedAt: audit.date, deletedBy: audit.userId, deleteReason: audit.reason } : tx),
  };
}

/**
 * Applies the per-sale patch to a whole set of sales (e.g. cancelling a shift).
 * Each sale is skipped when it is already voided, so replaying the same shift
 * never returns the same units twice.
 */
export function buildLocalVoidTransactionsPatch(
  state: VoidState,
  transactions: Transaction[],
  audit: { userId: string; reason: string; date: string },
  options: VoidOptions = {},
): Pick<VoidState, 'transactions' | 'inventory' | 'bankTransactions' | 'bankCards'> {
  let next = state;
  for (const transaction of transactions) {
    next = { ...next, ...buildLocalVoidTransactionPatch(next, transaction, audit, options) };
  }
  return {
    transactions: next.transactions,
    inventory: next.inventory,
    bankCards: next.bankCards,
    bankTransactions: next.bankTransactions,
  };
}
