import type { Transaction, InventoryLevel, BankCard, BankTransaction } from '../../types';
import type { AppState } from '../storeTypes';

export function applyLocalVoidTransaction(
  state: Pick<AppState, 'inventory' | 'bankTransactions' | 'bankCards'>,
  transaction: Transaction
): Pick<AppState, 'inventory' | 'bankTransactions' | 'bankCards'> {
  const updatedInventory = [...state.inventory];
  const restore = (productId: string, qty: number, variantLabel?: string) => {
    if (!productId) return;
    const idx = updatedInventory.findIndex((item: InventoryLevel) =>
      item.productId === productId &&
      item.branchId === transaction.branchId &&
      (item.variantLabel || '') === (variantLabel || '')
    );
    if (idx !== -1) {
      updatedInventory[idx] = { ...updatedInventory[idx], quantity: updatedInventory[idx].quantity + qty };
    }
  };

  (transaction.items || []).forEach((item: any) => {
    if (!item) return;
    const prod = item.product;
    if (!prod) return;
    if (typeof prod === 'object' && prod.isKit && Array.isArray(prod.kitComponents)) {
      prod.kitComponents.forEach((component: any) =>
        restore(component.productId, component.quantity * (item.quantity || 1))
      );
    } else if (typeof prod === 'object') {
      restore(prod.id, item.quantity || 1, item.variantLabel);
    } else if (typeof prod === 'string') {
      restore(prod, item.quantity || 1, item.variantLabel);
    }
  });

  const bankToReverse = (state.bankTransactions || []).filter(
    (bt: BankTransaction) => bt.transactionId === transaction.id && bt.type === 'payment_received'
  );

  const updatedBankCards = (state.bankCards || []).map((card: BankCard) => {
    const amount = bankToReverse
      .filter((bt) => bt.cardId === card.id)
      .reduce((sum, bt) => sum + Number(bt.amount || 0), 0);
    return amount > 0
      ? { ...card, balance: Math.max(0, Number(card.balance || 0) - amount) }
      : card;
  });

  const remainingBankTransactions = (state.bankTransactions || []).filter(
    (bt) => !(bt.transactionId === transaction.id && bt.type === 'payment_received')
  );

  return {
    inventory: updatedInventory,
    bankTransactions: remainingBankTransactions,
    bankCards: updatedBankCards
  };
}
