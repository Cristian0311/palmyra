import { Calculator, CheckCircle2, Clock, Eye, Printer, User } from "lucide-react";
import { cn } from "../../lib/utils";

export type PayrollRowView = {
  settlementId?: string;
  sessionId: string;
  turnLabel: string;
  date: string;
  workerName: string;
  userId: string;
  branchId: string;
  baseSalary: number;
  commissions: number;
  totalSalary: number;
  discrepancyDeduction: number;
  totalSales: number;
  totalItems: number;
  status: "pending" | "paid";
  sessionTx: unknown[];
};

export type AggregatedPayrollRowView = {
  userId: string;
  workerName: string;
  shiftsCount: number;
  totalSales: number;
  totalBaseSalary: number;
  totalCommissions: number;
  totalSalary: number;
  totalDeductions?: number;
  pendingSalary: number;
  paidSalary: number;
};

type Props = {
  payroll: PayrollRowView[];
  aggregatedByWorker: AggregatedPayrollRowView[];
  branches: { id: string; name: string }[];
  formatMoney: (amount: number, code?: string) => string;
  onTogglePayment: (item: PayrollRowView) => void | Promise<void>;
  onOpenSession: (sessionId: string) => void;
  onPrintShiftTicket: (sessionId: string) => void;
};

const KPI = ({ label, value, tone }: { label: string; value: string; tone: string }) => (
  <div className="bg-secondary p-3 rounded-2xl shadow-sm border border-base">
    <span className="text-[8px] font-black text-muted uppercase tracking-widest block">{label}</span>
    <p className={cn("text-base font-black mt-0.5", tone)}>{value}</p>
  </div>
);

