import { 
  TrendingUp, DollarSign, Calendar, Calculator, Package, User, Users, Eye,
  X, ArrowDownRight, ArrowUpRight, ArrowLeftRight, ArrowRight, History, Download, Printer, CheckCircle2, 
  Clock, AlertCircle, AlertTriangle, FileSpreadsheet, ChevronDown, Check, Plus, Search,
  BarChart3, Brain, ListChecks, ShieldAlert, Loader2, Trash2,
  HelpCircle, Edit3, Save, FileText, CheckCircle, Minus
} from "lucide-react";

type ModalProps = Record<string, any>;

export default function ReportsCloseSessionModal(props: ModalProps) {
  const { branches, currencies, formatMoney, isClosingShiftFromReports, sessionClosingBalances, sessionClosingDateInput, sessionClosingNotesInput, sessionToCloseModal, sessionTurnMap, setIsClosingShiftFromReports, setSessionClosingBalances, setSessionClosingDateInput, setSessionClosingNotesInput, setSessionToCloseModal, store, transactions } = props;
  return (
    <>
      {sessionToCloseModal && (
        <div className="fixed inset-0 bg-slate-950/75 backdrop-blur-xs z-[100] flex items-center justify-center p-3 sm:p-4 overflow-hidden animate-in fade-in duration-200">
          <div className="bg-white dark:bg-slate-900 rounded-3xl p-5 sm:p-6 shadow-2xl border border-base max-w-lg w-full max-h-[94vh] flex flex-col overflow-hidden animate-in zoom-in-95">
            <div className="flex items-center justify-between border-b border-base pb-3 mb-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-emerald-50 dark:bg-emerald-950/50 rounded-2xl flex items-center justify-center text-emerald-600 dark:text-emerald-400">
                  <CheckCircle className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-sm font-black text-slate-900 dark:text-white uppercase tracking-tight">
                    Cerrar Turno desde Reportes
                  </h3>
                  <p className="text-[10px] font-bold text-muted uppercase">
                    {sessionTurnMap.get(sessionToCloseModal.id) || sessionToCloseModal.id} • {sessionToCloseModal.workerName || 'Vendedor'}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setSessionToCloseModal(null)}
                className="p-1 hover:bg-subtle rounded-full text-muted hover:text-primary transition-colors cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto space-y-4 pr-1 custom-scrollbar text-primary">
              <div className="bg-slate-50 dark:bg-slate-800/50 p-3.5 rounded-2xl border border-base space-y-2 text-xs">
                <div className="flex justify-between">
                  <span className="text-muted font-bold">Sucursal:</span>
                  <span className="font-black text-primary">{branches.find(b => b.id === sessionToCloseModal.branchId)?.name || 'Central'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted font-bold">Apertura:</span>
                  <span className="font-mono text-primary">{new Date(sessionToCloseModal.openedAt).toLocaleString('es-CU')}</span>
                </div>
                <div className="flex justify-between">                  <span className="text-muted font-bold">Fondo Inicial:</span>
                  <span className="font-black text-primary">{formatMoney(sessionToCloseModal.openingBalance)}</span>
                </div>
                {(() => {
                  const sessionTxs = transactions.filter(t => 
                    t.sessionId === sessionToCloseModal.id || (
                      t.branchId === sessionToCloseModal.branchId &&
                      new Date(t.date).getTime() >= new Date(sessionToCloseModal.openedAt).getTime()
                    )
                  );
                  const totalSales = sessionTxs.reduce((sum, tx) => sum + (tx.total || 0), 0);
                  return (
                    <div className="flex justify-between border-t border-base/60 pt-2 font-black text-rose-600 dark:text-rose-400">
                      <span>Ventas Acumuladas:</span>
                      <span>{formatMoney(totalSales)}</span>
                    </div>
                  );
                })()}
              </div>

              {/* Fecha de cierre */}
              <div>
                <label className="block text-[9px] font-black uppercase text-muted tracking-wider mb-1.5">
                  Fecha Oficial de Cierre del Turno:
                </label>
                <input
                  type="date"
                  value={sessionClosingDateInput}
                  onChange={(e) => setSessionClosingDateInput(e.target.value)}
                  className="w-full px-3.5 py-2.5 bg-subtle border border-base rounded-xl text-xs font-bold text-primary outline-none focus:ring-2 focus:ring-emerald-500/20"
                />
              </div>

              {/* Arqueo / Saldos Declarados */}
              <div>
                <label className="block text-[9px] font-black uppercase text-muted tracking-wider mb-2">
                  Arqueo de Efectivo en Caja (Declarado al Cierre):
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  {currencies.map(c => {
                    const key = `${c.code}-cash`;
                    return (
                      <div key={c.code} className="p-2.5 bg-subtle rounded-xl border border-base flex items-center justify-between gap-2">
                        <span className="text-[10px] font-black uppercase text-primary shrink-0">
                          {c.code} (Efectivo)
                        </span>
                        <input
                          type="number"
                          step={c.code === 'CUP' ? '1' : '0.01'}
                          placeholder="0"
                          value={sessionClosingBalances[key] ?? ''}
                          onChange={(e) => {
                            const val = parseFloat(e.target.value);
                            setSessionClosingBalances(prev => ({
                              ...prev,
                              [key]: isNaN(val) ? 0 : val
                            }));
                          }}
                          className="w-24 px-2 py-1 bg-secondary border border-base rounded-lg text-right text-xs font-black font-mono text-primary outline-none focus:border-emerald-500"
                        />
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Notas opcionales */}
              <div>
                <label className="block text-[9px] font-black uppercase text-muted tracking-wider mb-1.5">
                  Notas de Cierre / Observaciones (Opcional):
                </label>
                <input
                  type="text"
                  placeholder="Ej: Cierre regular verificado por administrador"
                  value={sessionClosingNotesInput}
                  onChange={(e) => setSessionClosingNotesInput(e.target.value)}
                  className="w-full px-3.5 py-2 bg-subtle border border-base rounded-xl text-xs text-primary outline-none focus:ring-2 focus:ring-emerald-500/20"
                />
              </div>
            </div>

            <div className="flex gap-2.5 pt-4 border-t border-base mt-2">
              <button
                type="button"
                onClick={() => setSessionToCloseModal(null)}
                disabled={isClosingShiftFromReports}
                className="flex-1 py-3 bg-subtle hover:bg-slate-200 dark:hover:bg-slate-800 text-primary font-black rounded-xl text-[10px] uppercase tracking-wider transition-all cursor-pointer disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={isClosingShiftFromReports}
                onClick={async () => {
                  setIsClosingShiftFromReports(true);
                  try {
                    const balancesArray: import('../types').Payment[] = Object.entries(sessionClosingBalances)
                      .filter(([_, amt]) => (amt as number) > 0)
                      .map(([k, amt]) => {
                        const [currCode, method] = k.split('-');
                        const curr = currencies.find(c => c.code === currCode);
                        return {
                          currencyCode: currCode as any,
                          amount: amt as number,
                          exchangeRate: curr?.rateToBase || 1,
                          method: (method || 'cash') as any
                        };
                      });

                    let finalClosingDate = new Date().toISOString();
                    if (sessionClosingDateInput) {
                      const parts = sessionClosingDateInput.split('-');
                      if (parts.length === 3) {
                        const d = new Date();
                        d.setFullYear(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
                        finalClosingDate = d.toISOString();
                      }
                    }

                    const res = await store.forceCloseSessionFromReports(
                      sessionToCloseModal.id,
                      balancesArray,
                      finalClosingDate,
                      sessionClosingNotesInput
                    );

                    if (res.success) {
                      store.addNotification(`Turno ${sessionTurnMap.get(sessionToCloseModal.id) || sessionToCloseModal.id} cerrado correctamente.`, 'success');
                      setSessionToCloseModal(null);
                    } else {
                      store.addNotification('No se pudo cerrar el turno.', 'error');
                    }
                  } catch (err: any) {
                    store.addNotification(err.message || 'Error al cerrar turno', 'error');
                  } finally {
                    setIsClosingShiftFromReports(false);
                  }
                }}
                className="flex-1 py-3 bg-emerald-600 hover:bg-emerald-700 text-white font-black rounded-xl text-[10px] uppercase tracking-wider transition-all shadow-md shadow-emerald-600/20 active:scale-95 flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
              >
                {isClosingShiftFromReports ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>Cerrando Turno...</span>
                  </>
                ) : (
                  <>
                    <CheckCircle className="w-4 h-4" />
                    <span>Confirmar y Cerrar Turno</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
