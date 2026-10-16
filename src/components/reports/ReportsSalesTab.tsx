import { useMemo, useState } from "react";
import {
  AlertCircle,
  CheckCircle,
  Eye,
  FileSpreadsheet,
  Printer,
  Trash2,
  TrendingUp,
  Users,
} from "lucide-react";
import { cn } from "../../lib/utils";
import type { CashRegisterSession, Transaction, User } from "../../types";

type PayrollRow = {
  sessionId: string;
  totalSalary?: number;
};

type Props = {
  sessions: CashRegisterSession[];
  transactions: Transaction[];
  payroll: PayrollRow[];
  users: User[];
  branches: { id: string; name: string }[];
  sessionTurnMap: Map<string, number | string>;
  salesViewMode: "by_shift" | "all_tickets";
  setSalesViewMode: (mode: "by_shift" | "all_tickets") => void;
  formatMoney: (amount: number, code?: string) => string;
  onRequestCloseSession: (session: CashRegisterSession) => void;
  onOpenSessionDetail: (sessionId: string) => void;
  onPrintShiftTicket: (sessionId: string) => void;
  onOpenTransactionDetail: (transaction: Transaction) => void;
  onVoidTransaction: (transaction: Transaction) => void | Promise<void>;
};

export function ReportsSalesTab({
  sessions,
  transactions,
  payroll,
  users,
  branches,
  sessionTurnMap,
  salesViewMode,
  setSalesViewMode,
  formatMoney,
  onRequestCloseSession,
  onOpenSessionDetail,
  onPrintShiftTicket,
  onOpenTransactionDetail,
  onVoidTransaction,
}: Props) {
  const [sortState, setSortState] = useState<{ scope: "sessions" | "transactions"; key: string; direction: "asc" | "desc" } | null>(null);

  const toggleSort = (scope: "sessions" | "transactions", key: string) => {
    setSortState(current => current?.scope === scope && current.key === key
      ? { scope, key, direction: current.direction === "asc" ? "desc" : "asc" }
      : { scope, key, direction: "asc" });
  };

  const sortIndicator = (scope: "sessions" | "transactions", key: string) =>
    sortState?.scope === scope && sortState.key === key ? (sortState.direction === "asc" ? " ↑" : " ↓") : " ↕";

  const sortedSessions = useMemo(() => {
    if (!sortState || sortState.scope !== "sessions") return sessions;
    const value = (session: CashRegisterSession): string | number => {
      const sessionOpenMs = new Date(session.openedAt).getTime();
      const sessionCloseMs = session.closedAt ? new Date(session.closedAt).getTime() : Infinity;
      const txs = transactions.filter(tx => {
        if (tx.deletedAt) return false;
        if (tx.sessionId === session.id) return true;
        if (tx.sessionId || tx.status !== "completed" || tx.branchId !== session.branchId) return false;
        const txTime = new Date(tx.date).getTime();
        return Number.isFinite(txTime) && txTime >= sessionOpenMs && txTime <= sessionCloseMs;
      });
      const payrollItem = payroll.find(item => item.sessionId === session.id);
      switch (sortState.key) {
        case "turn": {
          const turn = sessionTurnMap.get(session.id);
          const numeric = Number(String(turn ?? "").replace(/[^0-9.-]/g, ""));
          return Number.isFinite(numeric) && String(turn ?? "").match(/\d/) ? numeric : String(turn ?? session.id).toLocaleLowerCase();
        }
        case "status": return session.status;
        case "date": return new Date(session.closingDate || session.closedAt || session.openedAt || 0).getTime() || 0;
        case "worker": return (session.workerName || users.find(user => user.id === session.userId)?.name || "").toLocaleLowerCase();
        case "branch": return (branches.find(branch => branch.id === session.branchId)?.name || "").toLocaleLowerCase();
        case "products": return txs.reduce((sum, tx) => sum + (tx.items || []).reduce((n, item) => n + (Number(item.quantity) || 0), 0), 0);
        case "total": return txs.reduce((sum, tx) => sum + (Number(tx.total) || 0), 0);
        case "salary": return Number(payrollItem?.totalSalary) || 0;
        default: return 0;
      }
    };
    return [...sessions].sort((a, b) => {
      const av = value(a), bv = value(b);
      const compared = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv), "es", { numeric: true, sensitivity: "base" });
      return (sortState.direction === "asc" ? compared : -compared) || a.id.localeCompare(b.id);
    });
  }, [sessions, transactions, payroll, users, branches, sessionTurnMap, sortState]);

  const sortedTransactions = useMemo(() => {
    if (!sortState || sortState.scope !== "transactions") return transactions;
    const value = (tx: Transaction): string | number => {
      const worker = users.find(user => user.id === tx.userId);
      switch (sortState.key) {
        case "ticket": return (tx.ticketNumber || tx.id).toLocaleLowerCase();
        case "type": return tx.status;
        case "date": return new Date(tx.date || 0).getTime() || 0;
        case "worker": return (tx.cashierName || worker?.name || "").toLocaleLowerCase();
        case "branch": return (branches.find(branch => branch.id === tx.branchId)?.name || "").toLocaleLowerCase();
        case "items": return (tx.items || []).reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
        case "total": return Number(tx.total) || 0;
        default: return 0;
      }
    };
    return [...transactions].sort((a, b) => {
      const av = value(a), bv = value(b);
      const compared = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv), "es", { numeric: true, sensitivity: "base" });
      return (sortState.direction === "asc" ? compared : -compared) || a.id.localeCompare(b.id);
    });
  }, [transactions, users, branches, sortState]);

  const sortableHeader = (label: string, scope: "sessions" | "transactions", key: string, align = "") => (
    <button type="button" onClick={() => toggleSort(scope, key)} className={cn("inline-flex items-center gap-1 cursor-pointer hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-rose-500", align)} aria-label={`Ordenar por ${label}`}>
      {label}<span aria-hidden="true">{sortIndicator(scope, key)}</span>
    </button>
  );

  return (
    <div className="space-y-4 animate-in fade-in duration-200">
      <div className="bg-secondary rounded-2xl shadow-sm border border-base p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h3 className="text-xs font-black text-primary uppercase tracking-wider flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-rose-600 dark:text-rose-400" />
            Registro de Ventas Comerciales
          </h3>
          <p className="text-[8px] font-bold text-muted uppercase tracking-widest mt-0.5">
            Ventas consecutivas lineales por turno y tickets individuales
          </p>
        </div>

        <div className="flex items-center gap-1.5 bg-subtle p-1 rounded-xl border border-base shrink-0">
          <button
            type="button"
            onClick={() => setSalesViewMode("by_shift")}
            className={cn(
              "px-3 py-1.5 rounded-lg text-[9px] font-black uppercase tracking-wider transition-all flex items-center gap-1.5 cursor-pointer",
              salesViewMode === "by_shift"
                ? "bg-rose-600 text-white shadow-xs"
                : "text-secondary hover:text-primary"
            )}
          >
            <Users className="w-3.5 h-3.5" />
            <span>Por Turnos ({sessions.length})</span>
          </button>

          <button
            type="button"
            onClick={() => setSalesViewMode("all_tickets")}
            className={cn(
              "px-3 py-1.5 rounded-lg text-[9px] font-black uppercase tracking-wider transition-all flex items-center gap-1.5 cursor-pointer",
              salesViewMode === "all_tickets"
                ? "bg-rose-600 text-white shadow-xs"
                : "text-secondary hover:text-primary"
            )}
          >
            <FileSpreadsheet className="w-3.5 h-3.5" />
            <span>Todos los Tickets ({transactions.length})</span>
          </button>
        </div>
      </div>

      {salesViewMode === "by_shift" ? (
        <div className="bg-secondary rounded-2xl shadow-sm border border-base overflow-hidden">
          <div className="p-3 border-b border-base flex items-center justify-between bg-subtle/50">
            <span className="text-[9px] font-black text-primary uppercase tracking-wider">
              Listado Consecutivo de Turnos de Caja
            </span>
            <span className="text-[9px] font-bold text-muted">
              {sessions.length} turnos encontrados
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-subtle border-b border-base text-[8px] font-black text-muted uppercase tracking-[0.15em]">
                  <th className="px-3 py-2.5">{sortableHeader("Turno", "sessions", "turn")}</th>
                  <th className="px-3 py-2.5 text-center">{sortableHeader("Estado", "sessions", "status")}</th>
                  <th className="px-3 py-2.5">{sortableHeader("Fecha y Hora", "sessions", "date")}</th>
                  <th className="px-3 py-2.5">{sortableHeader("Vendedor / Sucursal", "sessions", "worker")}</th>
                  <th className="px-3 py-2.5 text-center">{sortableHeader("Productos", "sessions", "products")}</th>
                  <th className="px-3 py-2.5 text-right">{sortableHeader("Venta Total", "sessions", "total", "justify-end")}</th>
                  <th className="px-3 py-2.5 text-right">{sortableHeader("Salario Liquidado", "sessions", "salary", "justify-end")}</th>
                  <th className="px-3 py-2.5 text-center">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-base">
                {sortedSessions.map((session, idx) => {
                  const sessionOpenMs = new Date(session.openedAt).getTime();
                  const sessionCloseMs = session.closedAt ? new Date(session.closedAt).getTime() : Infinity;
                  const sessionTx = transactions.filter((transaction) => {
                    if (transaction.deletedAt) return false;
                    if (transaction.sessionId === session.id) return true;
                    if (transaction.sessionId || transaction.status !== "completed" || transaction.branchId !== session.branchId) return false;
                    const transactionTime = new Date(transaction.date).getTime();
                    return Number.isFinite(transactionTime) && transactionTime >= sessionOpenMs && transactionTime <= sessionCloseMs;
                  });
                  const totalSalesInSession = sessionTx.reduce(
                    (sum, transaction) => sum + (transaction.total || 0),
                    0
                  );
                  const totalItems = sessionTx.reduce(
                    (sum, transaction) =>
                      sum +
                      (transaction.items || []).reduce(
                        (itemSum, item) => itemSum + (item.quantity || 0),
                        0
                      ),
                    0
                  );
                  const sequentialTurn =
                    sessionTurnMap.get(session.id) || session.id;
                  const dateToDisplay = new Date(
                    session.closingDate ||
                      session.closedAt ||
                      session.openedAt
                  );
                  const payrollItem = payroll.find(
                    (item) => item.sessionId === session.id
                  );
                  const branchName =
                    branches.find((branch) => branch.id === session.branchId)
                      ?.name || "Sucursal Principal";
                  const workerName =
                    session.workerName ||
                    users.find((user) => user.id === session.userId)?.name ||
                    "Vendedor";

                  return (
                    <tr
                      key={`${session.id || "sess"}-${session.openedAt || ""}-${idx}`}
                      className="hover:bg-subtle transition-colors"
                    >
                      <td className="px-3 py-2 whitespace-nowrap">
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-black bg-rose-50 dark:bg-rose-950/50 text-rose-700 dark:text-rose-300 border border-rose-100 dark:border-rose-900/50 tracking-wider">
                          {sequentialTurn}
                        </span>
                      </td>

                      <td className="px-3 py-2 text-center whitespace-nowrap">
                        <span
                          className={cn(
                            "px-2 py-0.5 rounded text-[7px] font-black uppercase tracking-widest",
                            session.status === "open"
                              ? "bg-emerald-50 text-emerald-700 border border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800"
                              : session.status === "cancelled"
                                ? "bg-rose-50 text-rose-700 border border-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-800"
                                : "bg-slate-100 text-slate-600 border border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700"
                          )}
                        >
                          {session.status === "open"
                            ? "Abierto"
                            : session.status === "cancelled"
                              ? "Cancelado"
                              : "Cerrado"}
                        </span>
                      </td>

                      <td className="px-3 py-2 whitespace-nowrap">
                        <div className="flex items-center gap-1.5 text-[11px] font-bold text-primary">
                          <span>
                            {dateToDisplay.toLocaleDateString("es-ES", {
                              day: "2-digit",
                              month: "2-digit",
                              year: "numeric",
                            })}
                          </span>
                          <span className="text-[9px] font-medium text-muted">
                            {dateToDisplay.toLocaleTimeString([], {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                            {session.status === "open" && " (En curso)"}
                          </span>
                        </div>
                      </td>

                      <td className="px-3 py-2 whitespace-nowrap">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[11px] font-black text-primary uppercase whitespace-normal break-words">
                            {workerName}
                          </span>
                          <span className="text-[8px] font-bold text-muted uppercase bg-subtle px-1.5 py-0.5 rounded border border-base">
                            {branchName}
                          </span>
                        </div>
                      </td>

                      <td className="px-3 py-2 text-center whitespace-nowrap">
                        <span className="bg-subtle text-muted px-2 py-0.5 rounded text-[9px] font-black uppercase border border-base">
                          {totalItems} prods
                        </span>
                      </td>

                      <td className="px-3 py-2 text-right font-black text-primary text-xs sm:text-sm tracking-tight whitespace-nowrap">
                        {formatMoney(totalSalesInSession)}
                      </td>

                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        <span className="text-[11px] font-black text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/50 px-2 py-0.5 rounded border border-emerald-100 dark:border-emerald-900/30">
                          {formatMoney(payrollItem?.totalSalary || 0)}
                        </span>
                      </td>

                      <td className="px-3 py-2 text-center whitespace-nowrap">
                        <div className="flex items-center justify-center gap-1.5">
                          {session.status === "open" && (
                            <button
                              onClick={() => onRequestCloseSession(session)}
                              title="Cerrar Turno de Caja"
                              className="h-7 px-2.5 inline-flex items-center justify-center gap-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-[9px] font-black uppercase tracking-wider transition-all active:scale-95 shadow-2xs cursor-pointer"
                            >
                              <CheckCircle className="w-3 h-3" />
                              <span>Cerrar</span>
                            </button>
                          )}
                          <button
                            onClick={() => onOpenSessionDetail(session.id)}
                            title="Ver Detalle Completo del Turno"
                            className="h-7 px-2.5 inline-flex items-center justify-center gap-1 bg-rose-50 hover:bg-rose-100 dark:bg-rose-950/60 dark:hover:bg-rose-900/80 text-rose-700 dark:text-rose-300 rounded-lg text-[9px] font-black uppercase tracking-wider border border-rose-200 dark:border-rose-900/50 transition-all active:scale-95 shadow-2xs cursor-pointer"
                          >
                            <Eye className="w-3 h-3 text-rose-600 dark:text-rose-400" />
                            <span>Detalle</span>
                          </button>
                          <button
                            onClick={() => onPrintShiftTicket(session.id)}
                            title="Imprimir Comprobante Térmico"
                            className="h-7 w-7 p-0 inline-flex items-center justify-center bg-subtle text-primary rounded-lg hover:bg-slate-200 dark:hover:bg-slate-800 transition-all active:scale-95 border border-base cursor-pointer shadow-2xs"
                          >
                            <Printer className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}

                {sessions.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-6 py-10 text-center text-muted">
                      <AlertCircle className="w-7 h-7 mx-auto mb-1.5 opacity-40" />
                      <p className="font-black uppercase text-[10px] tracking-wider">
                        No se encontraron turnos para el filtro seleccionado.
                      </p>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="bg-secondary rounded-2xl shadow-sm border border-base overflow-hidden">
          <div className="p-3 border-b border-base flex items-center justify-between bg-subtle/50">
            <span className="text-[9px] font-black text-primary uppercase tracking-wider flex items-center gap-1.5">
              <FileSpreadsheet className="w-3.5 h-3.5 text-rose-600" />
              Listado Detallado de Tickets y Facturas Individuales
            </span>
            <span className="text-[9px] font-bold text-muted">
              {transactions.length} ventas / facturas registradas
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-subtle border-b border-base text-[8px] font-black text-muted uppercase tracking-[0.15em]">
                  <th className="px-3 py-2.5">{sortableHeader("Ticket / Vale", "transactions", "ticket")}</th>
                  <th className="px-3 py-2.5">{sortableHeader("Tipo Venta", "transactions", "type")}</th>
                  <th className="px-3 py-2.5">{sortableHeader("Fecha y Hora", "transactions", "date")}</th>
                  <th className="px-3 py-2.5">{sortableHeader("Vendedor / Cajero", "transactions", "worker")}</th>
                  <th className="px-3 py-2.5">{sortableHeader("Sucursal / Almacén", "transactions", "branch")}</th>
                  <th className="px-3 py-2.5">{sortableHeader("Artículos", "transactions", "items")}</th>
                  <th className="px-3 py-2.5 text-right">{sortableHeader("Total", "transactions", "total", "justify-end")}</th>
                  <th className="px-3 py-2.5 text-center">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-base">
                {sortedTransactions.map((tx) => {
                  const branchName =
                    branches.find((branch) => branch.id === tx.branchId)?.name ||
                    "Sucursal";
                  const worker = users.find((user) => user.id === tx.userId);
                  const workerName =
                    tx.cashierName || worker?.name || "Vendedor";
                  const totalItems = (tx.items || []).reduce(
                    (sum, item) => sum + (item.quantity || 0),
                    0
                  );
                  const dateObj = new Date(tx.date);

                  return (
                    <tr key={tx.id} className="hover:bg-subtle transition-colors">
                      <td className="px-3 py-2 whitespace-nowrap">
                        <span
                          className={cn(
                            "inline-flex items-center px-2 py-0.5 rounded text-[9px] font-black font-mono border tracking-wider",
                            "bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-800"
                          )}
                        >
                          {tx.id}
                        </span>
                      </td>

                      <td className="px-3 py-2 whitespace-nowrap">
                        <span
                          className={cn(
                            "px-2 py-0.5 rounded text-[7px] font-black uppercase tracking-wider",
                            "bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300 border border-rose-200 dark:border-rose-800"
                          )}
                        >
                          Venta POS
                        </span>
                      </td>

                      <td className="px-3 py-2 whitespace-nowrap">
                        <div className="flex items-center gap-1 text-[11px] font-bold text-primary">
                          <span>
                            {dateObj.toLocaleDateString("es-ES", {
                              day: "2-digit",
                              month: "2-digit",
                              year: "numeric",
                            })}
                          </span>
                          <span className="text-[9px] font-mono text-muted">
                            {dateObj.toLocaleTimeString([], {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </span>
                        </div>
                      </td>

                      <td className="px-3 py-2 whitespace-nowrap">
                        <span className="text-[11px] font-black text-primary uppercase">
                          {workerName}
                        </span>
                      </td>

                      <td className="px-3 py-2 whitespace-nowrap">
                        <span className="text-[8px] font-bold text-muted uppercase bg-subtle px-1.5 py-0.5 rounded border border-base">
                          {branchName}
                        </span>
                      </td>

                      <td className="px-3 py-2 whitespace-nowrap">
                        <span className="bg-subtle text-muted px-2 py-0.5 rounded text-[9px] font-black uppercase border border-base">
                          {totalItems} uds ({(tx.items || []).length} items)
                        </span>
                      </td>

                      <td className="px-3 py-2 text-right font-black text-primary text-xs whitespace-nowrap">
                        {formatMoney(tx.total)}
                      </td>

                      <td className="px-3 py-2 text-center whitespace-nowrap">
                        <div className="flex items-center justify-center gap-1.5">
                          <button
                            onClick={() => onOpenTransactionDetail(tx)}
                            title="Ver Detalle del Ticket de Venta"
                            className="h-7 px-2.5 inline-flex items-center justify-center gap-1 bg-rose-50 hover:bg-rose-100 dark:bg-rose-950/60 dark:hover:bg-rose-900/80 text-rose-700 dark:text-rose-300 rounded-lg text-[9px] font-black uppercase tracking-wider border border-rose-200 dark:border-rose-900/50 transition-all active:scale-95 shadow-2xs cursor-pointer"
                          >
                            <Eye className="w-3 h-3 text-rose-600 dark:text-rose-400" />
                            <span>Detalle</span>
                          </button>
                          <button
                            onClick={() => {
                              if (tx.sessionId) onPrintShiftTicket(tx.sessionId);
                            }}
                            title="Imprimir Ticket Térmico"
                            className="h-7 w-7 p-0 inline-flex items-center justify-center bg-subtle text-primary rounded-lg hover:bg-slate-200 dark:hover:bg-slate-800 transition-all border border-base active:scale-95 cursor-pointer shadow-2xs"
                          >
                            <Printer className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => void onVoidTransaction(tx)}
                            title="Anular Venta"
                            className="h-7 w-7 p-0 inline-flex items-center justify-center bg-rose-50 hover:bg-rose-100 text-rose-600 rounded-lg transition-all border border-rose-200 active:scale-95 cursor-pointer shadow-2xs"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}

                {transactions.length === 0 && (
                  <tr>
                    <td
                      colSpan={8}
                      className="px-6 py-10 text-center text-muted text-[10px] font-bold uppercase"
                    >
                      No se encontraron transacciones para el filtro seleccionado.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
