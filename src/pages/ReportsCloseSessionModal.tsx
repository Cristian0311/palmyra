import { useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle, ArrowDownRight, ArrowUpRight, CheckCircle, CheckCircle2, Loader2, X,
} from "lucide-react";
import { cn } from "../lib/utils";
import type { Currency, Transaction } from "../types";
import { calculateExpectedBalances } from "../services/cash/expectedCash";
import { getSessionTurnLabel } from "../modules/reports/utils/sessionTurnLabels";

type ModalProps = {
  baseCurrency: Currency;
  branches: { id: string; name: string }[];
  currencies: Currency[];
  formatMoney: (amount: number, code?: string) => string;
  isClosingShiftFromReports: boolean;
  sessionClosingBalances: { [key: string]: number };
  sessionClosingDateInput: string;
  sessionClosingNotesInput: string;
  sessionToCloseModal: any;
  sessionTurnMap: Map<string, number | string>;
  setIsClosingShiftFromReports: (value: boolean) => void;
  setSessionClosingBalances: (updater: (prev: { [key: string]: number }) => { [key: string]: number }) => void;
  setSessionClosingDateInput: (value: string) => void;
  setSessionClosingNotesInput: (value: string) => void;
  setSessionToCloseModal: (session: any) => void;
  store: any;
  transactions: Transaction[];
};

const labelStyle = { fontSize: 11, letterSpacing: '0.06em' } as const;

