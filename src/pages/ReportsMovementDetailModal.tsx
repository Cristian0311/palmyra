import { 
  TrendingUp, DollarSign, Calendar, Calculator, Package, User, Users, Eye,
  X, ArrowDownRight, ArrowUpRight, ArrowLeftRight, ArrowRight, History, Download, Printer, CheckCircle2, 
  Clock, AlertCircle, AlertTriangle, FileSpreadsheet, ChevronDown, Check, Plus, Search,
  BarChart3, Brain, ListChecks, ShieldAlert, Loader2, Trash2,
  HelpCircle, Edit3, Save, FileText, CheckCircle, Minus
} from "lucide-react";
import { cn } from "../lib/utils";

type ModalProps = Record<string, any>;

export default function ReportsMovementDetailModal(props: ModalProps) {
  const { baseCurrency, currencies, formatMoney, handlePrintCashMovementTicket, selectedMovementDetail, setSelectedMovementDetail } = props;
  return (
    <>
      {selectedMovementDetail && (
        <div className="fixed inset-0 bg-slate-950/70 backdrop-blur-sm z-[95] flex items-center justify-center p-2 sm:p-4 overflow-hidden animate-in fade-in duration-200">
          <div className="bg-white dark:bg-slate-900 rounded-3xl shadow-2xl w-full max-w-md max-h-[94vh] sm:max-h-[90vh] flex flex-col overflow-hidden border border-base">
            {(() => {
              const m = selectedMovementDetail;
              const dateObj = new Date(m.date);
              const curr = currencies.find(c => c.code === m.currencyCode);
              const rate = curr?.rateToBase || 1;
              const cupAmount = m.amount * rate;

              return (
                <>
                  <div className={cn(
                    "p-4 sm:p-5 border-b border-base flex items-center justify-between shrink-0",
                    m.type === 'income' ? "bg-emerald-50/50 dark:bg-emerald-950/30" : "bg-rose-50/50 dark:bg-rose-950/30"
                  )}>
                    <div className="flex items-center gap-3">
                      <div className={cn(
                        "p-2.5 rounded-2xl",
                        m.type === 'income' ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300" : "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300"
                      )}>
                        {m.type === 'income' ? <ArrowUpRight className="w-5 h-5" /> : <ArrowDownRight className="w-5 h-5" />}
                      </div>
                      <div>
                        <span className={cn(
                          "text-[8px] font-black uppercase tracking-wider block",
                          m.type === 'income' ? "text-emerald-700 dark:text-emerald-400" : "text-rose-700 dark:text-rose-400"
                        )}>
                          {m.type === 'income' ? 'Ingreso de Caja (Entrada)' : 'Egreso de Caja (Gasto Operativo)'}
                        </span>
                        <h3 className="text-sm font-black text-primary uppercase tracking-tight">
                          Vale #{m.id.slice(0, 12)}
                        </h3>
                      </div>
                    </div>
                    <button 
                      onClick={() => setSelectedMovementDetail(null)}
                      className="p-1.5 hover:bg-subtle rounded-full transition-colors text-muted hover:text-primary cursor-pointer"
                    >
                      <X className="w-5 h-5" />
                    </button>
                  </div>

                  <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-4 custom-scrollbar text-primary">
                    <div className="p-4 rounded-2xl bg-subtle border border-base text-center">
                      <span className="text-[8px] font-black uppercase text-muted tracking-widest block mb-1">
                        Importe del Movimiento
                      </span>
                      <p className={cn("text-2xl font-black font-mono", m.type === 'income' ? "text-emerald-600" : "text-rose-600")}>
                        {m.type === 'income' ? '+' : '-'}{formatMoney(m.amount, m.currencyCode)}
                      </p>
                      {m.currencyCode !== baseCurrency.code && (
                        <p className="text-[10px] font-bold text-muted mt-1">
                          Equivalente en moneda base: {formatMoney(cupAmount, baseCurrency.code)}
                        </p>
                      )}
                    </div>

                    <div className="grid grid-cols-2 gap-2 text-[9px]">
                      <div className="bg-subtle p-2.5 rounded-xl border border-base">
                        <span className="text-muted font-black uppercase block text-[7px]">Turno</span>
                        <p className="font-black text-rose-600 dark:text-rose-400 mt-0.5">{m.turnLabel}</p>
                      </div>
                      <div className="bg-subtle p-2.5 rounded-xl border border-base">
                        <span className="text-muted font-black uppercase block text-[7px]">Sucursal</span>
                        <p className="font-bold text-primary mt-0.5">{m.branchName}</p>
                      </div>
                      <div className="bg-subtle p-2.5 rounded-xl border border-base">
                        <span className="text-muted font-black uppercase block text-[7px]">Responsable</span>
                        <p className="font-bold text-primary mt-0.5">{m.workerName}</p>
                      </div>
                      <div className="bg-subtle p-2.5 rounded-xl border border-base">
                        <span className="text-muted font-black uppercase block text-[7px]">Fecha y Hora</span>
                        <p className="font-bold text-primary mt-0.5">{dateObj.toLocaleString('es-CU')}</p>
                      </div>
                    </div>

                    <div className="bg-subtle p-3 rounded-2xl border border-base">
                      <span className="text-[8px] font-black uppercase text-muted tracking-wider block mb-1">
                        Concepto / Justificación:
                      </span>
                      <p className="text-xs font-bold text-primary leading-relaxed">
                        {m.description || 'Sin descripción especificada'}
                      </p>
                    </div>
                  </div>

                  <div className="p-3 sm:p-4 bg-subtle border-t border-base shrink-0 flex items-center justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => handlePrintCashMovementTicket(m)}
                      className="px-3.5 py-1.5 bg-rose-600 hover:bg-rose-700 text-white rounded-xl text-[9px] font-black uppercase tracking-wider transition-all flex items-center gap-1.5 cursor-pointer shadow-sm active:scale-95"
                    >
                      <Printer className="w-3.5 h-3.5" />
                      <span>Imprimir Vale Térmico (58mm)</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => setSelectedMovementDetail(null)}
                      className="px-4 py-1.5 bg-slate-900 hover:bg-slate-800 dark:bg-slate-700 dark:hover:bg-slate-600 text-white rounded-xl text-[9px] font-black uppercase tracking-wider transition-all cursor-pointer shadow-sm active:scale-95"
                    >
                      Cerrar
                    </button>
                  </div>
                </>
              );
            })()}
          </div>
        </div>
      )}
    </>
  );
}
