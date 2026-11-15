import { useCallback, useEffect, useState } from 'react';
import type { Transaction } from '../../../types';
import { callSetSaleReportHiddenRPC } from '../../../services/supabaseSync/rpc';

/**
 * Reports visibility (hide / restore a ticket inside Reports).
 *
 * The server is the source of truth: the flag lives in
 * `sales.metadata.report_visibility` and is written through
 * `palmyra_set_sale_report_hidden`. The local list keeps the UI responsive when
 * the device is offline and mirrors the last known server state.
 *
 * Hiding a ticket NEVER voids the sale, its payments or its stock movements.
 */
const STORAGE_KEY = 'palmyra:hidden-sales-report-ids:v2';

type Notify = (message: string, type?: 'success' | 'error' | 'warning' | 'info', details?: string) => void;

function readLocalHiddenIds(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

export function useReportVisibility(transactions: Transaction[], addNotification: Notify) {
  const [hiddenReportIds, setHiddenReportIds] = useState<string[]>(readLocalHiddenIds);

  const writeHiddenReportIds = useCallback((ids: string[]) => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(ids)); } catch { /* caché opcional */ }
    setHiddenReportIds(ids);
  }, []);

  // Reconcile with Supabase: add tickets hidden on another device and drop the
  // ones explicitly restored elsewhere.
  useEffect(() => {
    const hiddenRemote = transactions.filter(tx => tx.reportHidden).map(tx => tx.id);
    const restoredRemote = transactions.filter(tx => !tx.reportHidden && tx.reportHiddenAt).map(tx => tx.id);
    if (!hiddenRemote.length && !restoredRemote.length) return;
    setHiddenReportIds(prev => {
      const next = Array.from(new Set([...prev, ...hiddenRemote])).filter(id => !restoredRemote.includes(id));
      const changed = next.length !== prev.length || next.some((id, index) => id !== prev[index]);
      if (!changed) return prev;
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* caché opcional */ }
      return next;
    });
  }, [transactions]);

  const pushReportVisibility = useCallback(async (transaction: Transaction, hidden: boolean) => (
    callSetSaleReportHiddenRPC(transaction.remoteId || transaction.id, hidden)
  ), []);

  const hideTransactionReport = useCallback(async (transaction: Transaction) => {
    writeHiddenReportIds(Array.from(new Set([...hiddenReportIds, transaction.id])));
    const result = await pushReportVisibility(transaction, true);
    addNotification(
      result.success
        ? 'Ticket ocultado de la lista de reportes en todos los dispositivos. La venta, el cobro y el inventario permanecen intactos.'
        : `Ticket ocultado solo en este dispositivo. ${result.error || 'No se pudo guardar en la nube.'} La venta sigue intacta.`,
      result.success ? 'success' : 'warning',
    );
  }, [hiddenReportIds, addNotification, writeHiddenReportIds, pushReportVisibility]);

  const restoreTransactionReport = useCallback(async (transaction: Transaction) => {
    writeHiddenReportIds(hiddenReportIds.filter(id => id !== transaction.id));
    const result = await pushReportVisibility(transaction, false);
    addNotification(
      result.success
        ? 'Ticket restaurado en la lista de reportes. La venta original no fue modificada.'
        : `Ticket restaurado solo en este dispositivo. ${result.error || 'No se pudo guardar en la nube.'}`,
      result.success ? 'success' : 'warning',
    );
  }, [hiddenReportIds, addNotification, writeHiddenReportIds, pushReportVisibility]);

  return { hiddenReportIds, hideTransactionReport, restoreTransactionReport };
}
