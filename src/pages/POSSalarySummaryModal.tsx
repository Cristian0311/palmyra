import { useEffect } from "react";
import { Search, Wifi, WifiOff, RefreshCw, Plus, Minus, CreditCard, Receipt, Trash2, ShoppingCart, ShieldCheck, DollarSign, Banknote, QrCode, ArrowLeftRight, UserPlus, X, Lock, Unlock, Camera, AlertCircle, TrendingUp, Wallet, MessageSquare, Mail, HelpCircle, Calculator, ArrowRight, Package, User, RotateCcw, Printer, Bluetooth, Usb, Smartphone, Send, Copy, Check, CheckCircle, Share2, Store, ChevronDown, ChevronUp, Filter } from "lucide-react";
import { formatMoney } from "../modules/pos/utils/paymentMath";
import { findSessionEmployeeUser } from "../services/employeeCompensation";

type ModalProps = Record<string, any>;

export default function POSSalarySummaryModal(props: ModalProps) {
  const { activeTransactions, bankCards, bankTransactions, baseCurrency, companyCompensation, currentUser, formatSalaryCUP, handlePrintClosureThermal, lastClosedSession, navigate, products, salarySettlements, setShowSalarySummary, showSalarySummary, users } = props;
  useEffect(() => {
    if (!showSalarySummary) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShowSalarySummary(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [showSalarySummary, setShowSalarySummary]);
  return (
    <>
      {showSalarySummary && lastClosedSession && (
        <div
          className="palmyra-overlay z-[var(--z-modal)] flex items-center justify-center p-2 sm:p-4 overflow-hidden animate-in fade-in duration-200"
          role="presentation"
          onMouseDown={event => { if (event.target === event.currentTarget) setShowSalarySummary(false); }}
        >
          <div className="palmyra-modal-panel w-full max-w-md max-h-[92dvh] flex flex-col overflow-hidden animate-in zoom-in-95">
            {/* Header: Compact & Sticky */}
            <div className="p-3.5 sm:p-4 text-center border-b border-base bg-secondary shrink-0">
              <div className="mx-auto mb-1.5 flex h-9 w-9 sm:h-10 sm:w-10 items-center justify-center rounded-xl bg-gradient-to-br from-violet-600 to-indigo-600 text-white shadow-sm">
                <ShieldCheck className="h-4 w-4 sm:h-5 sm:w-5" />
              </div>
              <div className="flex items-center justify-center gap-1.5 flex-wrap">
                <span className="palmyra-badge max-w-[10rem]">{lastClosedSession.id}</span>
                <span className="text-[10px] font-bold text-muted uppercase truncate max-w-[12rem]">
                  {lastClosedSession.workerName || 'Empleado'}
                </span>
              </div>
              <h3 className="text-sm sm:text-base font-black text-primary uppercase tracking-tight mt-1">
                Turno Cerrado con Éxito
              </h3>
              <p className="text-[9px] font-medium text-muted uppercase tracking-wider tabular-nums">
                {new Date(lastClosedSession.closingDate || lastClosedSession.closedAt || new Date()).toLocaleString()}
              </p>
            </div>

            {/* Scrollable Body */}
            <div className="flex-1 overflow-y-auto custom-scrollbar p-3.5 sm:p-4 space-y-2.5 text-left">
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

                // Bank receipts anchored to this shift's sales (POS stores the sale id
                // in transactionId; legacy rows used the sale id as reference).
                const saleIds = new Set<string>();
                sessionTransactions.forEach(tx => {
                  saleIds.add(tx.id);
                  if (tx.remoteId) saleIds.add(tx.remoteId);
                });
                const bankReceipts: any[] = (bankTransactions || []).filter((entry: any) => {
                  if (entry.type !== 'payment_received') return false;
                  const anchor = String(entry.transactionId || entry.reference || '').trim();
                  return anchor ? saleIds.has(anchor) : false;
                });
                const cardById = new Map<string, any>((bankCards || []).map((card: any): [string, any] => [card.id, card]));
                const bankTotals = new Map<string, number>();
                for (const receipt of bankReceipts) {
                  const currency = cardById.get(receipt.cardId)?.currency || baseCurrency.code;
                  bankTotals.set(currency, (bankTotals.get(currency) || 0) + Number(receipt.amount || 0));
                }

                // Group products for display
                const groupedProducts: { [name: string]: number } = {};                sessionTransactions.forEach(tx => {
                  tx.items.forEach(item => {
                    const name = typeof item.product === 'string' ? item.product : item.product?.name;
                    if (name) groupedProducts[name] = (groupedProducts[name] || 0) + item.quantity;
                  });
                });

                return (
                  <div className="space-y-2.5">
                    {/* Resumen de Productos */}
                    <div className="bg-subtle rounded-xl sm:rounded-2xl p-2.5 sm:p-3 border border-base">
                      <p className="text-[9px] font-black text-muted uppercase tracking-widest mb-1.5 flex justify-between gap-2">
                        <span>Resumen de Venta</span>
                        <span className="shrink-0 text-indigo-600 dark:text-indigo-400 tabular-nums">{totalItems} {totalItems === 1 ? 'unidad' : 'unidades'}</span>
                      </p>
                      <div className="max-h-32 overflow-y-auto space-y-1 pr-1 custom-scrollbar">
                        {Object.entries(groupedProducts).map(([name, qty]) => (
                          <div key={name} className="flex justify-between items-center gap-2 text-[10px] sm:text-[11px] py-0.5 border-b border-base/60 last:border-0">
                            <span className="font-semibold text-primary min-w-0 flex-1 truncate">{name}</span>
                            <span className="shrink-0 font-mono font-black text-primary bg-secondary px-1.5 py-0.5 rounded border border-base tabular-nums">x{qty}</span>
                          </div>
                        ))}
                        {Object.keys(groupedProducts).length === 0 && (
                          <p className="text-[10px] text-muted italic py-1">No se registraron ventas en este turno.</p>
                        )}
                      </div>
                    </div>

                    {/* Liquidación de Salario */}
                    <div className="bg-secondary rounded-xl sm:rounded-2xl p-2.5 sm:p-3 border border-indigo-100 dark:border-indigo-900/50 space-y-1.5 shadow-2xs">
                      <div className="text-[9px] font-black text-indigo-600 dark:text-indigo-400 uppercase tracking-widest border-b border-indigo-50 dark:border-indigo-950 pb-1.5 flex justify-between gap-2">
                        <span>Liquidación de Salario</span>
                        <span className="text-muted font-bold truncate max-w-[10rem]">{lastClosedSession.workerName}</span>
                      </div>
                      
                      <div className="space-y-1 text-[11px] sm:text-xs">
                        <div className="flex justify-between items-center gap-2">
                          <span className="font-semibold text-muted text-[10px] uppercase">Salario Base</span>
                          <span className="shrink-0 font-mono font-bold text-primary tabular-nums">{formatMoney(baseSalary, baseCurrency.symbol)}</span>
                        </div>
                        <div className="flex justify-between items-center gap-2">
                          <span className="font-semibold text-muted text-[10px] uppercase">Comisiones</span>
                          <span className="shrink-0 font-mono font-bold text-emerald-600 dark:text-emerald-400 tabular-nums">{formatMoney(commissions, baseCurrency.symbol)}</span>
                        </div>
                        
                        {deduction > 0 && (
                          <div className="flex justify-between items-center gap-2 p-1.5 bg-rose-50 dark:bg-rose-950/30 rounded-lg border border-rose-100 dark:border-rose-900/50">
                            <span className="font-bold text-rose-600 dark:text-rose-400 text-[9px] uppercase">Descuento Descuadre</span>
                            <span className="shrink-0 font-mono font-black text-rose-600 dark:text-rose-400 tabular-nums">{formatMoney(deduction, baseCurrency.symbol)}</span>
                          </div>
                        )}
                      </div>

                      <div className="pt-1.5 border-t border-base border-dashed flex justify-between items-center gap-2">
                        <div className="min-w-0">
                          <span className="text-[9px] font-black text-primary uppercase tracking-wider block">Neto a Recibir</span>
                          <span className="text-[8px] font-bold text-muted uppercase">Liquidación Total Turno</span>
                        </div>
                        <span className="shrink-0 text-base sm:text-lg font-black text-indigo-600 dark:text-indigo-400 font-mono tabular-nums tracking-tight">
                          {formatSalaryCUP(totalSalary)}
                        </span>
                      </div>
                    </div>

                    {/* Totales de Turno */}
                    <div className="grid grid-cols-2 gap-2">
                      <div className="min-w-0 bg-emerald-50 dark:bg-emerald-950/30 rounded-xl p-2.5 border border-emerald-100 dark:border-emerald-900/50">
                        <p className="text-[9px] font-black text-emerald-800 dark:text-emerald-400 uppercase tracking-tight">Total Vendido</p>
                        <p className="truncate text-xs sm:text-sm font-black text-emerald-700 dark:text-emerald-300 font-mono tabular-nums">{formatMoney(totalSales, baseCurrency.symbol)}</p>
                      </div>
                      <div className="min-w-0 bg-slate-900 dark:bg-slate-800 rounded-xl p-2.5 text-white">
                        <p className="text-[9px] font-black text-slate-400 uppercase tracking-tight">Ventas Turno</p>
                        <p className="truncate text-xs sm:text-sm font-black font-mono tabular-nums">{sessionTransactions.length} Tickets</p>
                      </div>
                    </div>

                    {/* Cobros bancarios del turno: el detalle que antes había que buscar en Bancos */}
                    {bankReceipts.length > 0 && (
                      <div className="bg-secondary rounded-xl sm:rounded-2xl p-2.5 sm:p-3 border border-emerald-100 dark:border-emerald-900/50 space-y-1.5">
                        <div className="flex justify-between items-center gap-2 text-[9px] font-black text-emerald-700 dark:text-emerald-400 uppercase tracking-widest border-b border-emerald-50 dark:border-emerald-950 pb-1.5">
                          <span>Cobros bancarios del turno</span>
                          <span className="shrink-0 text-muted font-bold tabular-nums">{bankReceipts.length} cobro(s)</span>
                        </div>
                        {Array.from(bankTotals.entries()).map(([currency, total]) => (
                          <div key={currency} className="flex justify-between items-center gap-2 text-[11px]">
                            <span className="font-semibold text-muted uppercase">{currency} · transferencia</span>
                            <span className="shrink-0 font-mono font-black text-emerald-600 dark:text-emerald-400 tabular-nums">{formatMoney(total, currency)}</span>
                          </div>
                        ))}
                        <div className="max-h-24 overflow-y-auto space-y-1 pt-1 border-t border-dashed border-base custom-scrollbar">
                          {bankReceipts.slice(0, 8).map((receipt: any) => {
                            const card = cardById.get(receipt.cardId);
                            const reference = String(receipt.reference || '');
                            return (
                              <div key={receipt.id} className="flex justify-between items-center gap-2 text-[9px]">
                                <span className="min-w-0 flex-1 truncate font-semibold text-primary" title={reference || receipt.description}>
                                  {card?.bankName || card?.bank || card?.name || 'Banco'} · {reference ? `Ref. ${reference.length > 16 ? `${reference.slice(0, 8)}…${reference.slice(-6)}` : reference}` : receipt.description}
                                </span>
                                <span className="shrink-0 font-mono font-black text-primary tabular-nums">
                                  {formatMoney(Number(receipt.amount || 0), card?.currency || baseCurrency.code)}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                        <p className="text-[8px] font-semibold text-muted uppercase tracking-wide">
                          También disponibles en Bancos → Ingresos por turno.
                        </p>
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>

            {/* Action Footer - Sticky and Compact */}
            <div className="p-2.5 sm:p-3 bg-subtle border-t border-base space-y-1.5 shrink-0">
              <div className="flex flex-wrap justify-end gap-2">
                <button 
                  onClick={() => handlePrintClosureThermal(lastClosedSession)}
                  className="flex-1 sm:flex-none inline-flex h-9 items-center justify-center gap-1.5 px-3 bg-slate-900 hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white text-white rounded-xl font-black text-[10px] sm:text-[11px] uppercase tracking-wider transition-all shadow-xs active:scale-95 cursor-pointer"
                  title="Imprimir ticket en la impresora configurada"
                >
                  <Printer className="h-3.5 w-3.5 shrink-0" />
                  <span>Imprimir Ticket</span>
                </button>
                <button 
                  onClick={() => {
                    setShowSalarySummary(false);
                    navigate('/');
                  }}
                  className="flex-1 sm:flex-none inline-flex h-9 items-center justify-center gap-1.5 px-3 bg-secondary border border-base text-primary rounded-xl font-black text-[10px] sm:text-[11px] uppercase tracking-wider hover:bg-subtle transition-all active:scale-95 cursor-pointer shadow-2xs"
                >
                  <span>Finalizar e Ir al Menú</span>
                  <ArrowRight className="h-3.5 w-3.5 shrink-0" />
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
