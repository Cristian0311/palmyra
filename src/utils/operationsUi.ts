import type { BankCard, BankTransaction, SupplierOrder } from '../types';

export function selectBankTransactions(transactions: readonly BankTransaction[], cardId: string | null, query = '', direction = 'all') {
  const term = query.trim().toLocaleLowerCase('es');
  return transactions.filter(transaction => {
    const income = transaction.type === 'deposit' || transaction.type === 'payment_received';
    return (!cardId || transaction.cardId === cardId)
      && (direction === 'all' || (direction === 'income' ? income : !income))
      && (!term || `${transaction.reference || ''} ${transaction.description || ''}`.toLocaleLowerCase('es').includes(term));
  }).sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
}

export function validateBankTransfer(from: BankCard | undefined, to: BankCard | undefined, amount: number, external: boolean): string | null {
  if (!from || from.isActive === false) return 'Selecciona una cuenta de origen activa.';
  if (!Number.isFinite(amount) || amount <= 0) return 'Introduce un monto mayor que cero.';
  if (from.balance < amount) return 'Saldo insuficiente en la cuenta de origen.';
  if (!external && (!to || to.isActive === false || from.id === to.id)) return 'Selecciona otra cuenta activa como destino.';
  return null;
}

// Shared across mounts. No stock writes: receipt remains owned by the existing store/RPC.
const pendingOrderActions = new Set<string>();
export async function runPendingOrderAction(
  id: string,
  readOrder: () => SupplierOrder | undefined,
  hasQueuedReceipt: () => boolean,
  action: () => Promise<unknown> | unknown,
): Promise<boolean> {
  if (pendingOrderActions.has(id) || readOrder()?.status !== 'pending' || hasQueuedReceipt()) return false;
  pendingOrderActions.add(id);
  try { await action(); return true; }
  finally { pendingOrderActions.delete(id); }
}
