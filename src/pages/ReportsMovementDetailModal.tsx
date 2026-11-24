import { useEffect, useState } from 'react';
import {
  AlertTriangle, ArrowDownRight, ArrowUpRight, CheckCircle2, Edit3, Info, Printer,
  Save, X,
} from 'lucide-react';
import { cn } from '../lib/utils';
import type { CashRegisterSession } from '../types';

type MovementDetail = {
  id: string;
  sessionId: string;
  turnLabel: string;
  branchId: string;
  branchName: string;
  workerName: string;
  type: 'income' | 'expense';
  amount: number;
  currencyCode: string;
  description: string;
  date: string;
  session: CashRegisterSession;
};

type Props = {
  baseCurrency: { code: string };
  currencies: { code: string; rateToBase?: number }[];
  formatMoney: (amount: number, code?: string) => string;
  handlePrintCashMovementTicket: (movement: MovementDetail) => void;
  selectedMovementDetail: MovementDetail | null;
  setSelectedMovementDetail: (movement: MovementDetail | null) => void;
  onSaveCorrection: (movementId: string, patch: { type: 'income' | 'expense'; amount: number; currencyCode: string; description: string }) => boolean;
};

const labelClass = 'font-black uppercase tracking-wider text-[10px] sm:text-[11px]';
const metaClass = 'text-[11px] sm:text-xs';