export default function ReportsCloseSessionModal({
  baseCurrency,
  branches,
  currencies,
  formatMoney,
  isClosingShiftFromReports,
  sessionClosingBalances,
  sessionClosingDateInput,
  sessionClosingNotesInput,
  sessionToCloseModal,
  sessionTurnMap,
  setIsClosingShiftFromReports,
  setSessionClosingBalances,
  setSessionClosingDateInput,
  setSessionClosingNotesInput,
  setSessionToCloseModal,
  store,
  transactions,
}: ModalProps) {
  const expectedRows = useMemo(() => {
    if (!sessionToCloseModal) return [];
    return calculateExpectedBalances(sessionToCloseModal, transactions, baseCurrency);
  }, [sessionToCloseModal, transactions, baseCurrency]);

  const sessionTxs = useMemo(() => {
    if (!sessionToCloseModal) return [];
    return transactions.filter(tx => {
      if (tx.status !== 'completed' || tx.deletedAt) return false;
      if (String(tx.notes || '').startsWith('AJUSTE_')) return false;
      if (tx.sessionId) return tx.sessionId === sessionToCloseModal.id;
      if (tx.branchId !== sessionToCloseModal.branchId) return false;
      const txTime = new Date(tx.date).getTime();
      return txTime >= new Date(sessionToCloseModal.openedAt).getTime() &&
        (!sessionToCloseModal.closedAt || txTime <= new Date(sessionToCloseModal.closedAt).getTime());
    });
  }, [transactions, sessionToCloseModal]);

  // Escape cancels the close-shift modal unless the operation is already running.
  useEffect(() => {
    if (!sessionToCloseModal) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isClosingShiftFromReports) setSessionToCloseModal(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sessionToCloseModal, isClosingShiftFromReports, setSessionToCloseModal]);

  if (!sessionToCloseModal) return null;

  const totalSales = sessionTxs.reduce((sum, tx) => sum + (tx.total || 0), 0);

  const differenceRows = currencies.flatMap(c => (['cash', 'transfer'] as const).map(method => {
    const expectedRow = expectedRows.find(r => r.currencyCode === c.code && r.method === method);
    const expected = expectedRow?.amount || 0;
    const declared = sessionClosingBalances[`${c.code}-${method}`];
    if (typeof declared !== 'number') return null;
    const difference = declared - expected;
    if (Math.abs(difference) <= 0.01) return null;
    return { currencyCode: c.code, method, expected, actual: declared, difference, rate: c.rateToBase || 1 };
  })).filter((row): row is NonNullable<typeof row> => Boolean(row));

  const shortageBase = differenceRows.filter(r => r.difference < 0).reduce((sum, r) => sum + Math.abs(r.difference) * r.rate, 0);
  const overageBase = differenceRows.filter(r => r.difference > 0).reduce((sum, r) => sum + r.difference * r.rate, 0);
  const hasDifference = differenceRows.length > 0;
  const pendingInputs = expectedRows.filter(row =>
    Math.abs(row.amount) > 0.01 && typeof sessionClosingBalances[`${row.currencyCode}-${row.method}`] !== 'number'
  );

  const setBalance = (key: string, raw: string) => {
    const value = parseFloat(raw);
    setSessionClosingBalances(prev => ({ ...prev, [key]: Number.isFinite(value) && value > 0 ? value : 0 }));
  };

  const handleConfirm = async () => {
    setIsClosingShiftFromReports(true);
    try {
      const balancesArray: import('../types').Payment[] = Object.entries(sessionClosingBalances)
        .filter(([, amount]) => (amount as number) > 0)
        .map(([key, amount]) => {
          const [currCode, method] = key.split('-');
          const currency = currencies.find(c => c.code === currCode);
          return {
            currencyCode: currCode as Currency['code'],
            amount: amount as number,
            exchangeRate: currency?.rateToBase || 1,
            method: (method || 'cash') as 'cash' | 'transfer',
          };
        });

      let finalClosingDate = new Date().toISOString();
      if (sessionClosingDateInput) {
        const parts = sessionClosingDateInput.split('-');
        if (parts.length === 3) {
          finalClosingDate = new Date(`${sessionClosingDateInput}T12:00:00-04:00`).toISOString();
        }
      }

      const res = await store.forceCloseSessionFromReports(
        sessionToCloseModal.id,
        balancesArray,
        finalClosingDate,
        sessionClosingNotesInput
      );

      if (res.success) {
        const turnLabel = getSessionTurnLabel(sessionToCloseModal, sessionTurnMap);
        if (res.pending) {
          store.addNotification(
            `${turnLabel} cerrado en este dispositivo. Quedó guardado para sincronizarse cuando la nube responda.`,
            'info',
          );
        } else {
          store.addNotification(
            hasDifference
              ? `${turnLabel} cerrado. El descuadre quedó registrado para conciliación.`
              : `${turnLabel} cerrado. La caja cuadra con lo esperado.`,
            'success',
          );
        }
        setSessionToCloseModal(null);
      } else {
        store.addNotification(res.error || 'No se pudo cerrar el turno.', 'error');
      }
    } catch (err: any) {
      store.addNotification(err.message || 'Error al cerrar turno', 'error');
    } finally {
      setIsClosingShiftFromReports(false);
    }
  };

  return createPortal((
    <div className="palmyra-overlay z-[var(--z-confirm)] flex items-center justify-center p-2 sm:p-4" role="presentation">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="close-session-title"
        className="palmyra-modal-panel palmyra-mobile-modal flex w-full max-w-2xl flex-col overflow-hidden animate-in zoom-in-95"
      >
        <header className="flex items-start justify-between gap-3 border-b border-base px-4 py-3.5">
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-[#6535C5] to-indigo-600 text-white shadow-sm">
              <CheckCircle size={22} aria-hidden="true" />
            </span>
            <div>
              <h2 id="close-session-title" className="font-black uppercase text-primary" style={{ fontSize: 14 }}>
                Cerrar Turno desde Reportes
              </h2>
              <p className="font-bold text-muted uppercase" style={{ fontSize: 10 }}>
                {getSessionTurnLabel(sessionToCloseModal, sessionTurnMap)} · {sessionToCloseModal.workerName || 'Vendedor'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setSessionToCloseModal(null)}
            aria-label="Cancelar cierre de turno"
            className="flex h-11 w-11 items-center justify-center rounded-xl border border-base bg-secondary text-muted transition-colors hover:bg-subtle hover:text-primary"
          >
            <X size={20} />
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-3.5 overflow-y-auto px-4 py-4">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              { label: 'Sucursal', value: branches.find(b => b.id === sessionToCloseModal.branchId)?.name || 'Central' },
              { label: 'Apertura', value: new Date(sessionToCloseModal.openedAt).toLocaleString('es-CU', { timeZone: 'America/Havana', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) },
              { label: 'Fondo inicial', value: formatMoney(sessionToCloseModal.openingBalance) },
              { label: 'Ventas acumuladas', value: formatMoney(totalSales) },
            ].map(item => (
              <div key={item.label} className="rounded-xl border border-base bg-subtle p-2.5">
                <span className="font-black uppercase text-muted" style={{ fontSize: 9 }}>{item.label}</span>
                <p className="mt-0.5 truncate font-black text-primary" style={{ fontSize: 12 }} title={item.value}>{item.value}</p>
              </div>
            ))}
          </div>

          <div>
            <label className="mb-1.5 block font-black uppercase text-muted" style={{ fontSize: 10, letterSpacing: '0.06em' }}>
              Fecha oficial de cierre
            </label>
            <input
              type="date"
              value={sessionClosingDateInput}
              onChange={(e) => setSessionClosingDateInput(e.target.value)}
              className="min-h-11 w-full rounded-xl border border-base bg-subtle px-3 font-bold text-primary outline-none focus:border-[#6535C5] focus:ring-2 focus:ring-[#6535C5]/20"
              style={{ fontSize: 13 }}
            />
          </div>

          <div className="rounded-2xl border border-base bg-subtle p-3">
            <h3 className="font-black uppercase text-primary" style={{ fontSize: 11, letterSpacing: '0.06em' }}>
              Arqueo declarado al cierre
            </h3>
            <p className="mt-0.5 font-bold text-muted" style={{ fontSize: 11 }}>
              Escribe lo que realmente hay en caja y en las cuentas de transferencia. Comparamos cada moneda con lo que el sistema espera.
            </p>

            <div className="mt-2.5 space-y-2">
              {currencies.map(currency => (
                <div key={currency.code} className="rounded-xl border border-base bg-secondary p-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-1.5 font-black text-primary" style={{ fontSize: 12 }}>
                      <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-[#6535C5]/10 font-black text-[#6535C5] dark:text-violet-300" style={{ fontSize: 9 }}>
                        {currency.code}
                      </span>
                      {currency.name}
                    </span>
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    {([
                      { method: 'cash' as const, label: 'Efectivo', icon: ArrowDownRight },
                      { method: 'transfer' as const, label: 'Transferencia', icon: ArrowUpRight },
                    ]).map(({ method, label }) => {
                      const key = `${currency.code}-${method}`;
                      const expected = expectedRows.find(r => r.currencyCode === currency.code && r.method === method)?.amount || 0;
                      const declared = sessionClosingBalances[key];
                      const difference = typeof declared === 'number' ? declared - expected : 0;
                      return (
                        <label key={method} className="block">
                          <span className="flex min-w-0 items-center justify-between gap-1 font-black uppercase text-muted" style={{ fontSize: 9 }}>
                            <span className="shrink-0">{label}</span>
                            <span className="min-w-0 truncate font-bold normal-case text-muted" style={{ fontSize: 9 }}>
                              Esperado {formatMoney(expected, currency.code)}
                            </span>
                          </span>
                          <input
                            type="number"
                            min={0}
                            step={currency.code === 'CUP' ? '1' : '0.01'}
                            inputMode="decimal"
                            placeholder="0"
                            value={declared ?? ''}
                            onChange={(e) => setBalance(key, e.target.value)}
                            className={cn(
                              "mt-1 min-h-11 w-full rounded-xl border bg-primary px-2.5 text-right font-black font-mono text-primary outline-none focus:ring-2",
                              typeof declared === 'number' && Math.abs(difference) > 0.01
                                ? 'border-amber-400 focus:border-amber-500 focus:ring-amber-500/20'
                                : 'border-base focus:border-[#6535C5] focus:ring-[#6535C5]/20'
                            )}
                            style={{ fontSize: 14 }}
                          />
                          {typeof declared === 'number' && Math.abs(difference) > 0.01 && (
                            <span
                              className={cn('mt-0.5 block font-black', difference < 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400')}
                              style={{ fontSize: 10 }}
                            >
                              {difference < 0 ? 'Faltan' : 'Sobran'} {formatMoney(Math.abs(difference), currency.code)}
                            </span>
                          )}
                        </label>
                      );
                    })}
                  </div>
                </div>
              ))}

              {currencies.length === 0 && (
                <p className="font-bold text-muted" style={{ fontSize: 11 }}>No hay monedas configuradas.</p>
              )}
            </div>
          </div>

          {hasDifference ? (
            <div className="rounded-2xl border border-amber-300 bg-amber-50/70 p-3 dark:border-amber-900/60 dark:bg-amber-950/30">
              <div className="flex items-start gap-2">
                <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
                <div className="space-y-1">
                  <p className="font-black text-amber-900 dark:text-amber-200" style={{ fontSize: 12 }}>
                    Este cierre tiene una diferencia
                  </p>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 font-bold text-amber-900/90 dark:text-amber-200/90" style={{ fontSize: 11 }}>
                    {shortageBase > 0.01 && <span className="text-red-700 dark:text-red-300">Faltante: {formatMoney(shortageBase, baseCurrency.code)}</span>}
                    {overageBase > 0.01 && <span className="text-emerald-700 dark:text-emerald-300">Sobrante: {formatMoney(overageBase, baseCurrency.code)}</span>}
                  </div>
                  <p className="font-bold text-amber-900/80 dark:text-amber-200/80" style={{ fontSize: 11 }}>
                    El turno se cerrará y aparecerá en <strong>Descuadres</strong> para documentar la causa y conciliar la caja.
                  </p>
                </div>
              </div>
            </div>
          ) : pendingInputs.length > 0 ? (
            <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50/70 p-2.5 dark:border-amber-900/60 dark:bg-amber-950/30">
              <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
              <p className="font-bold text-amber-900 dark:text-amber-200" style={{ fontSize: 11 }}>
                Aún falta declarar {pendingInputs.length} monto{pendingInputs.length === 1 ? '' : 's'} con movimiento esperado
                ({pendingInputs.map(row => `${row.currencyCode} ${row.method === 'cash' ? 'efectivo' : 'transferencia'}`).join(', ')}).
                Si lo dejas en blanco se registrará como faltante.
              </p>
            </div>
          ) : differenceRows.length === 0 && Object.values(sessionClosingBalances).some(v => Number(v) > 0) ? (
            <div className="flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50/70 p-2.5 dark:border-emerald-900/60 dark:bg-emerald-950/30">
              <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
              <p className="font-bold text-emerald-800 dark:text-emerald-200" style={{ fontSize: 11 }}>
                Lo declarado coincide con lo esperado por el sistema. El turno se cerrará sin descuadre.
              </p>
            </div>
          ) : null}

          <label className="block">
            <span className="mb-1 block font-black uppercase text-muted" style={{ fontSize: 10, letterSpacing: '0.06em' }}>
              Notas de cierre (opcional)
            </span>
            <input
              type="text"
              placeholder="Ej: Cierre verificado por administrador"
              value={sessionClosingNotesInput}
              onChange={(e) => setSessionClosingNotesInput(e.target.value)}
              className="min-h-11 w-full rounded-xl border border-base bg-subtle px-3 font-bold text-primary outline-none focus:border-[#6535C5] focus:ring-2 focus:ring-[#6535C5]/20"
              style={{ fontSize: 12 }}
            />
          </label>
        </div>

        <footer className="flex flex-wrap gap-2 border-t border-base bg-subtle px-4 py-3">
          <button
            type="button"
            onClick={() => setSessionToCloseModal(null)}
            disabled={isClosingShiftFromReports}
            className="min-h-11 flex-1 rounded-xl border border-base bg-secondary px-4 font-black uppercase text-primary transition-colors hover:bg-subtle disabled:opacity-50"
            style={labelStyle}
          >
            Cancelar
          </button>
          <button
            type="button"
            disabled={isClosingShiftFromReports}
            onClick={handleConfirm}
            className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-[#6535C5] to-indigo-600 px-4 font-black uppercase text-white shadow-sm transition-all hover:shadow-md active:scale-[0.99] disabled:opacity-50"
            style={labelStyle}
          >
            {isClosingShiftFromReports ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                <span>Cerrando turno…</span>
              </>
            ) : (
              <>
                <CheckCircle size={16} aria-hidden="true" />
                <span>Confirmar y cerrar turno</span>
              </>
            )}
          </button>
        </footer>
      </section>
    </div>
  ), document.body);
}