export function ReportsPayrollTab({
  payroll,
  aggregatedByWorker,
  branches,
  formatMoney,
  onTogglePayment,
  onOpenSession,
  onPrintShiftTicket,
}: Props) {
  const totalSalary = payroll.reduce((sum, item) => sum + item.totalSalary, 0);
  const totalCommissions = payroll.reduce((sum, item) => sum + item.commissions, 0);
  const totalBase = payroll.reduce((sum, item) => sum + item.baseSalary, 0);

  return (
    <div className="space-y-4 animate-in fade-in duration-200">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <KPI label="Total Nómina Neta" value={formatMoney(totalSalary)} tone="text-violet-600 dark:text-violet-300" />
        <KPI label="Total Comisiones" value={formatMoney(totalCommissions)} tone="text-emerald-600 dark:text-emerald-400" />
        <KPI label="Total Salarios Base" value={formatMoney(totalBase)} tone="text-primary" />
        <KPI label="Turnos Computados" value={`${payroll.length} Turnos`} tone="text-primary" />
      </div>

      <div className="bg-secondary rounded-2xl shadow-sm border border-base overflow-hidden">
        <div className="p-3.5 border-b border-base flex flex-col sm:flex-row sm:items-center justify-between gap-2 bg-violet-50/30 dark:bg-violet-950/20">
          <div>
            <h3 className="text-xs font-black text-primary uppercase tracking-wider flex items-center gap-2">
              <Calculator className="w-4 h-4 text-violet-600 dark:text-violet-300" />
              Liquidación Diaria de Salarios por Turno Cerrado
            </h3>
            <p className="text-[8px] font-bold text-muted uppercase tracking-widest mt-0.5">
              Fecha de salario, turno lineal consecutivo, ventas, comisiones y liquidación exacta
            </p>
          </div>
          <span className="text-[9px] font-black text-violet-600 dark:text-violet-300 uppercase tracking-wider">
            {payroll.length} liquidaciones
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[940px] text-left border-collapse">
            <thead>
              <tr className="bg-subtle border-b border-base text-[8px] font-black text-muted uppercase tracking-[0.15em]">
                <th className="px-3 py-2.5">Turno</th>
                <th className="px-3 py-2.5">Fecha Salario</th>
                <th className="px-3 py-2.5">Trabajador / Sucursal</th>
                <th className="px-3 py-2.5 text-right">Ventas Turno</th>
                <th className="px-3 py-2.5 text-right">Salario Base</th>
                <th className="px-3 py-2.5 text-right">Comisión</th>
                <th className="px-3 py-2.5 text-right">Total a Liquidar</th>
                <th className="px-3 py-2.5 text-center">Estado</th>
                <th className="px-3 py-2.5 text-center">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-base">
              {payroll.map((item, idx) => {
                const dateObj = new Date(item.date);
                const branchName = branches.find(b => b.id === item.branchId)?.name || 'Sucursal Principal';
                return (
                  <tr key={`${item.sessionId || 'pay'}-${item.date || ''}-${idx}`} className="hover:bg-subtle transition-colors">
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-black bg-subtle text-secondary border border-base tracking-wider">
                        {item.turnLabel}
                      </span>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <div className="flex items-center gap-1.5 text-[11px] font-bold text-primary">
                        <span>{dateObj.toLocaleDateString('es-CU', { timeZone: 'America/Havana', day: '2-digit', month: '2-digit', year: 'numeric' })}</span>
                        <span className="text-[9px] font-medium text-muted">{dateObj.toLocaleTimeString('es-CU', { timeZone: 'America/Havana', hour: '2-digit', minute: '2-digit' })}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[11px] font-black text-primary uppercase">{item.workerName}</span>
                        <span className="text-[8px] font-bold text-muted uppercase bg-subtle px-1.5 py-0.5 rounded border border-base">
                          {branchName}
                        </span>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      <div className="flex items-center justify-end gap-1 text-[10px]">
                        <span className="font-black text-primary">{formatMoney(item.totalSales)}</span>
                        <span className="text-[8px] font-bold text-muted">({item.totalItems}p)</span>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right text-[10px] font-bold text-primary whitespace-nowrap opacity-80">
                      {formatMoney(item.baseSalary)}
                    </td>
                    <td className="px-3 py-2 text-right text-[10px] font-bold text-emerald-600 dark:text-emerald-400 whitespace-nowrap">
                      +{formatMoney(item.commissions)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <span className="text-xs font-black text-emerald-700 dark:text-emerald-400 tracking-tight bg-emerald-50 dark:bg-emerald-950/50 px-2 py-0.5 rounded-lg border border-emerald-100 dark:border-emerald-900/30">
                        {formatMoney(item.totalSalary)}
                      </span>
                      {item.discrepancyDeduction > 0 && (
                        // El total es neto; sin este detalle no cuadraba con base + comisión.
                        <span className="mt-0.5 block text-[8px] font-bold uppercase text-rose-600 dark:text-rose-400">
                          −{formatMoney(item.discrepancyDeduction)} descuadre
                        </span>
                      )}
                    </td>

                    <td className="px-3 py-2 text-center whitespace-nowrap">
                      <button
                        type="button"
                        onClick={() => void onTogglePayment(item)}
                        aria-label={item.status === 'paid' ? 'Marcar liquidación como pendiente' : 'Marcar liquidación como pagada'}
                        className={cn(
                          "px-2.5 py-0.5 rounded-full text-[8px] font-black uppercase tracking-wider transition-all border cursor-pointer",
                          item.status === 'paid'
                            ? "bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-900/50 hover:bg-emerald-100 dark:hover:bg-emerald-900/70"
                            : "bg-amber-50 dark:bg-amber-950/50 text-amber-700 dark:text-amber-400 border-amber-200 dark:border-amber-900/50 hover:bg-amber-100 dark:hover:bg-amber-900/70"
                        )}
                      >
                        {item.status === 'paid' ? (
                          <span className="inline-flex items-center gap-1"><CheckCircle2 className="w-3 h-3" />Pagado</span>
                        ) : (
                          <span className="inline-flex items-center gap-1"><Clock className="w-3 h-3" />Pendiente</span>
                        )}
                      </button>
                    </td>

                    <td className="px-3 py-2 text-center whitespace-nowrap">
                      <div className="flex items-center justify-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => onOpenSession(item.sessionId)}
                          title="Ver Detalle del Turno y Liquidación"
                          aria-label="Ver detalle del turno y liquidación"
                          className="h-7 px-2.5 inline-flex items-center justify-center gap-1 bg-violet-50 hover:bg-violet-100 dark:bg-violet-950/50 dark:hover:bg-violet-900/60 text-violet-700 dark:text-violet-300 text-[9px] font-black uppercase rounded-lg border border-violet-200 dark:border-violet-900/50 transition-all active:scale-95 shadow-2xs cursor-pointer"
                        >
                          <Eye className="w-3 h-3 text-violet-600 dark:text-violet-300" />
                          <span>Detalle</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => onPrintShiftTicket(item.sessionId)}
                          title="Imprimir Comprobante de Liquidación"
                          aria-label="Imprimir comprobante de liquidación"
                          className="h-7 w-7 p-0 inline-flex items-center justify-center bg-subtle text-primary rounded-lg hover:bg-secondary transition-all border border-base active:scale-95 cursor-pointer shadow-2xs"
                        >
                          <Printer className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}

              {payroll.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-6 py-10 text-center text-muted font-bold uppercase text-[10px]">
                    No hay turnos cerrados con nómina calculada para el filtro seleccionado.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="bg-secondary rounded-2xl shadow-sm border border-base overflow-hidden">
        <div className="p-3.5 border-b border-base bg-subtle/50">
          <h3 className="text-[11px] font-black text-primary uppercase tracking-wider flex items-center gap-2">
            <User className="w-3.5 h-3.5 text-violet-600 dark:text-violet-300" />
            Resumen Acumulado por Trabajador
          </h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-left border-collapse">
            <thead>
              <tr className="bg-subtle border-b border-base text-[8px] font-black text-muted uppercase tracking-[0.15em]">
                <th className="px-3 py-2.5">Trabajador</th>
                <th className="px-3 py-2.5 text-center">Turnos Realizados</th>
                <th className="px-3 py-2.5 text-right">Ventas Totales</th>
                <th className="px-3 py-2.5 text-right">Salario Base Acumulado</th>
                <th className="px-3 py-2.5 text-right">Comisiones Totales</th>
                <th className="px-3 py-2.5 text-right">Descuentos</th>
                <th className="px-3 py-2.5 text-right">Total Ganado</th>
                <th className="px-3 py-2.5 text-right">Pendiente de Pago</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-base">
              {aggregatedByWorker.map((agg, idx) => (
                <tr key={agg.userId || agg.workerName || idx} className="hover:bg-subtle transition-colors">
                  <td className="px-3 py-2 text-[11px] font-black text-primary uppercase tracking-tight whitespace-nowrap">
                    {agg.workerName}
                  </td>
                  <td className="px-3 py-2 text-center text-[10px] font-black text-secondary whitespace-nowrap">
                    {agg.shiftsCount} turnos
                  </td>
                  <td className="px-3 py-2 text-right text-[10px] font-bold text-secondary whitespace-nowrap">
                    {formatMoney(agg.totalSales)}
                  </td>
                  <td className="px-3 py-2 text-right text-[10px] font-bold text-secondary whitespace-nowrap">
                    {formatMoney(agg.totalBaseSalary)}
                  </td>
                  <td className="px-3 py-2 text-right text-[10px] font-bold text-emerald-600 dark:text-emerald-400 whitespace-nowrap">
                    +{formatMoney(agg.totalCommissions)}
                  </td>
                  <td className="px-3 py-2 text-right text-[10px] font-bold whitespace-nowrap text-rose-600 dark:text-rose-400">
                    {agg.totalDeductions ? `−${formatMoney(agg.totalDeductions)}` : '—'}
                  </td>
                  <td className="px-3 py-2 text-right text-xs font-black text-primary whitespace-nowrap">
                    {formatMoney(agg.totalSalary)}
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    <span className={cn(
                      "text-[11px] font-black",
                      agg.pendingSalary > 0 ? "text-amber-600 dark:text-amber-400" : "text-emerald-600 dark:text-emerald-400"
                    )}>
                      {formatMoney(agg.pendingSalary)}
                    </span>
                  </td>
                </tr>
              ))}

              {aggregatedByWorker.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-6 py-6 text-center text-muted text-[10px] font-bold uppercase">
                    No hay acumulación registrada de trabajadores.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}



