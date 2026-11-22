import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, ArrowDownLeft, PackageCheck, X } from "lucide-react";
import { cn } from "../../lib/utils";
import { ticketDisplay } from "../../lib/documentCodes";
import type { BankTransaction, ReturnItem, Transaction } from "../../types";
import { getRemainingVoidItems } from "../../store/utils/localVoidTransaction";

type Props = {
  transaction: Transaction;
  returns?: ReturnItem[];
  bankTransactions?: BankTransaction[];
  busy?: boolean;
  onCancel: () => void;
  onConfirm: (reason: string) => void | Promise<void>;
};

const QUICK_REASONS = [
  'Cobro duplicado',
  'Venta de prueba',
  'Error de cajero',
  'Cliente desistió',
];

const MIN_REASON_LENGTH = 3;

/**
 * Void confirmation for one sale. It states exactly which units will return to
 * stock (price already returned by a completed return is excluded) so the same
 * merchandise is never credited twice.
 *
 * Rendered in a portal (document.body) above every other Reports modal, with the
 * reason field first and the confirm footer pinned, so the operator always sees
 * where to type — including on small screens and when opened from the ticket
 * detail modal.
 */
export function ReportsVoidDialog({ transaction, returns = [], bankTransactions = [], busy = false, onCancel, onConfirm }: Props) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const reasonRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);

  // The reason is the only required input: focus it as soon as the dialog opens
  // so the operator does not have to hunt for the field.
  useEffect(() => {
    const timer = window.setTimeout(() => reasonRef.current?.focus({ preventScroll: true }), 30);
    return () => window.clearTimeout(timer);
  }, []);

  const restorable = useMemo(
    () => getRemainingVoidItems(transaction, returns).filter(item => Number(item.quantity) > 0),
    [transaction, returns],
  );
  const unitsToRestore = restorable.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
  const bankReversal = useMemo(() => {
    const received = bankTransactions.filter(bt =>
      [transaction.id, transaction.remoteId].includes(bt.transactionId) && bt.type === 'payment_received');
    return received.reduce((sum, bt) => sum + Number(bt.amount || 0), 0);
  }, [transaction, bankTransactions]);

  const reasonIsValid = reason.trim().length >= MIN_REASON_LENGTH;

  const submit = async () => {
    const trimmed = reason.trim();
    if (trimmed.length < MIN_REASON_LENGTH) {
      setError('Escribe el motivo de la eliminación: mínimo 3 caracteres.');
      reasonRef.current?.focus();
      return;
    }
    setError('');
    await onConfirm(trimmed.slice(0, 500));
  };

  return createPortal((
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-slate-950/70 p-2 sm:p-3"
      role="presentation"
      onMouseDown={event => { if (event.target === event.currentTarget && !busy) onCancel(); }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="reports-void-title"
        className="flex max-h-[calc(100dvh-1rem)] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-base bg-secondary shadow-2xl"
      >
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-base bg-rose-50/60 px-4 py-3 dark:bg-rose-950/30">
          <div className="min-w-0">
            <h2 id="reports-void-title" className="text-sm font-black text-primary">Eliminar venta</h2>
            <p className="mt-0.5 truncate text-[10px] font-bold uppercase tracking-wider text-muted">
              Ticket {ticketDisplay(transaction.ticketNumber, transaction.id)}
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-lg p-1.5 text-muted hover:bg-subtle disabled:opacity-50"
            aria-label="Cerrar"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-4 py-3 text-primary custom-scrollbar">
          <div>
            <label htmlFor="reports-void-reason" className="mb-1 block text-[11px] font-black uppercase tracking-widest text-muted">
              Motivo de la eliminación
            </label>
            <textarea
              id="reports-void-reason"
              ref={reasonRef}
              value={reason}
              onChange={event => { setReason(event.target.value); if (error) setError(''); }}
              onKeyDown={event => {
                if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) void submit();
              }}
              maxLength={500}
              rows={3}
              disabled={busy}
              placeholder="Obligatorio. Queda registrado en la auditoría de la venta."
              aria-invalid={error ? true : undefined}
              aria-describedby="reports-void-reason-hint"
              className="min-h-[88px] w-full resize-none rounded-xl border border-base bg-subtle px-3 py-2 text-xs font-bold text-primary outline-none focus-visible:ring-2 focus-visible:ring-rose-500/40 disabled:opacity-60"
            />
            <div className="mt-1.5 flex flex-wrap gap-1">
              {QUICK_REASONS.map(option => (
                <button
                  key={option}
                  type="button"
                  disabled={busy}
                  onClick={() => { setReason(option); setError(''); reasonRef.current?.focus(); }}
                  className="rounded-lg border border-base bg-subtle px-2 py-1 text-[9px] font-bold text-secondary hover:text-primary hover:bg-slate-200 dark:hover:bg-slate-800 disabled:opacity-50"
                >
                  {option}
                </button>
              ))}
            </div>
            {error ? (
              <p className="mt-1 text-[10px] font-bold text-rose-600 dark:text-rose-400" role="alert">{error}</p>
            ) : (
              <p id="reports-void-reason-hint" className="mt-1 text-[10px] font-bold text-muted">
                Mínimo 3 caracteres. Puedes elegir un motivo rápido o escribirlo.
              </p>
            )}
          </div>

          <p className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 p-2.5 text-[10px] font-bold leading-relaxed text-rose-900 dark:border-rose-900/60 dark:bg-rose-950/30 dark:text-rose-200">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            La venta se eliminará de todos los registros, los productos volverán al almacén donde se descontaron y se revertirán los cobros bancarios vinculados. Esta acción no se puede deshacer.
          </p>

          {bankReversal > 0 && (
            <p className="flex items-center gap-1.5 rounded-xl border border-blue-200 bg-blue-50 px-2.5 py-2 text-[10px] font-bold text-blue-900 dark:border-blue-900/60 dark:bg-blue-950/30 dark:text-blue-200">
              <ArrowDownLeft className="h-3.5 w-3.5 shrink-0" />
              Se retirarán {bankReversal.toLocaleString('es-CU')} de la cuenta bancaria que recibió el cobro.
            </p>
          )}

          <div>
            <p className="mb-1.5 flex items-center gap-1.5 text-[9px] font-black uppercase tracking-widest text-muted">
              <PackageCheck className="h-3 w-3" /> Inventario a reponer ({unitsToRestore} uds)
            </p>
            {restorable.length === 0 ? (
              <p className="rounded-xl border border-dashed border-base px-2.5 py-2 text-[10px] font-bold text-muted">
                Todas las unidades de esta venta ya fueron devueltas: al anular no se repone stock adicional.
              </p>
            ) : (
              <ul className="space-y-1">
                {restorable.map(item => {
                  const name = typeof item.product === 'string' ? item.product : item.product?.name || 'Producto';
                  return (
                    <li key={item.id} className="flex items-center justify-between rounded-lg border border-base bg-subtle px-2.5 py-1.5 text-[10px] font-bold">
                      <span className="min-w-0 truncate text-primary">
                        {name}
                        {item.variantLabel ? <span className="text-muted"> · {item.variantLabel}</span> : null}
                        {item.serialNumber ? <span className="text-muted"> · serie {item.serialNumber}</span> : null}
                      </span>
                      <span className="ml-2 shrink-0 font-black text-emerald-600">+{item.quantity}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>

        <footer className="sticky bottom-0 flex shrink-0 items-center justify-end gap-2 border-t border-base bg-subtle px-4 py-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-xl border border-base px-3.5 py-2 text-[10px] font-black uppercase tracking-wider text-secondary disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy}
            aria-disabled={!reasonIsValid}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-[10px] font-black uppercase tracking-wider text-white transition-colors disabled:opacity-60",
              reasonIsValid ? "bg-rose-600 hover:bg-rose-700" : "bg-rose-400/90 hover:bg-rose-500 dark:bg-rose-900/70",
            )}
          >
            {busy ? 'Eliminando…' : 'Confirmar y eliminar'}
          </button>
        </footer>
      </section>
    </div>
  ), document.body);
}
