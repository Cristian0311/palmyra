import type { BankCard, BankTransaction, InventoryLevel, Transaction } from '../../types';

export function buildLocalVoidTransactionPatch(
  state: { inventory: InventoryLevel[]; bankTransactions: BankTransaction[]; bankCards: BankCard[] },
  transaction: Transaction
): { inventory: InventoryLevel[]; bankTransactions: BankTransaction[]; bankCards: BankCard[] } {
  const updatedInventory = [...state.inventory];
  const restore = (productId: string, qty: number, variantLabel?: string) => {
    if (!productId) return;
    const idx = updatedInventory.findIndex((item) =>
      item.productId === productId &&
      item.branchId === transaction.branchId &&
      (item.variantLabel || '') === (variantLabel || '')
    );
    if (idx !== -1) {
      updatedInventory[idx] = { ...updatedInventory[idx], quantity: updatedInventory[idx].quantity + qty };
    }
  };

  for (const item of transaction.items || []) {
    if (!item?.product) continue;
    const prod = item.product;
    if (typeof prod === 'object' && prod.isKit && Array.isArray(prod.kitComponents)) {
      for (const component of prod.kitComponents) {
        restore(component.productId, component.quantity * (item.quantity || 1));
      }
    } else if (typeof prod === 'object') {
      restore(prod.id, item.quantity || 1, item.variantLabel);
    } else if (typeof prod === 'string') {
      restore(prod, item.quantity || 1, item.variantLabel);
    }
  }

  const bankToReverse = state.bankTransactions.filter(
    (bt) => bt.transactionId === transaction.id && bt.type === 'payment_received'
  );

  const bankCards = state.bankCards.map((card) => {
    const amount = bankToReverse
      .filter((bt) => bt.cardId === card.id)
      .reduce((sum, bt) => sum + Number(bt.amount || 0), 0);
    return amount > 0
      ? { ...card, balance: Math.max(0, Number(card.balance || 0) - amount) }
      : card;
  });

  const bankTransactions = state.bankTransactions.filter(
    (bt) => !(bt.transactionId === transaction.id && bt.type === 'payment_received')
  );

  return { inventory: updatedInventory, bankTransactions, bankCards };
}