export default function ReportsMovementDetailModal({
  baseCurrency,
  currencies,
  formatMoney,
  handlePrintCashMovementTicket,
  selectedMovementDetail,
  setSelectedMovementDetail,
  onSaveCorrection,
}: Props) {
  const movement = selectedMovementDetail;
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [type, setType] = useState<'income' | 'expense'>('expense');
  const [amount, setAmount] = useState(0);
  const [currencyCode, setCurrencyCode] = useState('CUP');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!movement) return;
    setEditing(false);
    setConfirming(false);
    setError('');
    setType(movement.type);
    setAmount(movement.amount);
    setCurrencyCode(movement.currencyCode);
    setDescription(movement.description);
  }, [movement?.id]);

  // Escape closes the modal unless the operator is mid-edit or confirming a correction.
  useEffect(() => {
    if (!movement) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !editing && !confirming) setSelectedMovementDetail(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [movement, editing, confirming, setSelectedMovementDetail]);

  if (!movement) return null;

  const dateObj = new Date(movement.date);
  const rate = currencies.find(c => c.code === movement.currencyCode)?.rateToBase || 1;
  const isIncome = movement.type === 'income';
  const changed = type !== movement.type
    || Math.abs(amount - movement.amount) > 0.001
    || currencyCode !== movement.currencyCode
    || description.trim() !== (movement.description || '').trim();

  const startConfirmation = () => {
    if (!Number.isFinite(amount) || amount <= 0) {
      setError('El importe debe ser mayor que cero.');
      return;
    }
    if (!description.trim()) {
      setError('Escribe el concepto o la justificación del movimiento.');
      return;
    }
    setError('');
    setConfirming(true);
  };

  const applyCorrection = () => {
    const saved = onSaveCorrection(movement.id, {
      type,
      amount,
      currencyCode,
      description: description.trim(),
    });
    if (saved) setSelectedMovementDetail(null);
  };

  return (
    <div
      className="palmyra-overlay z-[var(--z-modal)] flex items-center justify-center p-2 sm:p-4"
      role="presentation"
      onMouseDown={event => {
        if (event.target === event.currentTarget && !editing && !confirming) setSelectedMovementDetail(null);
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="movement-detail-title"
        className="palmyra-modal-panel palmyra-mobile-modal flex w-full max-w-lg flex-col overflow-hidden"
      >
        <header className="flex items-center justify-between gap-2.5 border-b border-base bg-secondary px-3.5 py-2.5 sm:px-4 sm:py-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-white shadow-sm', isIncome ? 'bg-gradient-to-br from-emerald-500 to-teal-600' : 'bg-gradient-to-br from-red-500 to-rose-600')}>
              {isIncome ? <ArrowUpRight size={18} aria-hidden="true" /> : <ArrowDownRight size={18} aria-hidden="true" />}
            </span>
            <div className="min-w-0">
              <p className={cn(labelClass, 'truncate', isIncome ? 'text-emerald-800 dark:text-emerald-300' : 'text-red-800 dark:text-red-300')}>
                {isIncome ? 'Ingreso de caja' : 'Egreso / gasto de caja'}
              </p>
              <h2 id="movement-detail-title" className="truncate text-sm sm:text-base font-black text-primary tabular-nums">
                Vale {movement.turnLabel || 'de caja'} · {dateObj.toLocaleDateString('es-CU', { timeZone: 'America/Havana', day: '2-digit', month: 'short' })}
              </h2>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setSelectedMovementDetail(null)}
            aria-label="Cerrar detalle del movimiento"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-base bg-secondary text-muted transition-colors hover:bg-subtle hover:text-primary"
          >
            <X size={16} />
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3.5 py-3 sm:px-4 sm:py-3.5">
          <div className="rounded-2xl border border-base bg-subtle p-3 text-center">
            <span className={cn(labelClass, 'text-muted')}>Importe del movimiento</span>
            <p className={cn('mt-1 font-black font-mono leading-none tabular-nums text-xl sm:text-2xl', isIncome ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')}>
              {isIncome ? '+' : '−'}{formatMoney(movement.amount, movement.currencyCode)}
            </p>
            {movement.currencyCode !== baseCurrency.code && (
              <p className={cn('mt-1 font-bold text-muted tabular-nums', metaClass)}>
                Equivalente en {baseCurrency.code}: {formatMoney(movement.amount * rate, baseCurrency.code)}
              </p>
            )}
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {[
              { label: 'Turno', value: movement.turnLabel },
              { label: 'Sucursal', value: movement.branchName },
              { label: 'Responsable', value: movement.workerName },
              { label: 'Fecha y hora', value: dateObj.toLocaleString('es-CU', { timeZone: 'America/Havana', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) },
            ].map(item => (
              <div key={item.label} className="min-w-0 rounded-xl border border-base bg-subtle p-2.5">
                <span className={cn(labelClass, 'text-muted')}>{item.label}</span>
                <p className={cn('mt-0.5 truncate font-bold text-primary tabular-nums', metaClass)} title={item.value}>{item.value}</p>
              </div>
            ))}
          </div>

          <div className="rounded-2xl border border-base bg-subtle p-2.5 sm:p-3">
            <span className={cn(labelClass, 'text-muted')}>Concepto / justificación</span>
            <p className={cn('mt-1 font-bold leading-relaxed text-primary break-words', metaClass)}>
              {movement.description || 'Sin descripción especificada'}
            </p>
          </div>

          {!editing && !confirming && (
            <div className="flex items-start gap-2 rounded-xl border border-base bg-secondary p-2.5">
              <Info size={15} className="mt-0.5 shrink-0 text-muted" aria-hidden="true" />
              <p className={cn('font-bold text-muted', metaClass)}>
                Si este egreso o gasto está mal registrado, corrígelo aquí. El descuadre del turno se recalcula automáticamente
                y conserva la evidencia anterior en las notas de auditoría.
              </p>
            </div>
          )}

          {editing && !confirming && (
            <div className="space-y-2.5 rounded-2xl border border-violet-200 bg-violet-50/60 p-3 dark:border-violet-900/60 dark:bg-violet-950/25">
              <h3 className={cn(labelClass, 'flex items-center gap-1.5 text-violet-800 dark:text-violet-300')}>
                <Edit3 size={14} aria-hidden="true" /> Corregir movimiento
              </h3>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <label className="block">
                  <span className={cn(labelClass, 'text-muted')}>Tipo</span>
                  <select
                    value={type}
                    onChange={event => setType(event.target.value as 'income' | 'expense')}
                    className="mt-1 block h-9 w-full rounded-xl border border-base bg-primary px-2.5 font-bold text-primary outline-none focus:border-violet-500 text-[13px] sm:text-sm"
                  >
                    <option value="expense">Egreso / gasto</option>
                    <option value="income">Ingreso / entrada</option>
                  </select>
                </label>
                <label className="block">
                  <span className={cn(labelClass, 'text-muted')}>Moneda</span>
                  <select
                    value={currencyCode}
                    onChange={event => setCurrencyCode(event.target.value)}
                    className="mt-1 block h-9 w-full rounded-xl border border-base bg-primary px-2.5 font-bold text-primary outline-none focus:border-violet-500 text-[13px] sm:text-sm"
                  >
                    {currencies.map(currency => <option key={currency.code} value={currency.code}>{currency.code}</option>)}
                  </select>
                </label>
              </div>
              <label className="block">
                <span className={cn(labelClass, 'text-muted')}>Importe</span>
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={amount}
                  onChange={event => setAmount(Math.max(0, Number(event.target.value) || 0))}
                  className="mt-1 block h-9 w-full rounded-xl border border-base bg-primary px-3 font-black font-mono text-primary tabular-nums outline-none focus:border-violet-500 text-[13px] sm:text-sm"
                />
              </label>
              <label className="block">
                <span className={cn(labelClass, 'text-muted')}>Concepto</span>
                <input
                  type="text"
                  value={description}
                  onChange={event => setDescription(event.target.value)}
                  className="mt-1 block h-9 w-full rounded-xl border border-base bg-primary px-3 font-bold text-primary outline-none focus:border-violet-500 text-[13px] sm:text-sm"
                />
              </label>
              {error && <p className={cn('font-bold text-red-600 dark:text-red-400', metaClass)} role="alert">{error}</p>}
              <div className="flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  onClick={startConfirmation}
                  disabled={!changed}
                  className="inline-flex h-9 items-center gap-2 rounded-xl bg-gradient-to-r from-violet-600 to-indigo-600 px-3.5 font-black uppercase text-white shadow-sm transition-all hover:shadow-md disabled:opacity-50 text-[10px] sm:text-[11px]"
                >
                  <Save size={14} aria-hidden="true" /> Guardar corrección
                </button>
                <button
                  type="button"
                  onClick={() => { setEditing(false); setError(''); }}
                  className="inline-flex h-9 items-center gap-2 rounded-xl border border-base bg-secondary px-3.5 font-black uppercase text-primary transition-colors hover:bg-subtle text-[10px] sm:text-[11px]"
                >
                  Cancelar
                </button>
              </div>
            </div>
          )}

          {confirming && (
            <div className="space-y-2.5 rounded-2xl border border-amber-300 bg-amber-50/70 p-3 dark:border-amber-900/60 dark:bg-amber-950/30">
              <div className="flex items-start gap-2">
                <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
                <div className="min-w-0">
                  <p className={cn('font-black text-amber-900 dark:text-amber-200', metaClass)}>Confirma la corrección</p>
                  <p className={cn('mt-0.5 font-bold text-amber-900/80 dark:text-amber-200/80', metaClass)}>
                    {movement.type === 'income' ? 'Ingreso' : 'Egreso'} de {formatMoney(movement.amount, movement.currencyCode)} pasará a
                    {' '}{type === 'income' ? 'ingreso' : 'egreso'} de {formatMoney(amount, currencyCode)}.
                    El descuadre del turno se recalculará con este nuevo valor; las ventas y el inventario no cambian.
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  onClick={applyCorrection}
                  className="inline-flex h-9 items-center gap-2 rounded-xl bg-gradient-to-r from-violet-600 to-indigo-600 px-3.5 font-black uppercase text-white shadow-sm transition-all hover:shadow-md text-[10px] sm:text-[11px]"
                >
                  <CheckCircle2 size={14} aria-hidden="true" /> Aplicar corrección
                </button>
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  className="inline-flex h-9 items-center gap-2 rounded-xl border border-base bg-secondary px-3.5 font-black uppercase text-primary transition-colors hover:bg-subtle text-[10px] sm:text-[11px]"
                >
                  Volver
                </button>
              </div>
            </div>
          )}
        </div>

        <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-base bg-subtle px-3.5 py-2.5 sm:px-4 sm:py-3">
          <button
            type="button"
            onClick={() => handlePrintCashMovementTicket(movement)}
            className="inline-flex h-9 items-center gap-2 rounded-xl border border-base bg-secondary px-3.5 font-black uppercase text-primary transition-colors hover:bg-subtle text-[10px] sm:text-[11px]"
          >
            <Printer size={14} aria-hidden="true" /> Imprimir vale
          </button>
          {!editing && !confirming && (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="inline-flex h-9 items-center gap-2 rounded-xl border border-violet-200 bg-violet-50 px-3.5 font-black uppercase text-violet-700 transition-colors hover:bg-violet-100 dark:border-violet-900/60 dark:bg-violet-950/40 dark:text-violet-300 text-[10px] sm:text-[11px]"
            >
              <Edit3 size={14} aria-hidden="true" /> Corregir
            </button>
          )}
          <button
            type="button"
            onClick={() => setSelectedMovementDetail(null)}
            className="inline-flex h-9 items-center gap-2 rounded-xl bg-slate-900 px-4 font-black uppercase text-white transition-colors hover:bg-slate-800 dark:bg-slate-700 dark:hover:bg-slate-600 text-[10px] sm:text-[11px]"
          >
            Cerrar
          </button>
        </footer>
      </section>
    </div>
  );
}
