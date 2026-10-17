import { Search, Wifi, WifiOff, RefreshCw, Plus, Minus, CreditCard, Receipt, Trash2, ShoppingCart, ShieldCheck, DollarSign, Banknote, QrCode, ArrowLeftRight, UserPlus, X, Lock, Unlock, Camera, AlertCircle, TrendingUp, Wallet, MessageSquare, Mail, HelpCircle, Calculator, ArrowRight, Package, User, RotateCcw, Printer, Bluetooth, Usb, Smartphone, Send, Copy, Check, CheckCircle, Share2, Store, ChevronDown, ChevronUp, Filter } from "lucide-react";
import { formatMoney } from "../modules/pos/utils/paymentMath";
import { findSessionEmployeeUser } from "../services/employeeCompensation";

type ModalProps = Record<string, any>;

export default function POSSalarySummaryModal(props: ModalProps) {
  const { activeTransactions, baseCurrency, companyCompensation, currentUser, formatSalaryCUP, handlePrintClosureThermal, lastClosedSession, navigate, products, salarySettlements, setShowSalarySummary, showSalarySummary, users } = props;
  return (
    <>
      {showSalarySummary && lastClosedSession && (
        <div className="fixed inset-0 bg-slate-950/70 backdrop-blur-sm z-[95] flex items-center justify-center p-2 sm:p-4 overflow-hidden animate-in fade-in duration-200">
          <div className="bg-white dark:bg-slate-900 rounded-2xl sm:rounded-3xl shadow-2xl w-full max-w-md max-h-[94vh] sm:max-h-[90vh] flex flex-col overflow-hidden border border-slate-200 dark:border-slate-800 animate-in zoom-in-95">
            {/* Header: Compact & Sticky */}
            <div className="p-3.5 sm:p-4 text-center border-b border-slate-100 dark:border-slate-800 bg-slate-50/80 dark:bg-slate-900/80 shrink-0">
              <div className="w-10 h-10 bg-emerald-50 dark:bg-emerald-950/50 text-emerald-600 dark:text-emerald-400 rounded-full flex items-center justify-center mx-auto mb-1 border border-emerald-100 dark:border-emerald-900/50 shadow-xs">
                <ShieldCheck className="w-5 h-5" />
              </div>
              <div className="flex items-center justify-center gap-1.5 flex-wrap">
                <span className="bg-indigo-50 dark:bg-indigo-950/50 text-indigo-700 dark:text-indigo-300 text-[9px] font-black px-2.5 py-0.5 rounded-full uppercase tracking-wider border border-indigo-100 dark:border-indigo-900">
                  {lastClosedSession.id}
                </span>
                <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase">
                  {lastClosedSession.workerName || 'Empleado'}
                </span>
              </div>
              <h3 className="text-base sm:text-lg font-black text-slate-900 dark:text-white uppercase tracking-tight mt-0.5">
                Turno Cerrado con Éxito
              </h3>
              <p className="text-[8px] sm:text-[9px] font-medium text-slate-400 uppercase tracking-wider">
                {new Date(lastClosedSession.closingDate || lastClosedSession.closedAt || new Date()).toLocaleString()}
              </p>
            </div>

            {/* Scrollable Body */}
            <div className="flex-1 overflow-y-auto custom-scrollbar p-3.5 sm:p-5 space-y-3 text-left">
              {(() => {
                const sessionOpenMs = new Date(lastClosedSession.openedAt).getTime();
                const sessionCloseMs = lastClosedSession.closedAt ? new Date(lastClosedSession.closedAt).getTime() : Infinity;
                const sessionTransactions = activeTransactions.filter(t => {
                  if (t.deletedAt || t.status !== 'completed' || String(t.notes || '').startsWith('AJUSTE_')) return false;
                  if (t.sessionId === lastClosedSession.id) return true;
                  if (t.sessionId || t.branchId !== lastClosedSession.branchId) return false;
                  const txTime = new Date(t.date).getTime();
                  return Number.isFinite(txTime) && txTime >= sessionOpenMs && txTime <= sessionCloseMs;
                });

                const employee = findSessionEmployeeUser(lastClosedSession, users, lastClosedSession.workerName) || (!lastClosedSession.employeeId && currentUser?.id === lastClosedSession.userId ? currentUser : undefined);
                const settlement = salarySettlements.find(s => s.sessionId === lastClosedSession.id);
                const deduction = settlement?.discrepancyDeduction || 0;
                const fallbackCommissions = sessionTransactions.reduce((sum, tx) => {
                  const sellers = tx.sellerEmployeeIds?.length ? tx.sellerEmployeeIds : [tx.userId];
                  const splitFactor = Math.max(1, sellers.length);
                  return sum + sellers.reduce((sellerSum, sellerId) => {
                    if (sellerId !== lastClosedSession.userId && sellerId !== lastClosedSession.employeeId && !(lastClosedSession.workingEmployeeIds || []).includes(sellerId)) return sellerSum;
                    if (companyCompensation.mode === 'sales_percent') return sellerSum + (Math.max(0, Number(tx.total) || 0) * companyCompensation.percentRate / 100) / splitFactor;
                    return sellerSum + (tx.items || []).reduce((itemSum, item) => {
                      const productSnapshot = typeof item.product === 'string' ? undefined : item.product;
                      const productId = typeof item.product === 'string' ? item.product : item.product?.id;
                      const product = productId ? products.find(p => p.id === productId) : undefined;
                      const commissionValue = product?.commissionValue ?? productSnapshot?.commissionValue ?? (item as any).product_snapshot?.commissionValue ?? (item as any).commissionValue ?? 0;
                      return itemSum + (Math.max(0, Number(commissionValue) || 0) * Math.max(0, Number(item.quantity) || 0)) / splitFactor;
                    }, 0);
                  }, 0);
                }, 0);
                const baseSalary = settlement?.baseSalary ?? (companyCompensation.mode === 'sales_percent' ? 0 : Math.max(0, Number(employee?.baseSalary) || 0));
                const commissions = settlement?.commissions ?? fallbackCommissions;
                const totalSalary = settlement?.total ?? Math.max(0, (baseSalary + commissions) - deduction);
                
                const totalSales = sessionTransactions.reduce((sum, tx) => sum + (tx.total || 0), 0);
                const totalItems = sessionTransactions.reduce((sum, tx) => sum + (tx.items || []).reduce((s, i) => s + (i.quantity || 0), 0), 0);

                // Group products for display
                const groupedProducts: { [name: string]: number } = {};                sessionTransactions.forEach(tx => {
                  tx.items.forEach(item => {
                    const name = typeof item.product === 'string' ? item.product : item.product?.name;
                    if (name) groupedProducts[name] = (groupedProducts[name] || 0) + item.quantity;
                  });
                });

                return (
                  <div className="space-y-3">
                    {/* Resumen de Productos */}
                    <div className="bg-slate-50 dark:bg-slate-800/40 rounded-xl sm:rounded-2xl p-3 border border-slate-100 dark:border-slate-800">
                      <p className="text-[9px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-2 flex justify-between">
                        <span>Resumen de Venta</span>
                        <span className="text-indigo-600 dark:text-indigo-400">{totalItems} {totalItems === 1 ? 'unidad' : 'unidades'}</span>
                      </p>
                      <div className="max-h-36 overflow-y-auto space-y-1.5 pr-1 custom-scrollbar">
                        {Object.entries(groupedProducts).map(([name, qty]) => (
                          <div key={name} className="flex justify-between items-center text-[10px] sm:text-[11px] py-0.5 border-b border-slate-100 dark:border-slate-800/50 last:border-0">
                            <span className="font-semibold text-slate-700 dark:text-slate-300 truncate max-w-[200px] sm:max-w-[240px]">{name}</span>
                            <span className="font-mono font-black text-slate-900 dark:text-white bg-white dark:bg-slate-700 px-1.5 py-0.2 rounded border border-slate-200 dark:border-slate-600 shrink-0">x{qty}</span>
                          </div>
                        ))}
                        {Object.keys(groupedProducts).length === 0 && (
                          <p className="text-[10px] text-slate-400 italic py-1">No se registraron ventas en este turno.</p>
                        )}
                      </div>
                    </div>

                    {/* Liquidación de Salario */}
                    <div className="bg-white dark:bg-slate-900 rounded-xl sm:rounded-2xl p-3 border border-indigo-100 dark:border-indigo-900/50 space-y-2 shadow-2xs">
                      <div className="text-[9px] font-black text-indigo-600 dark:text-indigo-400 uppercase tracking-widest border-b border-indigo-50 dark:border-indigo-950 pb-1.5 flex justify-between">
                        <span>Liquidación de Salario</span>
                        <span className="text-slate-400 font-bold">{lastClosedSession.workerName}</span>
                      </div>
                      
                      <div className="space-y-1 text-xs">
                        <div className="flex justify-between items-center">
                          <span className="font-semibold text-slate-500 dark:text-slate-400 text-[10px] uppercase">Salario Base</span>
                          <span className="font-mono font-bold text-slate-900 dark:text-slate-100">{formatMoney(baseSalary, baseCurrency.symbol)}</span>
                        </div>
                        <div className="flex justify-between items-center">
                          <span className="font-semibold text-slate-500 dark:text-slate-400 text-[10px] uppercase">Comisiones</span>
                          <span className="font-mono font-bold text-emerald-600 dark:text-emerald-400">{formatMoney(commissions, baseCurrency.symbol)}</span>
                        </div>
                        
                        {deduction > 0 && (
                          <div className="flex justify-between items-center p-1.5 bg-rose-50 dark:bg-rose-950/30 rounded-lg border border-rose-100 dark:border-rose-900/50">
                            <span className="font-bold text-rose-600 dark:text-rose-400 text-[9px] uppercase">Descuento Descuadre</span>
                            <span className="font-mono font-black text-rose-600 dark:text-rose-400">{formatMoney(deduction, baseCurrency.symbol)}</span>
                          </div>
                        )}
                      </div>

                      <div className="pt-2 border-t border-slate-100 dark:border-slate-800 border-dashed flex justify-between items-center">
                        <div>
                          <span className="text-[9px] font-black text-slate-900 dark:text-white uppercase tracking-wider block">Neto a Recibir</span>
                          <span className="text-[7px] font-bold text-slate-400 uppercase">Liquidación Total Turno</span>
                        </div>
                        <span className="text-lg sm:text-lg font-black text-indigo-600 dark:text-indigo-400 font-mono tracking-tight">
                          {formatSalaryCUP(totalSalary)}
                        </span>
                      </div>
                    </div>

                    {/* Totales de Turno */}
                    <div className="grid grid-cols-2 gap-2">
                      <div className="bg-emerald-50 dark:bg-emerald-950/30 rounded-xl p-2.5 border border-emerald-100 dark:border-emerald-900/50">
                        <p className="text-[8px] font-black text-emerald-800 dark:text-emerald-400 uppercase tracking-tight">Total Vendido</p>
                        <p className="text-xs sm:text-sm font-black text-emerald-700 dark:text-emerald-300 font-mono">{formatMoney(totalSales, baseCurrency.symbol)}</p>
                      </div>
                      <div className="bg-slate-900 dark:bg-slate-800 rounded-xl p-2.5 text-white">
                        <p className="text-[8px] font-black text-slate-400 uppercase tracking-tight">Ventas Turno</p>
                        <p className="text-xs sm:text-sm font-black font-mono">{sessionTransactions.length} Tickets</p>
                      </div>
                    </div>
                  </div>
                );
              })()}
            </div>

            {/* Action Footer - Sticky and Compact */}
            <div className="p-2.5 sm:p-3 bg-slate-50 dark:bg-slate-900 border-t border-slate-200 dark:border-slate-800 space-y-1.5 shrink-0">
              <div className="grid grid-cols-2 gap-1.5">
                <button 
                  onClick={() => handlePrintClosureThermal(lastClosedSession)}
                  className="py-2.5 px-2 bg-slate-900 hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white text-white rounded-xl font-black text-[9px] sm:text-[10px] uppercase tracking-wider transition-all shadow-xs active:scale-95 flex items-center justify-center gap-1.5 cursor-pointer"
                  title="Imprimir ticket en la impresora configurada"
                >
                  <Printer className="w-3.5 h-3.5 shrink-0" />
                  <span>Imprimir Ticket</span>
                </button>

                
              </div>

              <button 
                onClick={() => {
                  setShowSalarySummary(false);
                  navigate('/');
                }}
                className="w-full py-2.5 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 rounded-xl font-black text-[10px] sm:text-xs uppercase tracking-wider hover:bg-slate-100 dark:hover:bg-slate-750 transition-all active:scale-95 flex items-center justify-center gap-1.5 cursor-pointer shadow-2xs"
              >
                <span>Finalizar e Ir al Menú</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
