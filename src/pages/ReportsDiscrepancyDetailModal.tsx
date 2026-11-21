import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, ArrowDownRight, ArrowUpRight, Ban, Brain, CalendarDays, CheckCircle2,
  FileText, Info, ListChecks, MapPin, Printer, Receipt, RefreshCw, Save, Scale,
  ShieldAlert, Wallet, X,
} from 'lucide-react';
import { cn } from '../lib/utils';
import type { CashRegisterSession, Transaction } from '../types';
import type { SessionDiscrepancyDetail, SessionDiscrepancyInfo } from '../modules/reports/utils/getSessionDiscrepancyInfo';

type Props = {
  addNotification?: (message: string, type?: 'success' | 'error' | 'warning' | 'info') => void;
  baseCurrency: { code: string };
  branches: { id: string; name: string }[];
  currencies: { code: string; rateToBase?: number }[];
  formatMoney: (amount: number, code?: string) => string;
  getSessionDiscrepancyInfo: (session: CashRegisterSession) => SessionDiscrepancyInfo | null;
  handlePrintDiscrepancyTicket: (session: CashRegisterSession) => void;
  handlePrintShiftTicket: (sessionId: string) => void;
  selectedDiscrepancyDetailSession: CashRegisterSession | null;
  sessionTurnMap: Map<string, string>;
  setSelectedDiscrepancyDetailSession: (session: CashRegisterSession | null) => void;
  transactions: Transaction[];
  updateCashSession: (id: string, updates: Partial<CashRegisterSession>) => void;
  users: { id: string; name: string }[];
  currentUser?: { id?: string; name?: string } | null;
};

const CAUSES = [
  'Conteo incorrecto del efectivo',
  'Vuelto mal entregado al cliente',
  'Gasto/egreso no registrado en el turno',
  'Venta realizada pero no registrada',
  'Cobro duplicado de una venta',
  'Retiro de efectivo no registrado',
  'Otro (explicar en las notas)',
];

const labelStyle = { fontSize: 11, letterSpacing: '0.08em' } as const;
const metaStyle = { fontSize: 12 } as const;

