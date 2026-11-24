import { CalendarDays, Filter, RotateCcw, Search, User as UserIcon, Warehouse } from "lucide-react";
import { cn } from "../../lib/utils";
import type { User } from "../../types";
import type { ReportDateFilter } from "../../modules/reports/utils/reportDateFilter";

type SessionStatus = 'all' | 'open' | 'closed' | 'cancelled';

type Props = {
  branches: { id: string; name: string }[];
  users: User[];
  branch: string;
  onBranch: (value: string) => void;
  worker: string;
  onWorker: (value: string) => void;
  period: ReportDateFilter;
  onPeriod: (value: ReportDateFilter) => void;
  date: string;
  onDate: (value: string) => void;
  status?: SessionStatus;
  onStatus?: (value: SessionStatus) => void;
  showStatus?: boolean;
};

const PERIODS: { id: ReportDateFilter; label: string }[] = [
  { id: 'all', label: 'Todo' },
  { id: 'today', label: 'Hoy' },
  { id: 'yesterday', label: 'Ayer' },
  { id: 'custom', label: 'Fecha' },
];

const STATUSES: { id: SessionStatus; label: string }[] = [
  { id: 'all', label: 'Todos' },
  { id: 'open', label: 'Abiertos' },
  { id: 'closed', label: 'Cerrados' },
  { id: 'cancelled', label: 'Anulados' },
];

function readableDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return '';
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return Number.isFinite(date.getTime())
    ? date.toLocaleDateString('es-CU', { day: '2-digit', month: 'short', year: 'numeric' })
    : value;
}

function selectClass() {
  return "h-11 w-full rounded-xl border border-base bg-secondary px-2.5 text-[12px] font-bold text-primary outline-none focus-visible:ring-2 focus-visible:ring-[#6535C5]/30 cursor-pointer sm:h-9 sm:text-[11px]";
}

/**
 * Single filter bar shared by every Reports tab. A specific date always wins
 * over the quick period buttons, and the active scope is spelled out so the
 * operator never has to guess which period the figures belong to.
 */
export function ReportsFilters({
  branches, users, branch, onBranch, worker, onWorker,
  period, onPeriod, date, onDate, status = 'all', onStatus, showStatus = false,
}: Props) {
  const hasFilters = branch !== 'all' || worker !== 'all' || !!date || period !== 'all' || status !== 'all';
  const activeLabel = date
    ? `Fecha: ${readableDate(date)}`
    : period === 'today' ? 'Hoy'
    : period === 'yesterday' ? 'Ayer'
    : 'Todo el historial';

  const clear = () => {
    onBranch('all');
    onWorker('all');
    onPeriod('all');
    onDate('');
    onStatus?.('all');
  };

  return (
    <section aria-label="Filtros de reportes" className="rounded-2xl border border-base bg-secondary p-2.5 shadow-xs">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[9rem] flex-1">
          <label className="mb-1 flex items-center gap-1 text-[8px] font-black uppercase tracking-widest text-muted" htmlFor="reports-branch-filter">
            <Warehouse className="h-3 w-3" /> Almacén
          </label>
          <select id="reports-branch-filter" value={branch} onChange={event => onBranch(event.target.value)} className={selectClass()}>
            <option value="all">Todos los almacenes</option>
            {branches.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </div>

        <div className="min-w-[9rem] flex-1">
          <label className="mb-1 flex items-center gap-1 text-[8px] font-black uppercase tracking-widest text-muted" htmlFor="reports-worker-filter">
            <UserIcon className="h-3 w-3" /> Trabajador
          </label>
          <select id="reports-worker-filter" value={worker} onChange={event => onWorker(event.target.value)} className={selectClass()}>
            <option value="all">Todo el personal</option>
            {users.filter(item => item.isActive !== false).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </div>

        <div>
          <span className="mb-1 flex items-center gap-1 text-[8px] font-black uppercase tracking-widest text-muted">
            <Filter className="h-3 w-3" /> Periodo
          </span>
          <div className="flex items-center gap-1 rounded-xl border border-base bg-subtle p-0.5" role="group" aria-label="Periodo del reporte">
            {PERIODS.map(option => (
              <button
                key={option.id}
                type="button"
                aria-pressed={!date && period === option.id}
                onClick={() => {
                  onDate('');
                  onPeriod(option.id);
                }}
                className={cn(
                  "h-11 rounded-lg px-2.5 text-[11px] font-black uppercase tracking-wider transition-colors sm:h-8 sm:text-[10px]",
                  !date && period === option.id
                    ? "bg-[#6535C5] text-white shadow-xs"
                    : "text-secondary hover:text-primary hover:bg-slate-200 dark:hover:bg-slate-800"
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="mb-1 flex items-center gap-1 text-[8px] font-black uppercase tracking-widest text-muted" htmlFor="reports-date-filter">
            <CalendarDays className="h-3 w-3" /> Día exacto
          </label>
          <input
            id="reports-date-filter"
            type="date"
            value={date}
            onChange={event => {
              onDate(event.target.value);
              if (event.target.value) onPeriod('custom');
            }}
            className={cn(selectClass(), "w-[9.5rem]")}
          />
        </div>

        {showStatus && onStatus && (
          <div>
            <label className="mb-1 block text-[8px] font-black uppercase tracking-widest text-muted" htmlFor="reports-status-filter">
              Estado del turno
            </label>
            <select id="reports-status-filter" value={status} onChange={event => onStatus(event.target.value as SessionStatus)} className={cn(selectClass(), "w-[7.5rem]")}>
              {STATUSES.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select>
          </div>
        )}

        <div className="ml-auto flex items-center gap-2 rounded-xl border border-base bg-subtle px-2.5 py-1.5">
          <Search className="h-3 w-3 shrink-0 text-muted" aria-hidden="true" />
          <span className="whitespace-nowrap text-[9px] font-black uppercase tracking-wider text-secondary" aria-live="polite">
            {activeLabel}
          </span>
          {hasFilters && (
            <button
              type="button"
              onClick={clear}
              className="inline-flex min-h-9 items-center gap-1 rounded-lg px-1.5 py-1 text-[9px] font-black uppercase tracking-wider text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40"
              title="Quitar todos los filtros"
            >
              <RotateCcw className="h-3 w-3" /> Limpiar
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
