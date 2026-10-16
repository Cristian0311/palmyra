import { Search, Wifi, WifiOff, RefreshCw, Plus, Minus, CreditCard, Receipt, Trash2, ShoppingCart, ShieldCheck, DollarSign, Banknote, QrCode, ArrowLeftRight, UserPlus, X, Lock, Unlock, Camera, AlertCircle, TrendingUp, Wallet, MessageSquare, Mail, HelpCircle, Calculator, ArrowRight, Package, User, RotateCcw, Printer, Bluetooth, Usb, Smartphone, Send, Copy, Check, CheckCircle, Share2, Store, ChevronDown, ChevronUp, Filter } from "lucide-react";
import { cn, generateId } from "../lib/utils";
import { useStore } from "../store/useStore";
import { Product, Payment, Transaction, CashRegisterSession } from "../types";
import { formatMoney } from "../modules/pos/utils/paymentMath";
import { CashMovementTicket } from "../components/cash/CashMovementTicket";

type ModalProps = Record<string, any>;

export default function POSCashManagementModal(props: ModalProps) {
  const { activeTransactions, addNotification, bankCards, baseCurrency, cashDisplayCurrencies, cashManagementTab, closingBalances, companyCompensation, currencies, currentSession, currentUser, expectedBalances, formatSalaryCUP, handleAddMovement, handleClose, handlePrintClosureThermal, handleThermalPrint, isClosingSession, movementData, products, removeCashMovement, salesFilter, salesSubTab, sessionClosingDate, sessionWorkerName, setCashManagementTab, setClosingBalances, setMovementData, setSalesFilter, setSalesSubTab, setSessionClosingDate, setShowCashManagementModal, setShowReceiptModal, showCashManagementModal, turnProductSalaryRows, users } = props;
  return (
    <>
      {showCashManagementModal && currentSession && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[70] flex items-center justify-center p-4">
          <div className="palmyra-mobile-modal bg-white rounded-2xl sm:rounded-[2rem] shadow-2xl w-full max-w-2xl overflow-hidden animate-in zoom-in-95 border border-white/20 flex flex-col max-h-[calc(100dvh-1rem)]">
            <div className="p-4 border-b border-slate-50 flex items-center justify-between bg-slate-900 text-white shrink-0">
              <div className="flex items-center gap-2">
                <Receipt className="w-4 h-4 text-indigo-400" />
                <h3 className="text-xs font-black uppercase tracking-widest">Caja y Ventas del Turno</h3>
              </div>
              <button 
                onClick={() => setShowCashManagementModal(false)}
                className="p-1.5 hover:bg-white/10 rounded-full transition-colors text-slate-400"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            
            <div className="flex border-b border-slate-100 bg-slate-50/50 shrink-0">
              <button
                onClick={() => setCashManagementTab('movements')}
                className={cn(
                  "flex-1 py-2.5 text-[9px] font-black uppercase tracking-widest transition-colors",
                  cashManagementTab === 'movements' ? "text-indigo-600 border-b-2 border-indigo-600 bg-white" : "text-slate-400 hover:text-slate-600"
                )}
              >
                Movimientos
              </button>
              <button
                onClick={() => setCashManagementTab('sales')}
                className={cn(
                  "flex-1 py-2.5 text-[9px] font-black uppercase tracking-widest transition-colors",
                  cashManagementTab === 'sales' ? "text-indigo-600 border-b-2 border-indigo-600 bg-white" : "text-slate-400 hover:text-slate-600"
                )}
              >
                Ventas del Turno
              </button>
              <button
                onClick={() => setCashManagementTab('close')}
                className={cn(
                  "flex-1 py-2.5 text-[9px] font-black uppercase tracking-widest transition-colors",
                  cashManagementTab === 'close' ? "text-indigo-600 border-b-2 border-indigo-600 bg-white" : "text-slate-400 hover:text-slate-600"
                )}
              >
                Arqueo y Cierre
              </button>
            </div>

            <div className="p-5 max-h-[70vh] overflow-y-auto custom-scrollbar">
              {cashManagementTab === 'movements' ? (
                <div className="space-y-6">
                  <form onSubmit={handleAddMovement} className="p-4 bg-slate-50 rounded-2xl border border-slate-200 space-y-4">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-[8px] font-black text-slate-400 uppercase tracking-widest mb-1">Tipo</label>
                        <select 
                          value={movementData.type}
                          onChange={e => setMovementData({...movementData, type: e.target.value as any})}
                          className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-[10px] font-black uppercase outline-none focus:ring-2 focus:ring-indigo-500"
                        >
                          <option value="expense">Egreso (Gasto)</option>
                          <option value="income">Ingreso (Entrada)</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-[8px] font-black text-slate-400 uppercase tracking-widest mb-1">Moneda</label>
                        <select 
                          value={movementData.currencyCode}
                          onChange={e => setMovementData({...movementData, currencyCode: e.target.value})}
                          className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-[10px] font-black uppercase outline-none focus:ring-2 focus:ring-indigo-500"
                        >
                          {currencies.map(c => <option key={c.code} value={c.code}>{c.code}</option>)}
                        </select>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-[8px] font-black text-slate-400 uppercase tracking-widest mb-1">Monto</label>
                        <input 
                          type="number" 
                          step="0.01" 
                          required
                          value={movementData.amount}
                          onFocus={(e) => e.target.select()}
                          onChange={e => setMovementData({...movementData, amount: e.target.value})}
                          className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-[10px] font-black outline-none focus:ring-2 focus:ring-indigo-500"
                          placeholder="0.00"
                        />
                      </div>
                      <div>
                        <label className="block text-[8px] font-black text-slate-400 uppercase tracking-widest mb-1">Descripción</label>
                        <input 
                          type="text" 
                          required
                          value={movementData.description}
                          onChange={e => setMovementData({...movementData, description: e.target.value})}
                          className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-[10px] font-black outline-none focus:ring-2 focus:ring-indigo-500"
                          placeholder="Ej: Pago de almuerzo"
                        />
                      </div>
                    </div>
                    <button type="submit" className="w-full py-2 bg-indigo-600 text-white rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-indigo-700 transition-colors shadow-md shadow-indigo-100">
                      Registrar Movimiento
                    </button>
                  </form>

                  <div className="space-y-2">
                    <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Historial de Turno</h4>
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
                              <p className="text-[10px] font-black text-slate-900 uppercase tracking-tight">{m.description}</p>
                              <p className="text-[8px] font-bold text-slate-400 uppercase">{new Date(m.date).toLocaleTimeString()}</p>
                            </div>
                          </div>
                          
                          <div className="flex items-center gap-3">
                            <p className={cn(
                              "text-[11px] font-black",
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
                              className="p-1 text-slate-400 hover:text-rose-600 rounded-full hover:bg-rose-50 transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100"
                              title="Eliminar movimiento"
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
                      t.sessionId === currentSession?.id && !t.deletedAt
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
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5 sm:gap-2">
                          <div className="min-w-0 bg-emerald-50/80 border border-emerald-100 rounded-xl p-2 sm:p-2.5 flex min-h-[68px] flex-col justify-between shadow-sm">
                            <div className="flex items-center justify-between text-emerald-700 mb-0.5">
                              <span className="text-[7px] sm:text-[8px] font-black uppercase tracking-wider">Efectivo CUP</span>
                              <Banknote className="w-3 h-3 sm:w-3.5 sm:h-3.5 shrink-0" />
                            </div>
                            <span className="text-[11px] sm:text-xs font-black text-emerald-900 truncate">
                              {formatMoney(cashCupSum, '')} CUP
                            </span>
                          </div>

                          <div className="min-w-0 bg-amber-50/80 border border-amber-100 rounded-xl p-2 sm:p-2.5 flex min-h-[68px] flex-col justify-between shadow-sm">
                            <div className="flex items-center justify-between text-amber-700 mb-0.5">
                              <span className="text-[7px] sm:text-[8px] font-black uppercase tracking-wider">Efectivo USD</span>
                              <DollarSign className="w-3 h-3 sm:w-3.5 sm:h-3.5 shrink-0" />
                            </div>
                            <div className="min-w-0">
                              <span className="text-[11px] sm:text-xs font-black text-amber-900 block truncate">
                                ${cashUsdSum.toFixed(2)} USD
                              </span>
                              <span className="text-[7px] sm:text-[8px] font-bold text-amber-600 block truncate">
                                {formatMoney(cashUsdSum * (currencies.find(c => c.code === 'USD')?.rateToBase || 1), baseCurrency.symbol)} CUP eq.
                              </span>
                            </div>
                          </div>

                          <div className="min-w-0 bg-blue-50/80 border border-blue-100 rounded-xl p-2 sm:p-2.5 flex min-h-[68px] flex-col justify-between shadow-sm">
                            <div className="flex items-center justify-between text-blue-700 mb-0.5">
                              <span className="text-[7px] sm:text-[8px] font-black uppercase tracking-wider">Transferencia CUP</span>
                              <CreditCard className="w-3 h-3 sm:w-3.5 sm:h-3.5 shrink-0" />
                            </div>
                            <span className="text-[11px] sm:text-xs font-black text-blue-900 truncate">
                              {formatMoney(transferCupSum, '')} CUP
                            </span>
                          </div>

                          <div className="min-w-0 bg-indigo-50/80 border border-indigo-100 rounded-xl p-2 sm:p-2.5 flex min-h-[68px] flex-col justify-between shadow-sm">
                            <div className="flex items-center justify-between text-indigo-700 mb-0.5">
                              <span className="text-[7px] sm:text-[8px] font-black uppercase tracking-wider">Total Ventas</span>
                              <Package className="w-3 h-3 sm:w-3.5 sm:h-3.5 shrink-0" />
                            </div>
                            <div className="min-w-0">
                              <span className="text-[11px] sm:text-xs font-black text-indigo-900 block truncate">
                                {formatMoney(totalSalesAmount, baseCurrency.symbol)} CUP
                              </span>
                              <span className="text-[7px] sm:text-[8px] font-bold text-indigo-600 block truncate">
                                {sessionTx.length} {sessionTx.length === 1 ? 'ticket' : 'tickets'}
                              </span>
                            </div>
                          </div>

                          <div className="min-w-0 bg-rose-50/80 border border-rose-100 rounded-xl p-2 sm:p-2.5 flex min-h-[68px] flex-col justify-between shadow-sm">
                            <div className="flex items-center justify-between text-rose-700 mb-0.5">
                              <span className="text-[7px] sm:text-[8px] font-black uppercase tracking-wider">Egreso</span>
                              <AlertCircle className="w-3 h-3 sm:w-3.5 sm:h-3.5 shrink-0" />
                            </div>
                            <div className="min-w-0">
                              <span className="text-[11px] sm:text-xs font-black text-rose-900 block truncate">
                                {formatMoney(movementTotals.expenseBase, baseCurrency.symbol)} CUP
                              </span>
                              <span className="text-[6.5px] sm:text-[7px] font-bold text-rose-600 block truncate">
                                {movementTotals.expenseBase > 0 ? 'Ya descontado del efectivo' : 'Sin egresos registrados'}
                              </span>
                            </div>
                          </div>

                          <div className="min-w-0 bg-violet-50/80 border border-violet-100 rounded-xl p-2 sm:p-2.5 flex min-h-[68px] flex-col justify-between shadow-sm">
                            <div className="flex items-center justify-between text-violet-700 mb-0.5">
                              <span className="text-[7px] sm:text-[8px] font-black uppercase tracking-wider">Ingreso</span>
                              <TrendingUp className="w-3 h-3 sm:w-3.5 sm:h-3.5 shrink-0" />
                            </div>
                            <div className="min-w-0">
                              <span className="text-[11px] sm:text-xs font-black text-violet-900 block truncate">
                                {formatMoney(movementTotals.incomeBase, baseCurrency.symbol)} CUP
                              </span>
                              <span className="text-[6.5px] sm:text-[7px] font-bold text-violet-600 block truncate">
                                {movementTotals.incomeBase > 0 ? 'Ya agregado al efectivo' : 'Sin ingresos registrados'}
                              </span>
                            </div>
                          </div>
                        </div>

                        {/* Subtabs & Filters */}
                        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2 pt-1 border-t border-slate-100">
                          {/* Subtabs */}
                          <div className="flex bg-slate-100 p-0.5 rounded-xl text-[9px] font-black uppercase">
                            <button
                              onClick={() => setSalesSubTab('tickets')}
                              className={cn(
                                "px-3 py-1.5 rounded-lg transition-all flex items-center gap-1",
                                salesSubTab === 'tickets' ? "bg-white text-indigo-600 shadow-sm" : "text-slate-500 hover:text-slate-800"
                              )}
                            >
                              <Receipt className="w-3 h-3" />
                              Tickets ({sessionTx.length})
                            </button>
                            <button
                              onClick={() => setSalesSubTab('products')}
                              className={cn(
                                "px-3 py-1.5 rounded-lg transition-all flex items-center gap-1",
                                salesSubTab === 'products' ? "bg-white text-indigo-600 shadow-sm" : "text-slate-500 hover:text-slate-800"
                              )}
                            >
                              <Package className="w-3 h-3" />
                              Productos ({consolidatedList.reduce((s, p) => s + p.quantity, 0)} u.)
                            </button>
                            <button
                              onClick={() => setSalesSubTab('movements')}
                              className={cn(
                                "px-3 py-1.5 rounded-lg transition-all flex items-center gap-1",
                                salesSubTab === 'movements' ? "bg-white text-emerald-600 shadow-sm" : "text-slate-500 hover:text-slate-800"
                              )}
                            >
                              <Wallet className="w-3 h-3" />
                              Egreso y gasto ({(currentSession?.movements || []).length})
                            </button>
                          </div>

                          {/* Filter by Payment Method */}
                          {salesSubTab === 'tickets' && (
                            <div className="flex items-center gap-1 overflow-x-auto max-w-full pb-0.5">
                              <button
                                onClick={() => setSalesFilter('all')}
                                className={cn(
                                  "px-2 py-1 rounded-lg text-[8px] font-black uppercase tracking-wider whitespace-nowrap transition-all",
                                  salesFilter === 'all' ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-500 hover:bg-slate-200"
                                )}
                              >
                                Todos
                              </button>
                              <button
                                onClick={() => setSalesFilter('usd')}
                                className={cn(
                                  "px-2 py-1 rounded-lg text-[8px] font-black uppercase tracking-wider whitespace-nowrap transition-all flex items-center gap-0.5",
                                  salesFilter === 'usd' ? "bg-amber-600 text-white" : "bg-amber-50 text-amber-700 hover:bg-amber-100"
                                )}
                              >
                                💵 USD
                              </button>
                              <button
                                onClick={() => setSalesFilter('transfer')}
                                className={cn(
                                  "px-2 py-1 rounded-lg text-[8px] font-black uppercase tracking-wider whitespace-nowrap transition-all flex items-center gap-0.5",
                                  salesFilter === 'transfer' ? "bg-blue-600 text-white" : "bg-blue-50 text-blue-700 hover:bg-blue-100"
                                )}
                              >
                                💳 Transferencia
                              </button>
                              <button
                                onClick={() => setSalesFilter('cash_cup')}
                                className={cn(
                                  "px-2 py-1 rounded-lg text-[8px] font-black uppercase tracking-wider whitespace-nowrap transition-all flex items-center gap-0.5",
                                  salesFilter === 'cash_cup' ? "bg-emerald-600 text-white" : "bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                                )}
                              >
                                💵 Efectivo CUP
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
                                          <span className="font-mono text-[9px] font-black text-indigo-700 bg-indigo-50 px-1.5 py-0.5 rounded-md border border-indigo-100">
                                            {tx.ticketNumber || `#${tx.id.slice(0, 8).toUpperCase()}`}
                                          </span>
                                          {tx.offlinePending && (
                                            <span className="text-[8px] font-black uppercase tracking-wide text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded-md border border-amber-100">
                                              Pendiente
                                            </span>
                                          )}
                                          <span className="text-[9px] font-bold text-slate-400">
                                            {new Date(tx.date).toLocaleDateString("es-CU", { day: "2-digit", month: "2-digit", year: "2-digit" })} · {new Date(tx.date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                                          </span>
                                          <span className="text-[9px] font-bold text-slate-600">
                                            • {customer?.name || 'Consumidor Final'}
                                          </span>
                                        </div>
                                      </div>

                                      <div className="flex items-center gap-2 shrink-0">
                                        <span className="text-xs font-black text-slate-900 dark:text-white">
                                          {formatMoney(tx.total, baseCurrency.symbol)}
                                        </span>
                                        <div className="flex items-center gap-1">
                                          <button
                                            onClick={() => setShowReceiptModal(tx)}
                                            className="p-1 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-950/40 rounded-lg transition-colors cursor-pointer"
                                            title="Ver Comprobante Flotante"
                                          >
                                            <Receipt className="w-3.5 h-3.5" />
                                          </button>
                                          <button
                                            onClick={() => handleThermalPrint(tx)}
                                            className="p-1 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-950/40 rounded-lg transition-colors cursor-pointer"
                                            title="Imprimir Ticket Térmico"
                                          >
                                            <Printer className="w-3.5 h-3.5" />
                                          </button>
                                          <button
                                            onClick={() => {
                                              if (window.confirm(`¿Estás seguro de eliminar el ticket ${tx.id}? Esto devolverá los productos al inventario.`)) {
                                                useStore.getState().deleteTransaction(tx.id);
                                                addNotification(`Ticket ${tx.id} eliminado y stock restaurado.`, 'info');
                                              }
                                            }}
                                            className="p-1 text-slate-300 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40 rounded-lg transition-colors cursor-pointer"
                                            title="Anular Venta"
                                          >
                                            <Trash2 className="w-3.5 h-3.5" />
                                          </button>
                                        </div>
                                      </div>
                                    </div>

                                    {/* Products list in this ticket - Compact & Contained */}
                                    <div className="bg-slate-50 dark:bg-slate-800/40 rounded-lg p-1.5 space-y-0.5 text-[8px] max-h-20 sm:max-h-24 overflow-y-auto custom-scrollbar">
                                      {tx.items.map((item, idx) => (
                                        <div key={idx} className="flex justify-between items-center text-slate-700 font-bold">
                                          <span className="truncate pr-2">
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
                                    <div className="flex items-center justify-between gap-1.5 flex-wrap pt-0.5 border-t border-slate-100 text-[7px] font-black">
                                      <div className="flex items-center gap-1 flex-wrap">
                                        {cat === 'usd' && (
                                          <span className="bg-amber-100 text-amber-800 px-2 py-0.5 rounded-full flex items-center gap-1">
                                            💵 100% Pagado en USD
                                          </span>
                                        )}
                                        {cat === 'transfer' && (
                                          <span className="bg-blue-100 text-blue-800 px-2 py-0.5 rounded-full flex items-center gap-1">
                                            💳 Pagado por Transferencia
                                          </span>
                                        )}
                                        {cat === 'cash_cup' && (
                                          <span className="bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded-full flex items-center gap-1">
                                            💵 Pagado en Efectivo CUP
                                          </span>
                                        )}
                                        {cat === 'mixed' && (
                                          <span className="bg-purple-100 text-purple-800 px-2 py-0.5 rounded-full flex items-center gap-1">
                                            🔄 Pago Mixto / Multi-moneda
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
                                      <span className="w-7 h-7 bg-indigo-100 text-indigo-700 rounded-lg flex items-center justify-center font-black text-xs shrink-0">
                                        {prod.quantity}x
                                      </span>
                                      <div className="min-w-0">
                                        <span className="font-black text-slate-900 text-xs uppercase block truncate">{prod?.name || "Producto"}</span>
                                        <span className="text-[9px] font-bold text-slate-400 block">
                                          Precio unitario: {formatMoney(prod.unitPrice, baseCurrency.symbol)}
                                        </span>
                                      </div>
                                    </div>
                                    <span className="font-black text-indigo-600 text-xs shrink-0 ml-2">
                                      {formatMoney(prod.total, baseCurrency.symbol)}
                                    </span>
                                  </div>

                                  {/* Payment method breakdown for this product */}
                                  <div className="flex items-center gap-1.5 flex-wrap pt-1 border-t border-slate-100 text-[8px] font-bold">
                                    <span className="text-slate-400 uppercase tracking-widest text-[7px] font-black">Pagado en:</span>
                                    {prod.usdQty > 0 && (
                                      <span className="bg-amber-50 text-amber-800 border border-amber-200 px-1.5 py-0.5 rounded">
                                        💵 USD: {prod.usdQty} u. ({formatMoney(prod.usdTotal, baseCurrency.symbol)})
                                      </span>
                                    )}
                                    {prod.transferQty > 0 && (
                                      <span className="bg-blue-50 text-blue-800 border border-blue-200 px-1.5 py-0.5 rounded">
                                        💳 Transf: {prod.transferQty} u. ({formatMoney(prod.transferTotal, baseCurrency.symbol)})
                                      </span>
                                    )}
                                    {prod.cashCupQty > 0 && (
                                      <span className="bg-emerald-50 text-emerald-800 border border-emerald-200 px-1.5 py-0.5 rounded">
                                        💵 CUP: {prod.cashCupQty} u. ({formatMoney(prod.cashCupTotal, baseCurrency.symbol)})
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
                            className="flex-1 py-3 bg-indigo-600 text-white rounded-xl font-black text-xs uppercase tracking-widest hover:bg-indigo-700 transition-all shadow-md shadow-indigo-100 active:scale-95 flex items-center justify-center gap-2"
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
                <div className="space-y-6">
                  <div className="bg-gradient-to-r from-indigo-50 to-violet-50 rounded-2xl p-3 border border-indigo-100 shadow-sm">
                    <div>
                      <p className="text-[9px] font-black text-indigo-400 uppercase tracking-widest">Fondo Inicial</p>
                      <p className="text-base font-black text-indigo-900">{(currentSession?.openingBalance || 0).toLocaleString('es-CU', { minimumFractionDigits: 2 })} {baseCurrency.code}</p>
                    </div>
                    <button 
                      onClick={() => {
                        const autoBalances: {[key: string]: number} = {};
                        expectedBalances.forEach(eb => {
                          autoBalances[`${eb.currencyCode}-${eb.method}`] = eb.amount;
                        });
                        setClosingBalances(autoBalances);
                      }}
                      className="text-[9px] font-black uppercase text-white bg-indigo-600 hover:bg-indigo-700 px-3 py-1.5 rounded-xl transition-all shadow-md shadow-indigo-100 active:scale-95"
                    >
                      Cuadre Perfecto
                    </button>
                  </div>

                  <form onSubmit={handleClose} className="space-y-5">
                    {/* Fecha de Cierre Arriba */}
                    <div className="space-y-3">
                      <div className="bg-slate-50 p-3.5 rounded-2xl border border-slate-200">
                        <label className="block text-[8px] font-black text-slate-500 uppercase tracking-widest mb-1.5">
                          Fecha de Cierre del Turno
                        </label>
                        <input 
                          type="date"
                          required
                          value={sessionClosingDate}
                          onChange={(e) => setSessionClosingDate(e.target.value)}
                          className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs font-black text-slate-800 outline-none focus:ring-2 focus:ring-indigo-500 shadow-sm"
                        />
                      </div>

                      {/* Empleado del Turno (Sin volver a pedir el nombre) */}
                      <div className="bg-indigo-50/60 p-3 rounded-xl border border-indigo-100 flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <User className="w-4 h-4 text-indigo-600" />
                          <span className="text-[9px] font-black text-indigo-900 uppercase tracking-wider">Empleado Asignado:</span>
                        </div>
                        <span className="text-xs font-black text-indigo-950 uppercase tracking-tight">
                          {currentSession?.workerName || sessionWorkerName || currentUser?.name || 'Empleado'}
                        </span>
                      </div>

                      {/* Salary Calculation Card */}
                      {(() => {
                        const sessionUser = users.find(u => u.id === currentSession?.userId ||
                          (u.name && currentSession?.workerName && u.name.toLowerCase() === currentSession.workerName.toLowerCase())) || currentUser;
                        if (!sessionUser) return null;
                        const sessionOpenMs = new Date(currentSession.openedAt).getTime();
                        const sessionCloseMs = currentSession.closedAt ? new Date(currentSession.closedAt).getTime() : Infinity;
                        const sessionTx = activeTransactions.filter(t => {
                          if (t.deletedAt || t.status !== 'completed' || String(t.notes || '').startsWith('AJUSTE_')) return false;
                          if (t.sessionId === currentSession.id) return true;
                          if (t.sessionId || t.branchId !== currentSession.branchId) return false;
                          const txTime = new Date(t.date).getTime();
                          return Number.isFinite(txTime) && txTime >= sessionOpenMs && txTime <= sessionCloseMs;
                        });
                        const commissions = sessionTx.reduce((sum, tx) => {
                          const sellers = tx.sellerEmployeeIds?.length ? tx.sellerEmployeeIds : [tx.userId];
                          if (!sellers.includes(sessionUser.id)) return sum;
                          const splitFactor = Math.max(1, sellers.length);
                          if (companyCompensation.mode === 'sales_percent') {
                            return sum + (Math.max(0, Number(tx.total) || 0) * companyCompensation.percentRate / 100) / splitFactor;
                          }
                          return sum + (tx.items || []).reduce((itemSum, item) => {
                            const productSnapshot = typeof item.product === 'string' ? undefined : item.product;
                            const productId = typeof item.product === 'string' ? item.product : item.product?.id;
                            const product = productId ? products.find(p => p.id === productId) : undefined;
                            const commissionValue = product?.commissionValue ?? productSnapshot?.commissionValue ?? (item as any).product_snapshot?.commissionValue ?? (item as any).commissionValue ?? 0;
                            return itemSum + (Math.max(0, Number(commissionValue) || 0) * Math.max(0, Number(item.quantity) || 0)) / splitFactor;
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
                            <div className={percentageMode ? "rounded-xl border border-emerald-100 bg-emerald-50 px-3 py-2" : "rounded-xl border border-indigo-100 bg-indigo-50 px-3 py-2"}>
                              <p className={percentageMode ? "text-[8px] font-black uppercase tracking-wider text-emerald-700" : "text-[8px] font-black uppercase tracking-wider text-indigo-700"}>Cómo se calcula</p>
                              <p className={percentageMode ? "text-[9px] font-bold text-emerald-800" : "text-[9px] font-bold text-indigo-800"}>{percentageMode ? `La comisión se aplica al total de cada venta (${companyCompensation.percentRate}%) y se divide entre los vendedores de esa venta cuando corresponde.` : 'Cada producto aporta el CUP fijo configurado por unidad vendida.'}</p>
                            </div>
                            <div className="pt-2 border-t border-amber-100 flex justify-between items-center">
                              <span className="text-[9px] font-black text-amber-900 uppercase">Total salario del turno</span><span className="text-lg font-black text-amber-600">{formatSalaryCUP(totalSalary)}</span>
                            </div>
                            <div className="pt-3 border-t border-amber-100 space-y-2">
                              <div className="flex items-center justify-between gap-2"><span className="text-[9px] font-black text-amber-900 uppercase tracking-widest">Detalle de comisión</span><span className="text-[8px] font-black text-amber-700 uppercase whitespace-nowrap">{turnProductSalaryRows.reduce((sum, row) => sum + row.quantity, 0)} uds</span></div>
                              {turnProductSalaryRows.length > 0 ? (
                                <div className="overflow-x-auto rounded-xl border border-amber-100 bg-white">
                                  <table className="w-full min-w-[560px] text-left">
                                    <thead><tr className="bg-amber-50 border-b border-amber-100"><th className="px-3 py-2 text-[7px] font-black text-amber-700 uppercase">Empleado</th><th className="px-3 py-2 text-[7px] font-black text-amber-700 uppercase">Producto</th><th className="px-3 py-2 text-[7px] font-black text-amber-700 uppercase text-right">Cantidad</th><th className="px-3 py-2 text-[7px] font-black text-amber-700 uppercase text-right">Valor / unidad</th><th className="px-3 py-2 text-[7px] font-black text-amber-700 uppercase text-right">Comisión total</th></tr></thead>
                                    <tbody className="divide-y divide-amber-50">{turnProductSalaryRows.map(row => (<tr key={row.key}><td className="px-3 py-2 text-[8px] font-black text-slate-700 uppercase break-words">{row.employeeName}</td><td className="px-3 py-2 text-[8px] font-black text-slate-900 uppercase break-words">{row.productName}</td><td className="px-3 py-2 text-[8px] font-black text-slate-800 text-right">{row.quantity}</td><td className="px-3 py-2 text-[8px] font-black text-indigo-700 text-right">{formatSalaryCUP(row.salaryPerUnit)}</td><td className="px-3 py-2 text-[8px] font-black text-indigo-900 text-right">{formatSalaryCUP(row.salaryTotal)}</td></tr>))}</tbody>
                                  </table>
                                </div>
                              ) : <div className="bg-white rounded-xl border border-amber-100 px-3 py-4 text-center"><p className="text-[7px] font-black text-slate-400 uppercase tracking-wider">No hay ventas cobradas en este turno</p></div>}
                            </div>
                          </div>
                        );
                      })()}
                    </div>

                    <div className="space-y-3">
                      <div className="flex items-center justify-between border-b border-slate-100 pb-2"><div><h4 className="text-[10px] font-black text-slate-900 uppercase tracking-widest">Arqueo de efectivo</h4><p className="text-[8px] font-bold text-slate-400 uppercase mt-0.5">Cuenta lo que realmente hay en caja</p></div><span className="text-[8px] font-black text-indigo-600 bg-indigo-50 px-2 py-1 rounded-full">PASO 1</span></div>
                      <div className="grid grid-cols-2 gap-3">
                        <div className="bg-emerald-50 p-3 rounded-xl border-2 border-emerald-200 focus-within:ring-2 focus-within:ring-emerald-500 transition-all shadow-sm">
                          <label className="block text-[9px] font-black text-emerald-700 uppercase tracking-widest mb-1">Efectivo CUP / MN</label>
                          <p className="text-[7px] font-bold text-emerald-500 uppercase mb-1">Conteo físico de efectivo</p>
                          <input type="number" min="0" step="0.01" value={closingBalances['CUP-cash'] || ''} onFocus={(e) => e.target.select()} onChange={(e) => setClosingBalances({ ...closingBalances, ['CUP-cash']: parseFloat(e.target.value) || 0 })} className="w-full bg-transparent border-none focus:ring-0 outline-none font-black text-emerald-900 text-sm p-0" placeholder="0.00" />
                        </div>
                        {cashDisplayCurrencies.filter(c => c.code !== 'CUP').map(c => (
                          <div key={c.code} className="bg-slate-50 p-3 rounded-xl border border-slate-100 focus-within:ring-2 focus-within:ring-emerald-500 transition-all">
                            <label className="block text-[8px] font-black text-emerald-600 uppercase tracking-widest mb-1">Efectivo {c.code}</label>
                            <input type="number" min="0" step="0.01" value={closingBalances[c.code + '-cash'] || ''} onFocus={(e) => e.target.select()} onChange={(e) => setClosingBalances({ ...closingBalances, [c.code + '-cash']: parseFloat(e.target.value) || 0 })} className="w-full bg-transparent border-none focus:ring-0 outline-none font-black text-slate-900 text-sm p-0" placeholder="0.00" />
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="space-y-2">
                      <h4 className="text-[10px] font-black text-slate-900 uppercase tracking-widest border-b border-slate-100 pb-2">Resumen de pagos del turno</h4>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {expectedBalances.map((line) => (
                          <div key={line.currencyCode + '-' + line.method} className="bg-white border border-slate-200 rounded-xl px-3 py-2 flex items-center justify-between gap-3">
                            <div className="min-w-0">
                              <p className="text-[8px] font-black text-slate-500 uppercase">{line.method === 'cash' ? 'Efectivo' : 'Transferencia'} · {line.currencyCode}</p>
                              <p className="text-[7px] font-bold text-slate-400">Esperado en arqueo</p>
                            </div>
                            <span className="text-xs font-black text-slate-900 whitespace-nowrap">{formatMoney(Number(line.amount) || 0, currencies.find(c => c.code === line.currencyCode)?.symbol || line.currencyCode)}</span>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="space-y-2">
                      <h4 className="text-[10px] font-black text-slate-900 uppercase tracking-widest border-b border-slate-100 pb-2">Transferencias</h4>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        {Array.from(new Set(['CUP', ...expectedBalances.filter(line => line.method === 'transfer').map(line => line.currencyCode)]))
                          .map(code => (
                            <div key={code} className="bg-slate-50 p-3 rounded-xl border border-slate-100">
                              <label className="block text-[8px] font-black text-blue-600 uppercase tracking-widest mb-1">Transf. {code}</label>
                              <input
                                type="number"
                                min="0" step="0.01"
                                value={closingBalances[code + '-transfer'] || ''}
                                onFocus={(e) => e.target.select()}
                                onChange={(e) => setClosingBalances({ ...closingBalances, [code + '-transfer']: parseFloat(e.target.value) || 0 })}
                                className="w-full bg-transparent border-none focus:ring-0 outline-none font-black text-slate-900 text-sm p-0"
                                placeholder="0.00"
                              />
                            </div>
                          ))}
                      </div>
                    </div>

                    <div className="pt-2">
                      <button 
                        type="submit"
                        disabled={isClosingSession}
                        className="w-full py-4 bg-slate-900 text-white rounded-2xl font-black text-xs uppercase tracking-widest hover:bg-slate-800 transition-all shadow-xl shadow-slate-200 active:scale-95 flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed"
                      >
                        {isClosingSession ? <RefreshCw className="w-4 h-4 text-emerald-400 animate-spin" /> : <ShieldCheck className="w-4 h-4 text-emerald-400" />}
                        {isClosingSession ? "Confirmando Cierre..." : "Cerrar Turno y Finalizar"}
                      </button>
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
