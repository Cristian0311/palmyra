import { useMemo } from "react";
import { AlertTriangle, Calendar, Clock, Eye, EyeOff, Package, Printer, Trash2, X } from "lucide-react";
import { cn } from "../../lib/utils";
import type { CashRegisterSession, Currency, Transaction, User } from "../../types";
import { CashMovementTicket } from "../cash/CashMovementTicket";
import {
  getCompletedTransactionsForSession,
} from "../../modules/reports/utils/reportSessionCalculations";
import { summarizeReportSales } from "../../modules/reports/utils/reportSalesSummary";

type DiscrepancyInfo = {
  isForcedClose: boolean;
  totalShortageBase: number;
  totalOverageBase: number;
  auditStatus?: 'pending_review' | 'reviewed' | 'resolved';
} | null;

type Props = {
  session: CashRegisterSession;
  transactions: Transaction[];
  users: User[];
  currencies: Currency[];
  formatMoney: (amount: number, code?: string) => string;
  sessionTurnLabel: string;
  payrollItem?: { baseSalary?: number; commissions?: number; totalSalary?: number; status?: 'paid' | 'pending' } | null;
  discrepancyInfo: DiscrepancyInfo;
  showDiscrepancy?: boolean;
  showShiftActions?: boolean;
  sessionHidden?: boolean;
  onClose: () => void;
  onHideSession?: () => void | Promise<void>;
  onVoidSession?: () => void;
  onOpenDiscrepancy: (session: CashRegisterSession) => void;
  onEditDate: (session: CashRegisterSession) => void;
  onPrint: (sessionId: string) => void;
  onOpenTransaction: (transaction: Transaction) => void;
};

const STATUS_LABEL: Record<string, string> = { open: 'Abierto', closed: 'Cerrado', cancelled: 'Anulado' };

