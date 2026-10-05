import { generateReadableId } from '../../lib/utils';
import type { CartItem, Customer, InventoryLevel, Transaction, Warranty } from '../../types';

export function buildLocalCompletedSalePatch(
  state: {
    transactions: Transaction[];
    inventory: InventoryLevel[];
    warranties: Warranty[];
    customers: Customer[];
  },
  transaction: Transaction
): {
  transactions: Transaction[];
  inventory: InventoryLevel[];
  warranties: Warranty[];
  generatedWarranties: Warranty[];
} {
  const existing = state.transactions.find((item) => item.id === transaction.id && !item.deletedAt);
  if (existing) {
    return {
      transactions: state.transactions.map((item) => item.id === transaction.id ? { ...item, ...transaction } : item),
      inventory: state.inventory,
      warranties: state.warranties,
      generatedWarranties: []
    };
  }

  const generatedWarranties: Warranty[] = [];
  const updatedInventory = [...state.inventory];

  const finalItems = (transaction.items || []).map((item: CartItem) => {
    if (!item) return item;
    const finalItem = { ...item };
    const prod = item.product;
    if (prod && prod.warrantyDays && prod.warrantyDays > 0) {
      const expiryDate = new Date(transaction.date);
      expiryDate.setDate(expiryDate.getDate() + prod.warrantyDays);
      const customer = state.customers.find((customer) => customer.id === transaction.customerId);
      const warrantyId = generateReadableId('GDA', state.warranties.length + generatedWarranties.length);
      generatedWarranties.push({
        id: warrantyId,
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
      finalItem.warrantyCode = warrantyId;
    }
    return finalItem;
  });

  const consume = (productId: string, qty: number, variantLabel?: string) => {
    if (!productId) return;
    const idx = updatedInventory.findIndex((item) =>
      item.productId === productId &&
      item.branchId === transaction.branchId &&
      (item.variantLabel || '') === (variantLabel || '')
    );
    if (idx !== -1) {
      updatedInventory[idx] = { ...updatedInventory[idx], quantity: Math.max(0, updatedInventory[idx].quantity - qty) };
    }
  };

  for (const item of transaction.items || []) {
    if (!item?.product) continue;
    const prod = item.product;
    if (typeof prod === 'object' && prod.isKit && Array.isArray(prod.kitComponents)) {
      for (const component of prod.kitComponents) {
        consume(component.productId, component.quantity * (item.quantity || 1));
      }
    } else if (typeof prod === 'object') {
      consume(prod.id, item.quantity || 1, item.variantLabel);
    } else if (typeof prod === 'string') {
      consume(prod, item.quantity || 1, item.variantLabel);
    }
  }

  return {
    transactions: [{ ...transaction, items: finalItems }, ...state.transactions.filter((item) => item.id !== transaction.id)],
    inventory: updatedInventory,
    warranties: [...generatedWarranties, ...state.warranties],
    generatedWarranties
  };
}
