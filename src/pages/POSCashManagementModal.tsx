import { Search, Wifi, WifiOff, RefreshCw, Plus, Minus, CreditCard, Receipt, Trash2, ShoppingCart, ShieldCheck, DollarSign, Banknote, QrCode, ArrowLeftRight, UserPlus, X, Lock, Unlock, Camera, AlertCircle, TrendingUp, Wallet, MessageSquare, Mail, HelpCircle, Calculator, ArrowRight, Package, User, RotateCcw, Printer, Bluetooth, Usb, Smartphone, Send, Copy, Check, CheckCircle, Share2, Store, ChevronDown, ChevronUp, Filter } from "lucide-react";
import { cn, generateId } from "../lib/utils";
import { ticketDisplay } from "../lib/documentCodes";
import { useStore } from "../store/useStore";
import { Product, Payment, Transaction, CashRegisterSession, Currency } from "../types";
import { formatMoney } from "../modules/pos/utils/paymentMath";
import { CashMovementTicket } from "../components/cash/CashMovementTicket";
import { findSessionEmployeeUser } from "../services/employeeCompensation";

type ModalProps = Record<string, any>;

export default function POSCashManagementModal(props: ModalProps) {
  const { activeTransactions, addNotification, bankCards, baseCurrency, cashDisplayCurrencies, cashManagementTab, closingBalances, companyCompensation, currencies, currentSession, currentUser, expectedBalances, formatSalaryCUP, handleAddMovement, handleClose, handlePrintClosureThermal, handleThermalPrint, isClosingSession, movementData, products, removeCashMovement, salesFilter, salesSubTab, sessionClosingDate, sessionWorkerName, setCashManagementTab, setClosingBalances, setMovementData, setSalesFilter, setSalesSubTab, setSessionClosingDate, setShowCashManagementModal, setShowReceiptModal, showCashManagementModal, turnProductSalaryRows, users } = props;
  const rateFor = (code: string) => code === baseCurrency?.code
    ? 1
    : (currencies.find((c: Currency) => c.code === code)?.rateToBase || 1);

  const closeSalesTotal = (activeTransactions || [])
    .filter((t: Transaction) => t.sessionId === currentSession?.id && !t.deletedAt && t.status === 'completed' && !String(t.notes || '').startsWith('AJUSTE_'))
    .reduce((sum: number, t: Transaction) => sum + (Number(t.total) || 0), 0);

  const closeExpenseBase = (currentSession?.movements || []).reduce((sum: number, movement: any) => {
    if (movement.type === 'income') return sum;
    return sum + Math.abs(Number(movement.amount) || 0) * rateFor(movement.currencyCode);
  }, 0);

  const closeIncomeBase = (currentSession?.movements || []).reduce((sum: number, movement: any) => {
    if (movement.type !== 'income') return sum;
    return sum + Math.abs(Number(movement.amount) || 0) * rateFor(movement.currencyCode);
  }, 0);

  const transferCodes = Array.from(new Set(
    (expectedBalances || []).filter((line: any) => line.method === 'transfer').map((line: any) => String(line.currencyCode))
  ));

  const cuadreRows = [
    ...(cashDisplayCurrencies || []).map((c: Currency) => ({ key: c.code + '-cash', label: 'Efectivo ' + c.code, currencyCode: c.code, method: 'cash' })),
    ...transferCodes.map(code => ({ key: code + '-transfer', label: 'Transferencia ' + code, currencyCode: code, method: 'transfer' })),
  ].map((row: any) => {
    const expected = Number((expectedBalances || []).find((line: any) => line.currencyCode === row.currencyCode && line.method === row.method)?.amount) || 0;
    const declared = Number(closingBalances?.[row.key]) || 0;
    const symbol = currencies.find((c: Currency) => c.code === row.currencyCode)?.symbol || row.currencyCode;
    return { ...row, expected, declared, difference: declared - expected, symbol };
  }).filter((row: any) => Math.abs(row.expected) >= 0.01 || Math.abs(row.declared) >= 0.01);

  const hasCounts = Object.values(closingBalances || {}).some(value => Number(value) > 0);
  const totalDifferenceBase = cuadreRows.reduce((sum: number, row: any) => sum + row.difference * rateFor(row.currencyCode), 0);

  const applyPerfectCuadre = () => {
    const next = { ...(closingBalances || {}) };
    for (const line of expectedBalances || []) {
      if (line.method !== 'cash' && line.method !== 'transfer') continue;
      next[line.currencyCode + '-' + line.method] = Number(line.amount) || 0;
    }
    setClosingBalances(next);
  };

  return (
    <>
      {showCashManagementModal && currentSession && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[70] flex items-center justify-center p-4">
          <div role="dialog" aria-modal="true" aria-label="Caja y ventas del turno" className="palmyra-mobile-modal bg-white rounded-2xl sm:rounded-[2rem] shadow-2xl w-full max-w-2xl overflow-hidden animate-in zoom-in-95 border border-white/20 flex flex-col max-h-[calc(100dvh-1rem)]">
            <div className="p-4 border-b border-slate-50 flex items-center justify-between bg-slate-900 text-white shrink-0">
              <div className="flex items-center gap-2">
                <Receipt className="w-4 h-4 text-violet-400" />
                <h3 className="text-xs font-black uppercase tracking-widest">Caja y Ventas del Turno</h3>
              </div>
              <button 
                onClick={() => setShowCashManagementModal(false)}
                className="p-2 hover:bg-white/10 rounded-full transition-colors text-slate-400"
                aria-label="Cerrar caja y ventas"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            
            <div className="flex border-b border-slate-100 bg-slate-50/50 shrink-0">
              <button
                onClick={() => setCashManagementTab('movements')}
                className={cn(
                  "flex-1 py-3 text-[11px] font-black uppercase tracking-widest transition-colors",
                  cashManagementTab === 'movements' ? "text-violet-600 border-b-2 border-violet-600 bg-white" : "text-slate-400 hover:text-slate-600"
                )}
              >
                Movimientos
              </button>
              <button
                onClick={() => setCashManagementTab('sales')}
                className={cn(
                  "flex-1 py-3 text-[11px] font-black uppercase tracking-widest transition-colors",
                  cashManagementTab === 'sales' ? "text-violet-600 border-b-2 border-violet-600 bg-white" : "text-slate-400 hover:text-slate-600"
                )}
              >
                Ventas del Turno
              </button>
              <button
                onClick={() => setCashManagementTab('close')}
                className={cn(
                  "flex-1 py-3 text-[11px] font-black uppercase tracking-widest transition-colors",
                  cashManagementTab === 'close' ? "text-violet-600 border-b-2 border-violet-600 bg-white" : "text-slate-400 hover:text-slate-600"
                )}
              >
                Arqueo y Cierre
              </button>
            </div>

            <div className="p-4 sm:p-5 max-h-[70vh] overflow-y-auto custom-scrollbar">
              {cashManagementTab === 'movements' ? (
                <div className="space-y-6">
                  <form onSubmit={handleAddMovement} className="p-4 bg-slate-50 rounded-2xl border border-slate-200 space-y-4">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Tipo</label>
                        <select 
                          value={movementData.type}
                          onChange={e => setMovementData({...movementData, type: e.target.value as any})}
                          className="w-full px-3 py-2.5 bg-white border border-slate-200 rounded-xl text-[12px] font-black uppercase outline-none focus:ring-2 focus:ring-violet-500"
                        >
                          <option value="expense">Egreso (Gasto)</option>
                          <option value="income">Ingreso (Entrada)</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Moneda</label>
                        <select 
                          value={movementData.currencyCode}
                          onChange={e => setMovementData({...movementData, currencyCode: e.target.value})}
                          className="w-full px-3 py-2.5 bg-white border border-slate-200 rounded-xl text-[12px] font-black uppercase outline-none focus:ring-2 focus:ring-violet-500"
                        >
                          {currencies.map(c => <option key={c.code} value={c.code}>{c.code}</option>)}
                        </select>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Monto</label>
                        <input 
                          type="number" 
                          step="0.01" 
                          required
                          value={movementData.amount}
                          onFocus={(e) => e.target.select()}
                          onChange={e => setMovementData({...movementData, amount: e.target.value})}
                          className="w-full px-3 py-2.5 bg-white border border-slate-200 rounded-xl text-[12px] font-black outline-none focus:ring-2 focus:ring-violet-500"
                          placeholder="0.00"
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Descripción</label>
                        <input 
                          type="text" 
                          required
                          value={movementData.description}
                          onChange={e => setMovementData({...movementData, description: e.target.value})}
                          className="w-full px-3 py-2.5 bg-white border border-slate-200 rounded-xl text-[12px] font-black outline-none focus:ring-2 focus:ring-violet-500"
                          placeholder="Ej: Pago de almuerzo"
                        />
                      </div>
                    </div>
                    <button type="submit" className="w-full min-h-[44px] py-2.5 bg-violet-600 text-white rounded-xl text-[11px] font-black uppercase tracking-widest hover:bg-violet-700 transition-colors shadow-md shadow-violet-100">
                      {movementData.type === 'income' ? 'Registrar ingreso' : 'Registrar egreso'}
                    </button>
                  </form>

                  <div className="space-y-2">
                    <h4 className="text-[11px] font-black text-slate-400 uppercase tracking-widest">Historial de Turno</h4>
                    {currentSession?.movements && currentSession.movements.length > 0 ? (
                      currentSession.movements.map(m => (
                        <div key={m.id} className="flex items-center justify-between p-3 bg-white border border-slate-100 rounded-xl shadow-sm hover:border-slate-200 transition-all group">
                          <div className="flex items-center gap-3">
                            <div className={cn(
                              "w-8 h-8 rounded-lg flex items-center justify-center",
                              m.type === 'income' ? "bg-emerald-100 text-emerald-600" : "bg-rose-100 text-rose-600"
                            )}>
                              {m.type === 'income' ? <TrendingUp className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
                            </div>
                            <div>
                              <p className="text-[11px] font-black text-slate-900 uppercase tracking-tight">{m.description}</p>
                              <p className="text-[9.5px] font-bold text-slate-400 uppercase">{new Date(m.date).toLocaleTimeString()}</p>
                            </div>
                          </div>
                          
                          <div className="flex items-center gap-3">
                            <p className={cn(
                              "text-[12px] font-black whitespace-nowrap tabular-nums",
                              m.type === 'income' ? "text-emerald-600" : "text-rose-600"
                            )}>
                              {m.type === 'income' ? '+' : '-'}{m.amount.toLocaleString('es-CU', { minimumFractionDigits: 2 })} {m.currencyCode}
                            </p>
                            <button
                              type="button"
                              onClick={() => {
                                if (window.confirm(`¿Estás seguro de que deseas eliminar este movimiento: "${m.description}"?`)) {
                                  removeCashMovement(currentSession.id, m.id);
                                  addNotification("Movimiento de caja eliminado", 'info');
                                }
                              }}
                              className="p-2 text-slate-400 hover:text-rose-600 rounded-full hover:bg-rose-50 transition-colors opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus:opacity-100"
                              title="Eliminar movimiento"
                              aria-label="Eliminar movimiento"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      ))
                    ) : (
                      <p className="text-xs text-slate-400 text-center py-4 font-bold">No hay movimientos registrados</p>
                    )}
                  </div>
                </div>              ) : cashManagementTab === 'sales' ? (
                <div className="space-y-4">
                  {(() => {
                    const sessionTx = activeTransactions.filter(t => 
                      t.sessionId === currentSession?.id && !t.deletedAt && t.status === 'completed' && !String(t.notes || '').startsWith('AJUSTE_')
                    );

                    // Categorize payment types
                    let cashCupSum = 0;
                    let cashUsdSum = 0;
                    let transferCupSum = 0;
                    let otherSum = 0;

                    sessionTx.forEach(tx => {
                      (tx.payments || []).forEach(p => {
                        if (p.currencyCode === 'USD' && p.method === 'cash') {
                          cashUsdSum += p.amount;
                        } else if (p.currencyCode === baseCurrency.code && p.method === 'cash') {
                          cashCupSum += p.amount;
                        } else if (p.method === 'transfer') {
                          transferCupSum += (p.amount * (p.exchangeRate || 1));
                        } else {
                          otherSum += (p.amount * (p.exchangeRate || 1));
                        }
                      });
                    });

                    // Ingresos y egresos son parte del efectivo real del turno,
                    // no ventas. Ingreso suma y egreso resta.
                    const cashMovementsByCurrency = (currentSession?.movements || []).reduce((acc, movement) => {
                      const amount = Math.abs(Number(movement.amount) || 0);
                      const sign = movement.type === 'income' ? 1 : -1;
                      acc[movement.currencyCode] = (acc[movement.currencyCode] || 0) + sign * amount;
                      return acc;
                    }, {} as Record<string, number>);

                    const movementTotals = (currentSession?.movements || []).reduce(
                      (acc, movement) => {
                        const amount = Math.abs(Number(movement.amount) || 0);
                        const rate = movement.currencyCode === baseCurrency.code
                          ? 1
                          : (currencies.find(c => c.code === movement.currencyCode)?.rateToBase || 1);
                        const amountInBase = amount * rate;

                        if (movement.type === 'income') {
                          acc.incomeBase += amountInBase;
                          acc.incomeCount += 1;
                        } else {
                          acc.expenseBase += amountInBase;
                          acc.expenseCount += 1;
                        }

                        return acc;
                      },
                      { incomeBase: 0, expenseBase: 0, incomeCount: 0, expenseCount: 0 }
                    );

                    cashCupSum += cashMovementsByCurrency.CUP || 0;
                    cashUsdSum += cashMovementsByCurrency.USD || 0;

                    const totalSalesAmount = sessionTx.reduce((sum, tx) => sum + (tx.total || 0), 0);

                    // Helper to determine payment category for a transaction
                    const getTxPaymentCategory = (tx: Transaction): 'usd' | 'transfer' | 'cash_cup' | 'mixed' => {
                      const payments = tx.payments || [];
                      if (payments.length === 0) return 'cash_cup';
                      const hasUsd = payments.some(p => p.currencyCode === 'USD');
                      const hasTransfer = payments.some(p => p.method === 'transfer');
                      const hasCashCup = payments.some(p => p.currencyCode === baseCurrency.code && p.method === 'cash');

                      if (payments.length === 1) {
                        if (hasUsd) return 'usd';
                        if (hasTransfer) return 'transfer';
                        if (hasCashCup) return 'cash_cup';
                      }

                      // Multiple payments
                      const uniqueTypes = new Set(payments.map(p => `${p.currencyCode}-${p.method}`));
                      if (uniqueTypes.size === 1) {
                        if (hasUsd) return 'usd';
                        if (hasTransfer) return 'transfer';
                        return 'cash_cup';
                      }
                      return 'mixed';
                    };

                    const filteredTx = sessionTx.filter(tx => {
                      if (salesFilter === 'all') return true;
                      const cat = getTxPaymentCategory(tx);
                      return cat === salesFilter;
                    });

                    // Product Aggregation with Payment context breakdown
                    type ProdBreakdown = {
                      name: string;
                      quantity: number;
                      unitPrice: number;
                      total: number;
                      usdQty: number;
                      usdTotal: number;
                      transferQty: number;
                      transferTotal: number;
                      cashCupQty: number;
                      cashCupTotal: number;
                      mixedQty: number;
                      mixedTotal: number;
                    };

                    const productAgg: Record<string, ProdBreakdown> = {};
                    sessionTx.forEach(tx => {
                      const cat = getTxPaymentCategory(tx);
                      (tx.items || []).forEach(item => {
                        const prodObj = typeof item.product === 'object' ? item.product : products.find(p => p.id === (item.product as unknown as string));
                        const name = prodObj?.name || (typeof item.product === 'string' ? item.product : 'Producto');
                        const price = prodObj?.price || 0;
                        const variantStr = item.variantLabel ? ` (${item.variantLabel})` : '';
                        const fullName = `${name}${variantStr}`;

                        if (!productAgg[fullName]) {
                          productAgg[fullName] = { 
                            name: fullName, 
                            quantity: 0, 
                            unitPrice: price, 
                            total: 0,
                            usdQty: 0,
                            usdTotal: 0,
                            transferQty: 0,
                            transferTotal: 0,
                            cashCupQty: 0,
                            cashCupTotal: 0,
                            mixedQty: 0,
                            mixedTotal: 0
                          };
                        }
                        productAgg[fullName].quantity += item.quantity;
                        productAgg[fullName].total += (price * item.quantity);

                        if (cat === 'usd') {
                          productAgg[fullName].usdQty += item.quantity;
                          productAgg[fullName].usdTotal += (price * item.quantity);
                        } else if (cat === 'transfer') {
                          productAgg[fullName].transferQty += item.quantity;
                          productAgg[fullName].transferTotal += (price * item.quantity);
                        } else if (cat === 'cash_cup') {
                          productAgg[fullName].cashCupQty += item.quantity;
                          productAgg[fullName].cashCupTotal += (price * item.quantity);
                        } else {
                          productAgg[fullName].mixedQty += item.quantity;
                          productAgg[fullName].mixedTotal += (price * item.quantity);
                        }
                      });
                    });

                    const consolidatedList = Object.values(productAgg);

                    return (
                      <div className="space-y-4">
                        {/* Financial Cards Grid */}
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                          <div className="min-w-0 bg-emerald-50/80 border border-emerald-100 rounded-xl p-2.5 flex min-h-[72px] flex-col justify-between shadow-sm">
                            <div className="flex items-center justify-between text-emerald-700 mb-1">
                              <span className="text-[9px] font-black uppercase tracking-wider">Efectivo {baseCurrency.code}</span>
                              <Banknote className="w-3.5 h-3.5 shrink-0" />
                            </div>
                            <span className="text-[12px] sm:text-[13px] font-black text-emerald-900 leading-tight tabular-nums">
                              {formatMoney(cashCupSum, baseCurrency.symbol)}
                            </span>
                          </div>

                          <div className="min-w-0 bg-amber-50/80 border border-amber-100 rounded-xl p-2.5 flex min-h-[72px] flex-col justify-between shadow-sm">
                            <div className="flex items-center justify-between text-amber-700 mb-1">
                              <span className="text-[9px] font-black uppercase tracking-wider">Efectivo USD</span>
                              <DollarSign className="w-3.5 h-3.5 shrink-0" />
                            </div>
                            <div className="min-w-0">
                              <span className="text-[12px] sm:text-[13px] font-black text-amber-900 block leading-tight tabular-nums">
                                ${cashUsdSum.toFixed(2)} USD
                              </span>
                              <span className="text-[9px] font-bold text-amber-600 block leading-tight tabular-nums">
                                {formatMoney(cashUsdSum * (currencies.find(c => c.code === 'USD')?.rateToBase || 1), baseCurrency.symbol)} {baseCurrency.code} eq.
                              </span>
                            </div>
                          </div>

                          <div className="min-w-0 bg-blue-50/80 border border-blue-100 rounded-xl p-2.5 flex min-h-[72px] flex-col justify-between shadow-sm">
                            <div className="flex items-center justify-between text-blue-700 mb-1">
                              <span className="text-[9px] font-black uppercase tracking-wider">Transferencia {baseCurrency.code}</span>
                              <CreditCard className="w-3.5 h-3.5 shrink-0" />
                            </div>
                            <span className="text-[12px] sm:text-[13px] font-black text-blue-900 leading-tight tabular-nums">
                              {formatMoney(transferCupSum, baseCurrency.symbol)}
                            </span>
                          </div>

                          <div className="min-w-0 bg-violet-50/80 border border-violet-100 rounded-xl p-2.5 flex min-h-[72px] flex-col justify-between shadow-sm">
                            <div className="flex items-center justify-between text-violet-700 mb-1">
                              <span className="text-[9px] font-black uppercase tracking-wider">Total Ventas</span>
                              <Package className="w-3.5 h-3.5 shrink-0" />
                            </div>
                            <div className="min-w-0">
                              <span className="text-[12px] sm:text-[13px] font-black text-violet-900 block leading-tight tabular-nums">
                                {formatMoney(totalSalesAmount, baseCurrency.symbol)}
                              </span>
                              <span className="text-[9px] font-bold text-violet-600 block leading-tight">
                                {sessionTx.length} {sessionTx.length === 1 ? 'ticket' : 'tickets'}
                              </span>
                            </div>
                          </div>

                          <div className="min-w-0 bg-rose-50/80 border border-rose-100 rounded-xl p-2.5 flex min-h-[72px] flex-col justify-between shadow-sm">
                            <div className="flex items-center justify-between text-rose-700 mb-1">
                              <span className="text-[9px] font-black uppercase tracking-wider">Egreso</span>
                              <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                            </div>
                            <div className="min-w-0">
                              <span className="text-[12px] sm:text-[13px] font-black text-rose-900 block leading-tight tabular-nums">
                                {formatMoney(movementTotals.expenseBase, baseCurrency.symbol)}
                              </span>
                              <span className="text-[9px] font-bold text-rose-600 block leading-tight">
                                {movementTotals.expenseBase > 0 ? 'Ya descontado del efectivo' : 'Sin egresos registrados'}
                              </span>
                            </div>
                          </div>

                          <div className="min-w-0 bg-violet-50/80 border border-violet-100 rounded-xl p-2.5 flex min-h-[72px] flex-col justify-between shadow-sm">
                            <div className="flex items-center justify-between text-violet-700 mb-1">
                              <span className="text-[9px] font-black uppercase tracking-wider">Ingreso</span>
                              <TrendingUp className="w-3.5 h-3.5 shrink-0" />
                            </div>
                            <div className="min-w-0">
                              <span className="text-[12px] sm:text-[13px] font-black text-violet-900 block leading-tight tabular-nums">
                                {formatMoney(movementTotals.incomeBase, baseCurrency.symbol)}
                              </span>
                              <span className="text-[9px] font-bold text-violet-600 block leading-tight">
                                {movementTotals.incomeBase > 0 ? 'Ya agregado al efectivo' : 'Sin ingresos registrados'}
                              </span>
                            </div>
                          </div>
                        </div>

                        {/* Subtabs & Filters */}
                        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2 pt-1 border-t border-slate-100">
                          {/* Subtabs */}
                          <div className="flex bg-slate-100 p-0.5 rounded-xl text-[10.5px] font-black uppercase">
                            <button
                              onClick={() => setSalesSubTab('tickets')}
                              className={cn(
                                "px-3 py-2 rounded-lg transition-all flex items-center gap-1",
                                salesSubTab === 'tickets' ? "bg-white text-violet-600 shadow-sm" : "text-slate-500 hover:text-slate-800"
                              )}
                            >
                              <Receipt className="w-3.5 h-3.5" />
                              Tickets ({sessionTx.length})
                            </button>
                            <button
                              onClick={() => setSalesSubTab('products')}
                              className={cn(
                                "px-3 py-2 rounded-lg transition-all flex items-center gap-1",
                                salesSubTab === 'products' ? "bg-white text-violet-600 shadow-sm" : "text-slate-500 hover:text-slate-800"
                              )}
                            >
                              <Package className="w-3.5 h-3.5" />
                              Productos ({consolidatedList.reduce((s, p) => s + p.quantity, 0)} u.)
                            </button>
                            <button
                              onClick={() => setSalesSubTab('movements')}
                              className={cn(
                                "px-3 py-2 rounded-lg transition-all flex items-center gap-1",
                                salesSubTab === 'movements' ? "bg-white text-emerald-600 shadow-sm" : "text-slate-500 hover:text-slate-800"
                              )}
                            >
                              <Wallet className="w-3.5 h-3.5" />
                              Egreso y gasto ({(currentSession?.movements || []).length})
                            </button>
                          </div>

                          {/* Filter by Payment Method */}
                          {salesSubTab === 'tickets' && (
                            <div className="flex items-center gap-1 overflow-x-auto max-w-full pb-0.5">
                              <button
                                onClick={() => setSalesFilter('all')}
                                className={cn(
                                  "px-2.5 py-1.5 rounded-lg text-[9.5px] font-black uppercase tracking-wider whitespace-nowrap transition-all",
                                  salesFilter === 'all' ? "bg-violet-600 text-white" : "bg-slate-100 text-slate-500 hover:bg-slate-200"
                                )}
                              >
                                Todos
                              </button>
                              <button
                                onClick={() => setSalesFilter('usd')}
                                className={cn(
                                  "px-2.5 py-1.5 rounded-lg text-[9.5px] font-black uppercase tracking-wider whitespace-nowrap transition-all flex items-center gap-0.5",
                                  salesFilter === 'usd' ? "bg-amber-600 text-white" : "bg-amber-50 text-amber-700 hover:bg-amber-100"
                                )}
                              >
                                <Banknote className="h-3 w-3 shrink-0" aria-hidden="true" />
                                USD
                              </button>
                              <button
                                onClick={() => setSalesFilter('transfer')}
                                className={cn(
                                  "px-2.5 py-1.5 rounded-lg text-[9.5px] font-black uppercase tracking-wider whitespace-nowrap transition-all flex items-center gap-0.5",
                                  salesFilter === 'transfer' ? "bg-blue-600 text-white" : "bg-blue-50 text-blue-700 hover:bg-blue-100"
                                )}
                              >
                                <CreditCard className="h-3 w-3 shrink-0" aria-hidden="true" />
                                Transferencia
                              </button>
                              <button
                                onClick={() => setSalesFilter('cash_cup')}
                                className={cn(
                                  "px-2.5 py-1.5 rounded-lg text-[9.5px] font-black uppercase tracking-wider whitespace-nowrap transition-all flex items-center gap-0.5",
                                  salesFilter === 'cash_cup' ? "bg-emerald-600 text-white" : "bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                                )}
                              >
                                <Banknote className="h-3 w-3 shrink-0" aria-hidden="true" />
                                Efectivo {baseCurrency.code}
                              </button>
                            </div>
                          )}
                        </div>

                        {/* Content: each business record has its own visual section.
                            Cash movements are deliberately kept out of sale tickets. */}
                        {salesSubTab === 'movements' ? (
                          <div className="space-y-2 max-h-72 overflow-y-auto custom-scrollbar pr-1">
                            {(currentSession?.movements || []).length > 0 ? (
                              [...(currentSession?.movements || [])]
                                .sort((a,b) => new Date(b.date).getTime() - new Date(a.date).getTime())
                                .map((movement) => (
                                  <CashMovementTicket
                                    key={movement.id}
                                    movement={movement}
                                    workerName={currentSession?.workerName}
                                    formatMoney={(amount, code) => formatMoney(amount, currencies.find(c => c.code === code)?.symbol || code || '')}
                                    compact
                                  />
                                ))
                            ) : (
                              <div className="text-center py-8 bg-slate-50 rounded-xl border border-dashed border-slate-200">
                                <Wallet className="w-6 h-6 text-slate-300 mx-auto mb-1.5" />
                                <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">
                                  No hay egresos, gastos o ingresos registrados
                                </p>
                              </div>
                            )}
                          </div>
                        ) : salesSubTab === 'tickets' ? (
                          <div className="space-y-2 max-h-72 overflow-y-auto custom-scrollbar pr-1">
                            {filteredTx.length > 0 ? (
                              filteredTx.map((tx) => {
                                const customer = useStore.getState().customers.find(c => c.id === tx.customerId);
                                const cat = getTxPaymentCategory(tx);
                                return (
                                  <div key={tx.id} className="p-2 sm:p-2.5 bg-white rounded-xl border border-slate-200/80 shadow-sm space-y-1.5">
                                    <div className="flex items-center justify-between gap-2">
                                      <div>
                                        <div className="flex items-center gap-1.5 flex-wrap">
                                          <span className="font-mono text-[10px] font-black text-violet-700 bg-violet-50 px-1.5 py-0.5 rounded-md border border-violet-100">
                                            {ticketDisplay(tx.ticketNumber, tx.id)}
                                          </span>
                                          {tx.offlinePending && (
                                            <span className="text-[9px] font-black uppercase tracking-wide text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded-md border border-amber-100">
                                              Pendiente
                                            </span>
                                          )}
                                          <span className="text-[9.5px] font-bold text-slate-400">
                                            {new Date(tx.date).toLocaleDateString("es-CU", { day: "2-digit", month: "2-digit", year: "2-digit" })} · {new Date(tx.date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                                          </span>
                                          <span className="text-[9.5px] font-bold text-slate-600">
                                            • {customer?.name || 'Consumidor Final'}
                                          </span>
                                        </div>
                                      </div>

                                      <div className="flex items-center gap-2 shrink-0">
                                        <span className="text-[12px] font-black text-slate-900 dark:text-white whitespace-nowrap tabular-nums">
                                          {formatMoney(tx.total, baseCurrency.symbol)}
                                        </span>
                                        <div className="flex items-center gap-1">
                                          <button
                                            onClick={() => setShowReceiptModal(tx)}
                                            className="p-2 text-slate-400 hover:text-violet-600 hover:bg-violet-50 dark:hover:bg-violet-950/40 rounded-lg transition-colors cursor-pointer"
                                            title="Ver Comprobante Flotante"
                                            aria-label="Ver comprobante"
                                          >
                                            <Receipt className="w-4 h-4" />
                                          </button>
                                          <button
                                            onClick={() => handleThermalPrint(tx)}
                                            className="p-2 text-slate-400 hover:text-violet-600 hover:bg-violet-50 dark:hover:bg-violet-950/40 rounded-lg transition-colors cursor-pointer"
                                            title="Imprimir Ticket Térmico"
                                            aria-label="Imprimir ticket térmico"
                                          >
                                            <Printer className="w-4 h-4" />
                                          </button>
                                          <button
                                            onClick={() => {
                                              if (window.confirm(`¿Estás seguro de eliminar el ticket ${tx.id}? Esto devolverá los productos al inventario.`)) {
                                                useStore.getState().deleteTransaction(tx.id);
                                                addNotification(`Ticket ${tx.id} eliminado y stock restaurado.`, 'info');
                                              }
                                            }}
                                            className="p-2 text-slate-300 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40 rounded-lg transition-colors cursor-pointer"
                                            title="Anular Venta"
                                            aria-label="Anular venta"
                                          >
                                            <Trash2 className="w-4 h-4" />
                                          </button>
                                        </div>
                                      </div>
                                    </div>

                                    {/* Products list in this ticket - Compact & Contained */}
                                    <div className="bg-slate-50 dark:bg-slate-800/40 rounded-lg p-2 space-y-1 text-[9.5px] max-h-24 sm:max-h-28 overflow-y-auto custom-scrollbar">
                                      {tx.items.map((item, idx) => (
                                        <div key={idx} className="flex justify-between items-center text-slate-700 font-bold">
                                          <span className="truncate pr-2" title={`${item.quantity}x ${typeof (item.product as any) === "object" ? ((item.product as any)?.name || "Producto") : (products.find(p => p.id === (item.product as any))?.name || (item.product as any) || "Producto")}${item.variantLabel ? ` (${item.variantLabel})` : ''}`}>
                                            {item.quantity}x {typeof (item.product as any) === "object" ? ((item.product as any)?.name || "Producto") : (products.find(p => p.id === (item.product as any))?.name || (item.product as any) || "Producto")}
                                            {item.variantLabel ? ` (${item.variantLabel})` : ''}
                                          </span>
                                          <span className="font-mono shrink-0">
                                            {formatMoney((typeof (item.product as any) === "object" ? ((item.product as any)?.price || 0) : (products.find(p => p.id === (item.product as any))?.price || item.price || 0)) * item.quantity, baseCurrency.symbol)}
                                          </span>
                                        </div>
                                      ))}
                                    </div>



                        {/* Payment Method Badges & Breakdown */}
                                    <div className="flex items-center justify-between gap-1.5 flex-wrap pt-1 border-t border-slate-100 text-[9px] font-black">
                                      <div className="flex items-center gap-1 flex-wrap">
                                        {cat === 'usd' && (
                                          <span className="bg-amber-100 text-amber-800 px-2 py-0.5 rounded-full inline-flex items-center gap-1">
                                            <Banknote className="h-3 w-3 shrink-0" aria-hidden="true" />
                                            100% Pagado en USD
                                          </span>
                                        )}
                                        {cat === 'transfer' && (
                                          <span className="bg-blue-100 text-blue-800 px-2 py-0.5 rounded-full inline-flex items-center gap-1">
                                            <CreditCard className="h-3 w-3 shrink-0" aria-hidden="true" />
                                            Pagado por Transferencia
                                          </span>
                                        )}
                                        {cat === 'cash_cup' && (
                                          <span className="bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded-full inline-flex items-center gap-1">
                                            <Banknote className="h-3 w-3 shrink-0" aria-hidden="true" />
                                            Pagado en Efectivo {baseCurrency.code}
                                          </span>
                                        )}
                                        {cat === 'mixed' && (
                                          <span className="bg-purple-100 text-purple-800 px-2 py-0.5 rounded-full inline-flex items-center gap-1">
                                            <ArrowLeftRight className="h-3 w-3 shrink-0" aria-hidden="true" />
                                            Pago Mixto / Multi-moneda
                                          </span>
                                        )}

                                        {/* Individual lines */}
                                        {(tx.payments || []).map((p, pIdx) => {
                                          const card = p.bankCardId ? bankCards.find(c => c.id === p.bankCardId) : null;
                                          const sym = currencies.find(c => c.code === p.currencyCode)?.symbol || '';
                                          return (
                                            <span key={pIdx} className="bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded border border-slate-200 font-mono">
                                              {p.method === 'transfer' ? 'Transf' : 'Efec'} {formatMoney(p.amount, sym)} {card ? `(${card.bank})` : ''}
                                            </span>
                                          );
                                        })}
                                      </div>

                                      {tx.changeGiven && tx.changeGiven > 0 ? (
                                        <span className="text-emerald-600 font-bold">
                                          Vuelto: {formatMoney(tx.changeGiven, baseCurrency.symbol)}
                                        </span>
                                      ) : null}
                                    </div>
                                  </div>
                                );
                              })
                            ) : (
                              <div className="text-center py-8 bg-slate-50 rounded-xl border border-dashed border-slate-200">
                                <Receipt className="w-6 h-6 text-slate-300 mx-auto mb-1.5" />
                                <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">
                                  No hay ventas con este filtro
                                </p>
                              </div>
                            )}
                          </div>
                        ) : (
                          <div className="space-y-2 max-h-72 overflow-y-auto custom-scrollbar pr-1">
                            {consolidatedList.length > 0 ? (
                              consolidatedList.map((prod, idx) => (
                                <div key={idx} className="bg-white p-3 rounded-xl border border-slate-200 shadow-sm space-y-1.5">
                                  <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-2.5 min-w-0 flex-1">
                                      <span className="w-7 h-7 bg-violet-100 text-violet-700 rounded-lg flex items-center justify-center font-black text-xs shrink-0">
                                        {prod.quantity}x
                                      </span>
                                      <div className="min-w-0">
                                        <span className="font-black text-slate-900 text-xs uppercase block truncate">{prod?.name || "Producto"}</span>
                                        <span className="text-[10px] font-bold text-slate-400 block">
                                          Precio unitario: {formatMoney(prod.unitPrice, baseCurrency.symbol)}
                                        </span>
                                      </div>
                                    </div>
                                    <span className="font-black text-violet-600 text-xs shrink-0 ml-2 whitespace-nowrap tabular-nums">
                                      {formatMoney(prod.total, baseCurrency.symbol)}
                                    </span>
                                  </div>

                                  {/* Payment method breakdown for this product */}
                                  <div className="flex items-center gap-1.5 flex-wrap pt-1 border-t border-slate-100 text-[9px] font-bold">
                                    <span className="text-slate-400 uppercase tracking-widest text-[9px] font-black">Pagado en:</span>
                                    {prod.usdQty > 0 && (
                                      <span className="bg-amber-50 text-amber-800 border border-amber-200 px-1.5 py-0.5 rounded inline-flex items-center gap-1">
                                        <Banknote className="h-3 w-3 shrink-0" aria-hidden="true" />
                                        USD: {prod.usdQty} u. ({formatMoney(prod.usdTotal, baseCurrency.symbol)})
                                      </span>
                                    )}
                                    {prod.transferQty > 0 && (
                                      <span className="bg-blue-50 text-blue-800 border border-blue-200 px-1.5 py-0.5 rounded inline-flex items-center gap-1">
                                        <CreditCard className="h-3 w-3 shrink-0" aria-hidden="true" />
                                        Transf: {prod.transferQty} u. ({formatMoney(prod.transferTotal, baseCurrency.symbol)})
                                      </span>
                                    )}
                                    {prod.cashCupQty > 0 && (
                                      <span className="bg-emerald-50 text-emerald-800 border border-emerald-200 px-1.5 py-0.5 rounded inline-flex items-center gap-1">
                                        <Banknote className="h-3 w-3 shrink-0" aria-hidden="true" />
                                        CUP: {prod.cashCupQty} u. ({formatMoney(prod.cashCupTotal, baseCurrency.symbol)})
                                      </span>
                                    )}
                                  </div>
                                </div>
                              ))
                            ) : (
                              <div className="text-center py-8 bg-slate-50 rounded-xl border border-dashed border-slate-200">
                                <Package className="w-6 h-6 text-slate-300 mx-auto mb-1.5" />
                                <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">
                                  No hay productos vendidos en este turno
                                </p>
                              </div>
                            )}
                          </div>
                        )}

                        {/* Buttons to Print Full Shift Summary */}
                        <div className="pt-2 border-t border-slate-100 flex flex-col sm:flex-row gap-2">
                          <button
                            type="button"
                            onClick={() => handlePrintClosureThermal(currentSession)}
                            className="flex-1 py-3 bg-violet-600 text-white rounded-xl font-black text-xs uppercase tracking-widest hover:bg-violet-700 transition-all shadow-md shadow-violet-100 active:scale-95 flex items-center justify-center gap-2"
                          >
                            <Printer className="w-4 h-4" />
                            Imprimir Resumen de Cierre
                          </button>
                          
                        </div>
                      </div>
                    );
                  })()}
                </div>
              ) : (
                <div className="space-y-4">
                  <form onSubmit={handleClose} className="space-y-4">
                    {/* PASO 1 · Resumen calculado del turno */}
                    <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
                      <div className="flex items-center justify-between gap-2 border-b border-slate-100 bg-slate-50/70 px-3 py-2">
                        <div className="min-w-0">
                          <h4 className="text-[11px] font-black uppercase tracking-widest text-slate-900">Resumen del turno</h4>
                          <p className="text-[9px] font-bold uppercase tracking-wide text-slate-400">Calculado con las ventas y movimientos registrados</p>
                        </div>
                        <span className="shrink-0 rounded-full bg-white px-2 py-1 text-[9px] font-black uppercase text-slate-500 ring-1 ring-slate-200">Paso 1</span>
                      </div>
                      <div className="grid grid-cols-2 gap-1.5 p-2 sm:grid-cols-4">
                        {[
                          { label: 'Fondo inicial', value: formatMoney(currentSession?.openingBalance || 0, baseCurrency.symbol), tone: 'border-slate-200 bg-slate-50 text-slate-800' },
                          { label: 'Ventas del turno', value: formatMoney(closeSalesTotal, baseCurrency.symbol), tone: 'border-violet-200 bg-violet-50 text-violet-900' },
                          { label: 'Egresos', value: `-${formatMoney(closeExpenseBase, baseCurrency.symbol)}`, tone: 'border-rose-200 bg-rose-50 text-rose-900' },
                          { label: 'Ingresos', value: `+${formatMoney(closeIncomeBase, baseCurrency.symbol)}`, tone: 'border-emerald-200 bg-emerald-50 text-emerald-900' },
                        ].map(item => (
                          <div key={item.label} className={cn('min-w-0 rounded-xl border px-2 py-2', item.tone)}>
                            <p className="text-[9px] font-black uppercase tracking-wider opacity-70">{item.label}</p>
                            <p className="text-[11.5px] font-black leading-tight tabular-nums break-words">{item.value}</p>
                          </div>
                        ))}
                      </div>
                      <div className="grid grid-cols-1 gap-1.5 border-t border-slate-100 p-2 sm:grid-cols-2">
                        {expectedBalances.length > 0 ? expectedBalances.map((line: any) => (
                          <div key={line.currencyCode + '-' + line.method} className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5">
                            <span className="flex min-w-0 items-center gap-1.5 text-[8px] font-black uppercase text-slate-500">
                              {line.method === 'cash' ? <Banknote className="h-3 w-3 shrink-0" aria-hidden="true" /> : <CreditCard className="h-3 w-3 shrink-0" aria-hidden="true" />}
                              <span className="truncate">{line.method === 'cash' ? 'Efectivo' : 'Transferencia'} {line.currencyCode} · esperado</span>
                            </span>
                            <span className="shrink-0 text-[10px] font-black text-slate-900">
                              {formatMoney(Number(line.amount) || 0, currencies.find((c: Currency) => c.code === line.currencyCode)?.symbol || line.currencyCode)}
                            </span>
                          </div>
                        )) : (
                          <p className="col-span-full rounded-lg border border-dashed border-slate-200 py-2 text-center text-[9px] font-bold uppercase text-slate-400">Sin cobros registrados en este turno</p>
                        )}
                      </div>
                    </section>

                    {/* PASO 2 · Arqueo físico + cuadre */}
                    <section className="overflow-hidden rounded-2xl border-2 border-violet-200 bg-white shadow-sm">
                      <div className="flex items-center justify-between gap-2 border-b border-violet-100 bg-violet-50/70 px-3 py-2">
                        <div className="min-w-0">
                          <h4 className="text-[10px] font-black uppercase tracking-widest text-violet-950">Arqueo de efectivo</h4>
                          <p className="text-[8px] font-bold uppercase tracking-wide text-violet-500">Cuenta lo que realmente hay en caja</p>
                        </div>
                        <span className="shrink-0 rounded-full bg-white px-2 py-1 text-[8px] font-black uppercase text-violet-600 ring-1 ring-violet-200">Paso 2</span>
                      </div>
                      <div className="space-y-2.5 p-2.5">
                        <div className="grid grid-cols-2 gap-2">
                          <div className="rounded-xl border-2 border-emerald-200 bg-emerald-50 p-2.5 transition-all focus-within:ring-2 focus-within:ring-emerald-500">
                            <label className="block text-[9px] font-black uppercase tracking-widest text-emerald-700">Efectivo CUP / MN</label>
                            <p className="mb-1 text-[7px] font-bold uppercase text-emerald-500">Conteo físico</p>
                            <input type="number" min="0" step="0.01" value={closingBalances['CUP-cash'] || ''} onFocus={(e) => e.target.select()} onChange={(e) => setClosingBalances({ ...closingBalances, ['CUP-cash']: parseFloat(e.target.value) || 0 })} className="w-full border-none bg-transparent p-0 text-sm font-black text-emerald-900 outline-none focus:ring-0" placeholder="0.00" />
                          </div>
                          {cashDisplayCurrencies.filter((c: Currency) => c.code !== 'CUP').map((c: Currency) => (
                            <div key={c.code} className="rounded-xl border border-slate-200 bg-slate-50 p-2.5 transition-all focus-within:ring-2 focus-within:ring-emerald-500">
                              <label className="block text-[8px] font-black uppercase tracking-widest text-emerald-600">Efectivo {c.code}</label>
                              <input type="number" min="0" step="0.01" value={closingBalances[c.code + '-cash'] || ''} onFocus={(e) => e.target.select()} onChange={(e) => setClosingBalances({ ...closingBalances, [c.code + '-cash']: parseFloat(e.target.value) || 0 })} className="w-full border-none bg-transparent p-0 text-sm font-black text-slate-900 outline-none focus:ring-0" placeholder="0.00" />
                            </div>
                          ))}
                        </div>

                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                          {transferCodes.map((code: string) => (
                            <div key={code} className="rounded-xl border border-slate-200 bg-slate-50 p-2.5">
                              <label className="block text-[8px] font-black uppercase tracking-widest text-blue-600">Transferencia {code}</label>
                              <input
                                type="number"
                                min="0" step="0.01"
                                value={closingBalances[code + '-transfer'] || ''}
                                onFocus={(e) => e.target.select()}
                                onChange={(e) => setClosingBalances({ ...closingBalances, [code + '-transfer']: parseFloat(e.target.value) || 0 })}
                                className="w-full border-none bg-transparent p-0 text-sm font-black text-slate-900 outline-none focus:ring-0"
                                placeholder="0.00"
                              />
                            </div>
                          ))}
                        </div>

                        {hasCounts && cuadreRows.length > 0 && (
                          <div className="rounded-xl border border-slate-200 bg-slate-50 p-2">
                            <div className="mb-1.5 flex items-center justify-between">
                              <p className="text-[8px] font-black uppercase tracking-widest text-slate-500">Cuadre del arqueo</p>
                              <span className={cn(
                                'rounded-full px-2 py-0.5 text-[8px] font-black uppercase',
                                Math.abs(totalDifferenceBase) < 0.01 ? 'bg-emerald-100 text-emerald-800'
                                  : totalDifferenceBase < 0 ? 'bg-rose-100 text-rose-800' : 'bg-amber-100 text-amber-800',
                              )}>
                                {Math.abs(totalDifferenceBase) < 0.01 ? 'Cuadrado' : totalDifferenceBase < 0 ? 'Faltante' : 'Sobrante'}
                              </span>
                            </div>
                            <div className="space-y-1">
                              {cuadreRows.map((row: any) => (
                                <div key={row.key} className="flex items-center justify-between gap-2 text-[9px] font-bold">
                                  <span className="truncate text-slate-500">{row.label}</span>
                                  <span className="flex shrink-0 items-center gap-2 font-mono">
                                    <span className="text-slate-400">{formatMoney(row.declared, row.symbol)}</span>
                                    <span className="text-slate-300">/</span>
                                    <span className="text-slate-700">{formatMoney(row.expected, row.symbol)}</span>
                                    <span className={cn('min-w-[64px] text-right font-black', Math.abs(row.difference) < 0.01 ? 'text-emerald-600' : row.difference < 0 ? 'text-[var(--danger)]' : 'text-amber-600')}>
                                      {Math.abs(row.difference) < 0.01 ? 'OK' : `${row.difference > 0 ? '+' : ''}${formatMoney(row.difference, row.symbol)}`}
                                    </span>
                                  </span>
                                </div>
                              ))}
                            </div>
                            <p className="mt-1 border-t border-slate-200 pt-1 text-right text-[8px] font-black uppercase text-slate-500">
                              Diferencia total: <span className={cn(Math.abs(totalDifferenceBase) < 0.01 ? 'text-emerald-600' : 'text-[var(--danger)]')}>{formatMoney(totalDifferenceBase, baseCurrency.symbol)}</span>
                            </p>
                          </div>
                        )}

                        <button
                          type="button"
                          onClick={applyPerfectCuadre}
                          className="flex w-full items-center justify-center gap-2 rounded-xl bg-violet-600 py-3 text-[10px] font-black uppercase tracking-widest text-white shadow-md shadow-violet-200 transition-all hover:bg-violet-700 active:scale-95"
                        >
                          <Calculator className="h-4 w-4" />
                          Cuadre perfecto
                        </button>
                        <p className="text-center text-[8px] font-bold uppercase tracking-wide text-slate-400">
                          Rellena los conteos con lo esperado. Puedes ajustarlos antes de cerrar.
                        </p>
                      </div>
                    </section>

                    {/* PASO 3 · Fecha, empleado y liquidación */}
                    <section className="space-y-3 overflow-hidden rounded-2xl border border-slate-200 bg-white p-2.5 shadow-sm">
                      <div className="flex items-center justify-between gap-2 border-b border-slate-100 pb-2">
                        <div className="min-w-0">
                          <h4 className="text-[10px] font-black uppercase tracking-widest text-slate-900">Fecha y liquidación</h4>
                          <p className="text-[8px] font-bold uppercase tracking-wide text-slate-400">Quién cierra y cuánto se le liquida</p>
                        </div>
                        <span className="shrink-0 rounded-full bg-slate-100 px-2 py-1 text-[8px] font-black uppercase text-slate-500">Paso 3</span>
                      </div>

                      <div className="bg-slate-50 p-3.5 rounded-2xl border border-slate-200">
                        <label className="block text-[8px] font-black text-slate-500 uppercase tracking-widest mb-1.5">
                          Fecha de Cierre del Turno
                        </label>
                        <input
                          type="date"
                          required
                          value={sessionClosingDate}
                          onChange={(e) => setSessionClosingDate(e.target.value)}
                          className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs font-black text-slate-800 outline-none focus:ring-2 focus:ring-violet-500 shadow-sm"
                        />
                      </div>

                      <div className="flex items-center justify-between rounded-xl border border-violet-100 bg-violet-50/60 p-3">
                        <div className="flex items-center gap-2">
                          <User className="w-4 h-4 text-violet-600" />
                          <span className="text-[9px] font-black text-violet-900 uppercase tracking-wider">Empleado asignado:</span>
                        </div>
                        <span className="text-xs font-black text-violet-950 uppercase tracking-tight">
                          {currentSession?.workerName || sessionWorkerName || currentUser?.name || 'Empleado'}
                        </span>
                      </div>

                      {/* Salary Calculation Card */}
                      {(() => {
                        const sessionUser = findSessionEmployeeUser(currentSession, users, sessionWorkerName);
                        if (!sessionUser) return null;
                        const sessionOpenMs = new Date(currentSession.openedAt).getTime();
                        const sessionCloseMs = currentSession.closedAt ? new Date(currentSession.closedAt).getTime() : Infinity;
                        const sessionTx = activeTransactions.filter((t: Transaction) => {
                          if (t.deletedAt || t.status !== 'completed' || String(t.notes || '').startsWith('AJUSTE_')) return false;
                          if (t.sessionId === currentSession.id) return true;
                          if (t.sessionId || t.branchId !== currentSession.branchId) return false;
                          const txTime = new Date(t.date).getTime();
                          return Number.isFinite(txTime) && txTime >= sessionOpenMs && txTime <= sessionCloseMs;
                        });
                        const commissions = sessionTx.reduce((sum: number, tx: Transaction) => {
                          const sellers = tx.sellerEmployeeIds?.length ? tx.sellerEmployeeIds : [tx.userId];
                          const splitFactor = Math.max(1, sellers.length);
                          return sum + sellers.reduce((sellerSum: number, sellerId: string) => {
                            if (sellerId !== sessionUser.id && sellerId !== currentSession.employeeId && !(currentSession.workingEmployeeIds || []).includes(sellerId)) return sellerSum;
                            if (companyCompensation.mode === 'sales_percent') {
                              return sellerSum + (Math.max(0, Number(tx.total) || 0) * companyCompensation.percentRate / 100) / splitFactor;
                            }
                            return sellerSum + (tx.items || []).reduce((itemSum: number, item: any) => {
                              const productSnapshot = typeof item.product === 'string' ? undefined : item.product;
                              const productId = typeof item.product === 'string' ? item.product : item.product?.id;
                              const product = productId ? products.find((p: Product) => p.id === productId) : undefined;
                              const commissionValue = product?.commissionValue ?? productSnapshot?.commissionValue ?? (item as any).product_snapshot?.commissionValue ?? (item as any).commissionValue ?? 0;
                              return itemSum + (Math.max(0, Number(commissionValue) || 0) * Math.max(0, Number(item.quantity) || 0)) / splitFactor;
                            }, 0);
                          }, 0);
                        }, 0);
                        const baseSalary = companyCompensation.mode === 'sales_percent' ? 0 : Math.max(0, Number(sessionUser.baseSalary) || 0);
                        const totalSalary = baseSalary + commissions;
                        const percentageMode = companyCompensation.mode === 'sales_percent';
                        const compensationLabel = percentageMode
                          ? `Porcentaje sobre el total de la venta · ${companyCompensation.percentRate}%`
                          : 'CUP fijo por producto';
                        return (
                          <div className="bg-amber-50 p-4 rounded-2xl border border-amber-200 space-y-2 shadow-sm animate-in fade-in slide-in-from-top-2">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-2"><DollarSign className="w-4 h-4 text-amber-600" /><span className="text-[10px] font-black text-amber-900 uppercase tracking-widest">Liquidación del Turno</span></div>
                              <span className="text-xs font-black text-amber-900 uppercase">{sessionUser.name || 'Empleado'}</span>
                            </div>
                            <div className="grid grid-cols-2 gap-3 pt-2 border-t border-amber-100">
                              <div><p className="text-[8px] font-bold text-amber-600 uppercase tracking-tighter">Salario base</p><p className="text-sm font-black text-amber-900">{formatSalaryCUP(baseSalary)}</p></div>
                              <div><p className="text-[8px] font-bold text-amber-600 uppercase tracking-tighter">Modelo de pago</p><p className="text-[10px] font-black text-emerald-700">{compensationLabel}</p><p className="text-sm font-black text-emerald-700">{formatSalaryCUP(commissions)}</p></div>
                            </div>
                            <div className={percentageMode ? "rounded-xl border border-emerald-100 bg-emerald-50 px-3 py-2" : "rounded-xl border border-violet-100 bg-violet-50 px-3 py-2"}>
                              <p className={percentageMode ? "text-[8px] font-black uppercase tracking-wider text-emerald-700" : "text-[8px] font-black uppercase tracking-wider text-violet-700"}>Cómo se calcula</p>
                              <p className={percentageMode ? "text-[9px] font-bold text-emerald-800" : "text-[9px] font-bold text-violet-800"}>{percentageMode ? `La comisión se aplica al total de cada venta (${companyCompensation.percentRate}%) y se divide entre los vendedores de esa venta cuando corresponde.` : 'Cada producto aporta el CUP fijo configurado por unidad vendida.'}</p>
                            </div>
                            <div className="pt-2 border-t border-amber-100 flex justify-between items-center">
                              <span className="text-[9px] font-black text-amber-900 uppercase">Total salario del turno</span><span className="text-lg font-black text-amber-600">{formatSalaryCUP(totalSalary)}</span>
                            </div>
                            <div className="pt-3 border-t border-amber-100 space-y-2">
                              <div className="flex items-center justify-between gap-2"><span className="text-[9px] font-black text-amber-900 uppercase tracking-widest">Detalle de comisión</span><span className="text-[8px] font-black text-amber-700 uppercase whitespace-nowrap">{turnProductSalaryRows.reduce((sum: number, row: any) => sum + row.quantity, 0)} uds</span></div>
                              {turnProductSalaryRows.length > 0 ? (
                                <div className="overflow-hidden rounded-xl border border-amber-100 bg-white">
                                  <div className="hidden sm:block overflow-x-auto">
                                    <table className="w-full min-w-[560px] text-left">
                                      <thead><tr className="bg-amber-50 border-b border-amber-100"><th className="px-3 py-2 text-[8px] font-black text-amber-700 uppercase">Empleado</th><th className="px-3 py-2 text-[8px] font-black text-amber-700 uppercase">Producto</th><th className="px-3 py-2 text-[8px] font-black text-amber-700 uppercase text-right">Cantidad</th><th className="px-3 py-2 text-[8px] font-black text-amber-700 uppercase text-right">Valor / unidad</th><th className="px-3 py-2 text-[8px] font-black text-amber-700 uppercase text-right">Comisión total</th></tr></thead>
                                      <tbody className="divide-y divide-amber-50">{turnProductSalaryRows.map((row: any) => (<tr key={row.key}><td className="px-3 py-2 text-[9px] font-black text-slate-700 uppercase break-words">{row.employeeName}</td><td className="px-3 py-2 text-[9px] font-black text-slate-900 uppercase break-words">{row.productName}</td><td className="px-3 py-2 text-[9px] font-black text-slate-800 text-right tabular-nums">{row.quantity}</td><td className="px-3 py-2 text-[9px] font-black text-violet-700 text-right tabular-nums">{formatSalaryCUP(row.salaryPerUnit)}</td><td className="px-3 py-2 text-[9px] font-black text-violet-900 text-right tabular-nums">{formatSalaryCUP(row.salaryTotal)}</td></tr>))}</tbody>
                                    </table>
                                  </div>
                                  <ul className="sm:hidden divide-y divide-amber-50">
                                    {turnProductSalaryRows.map((row: any) => (
                                      <li key={row.key} className="space-y-1 px-3 py-2.5">
                                        <div className="flex items-start justify-between gap-2">
                                          <span className="min-w-0 text-[10px] font-black uppercase leading-snug text-slate-700 break-words">{row.employeeName}</span>
                                          <span className="shrink-0 text-[10px] font-black text-violet-900 whitespace-nowrap tabular-nums">{formatSalaryCUP(row.salaryTotal)}</span>
                                        </div>
                                        <p className="text-[9px] font-black uppercase leading-snug text-slate-900 break-words">{row.productName}</p>
                                        <p className="text-[8px] font-bold uppercase text-slate-500 tabular-nums">{row.quantity} uds × {formatSalaryCUP(row.salaryPerUnit)}</p>
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                              ) : <div className="bg-white rounded-xl border border-amber-100 px-3 py-4 text-center"><p className="text-[7px] font-black text-slate-400 uppercase tracking-wider">No hay ventas cobradas en este turno</p></div>}
                            </div>
                          </div>
                        );
                      })()}
                    </section>

                    <div className="pt-1">
                      <button
                        type="submit"
                        disabled={isClosingSession}
                        className="w-full py-4 bg-slate-900 text-white rounded-2xl font-black text-xs uppercase tracking-widest hover:bg-slate-800 transition-all shadow-xl shadow-slate-200 active:scale-95 flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed"
                      >
                        {isClosingSession ? <RefreshCw className="w-4 h-4 text-emerald-400 animate-spin" /> : <ShieldCheck className="w-4 h-4 text-emerald-400" />}
                        {isClosingSession ? "Confirmando Cierre..." : "Cerrar Turno y Finalizar"}
                      </button>
                      <p className="mt-2 text-center text-[8px] font-bold uppercase tracking-wide text-slate-400">
                        El inventario ya se descontó al cobrar cada ticket. Cerrar el turno no vuelve a descontar stock.
                      </p>
                    </div>
                  </form>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
