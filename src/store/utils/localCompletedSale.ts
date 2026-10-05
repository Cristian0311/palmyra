import { generateReadableId } from '../../lib/utils';
import type { Transaction, InventoryLevel, Warranty } from '../../types';
import type { AppState } from '../storeTypes';

export type LocalCompletedSaleResult = Pick<AppState, 'transactions' | 'inventory' | 'warranties' | 'cart' | 'currentCustomerId'> & {
  generatedWarranties: Warranty[];
  alreadyExisted: boolean;
};

export function applyLocalCompletedSale(
  state: Pick<AppState, 'transactions' | 'inventory' | 'warranties' | 'customers' | 'cart' | 'currentCustomerId'>,
  transaction: Transaction
): LocalCompletedSaleResult {
  const existing = (state.transactions || []).find((t) => t.id === transaction.id && !t.deletedAt);
  if (existing) {
    return {
      transactions: (state.transactions || []).map((t) => t.id === transaction.id ? { ...t, ...transaction } : t),
      inventory: state.inventory,
      warranties: state.warranties,
      cart: [],
      currentCustomerId: undefined,
      generatedWarranties: [],
      alreadyExisted: true
    };
  }

  const generatedWarranties: Warranty[] = [];
  const updatedInventory = [...state.inventory];
  const finalItems = (transaction.items || []).map((item: any) => {
    if (!item) return item;
    const finalItem = { ...item };
    const prod = item.product;
    if (prod && typeof prod === 'object' && prod.warrantyDays && prod.warrantyDays > 0) {
      const expiryDate = new Date(transaction.date);
      expiryDate.setDate(expiryDate.getDate() + prod.warrantyDays);
      const customer = state.customers.find((c) => c.id === transaction.customerId);
      const wrnId = generateReadableId('GDA', state.warranties.length + generatedWarranties.length);
      generatedWarranties.push({
        id: wrnId,
        productId: prod.id,
        productName: prod.name,
        transactionId: transaction.id,
        customerId: transaction.customerId,
        customerName: customer?.name || 'Cliente Genérico',
        purchaseDate: transaction.date,
        expiryDate: expiryDate.toISOString(),
        serialNumber: item.serialNumber,
        status: 'active'
      });
      finalItem.warrantyCode = wrnId;
    }
    return finalItem;
  });

  const consume = (productId: string, qty: number, variantLabel?: string) => {
    if (!productId) return;
    const idx = updatedInventory.findIndex((item: InventoryLevel) =>
      item.productId === productId &&
      item.branchId === transaction.branchId &&
      (item.variantLabel || '') === (variantLabel || '')
    );
    if (idx !== -1) {
      updatedInventory[idx] = { ...updatedInventory[idx], quantity: Math.max(0, updatedInventory[idx].quantity - qty) };
    }
  };

  (transaction.items || []).forEach((item: any) => {
    if (!item) return;
    const prod = item.product;
    if (!prod) return;
    if (typeof prod === 'object' && prod.isKit && Array.isArray(prod.kitComponents)) {
      prod.kitComponents.forEach((component: any) => consume(component.productId, component.quantity * (item.quantity || 1)));
    } else if (typeof prod === 'object') {
      consume(prod.id, item.quantity || 1, item.variantLabel);
    } else if (typeof prod === 'string') {
      consume(prod, item.quantity || 1, item.variantLabel);
    }
  });

  return {
    transactions: [{ ...transaction, items: finalItems }, ...state.transactions.filter((t) => t.id !== transaction.id)],
    inventory: updatedInventory,
    warranties: [...generatedWarranties, ...state.warranties],
    cart: [],
    currentCustomerId: undefined,
    generatedWarranties,
    alreadyExisted: false
  };
}