function havana(value?: string) {
  if (!value) return '-';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '-';
  return date.toLocaleString('es-CU', {
    timeZone: 'America/Havana', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function havanaTime(value?: string) {
  if (!value) return '-';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '-';
  return date.toLocaleTimeString('es-CU', { timeZone: 'America/Havana', hour: '2-digit', minute: '2-digit' });
}

/**
 * Shift detail: hours, payment mix, cash movements and the sold products with
 * their real variant and stored line total. Only completed, non-voided tickets
 * of this turn are counted.
 */
export function ReportsSessionDetailModal({
  session, transactions, currencies, formatMoney, sessionTurnLabel,
  payrollItem, discrepancyInfo, showDiscrepancy = true, showShiftActions = true, sessionHidden = false,
  onClose, onHideSession, onVoidSession, onOpenDiscrepancy, onEditDate, onPrint,
  onOpenTransaction, 
}: Props) {
  const sessionTx = useMemo(() => getCompletedTransactionsForSession(session, transactions), [session, transactions]);
  const summary = useMemo(() => summarizeReportSales(sessionTx), [sessionTx]);
  const sessionTickets = useMemo(
    () => [...sessionTx].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()),
    [sessionTx],
  );

  const paymentMix = useMemo(() => {
    return currencies.map(currency => {
      let cash = 0;
      let transfer = 0;
      for (const tx of sessionTx) {
        for (const payment of tx.payments || []) {
          if (payment.currencyCode !== currency.code) continue;
          if (payment.method === 'cash') cash += payment.amount;
          else transfer += payment.amount;
        }
        for (const change of tx.changePayments || []) {
          if (change.currencyCode !== currency.code) continue;
          if (change.method === 'cash') cash -= change.amount;
          else transfer -= change.amount;
        }
      }
      return { currencyCode: currency.code, cash, transfer };
    }).filter(row => Math.abs(row.cash) >= 0.01 || Math.abs(row.transfer) >= 0.01);
  }, [currencies, sessionTx]);

  const movements = useMemo(
    () => [...(session.movements || [])].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()),
    [session.movements],
  );

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center overflow-hidden bg-slate-950/70 p-2 backdrop-blur-sm sm:p-4 animate-in fade-in duration-200">
      <div className="flex max-h-[94vh] w-full max-w-lg flex-col overflow-hidden rounded-3xl border border-base bg-secondary shadow-2xl sm:max-h-[90vh]">
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-base bg-rose-50/40 px-4 py-3.5 dark:bg-rose-950/30">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="rounded border border-rose-200 bg-white px-2 py-0.5 text-[10px] font-black uppercase text-rose-700 dark:border-rose-900 dark:bg-slate-800 dark:text-rose-300">
                {sessionTurnLabel}
              </span>
              <span className={cn(
                "rounded border px-1.5 py-0.5 text-[8px] font-black uppercase tracking-widest",
                session.status === 'open' ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-300"
                  : session.status === 'cancelled' ? "border-red-200 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300"
                  : "border-base bg-subtle text-secondary",
              )}>
                {STATUS_LABEL[session.status] || session.status}
              </span>
            </div>
            <p className="mt-1 truncate text-[10px] font-bold uppercase tracking-wider text-muted">
              {session.workerName || 'Vendedor'} · {session.openedAt ? havana(session.openedAt) : 'Sin apertura'}
            </p>
            <p className="mt-0.5 text-[9px] font-bold text-muted">
              Cierre: {havana(session.closedAt || session.closingDate)}
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded-full p-1.5 text-muted hover:bg-subtle hover:text-primary" aria-label="Cerrar detalle del turno">
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-3.5 text-primary custom-scrollbar">
          {showDiscrepancy && discrepancyInfo && (
            <div className="flex items-center justify-between gap-2 rounded-2xl border border-amber-200 bg-amber-50 p-2.5 dark:border-amber-900/60 dark:bg-amber-950/40">
              <div className="flex min-w-0 items-center gap-2">
                <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" />
                <div className="min-w-0">
                  <span className="block text-[8px] font-black uppercase text-amber-800 dark:text-amber-300">
                    {discrepancyInfo.isForcedClose ? 'Cierre forzado' : 'Turno con descuadre'}
                  </span>
                  <span className="block truncate text-[9px] font-bold text-amber-950 dark:text-amber-200">
                    {discrepancyInfo.totalShortageBase > 0 ? `Faltante: -${formatMoney(discrepancyInfo.totalShortageBase)} ` : ''}
                    {discrepancyInfo.totalOverageBase > 0 ? `Sobrante: +${formatMoney(discrepancyInfo.totalOverageBase)}` : ''}
                  </span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => onOpenDiscrepancy(session)}
                className="shrink-0 rounded-lg bg-amber-600 px-2.5 py-1 text-[8px] font-black uppercase text-white hover:bg-amber-700"
              >
                Ver auditoría
              </button>
            </div>
          )}

          <div className="grid grid-cols-3 gap-2">
            {[
              { label: 'Ventas', value: formatMoney(summary.total) },
              { label: 'Tickets', value: String(summary.tickets) },
              { label: 'Unidades', value: String(summary.units) },
            ].map(metric => (
              <div key={metric.label} className="rounded-xl border border-base bg-subtle p-2">
                <p className="text-[8px] font-black uppercase tracking-wider text-muted">{metric.label}</p>
                <p className="mt-0.5 truncate text-xs font-black text-primary">{metric.value}</p>
              </div>
            ))}
          </div>

          <section>
            <div className="mb-1.5 flex items-center justify-between">
              <p className="flex items-center gap-1.5 text-[9px] font-black uppercase tracking-widest text-muted">
                <Eye className="h-3 w-3" /> Tickets del turno ({sessionTickets.length})
              </p>
              <span className="text-[8px] font-bold text-muted">Toca Ver para abrir el comprobante</span>
            </div>
            {sessionTickets.length === 0 ? (
              <p className="rounded-xl border border-dashed border-base px-2.5 py-2 text-center text-[10px] font-bold text-muted">
                Este turno no tiene tickets completados.
              </p>
            ) : (
              <div className="max-h-64 space-y-1.5 overflow-y-auto pr-0.5 custom-scrollbar">
                {sessionTickets.map(tx => (
                  <div key={tx.id} className="rounded-xl border border-base bg-subtle p-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-[9px] font-black uppercase tracking-tight text-primary" title={`Ticket #${tx.id}`}>
                          Ticket #{String(tx.id).slice(0, 8)}
                        </p>
                        <p className="text-[8px] font-bold uppercase text-muted">{havanaTime(tx.date)} · {tx.items?.length || 0} productos</p>
                      </div>
                      <span className="shrink-0 text-[10px] font-black text-primary">{formatMoney(tx.total)}</span>
                    </div>
                    <div className="mt-1.5">
                      <button
                        type="button"
                        onClick={() => onOpenTransaction(tx)}
                        className="inline-flex min-h-8 w-full items-center justify-center gap-1.5 rounded-lg border border-base bg-secondary px-2 text-[9px] font-black uppercase tracking-wide text-primary hover:bg-subtle"
                        title="Ver el comprobante completo de este ticket"
                      >
                        <Eye className="h-3.5 w-3.5" /> Ver comprobante
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section>
            <p className="mb-1.5 text-[9px] font-black uppercase tracking-widest text-muted">Ventas por método de pago</p>
            {paymentMix.length === 0 ? (
              <p className="rounded-xl border border-dashed border-base px-2.5 py-2 text-[10px] font-bold text-muted">Sin cobros registrados.</p>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                {paymentMix.map(row => (
                  <div key={row.currencyCode} className="rounded-xl border border-base bg-subtle p-2">
                    <div className="mb-1 border-b border-base/60 pb-1 text-[9px] font-black uppercase text-primary">{row.currencyCode}</div>
                    {Math.abs(row.cash) > 0.01 && (
                      <div className="flex justify-between text-[8px] font-bold text-muted">
                        <span>Efectivo</span><span className="font-mono text-emerald-600 dark:text-emerald-400">{formatMoney(row.cash, row.currencyCode)}</span>
                      </div>
                    )}
                    {Math.abs(row.transfer) > 0.01 && (
                      <div className="flex justify-between text-[8px] font-bold text-muted">
                        <span>Transferencia</span><span className="font-mono text-blue-600 dark:text-blue-400">{formatMoney(row.transfer, row.currencyCode)}</span>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>

          <section>
            <div className="mb-1.5 flex items-center justify-between">
              <p className="text-[9px] font-black uppercase tracking-widest text-muted">
                Egresos, gastos e ingresos ({movements.length})
              </p>
              <span className="text-[8px] font-bold text-muted">Comprobantes separados de las ventas</span>
            </div>
            {movements.length === 0 ? (
              <p className="rounded-xl border border-dashed border-base px-2.5 py-2 text-center text-[10px] font-bold text-muted">
                No hay movimientos de caja registrados en este turno.
              </p>
            ) : (
              <div className="space-y-1.5">
                {movements.map(movement => (
                  <CashMovementTicket
                    key={movement.id}
                    movement={movement}
                    workerName={session.workerName}
                    formatMoney={formatMoney}
                    compact
                  />
                ))}
              </div>
            )}
          </section>

          <section>
            <div className="mb-1.5 flex items-center justify-between">
              <p className="flex items-center gap-1.5 text-[9px] font-black uppercase tracking-widest text-muted">
                <Package className="h-3 w-3" /> Productos vendidos ({summary.products.length})
              </p>
              <span className="text-[8px] font-bold text-muted">{summary.units} unidades</span>
            </div>
            {summary.products.length === 0 ? (
              <p className="rounded-xl border border-dashed border-base px-2.5 py-3 text-center text-[10px] font-bold uppercase text-muted">
                No hay productos vendidos en este turno.
              </p>
            ) : (
              <div className="max-h-52 space-y-1 overflow-y-auto pr-0.5 custom-scrollbar">
                {summary.products.map(product => (
                  <div key={product.key} className="flex items-center justify-between rounded-xl border border-base bg-subtle p-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg border border-base bg-secondary text-[9px] font-black text-rose-600 dark:text-rose-400">
                        {product.quantity}
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-[9px] font-black uppercase tracking-tight text-primary">{product.name}</p>
                        <p className="truncate text-[8px] font-bold uppercase text-muted">
                          {product.variant || 'Sin variante'}
                          {product.missingCostUnits > 0 ? ' · costo incompleto' : ''}
                        </p>
                      </div>
                    </div>
                    <span className="ml-2 shrink-0 text-[10px] font-black text-primary">{formatMoney(product.revenue)}</span>
                  </div>
                ))}
              </div>
            )}
          </section>

          {payrollItem && (
            <section className="space-y-1.5 rounded-2xl border border-emerald-200 bg-emerald-50/60 p-3 dark:border-emerald-900/40 dark:bg-emerald-950/30">
              <div className="flex items-center justify-between text-[9px] font-black uppercase tracking-widest text-emerald-800 dark:text-emerald-300">
                <span>Liquidación salarial del turno</span>
                <span className={cn(
                  "rounded px-2 py-0.5 text-[8px] font-black",
                  payrollItem.status === 'paid'
                    ? "bg-emerald-200 text-emerald-900 dark:bg-emerald-900 dark:text-emerald-100"
                    : "bg-amber-100 text-amber-900 dark:bg-amber-900 dark:text-amber-100",
                )}>
                  {payrollItem.status === 'paid' ? 'Pagado' : 'Pendiente'}
                </span>
              </div>
              <div className="flex justify-between text-[10px] text-muted">
                <span>Salario base</span><span className="font-bold text-primary">{formatMoney(payrollItem.baseSalary || 0)}</span>
              </div>
              <div className="flex justify-between text-[10px] text-emerald-700 dark:text-emerald-400">
                <span>Comisiones</span><span className="font-bold">+{formatMoney(payrollItem.commissions || 0)}</span>
              </div>
              <div className="flex justify-between border-t border-emerald-200/60 pt-1 text-xs font-black text-primary dark:border-emerald-900/60">
                <span>Total salario</span>
                <span className="text-emerald-700 dark:text-emerald-400">{formatMoney(payrollItem.totalSalary || 0)}</span>
              </div>
            </section>
          )}

          <p className="flex items-center gap-1.5 text-[8px] font-bold uppercase tracking-wide text-muted">
            <Clock className="h-3 w-3" /> Solo se suman tickets completados y no anulados de este turno.
          </p>
        </div>

        <footer className="shrink-0 border-t border-base bg-subtle px-4 py-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <span className="block text-[8px] font-black uppercase tracking-widest text-muted">Total ventas turno</span>
              <span className="text-base font-black text-rose-600 dark:text-rose-400">{formatMoney(summary.total)}</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => onEditDate(session)}
                className="inline-flex items-center gap-1 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[9px] font-black uppercase tracking-wider text-amber-700 hover:bg-amber-100 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-400"
                title="Editar fecha del turno"
              >
                <Calendar className="h-4 w-4" /> Fecha
              </button>
              <button
                type="button"
                onClick={() => onPrint(session.id)}
                className="inline-flex items-center gap-1.5 rounded-xl bg-rose-600 px-3 py-2 text-[9px] font-black uppercase tracking-wider text-white hover:bg-rose-700 active:scale-95"
              >
                <Printer className="h-4 w-4" /> Imprimir
              </button>
            </div>
          </div>
          {showShiftActions && (onHideSession || onVoidSession) && (
            <div className="mt-2 grid grid-cols-2 gap-2">
              {onHideSession && (
                <button
                  type="button"
                  onClick={() => void onHideSession()}
                  className="inline-flex min-h-10 items-center justify-center gap-1.5 rounded-xl border border-amber-200 bg-amber-50 px-2 text-[9px] font-black uppercase tracking-wider text-amber-700 hover:bg-amber-100 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300"
                  title="Oculta o restaura el turno completo en la lista de reportes. No borra ventas ni toca el inventario."
                >
                  {sessionHidden ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                  {sessionHidden ? 'Mostrar turno' : 'Ocultar turno'}
                </button>
              )}
              {onVoidSession && (
                <button
                  type="button"
                  onClick={onVoidSession}
                  className="inline-flex min-h-10 items-center justify-center gap-1.5 rounded-xl border border-rose-300 bg-rose-50 px-2 text-[9px] font-black uppercase tracking-wider text-rose-700 hover:bg-rose-100 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-300"
                  title="Elimina el turno completo, devuelve el stock y guarda el motivo"
                >
                  <Trash2 className="h-4 w-4" /> Eliminar turno
                </button>
              )}
            </div>
          )}
          {showShiftActions && (onHideSession || onVoidSession) && (
            <p className="mt-1.5 text-center text-[8px] font-bold uppercase tracking-wide text-muted">
              Estas acciones aplican al turno completo, no a un ticket suelto.
            </p>
          )}
        </footer>
      </div>
    </div>
  );
}