const fmtDate = (value?: string) => value
  ? new Date(value).toLocaleString('es-CU', { timeZone: 'America/Havana', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
  : '—';

const fmtTime = (value: string) => new Date(value).toLocaleTimeString('es-CU', { timeZone: 'America/Havana', hour: '2-digit', minute: '2-digit' });

function methodLabel(method: string) {
  return method === 'transfer' || method === 'bank_transfer' ? 'Transferencia' : 'Efectivo';
}

export default function ReportsDiscrepancyDetailModal({
  addNotification,
  baseCurrency,
  branches,
  currencies,
  formatMoney,
  getSessionDiscrepancyInfo,
  handlePrintDiscrepancyTicket,
  handlePrintShiftTicket,
  selectedDiscrepancyDetailSession,
  sessionTurnMap,
  setSelectedDiscrepancyDetailSession,
  transactions,
  updateCashSession,
  users,
  currentUser,
}: Props) {
  const session = selectedDiscrepancyDetailSession;
  const [cause, setCause] = useState('');
  const [notes, setNotes] = useState('');
  const [deduct, setDeduct] = useState(false);
  const [deductAmount, setDeductAmount] = useState(0);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!session) return;
    setCause('');
    setNotes('');
    setConfirming(false);
    const info = getSessionDiscrepancyInfo(session);
    setDeduct(false);
    setDeductAmount(Math.round(info?.totalShortageBase || 0));
  }, [session?.id]);

  const info = session ? getSessionDiscrepancyInfo(session) : null;

  const sessionData = useMemo(() => {
    if (!session) return null;
    const openMs = new Date(session.openedAt).getTime();
    const closeMs = session.closedAt ? new Date(session.closedAt).getTime() : Infinity;
    const related = transactions.filter(tx => {
      if (tx.sessionId) return tx.sessionId === session.id;
      const txTime = new Date(tx.date).getTime();
      return tx.branchId === session.branchId && txTime >= openMs && txTime <= closeMs;
    });
    const completed = related.filter(tx => tx.status === 'completed' && !tx.deletedAt && !String(tx.notes || '').startsWith('AJUSTE_'));
    const voided = related.filter(tx => tx.status !== 'completed' || Boolean(tx.deletedAt));
    const movements = session.movements || [];
    const rateOf = (code: string) => currencies.find(c => c.code === code)?.rateToBase || 1;
    const sum = (items: { amount: number; currencyCode: string }[]) =>
      items.reduce((acc, item) => acc + Number(item.amount || 0) * rateOf(item.currencyCode), 0);
    return {
      completed,
      voided,
      movements,
      totalSales: completed.reduce((acc, tx) => acc + Math.max(0, Number(tx.total) || 0), 0),
      incomeBase: sum(movements.filter(m => m.type === 'income')),
      expenseBase: sum(movements.filter(m => m.type === 'expense')),
    };
  }, [session, transactions, currencies]);

  if (!session || !info || !sessionData) return null;

  const branch = branches.find(b => b.id === session.branchId);
  const worker = session.workerName || users.find(u => u.id === session.userId)?.name || 'Cajero';
  const turnLabel = sessionTurnMap.get(session.id) || session.id;
  const isReconciled = info.auditStatus === 'resolved';
  const netBase = info.totalOverageBase - info.totalShortageBase;
  const hasShortage = info.totalShortageBase > 0.01;
  const hasOverage = info.totalOverageBase > 0.01;
  const auditLog = (session.auditNotes || '').split('\n').filter(Boolean);

  const applyReconciliation = () => {
    if (!cause) {
      addNotification?.('Selecciona la causa de la diferencia antes de cuadrar la caja.', 'warning');
      return;
    }
    if (notes.trim().length < 5) {
      addNotification?.('Escribe una nota breve explicando qué ocurrió en el turno.', 'warning');
      return;
    }
    const stamp = new Date().toISOString();
    const author = currentUser?.name || 'Administrador';
    const entry = `[Conciliación ${fmtDate(stamp)} · ${author}] Causa: ${cause}. ${notes.trim()}${deduct && deductAmount > 0 ? ` Deducción salarial aplicada: ${formatMoney(deductAmount, baseCurrency.code)}.` : ''}`;
    const updates: Partial<CashRegisterSession> = {
      auditStatus: 'resolved',
      auditNotes: [...auditLog, entry].join('\n'),
      discrepancyNote: cause,
      ...(deduct && deductAmount > 0
        ? { discrepancyDeductionApplied: deductAmount, deductedFromSalary: true }
        : {}),
    };
    updateCashSession(session.id, updates);
    setSelectedDiscrepancyDetailSession({ ...session, ...updates });
    setConfirming(false);
    addNotification?.('Caja conciliada. La diferencia queda documentada con su causa; ventas, stock y arqueo original no se alteran.', 'success');
  };

  const saveReview = () => {
    const entry = `[Revisión ${fmtDate(new Date().toISOString())} · ${currentUser?.name || 'Administrador'}] ${notes.trim() || 'Turno revisado, pendiente de decisión final.'}`;
    const updates: Partial<CashRegisterSession> = {
      auditStatus: 'reviewed',
      auditNotes: [...auditLog, entry].join('\n'),
    };
    updateCashSession(session.id, updates);
    setSelectedDiscrepancyDetailSession({ ...session, ...updates });
    addNotification?.('Revisión guardada. El turno sigue marcado como auditado, sin conciliar.', 'success');
  };

  const reopenReview = () => {
    const entry = `[Reapertura ${fmtDate(new Date().toISOString())} · ${currentUser?.name || 'Administrador'}] Conciliación reabierta para nueva revisión.`;
    const updates: Partial<CashRegisterSession> = {
      auditStatus: 'reviewed',
      auditNotes: [...auditLog, entry].join('\n'),
    };
    updateCashSession(session.id, updates);
    setSelectedDiscrepancyDetailSession({ ...session, ...updates });
    addNotification?.('El turno volvió a revisión. La conciliación anterior queda en el historial.', 'info');
  };

  return (
    <div className="fixed inset-0 z-[95] flex items-center justify-center overflow-hidden bg-slate-950/70 p-2 backdrop-blur-sm sm:p-4" role="presentation">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="discrepancy-detail-title"
        className="flex max-h-[94dvh] w-full max-w-4xl flex-col overflow-hidden rounded-3xl border border-base bg-secondary shadow-2xl"
      >
        {/* Header */}
        <header className="flex items-start justify-between gap-3 border-b border-base bg-subtle px-4 py-3.5 sm:px-5">
          <div className="flex min-w-0 items-start gap-3">
            <span className={cn(
              'flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl text-white shadow-sm',
              isReconciled ? 'bg-gradient-to-br from-emerald-500 to-teal-600' : 'bg-gradient-to-br from-red-500 to-rose-600',
            )}>
              {isReconciled ? <CheckCircle2 size={22} aria-hidden="true" /> : <ShieldAlert size={22} aria-hidden="true" />}
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="rounded-lg border border-base bg-secondary px-2 py-0.5 font-black text-primary" style={{ fontSize: 12 }}>{turnLabel}</span>
                {info.isForcedClose ? (
                  <span className="inline-flex items-center gap-1 rounded-lg border border-red-200 bg-red-50 px-2 py-0.5 font-black uppercase text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300" style={labelStyle}>
                    <AlertTriangle size={12} aria-hidden="true" /> Cierre forzado
                  </span>
                ) : (
                  <span className="rounded-lg border border-amber-200 bg-amber-50 px-2 py-0.5 font-black uppercase text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300" style={labelStyle}>
                    Cierre con diferencia
                  </span>
                )}
                {isReconciled && (
                  <span className="inline-flex items-center gap-1 rounded-lg border border-emerald-200 bg-emerald-50 px-2 py-0.5 font-black uppercase text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300" style={labelStyle}>
                    <CheckCircle2 size={12} aria-hidden="true" /> Conciliado
                  </span>
                )}
              </div>
              <h2 id="discrepancy-detail-title" className="mt-1 truncate text-base font-black text-primary sm:text-lg">
                Descuadre del turno — {worker}
              </h2>
              <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-bold text-muted" style={metaStyle}>
                <span className="inline-flex items-center gap-1"><MapPin size={13} aria-hidden="true" />{branch?.name || 'Sucursal principal'}</span>
                <span className="inline-flex items-center gap-1"><CalendarDays size={13} aria-hidden="true" />{fmtDate(session.openedAt)} → {fmtDate(session.closingDate || session.closedAt)}</span>
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setSelectedDiscrepancyDetailSession(null)}
            aria-label="Cerrar el detalle del descuadre"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-base bg-secondary text-muted transition-colors hover:bg-subtle hover:text-primary"
          >
            <X size={20} />
          </button>
        </header>

        {/* Body */}
        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4 sm:px-5">
          {/* Resultado del arqueo */}
          <section aria-label="Resultado del arqueo">
            <div className="grid gap-2.5 sm:grid-cols-3">
              <div className="relative overflow-hidden rounded-2xl border border-red-200 bg-red-50/70 p-3.5 dark:border-red-900/60 dark:bg-red-950/30">
                <div className="flex items-center gap-2">
                  <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-red-600 text-white"><ArrowDownRight size={16} aria-hidden="true" /></span>
                  <span className="font-black uppercase text-red-800 dark:text-red-300" style={labelStyle}>Faltante en caja</span>
                </div>
                <p className="mt-2 font-black leading-none text-red-700 dark:text-red-300" style={{ fontSize: 26 }}>
                  {hasShortage ? `−${formatMoney(info.totalShortageBase, baseCurrency.code)}` : formatMoney(0, baseCurrency.code)}
                </p>
                <p className="mt-1 font-bold text-red-900/80 dark:text-red-200/80" style={{ fontSize: 12 }}>
                  {hasShortage
                    ? 'Se declaró menos dinero del que el sistema esperaba en el turno.'
                    : 'No falta dinero en este turno.'}
                </p>
              </div>

              <div className="relative overflow-hidden rounded-2xl border border-emerald-200 bg-emerald-50/70 p-3.5 dark:border-emerald-900/60 dark:bg-emerald-950/30">
                <div className="flex items-center gap-2">
                  <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-600 text-white"><ArrowUpRight size={16} aria-hidden="true" /></span>
                  <span className="font-black uppercase text-emerald-800 dark:text-emerald-300" style={labelStyle}>Sobrante en caja</span>
                </div>
                <p className="mt-2 font-black leading-none text-emerald-700 dark:text-emerald-300" style={{ fontSize: 26 }}>
                  {hasOverage ? `+${formatMoney(info.totalOverageBase, baseCurrency.code)}` : formatMoney(0, baseCurrency.code)}
                </p>
                <p className="mt-1 font-bold text-emerald-900/80 dark:text-emerald-200/80" style={{ fontSize: 12 }}>
                  {hasOverage
                    ? 'Se declaró más dinero del esperado. Revisa cobros duplicados o vueltos.'
                    : 'No sobra dinero en este turno.'}
                </p>
              </div>

              <div className="relative overflow-hidden rounded-2xl border border-base bg-subtle p-3.5">
                <div className="flex items-center gap-2">
                  <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-violet-600 to-indigo-600 text-white"><Scale size={16} aria-hidden="true" /></span>
                  <span className="font-black uppercase text-muted" style={labelStyle}>Diferencia neta</span>
                </div>
                <p className={cn('mt-2 font-black leading-none', netBase < -0.01 ? 'text-red-600 dark:text-red-400' : netBase > 0.01 ? 'text-emerald-600 dark:text-emerald-400' : 'text-primary')} style={{ fontSize: 26 }}>
                  {netBase > 0.01 ? '+' : ''}{formatMoney(netBase, baseCurrency.code)}
                </p>
                <p className="mt-1 font-bold text-muted" style={{ fontSize: 12 }}>
                  Fondo inicial: {formatMoney(session.openingBalance, baseCurrency.code)}
                </p>
              </div>
            </div>
          </section>

          {/* Qué pasó en el turno */}
          <section aria-label="Qué pasó en el turno" className="rounded-2xl border border-base bg-secondary p-3.5">
            <div className="flex items-center gap-2">
              <Receipt size={17} className="text-violet-600 dark:text-violet-400" aria-hidden="true" />
              <h3 className="font-black uppercase text-primary" style={labelStyle}>Qué pasó en este turno</h3>
            </div>
            <div className="mt-2.5 grid grid-cols-2 gap-2 lg:grid-cols-4">
              <div className="rounded-xl border border-base bg-subtle p-2.5">
                <p className="font-black uppercase text-muted" style={labelStyle}>Ventas cobradas</p>
                <p className="mt-0.5 text-lg font-black text-primary">{formatMoney(sessionData.totalSales, baseCurrency.code)}</p>
                <p className="font-bold text-muted" style={{ fontSize: 11 }}>{sessionData.completed.length} ticket(s)</p>
              </div>
              <div className="rounded-xl border border-base bg-subtle p-2.5">
                <p className="font-black uppercase text-muted" style={labelStyle}>Ingresos de caja</p>
                <p className="mt-0.5 text-lg font-black text-emerald-600 dark:text-emerald-400">+{formatMoney(sessionData.incomeBase, baseCurrency.code)}</p>
                <p className="font-bold text-muted" style={{ fontSize: 11 }}>{sessionData.movements.filter(m => m.type === 'income').length} entrada(s)</p>
              </div>
              <div className="rounded-xl border border-base bg-subtle p-2.5">
                <p className="font-black uppercase text-muted" style={labelStyle}>Egresos y gastos</p>
                <p className="mt-0.5 text-lg font-black text-red-600 dark:text-red-400">−{formatMoney(sessionData.expenseBase, baseCurrency.code)}</p>
                <p className="font-bold text-muted" style={{ fontSize: 11 }}>{sessionData.movements.filter(m => m.type === 'expense').length} salida(s)</p>
              </div>
              <div className="rounded-xl border border-base bg-subtle p-2.5">
                <p className="font-black uppercase text-muted" style={labelStyle}>Ventas anuladas</p>
                <p className="mt-0.5 text-lg font-black text-amber-600 dark:text-amber-400">{sessionData.voided.length}</p>
                <p className="font-bold text-muted" style={{ fontSize: 11 }}>No suman en el arqueo</p>
              </div>
            </div>

            <div className="mt-2.5 grid gap-2 sm:grid-cols-2">
              <div className="rounded-xl border border-base bg-subtle p-2.5">
                <div className="mb-1 flex items-center justify-between">
                  <span className="font-black uppercase text-muted" style={labelStyle}>Tickets del turno</span>
                  <span className="font-black text-primary" style={metaStyle}>{formatMoney(sessionData.totalSales, baseCurrency.code)}</span>
                </div>
                <div className="max-h-36 space-y-1 overflow-y-auto pr-1">
                  {sessionData.completed.map(tx => (
                    <div key={tx.id} className="flex items-center justify-between gap-2 rounded-lg border border-base bg-secondary px-2 py-1.5">
                      <span className="inline-flex min-w-0 items-center gap-1.5">
                        <Receipt size={13} className="shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                        <span className="truncate font-bold text-primary" style={metaStyle}>#{tx.id.slice(0, 8)}</span>
                        <span className="shrink-0 font-bold text-muted" style={{ fontSize: 11 }}>{fmtTime(tx.date)}</span>
                      </span>
                      <span className="shrink-0 font-black text-primary" style={metaStyle}>{formatMoney(tx.total, baseCurrency.code)}</span>
                    </div>
                  ))}
                  {sessionData.completed.length === 0 && <p className="py-3 text-center font-bold text-muted" style={metaStyle}>Sin ventas registradas.</p>}
                </div>
              </div>

              <div className="rounded-xl border border-base bg-subtle p-2.5">
                <div className="mb-1 flex items-center justify-between">
                  <span className="font-black uppercase text-muted" style={labelStyle}>Movimientos de caja</span>
                  <span className="inline-flex items-center gap-1 font-bold text-muted" style={{ fontSize: 11 }}>
                    <Wallet size={12} aria-hidden="true" /> entra y sale
                  </span>
                </div>
                <div className="max-h-36 space-y-1 overflow-y-auto pr-1">
                  {sessionData.movements.map(m => (
                    <div key={m.id} className="flex items-center justify-between gap-2 rounded-lg border border-base bg-secondary px-2 py-1.5">
                      <span className="inline-flex min-w-0 items-center gap-1.5">
                        {m.type === 'income'
                          ? <ArrowUpRight size={13} className="shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                          : <ArrowDownRight size={13} className="shrink-0 text-red-600 dark:text-red-400" aria-hidden="true" />}
                        <span className="truncate font-bold text-primary" style={metaStyle}>{m.description || (m.type === 'income' ? 'Ingreso de caja' : 'Egreso de caja')}</span>
                      </span>
                      <span className={cn('shrink-0 font-black', m.type === 'income' ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')} style={metaStyle}>
                        {m.type === 'income' ? '+' : '−'}{formatMoney(m.amount, m.currencyCode)}
                      </span>
                    </div>
                  ))}
                  {sessionData.movements.length === 0 && <p className="py-3 text-center font-bold text-muted" style={metaStyle}>Sin movimientos de caja.</p>}
                </div>
                <p className="mt-1.5 font-bold text-muted" style={{ fontSize: 11 }}>
                  Los egresos y gastos reducen el efectivo esperado; si uno está mal registrado, corrígelo desde la pestaña Movimientos.
                </p>
              </div>
            </div>
          </section>

          {/* Comparación por moneda */}
          <section aria-label="Comparación por moneda y método">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="inline-flex items-center gap-1.5 font-black uppercase text-muted" style={labelStyle}>
                <Scale size={15} aria-hidden="true" /> Esperado contra declarado
              </h3>
              <span className="font-bold text-muted" style={metaStyle}>{info.details.length} diferencia(s)</span>
            </div>
            <div className="space-y-2">
              {info.details.map((detail: SessionDiscrepancyDetail) => {
                const ratio = detail.expected > 0 ? Math.max(0, Math.min(1, detail.actual / detail.expected)) : detail.actual > 0 ? 1 : 0;
                const positive = detail.difference > 0;
                return (
                  <div key={`${detail.currencyCode}-${detail.method}`} className="rounded-2xl border border-base bg-secondary p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="rounded-lg border border-base bg-subtle px-2 py-0.5 font-black text-primary" style={{ fontSize: 12 }}>{detail.currencyCode}</span>
                        <span className="font-black uppercase text-muted" style={labelStyle}>{methodLabel(detail.method)}</span>
                      </span>
                      <span className={cn(
                        'inline-flex items-center gap-1 rounded-full px-2.5 py-1 font-black',
                        positive ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300' : 'bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300',
                      )} style={{ fontSize: 12 }}>
                        {positive ? <ArrowUpRight size={13} aria-hidden="true" /> : <ArrowDownRight size={13} aria-hidden="true" />}
                        {positive ? '+' : '−'}{formatMoney(Math.abs(detail.difference), detail.currencyCode)}
                      </span>
                    </div>
                    <div className="mt-2 grid grid-cols-2 gap-2" style={{ fontSize: 12 }}>
                      <div>
                        <p className="font-black uppercase text-muted" style={labelStyle}>El sistema esperaba</p>
                        <p className="font-black text-primary">{formatMoney(detail.expected, detail.currencyCode)}</p>
                      </div>
                      <div className="text-right">
                        <p className="font-black uppercase text-muted" style={labelStyle}>El cajero declaró</p>
                        <p className="font-black text-primary">{formatMoney(detail.actual, detail.currencyCode)}</p>
                      </div>
                    </div>
                    <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-subtle" role="img" aria-label={`Declarado ${Math.round(ratio * 100)}% de lo esperado`}>
                      <div className={cn('h-full rounded-full', positive ? 'bg-emerald-500' : 'bg-red-500')} style={{ width: `${Math.max(4, ratio * 100)}%` }} />
                    </div>
                  </div>
                );
              })}
              {info.details.length === 0 && (
                <div className="flex items-center gap-2 rounded-2xl border border-emerald-200 bg-emerald-50/70 p-3 dark:border-emerald-900/60 dark:bg-emerald-950/30">
                  <CheckCircle2 size={17} className="text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                  <p className="font-bold text-emerald-800 dark:text-emerald-300" style={metaStyle}>
                    El arqueo coincide con lo esperado en todas las monedas y métodos.
                  </p>
                </div>
              )}
            </div>
          </section>

          {/* Posibles causas */}
          <section aria-label="Posibles causas" className="rounded-2xl border border-amber-200 bg-amber-50/60 p-3.5 dark:border-amber-900/60 dark:bg-amber-950/25">
            <h3 className="inline-flex items-center gap-1.5 font-black uppercase text-amber-800 dark:text-amber-300" style={labelStyle}>
              <Brain size={15} aria-hidden="true" /> Posibles causas de la diferencia
            </h3>
            <ul className="mt-2 grid gap-1.5 sm:grid-cols-2" style={metaStyle}>
              <li className="flex items-start gap-1.5 font-bold text-amber-900/90 dark:text-amber-200/90"><Ban size={13} className="mt-0.5 shrink-0" aria-hidden="true" /> Una venta que no quedó registrada en el sistema.</li>
              <li className="flex items-start gap-1.5 font-bold text-amber-900/90 dark:text-amber-200/90"><ArrowDownRight size={13} className="mt-0.5 shrink-0" aria-hidden="true" /> Un gasto o retiro de efectivo sin registrar.</li>
              <li className="flex items-start gap-1.5 font-bold text-amber-900/90 dark:text-amber-200/90"><Wallet size={13} className="mt-0.5 shrink-0" aria-hidden="true" /> Vuelto entregado de más o de menos.</li>
              <li className="flex items-start gap-1.5 font-bold text-amber-900/90 dark:text-amber-200/90"><Receipt size={13} className="mt-0.5 shrink-0" aria-hidden="true" /> Un cobro duplicado o un conteo incorrecto del efectivo.</li>
            </ul>

            {info.matchingProducts.length > 0 && (
              <div className="mt-2.5 rounded-xl border border-amber-300 bg-secondary p-2.5 dark:border-amber-800">
                <p className="font-black uppercase text-amber-800 dark:text-amber-300" style={labelStyle}>El monto coincide con el precio de:</p>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {info.matchingProducts.map(match => match.matchedProducts.map(product => (
                    <span key={`${match.currencyCode}-${product.id}`} className="rounded-lg border border-amber-300 bg-amber-50 px-2 py-0.5 font-black text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200" style={{ fontSize: 12 }}>
                      {product.name} · {formatMoney(product.price, baseCurrency.code)}
                    </span>
                  )))}
                </div>
              </div>
            )}

            {info.aiDiagnostic && (
              <div className="mt-2.5 rounded-xl border border-base bg-secondary p-2.5">
                <p className="font-black uppercase text-muted" style={labelStyle}>Diagnóstico del turno</p>
                <p className="mt-1 font-bold text-primary" style={metaStyle}>{info.aiDiagnostic.analysis}</p>
                {info.aiDiagnostic.suggestions?.length > 0 && (
                  <ul className="mt-1 list-disc pl-4 font-bold text-muted" style={metaStyle}>
                    {info.aiDiagnostic.suggestions.map((suggestion, index) => <li key={index}>{suggestion}</li>)}
                  </ul>
                )}
              </div>
            )}
          </section>

          {/* Conciliación */}
          <section aria-label="Conciliar caja" className="rounded-2xl border border-base bg-secondary p-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="inline-flex items-center gap-1.5 font-black uppercase text-primary" style={labelStyle}>
                <ListChecks size={15} className="text-violet-600 dark:text-violet-400" aria-hidden="true" /> Cuadrar la caja
              </h3>
              <span className={cn(
                'rounded-full px-2.5 py-1 font-black uppercase',
                isReconciled ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300'
                  : info.auditStatus === 'reviewed' ? 'bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300'
                    : 'bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300',
              )} style={labelStyle}>
                {isReconciled ? 'Conciliado' : info.auditStatus === 'reviewed' ? 'Auditado' : 'Pendiente'}
              </span>
            </div>

            {isReconciled ? (
              <div className="mt-2.5 space-y-2">
                <div className="flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50/70 p-2.5 dark:border-emerald-900/60 dark:bg-emerald-950/30">
                  <CheckCircle2 size={17} className="mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                  <div className="min-w-0">
                    <p className="font-black text-emerald-800 dark:text-emerald-300" style={metaStyle}>Este turno ya fue conciliado.</p>
                    <p className="font-bold text-emerald-900/80 dark:text-emerald-200/80" style={{ fontSize: 12 }}>
                      {session.discrepancyNote ? `Causa registrada: ${session.discrepancyNote}. ` : ''}
                      {info.deducted ? `Deducción salarial: ${formatMoney(info.deductionAmount, baseCurrency.code)}.` : 'Sin deducción salarial.'}
                    </p>
                  </div>
                </div>
                {auditLog.length > 0 && (
                  <div className="max-h-32 space-y-1 overflow-y-auto rounded-xl border border-base bg-subtle p-2.5">
                    {auditLog.map((line, index) => (
                      <p key={index} className="font-bold text-muted" style={{ fontSize: 12 }}>{line}</p>
                    ))}
                  </div>
                )}
                <button type="button" onClick={reopenReview} className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-base bg-secondary px-4 py-2 font-black uppercase text-primary transition-colors hover:bg-subtle" style={labelStyle}>
                  <RefreshCw size={15} aria-hidden="true" /> Reabrir revisión
                </button>
              </div>
            ) : confirming ? (
              <div className="mt-2.5 space-y-2.5">
                <div className="rounded-xl border border-violet-200 bg-violet-50/70 p-3 dark:border-violet-900/60 dark:bg-violet-950/30">
                  <p className="font-black text-violet-900 dark:text-violet-200" style={metaStyle}>Confirma la conciliación</p>
                  <p className="mt-0.5 font-bold text-violet-900/80 dark:text-violet-200/80" style={{ fontSize: 12 }}>
                    Causa: {cause}. {deduct && deductAmount > 0 ? `Se descontarán ${formatMoney(deductAmount, baseCurrency.code)} del salario del turno. ` : ''}
                    La diferencia, el arqueo original y las ventas se conservan como evidencia.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={applyReconciliation} className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-gradient-to-r from-violet-600 to-indigo-600 px-4 py-2 font-black uppercase text-white shadow-md shadow-violet-600/20 transition-all hover:shadow-lg" style={labelStyle}>
                    <CheckCircle2 size={16} aria-hidden="true" /> Aplicar conciliación
                  </button>
                  <button type="button" onClick={() => setConfirming(false)} className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-base bg-secondary px-4 py-2 font-black uppercase text-primary transition-colors hover:bg-subtle" style={labelStyle}>
                    Volver
                  </button>
                </div>
              </div>
            ) : (
              <div className="mt-2.5 space-y-2.5">
                <p className="font-bold text-muted" style={metaStyle}>
                  Si ya sabes qué ocurrió o encontraste el error, documenta la causa. Cuadrar la caja no borra la diferencia:
                  la deja explicada y firmada. No cambia ventas, inventario ni el arqueo declarado.
                </p>
                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="block">
                    <span className="font-black uppercase text-muted" style={labelStyle}>Causa de la diferencia</span>
                    <select
                      value={cause}
                      onChange={event => setCause(event.target.value)}
                      className="mt-1 block w-full rounded-xl border border-base bg-primary px-3 py-2.5 font-bold text-primary outline-none focus:border-violet-500"
                      style={{ fontSize: 14 }}
                    >
                      <option value="">Selecciona una causa…</option>
                      {CAUSES.map(item => <option key={item} value={item}>{item}</option>)}
                    </select>
                  </label>
                  <div className="sm:col-span-1">
                    <span className="font-black uppercase text-muted" style={labelStyle}>Descuento salarial</span>
                    <label className={cn('mt-1 flex min-h-11 items-center gap-2 rounded-xl border border-base bg-primary px-3 py-2', !hasShortage && 'opacity-50')}>
                      <input
                        type="checkbox"
                        checked={deduct && hasShortage}
                        disabled={!hasShortage}
                        onChange={event => setDeduct(event.target.checked)}
                        className="h-4 w-4 accent-violet-600"
                      />
                      <span className="font-bold text-primary" style={{ fontSize: 13 }}>Descontar el faltante</span>
                      {deduct && hasShortage && (
                        <input
                          type="number"
                          min={0}
                          value={deductAmount}
                          onChange={event => setDeductAmount(Math.max(0, Number(event.target.value) || 0))}
                          className="ml-auto w-24 rounded-lg border border-base bg-secondary px-2 py-1 text-right font-black text-primary outline-none"
                          style={{ fontSize: 13 }}
                          aria-label="Monto a descontar del salario"
                        />
                      )}
                    </label>
                  </div>
                </div>
                <label className="block">
                  <span className="font-black uppercase text-muted" style={labelStyle}>Nota de conciliación</span>
                  <textarea
                    value={notes}
                    onChange={event => setNotes(event.target.value)}
                    rows={3}
                    placeholder="Ej: Se recontó el efectivo y faltaban 250 CUP; el cajero reconoce el faltante. Se acuerda descontar de la nómina."
                    className="mt-1 block w-full resize-none rounded-xl border border-base bg-primary px-3 py-2.5 font-bold text-primary outline-none focus:border-violet-500"
                    style={{ fontSize: 14 }}
                  />
                </label>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      if (!cause) { addNotification?.('Selecciona la causa antes de continuar.', 'warning'); return; }
                      if (notes.trim().length < 5) { addNotification?.('Escribe una nota breve antes de continuar.', 'warning'); return; }
                      setConfirming(true);
                    }}
                    className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-gradient-to-r from-violet-600 to-indigo-600 px-4 py-2 font-black uppercase text-white shadow-md shadow-violet-600/20 transition-all hover:shadow-lg"
                    style={labelStyle}
                  >
                    <Scale size={16} aria-hidden="true" /> Cuadrar caja
                  </button>
                  <button type="button" onClick={saveReview} className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-base bg-secondary px-4 py-2 font-black uppercase text-primary transition-colors hover:bg-subtle" style={labelStyle}>
                    <Save size={15} aria-hidden="true" /> Guardar revisión
                  </button>
                </div>
              </div>
            )}
          </section>

          <div className="flex items-start gap-2 rounded-xl border border-base bg-subtle p-2.5">
            <Info size={15} className="mt-0.5 shrink-0 text-muted" aria-hidden="true" />
            <p className="font-bold text-muted" style={{ fontSize: 12 }}>
              Si el problema es un egreso o gasto mal registrado, corrígelo en la pestaña Movimientos: el descuadre se recalcula
              automáticamente. Si no encuentras el error, deja el turno en revisión para investigarlo después.
            </p>
          </div>
        </div>

        {/* Footer */}
        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-base bg-subtle px-4 py-3">
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => handlePrintDiscrepancyTicket(session)}
              className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-violet-200 bg-violet-50 px-3.5 py-2 font-black uppercase text-violet-700 transition-colors hover:bg-violet-100 dark:border-violet-900/60 dark:bg-violet-950/40 dark:text-violet-300 dark:hover:bg-violet-950/60"
              style={labelStyle}
            >
              <Printer size={15} aria-hidden="true" /> Comprobante de descuadre
            </button>
            <button
              type="button"
              onClick={() => handlePrintShiftTicket(session.id)}
              className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-base bg-secondary px-3.5 py-2 font-black uppercase text-primary transition-colors hover:bg-subtle"
              style={labelStyle}
            >
              <FileText size={15} aria-hidden="true" /> Ticket del turno
            </button>
          </div>
          <button
            type="button"
            onClick={() => setSelectedDiscrepancyDetailSession(null)}
            className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-slate-900 px-4 py-2 font-black uppercase text-white transition-colors hover:bg-slate-800 dark:bg-slate-700 dark:hover:bg-slate-600"
            style={labelStyle}
          >
            Cerrar
          </button>
        </footer>
      </section>
    </div>
  );
}
