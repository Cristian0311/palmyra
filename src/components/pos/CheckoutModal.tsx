import React, { useState } from "react";
import {
  Plus, Trash2, CreditCard, DollarSign, Copy, Check
} from "lucide-react";
import type { Currency } from "../../types";
import { cn } from "../../lib/utils";

export interface CheckoutPaymentLine {
  id: string;
  code: string;
  amount: number;
  method: "cash" | "transfer";
  bankCardId?: string;
}

export interface CheckoutModalProps {
  totalBase: number;
  baseCurrency: Currency;
  currencies: Currency[];
  totalPaidBase: number;
  remainingBase: number;
  changeBase: number;
  paymentLines: CheckoutPaymentLine[];
  activePaymentLineId: string | null;
  lockedPaymentMethod?: 'cash' | 'transfer';
  bankCards: Array<{
    id: string;
    bank?: string;
    bankName?: string;
    name?: string;
    cardHolder?: string;
    accountNumber?: string;
    lastFourDigits?: string;
    lastFour?: string;
    phone?: string;
    currency?: string;
  }>;
  isSubmittingCheckout: boolean;
  onClose: () => void;
  onAddPaymentLine: () => void;
  onRemovePaymentLine: (id: string) => void;
  onUpdatePaymentLine: (id: string, field: keyof CheckoutPaymentLine, value: any) => void;
  onSetActivePaymentLine: (id: string) => void;
  onAutoFillRemaining: (id: string) => void;
  onSplitUsdPayment: (id: string) => void;
  onHandleCheckout: () => void;
  onCopyFeedback?: (message: string) => void;
}

export default function CheckoutModal({
  totalBase,
  baseCurrency,
  currencies,
  totalPaidBase,
  remainingBase,
  changeBase,
  paymentLines,
  activePaymentLineId,
  lockedPaymentMethod,
  bankCards,
  isSubmittingCheckout,
  onClose,
  onAddPaymentLine,
  onRemovePaymentLine,
  onUpdatePaymentLine,
  onSetActivePaymentLine,
  onAutoFillRemaining,
  onSplitUsdPayment,
  onHandleCheckout,
  onCopyFeedback,
}: CheckoutModalProps) {
  const [copiedTransferInfo, setCopiedTransferInfo] = useState(false);
  const formatMoney = (amount: number, symbol: string) => {
    const isCup = symbol === "CUP" || symbol === "MN" || symbol === "CUC" || symbol === "₱";
    const decimals = isCup ? 0 : 2;
    return `${symbol} ${amount.toLocaleString("es-CU", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
  };

  return (
        <div className="fixed inset-0 bg-slate-950/70 backdrop-blur-sm z-[80] flex items-center justify-center p-2 sm:p-4 overflow-hidden animate-in fade-in duration-200">
          <div className="bg-white dark:bg-slate-900 rounded-2xl sm:rounded-3xl shadow-2xl w-full max-w-md sm:max-w-lg overflow-hidden animate-in zoom-in-95 flex flex-col max-h-[94vh] sm:max-h-[90vh] border border-slate-200 dark:border-slate-800">
            
            {/* Header: Total Summary (Compact) */}
            <div className="bg-slate-900 text-white p-3.5 sm:p-4 relative shrink-0">
              <button 
                onClick={onClose}
                className="absolute right-3 top-3 p-1.5 hover:bg-white/10 rounded-full transition-colors text-slate-400 hover:text-white"
                title="Cerrar cobro"
              >
                <Plus className="w-5 h-5 rotate-45" />
              </button>
              
              <div className="text-center">
                <p className="text-slate-400 text-[8px] sm:text-[9px] font-black uppercase tracking-[0.2em] mb-0.5">Total a Cobrar</p>
                <h3 className="text-2xl sm:text-3xl font-black tracking-tight">{formatMoney(totalBase, baseCurrency.symbol)}</h3>
                <div className="mt-1 flex flex-wrap justify-center gap-1.5">
                  {currencies.filter(c => !c.isBase).map(c => (
                    <span key={c.code} className="text-[8px] font-black bg-white/5 border border-white/10 px-2 py-0.5 rounded-lg text-slate-300">
                      {c.code}: {formatMoney(totalBase / c.rateToBase, c.symbol)}
                    </span>
                  ))}
                </div>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-3 sm:p-5 space-y-2 sm:space-y-3">
              {/* Status Bar (Compact) */}
              <div className="flex gap-2">
                <div className="flex-1 bg-subtle border border-base p-2 sm:p-3 rounded-xl sm:rounded-2xl">
                  <p className="text-[7px] sm:text-[8px] font-black text-muted uppercase tracking-widest">Pagado</p>
                  <p className="text-sm sm:text-base font-black text-primary">{formatMoney(totalPaidBase, baseCurrency.symbol)}</p>
                </div>
                <div className={cn(
                  "flex-1 p-2 sm:p-3 rounded-xl sm:rounded-2xl border transition-colors",
                  remainingBase > 0 ? "bg-rose-50 border-rose-100" : "bg-emerald-50 border-emerald-100"
                )}>
                  <p className="text-[7px] sm:text-[8px] font-black uppercase tracking-widest text-muted">
                    {remainingBase > 0 ? "Faltante" : "Vuelto"}
                  </p>
                  <p className={cn(
                    "text-sm sm:text-base font-black",
                    remainingBase > 0 ? "text-rose-600" : "text-emerald-600"
                  )}>
                    {formatMoney(remainingBase > 0 ? remainingBase : changeBase, baseCurrency.symbol)}
                  </p>
                </div>
              </div>

              {changeBase > 0 && (
                <div className="bg-emerald-50 border border-emerald-100 rounded-2xl p-4 shadow-sm animate-in fade-in slide-in-from-top-2">
                  <p className="text-[10px] font-black text-emerald-900 uppercase tracking-widest mb-1">Vuelto a entregar</p>
                  <p className="text-2xl font-black text-emerald-600">{formatMoney(changeBase, baseCurrency.symbol)}</p>
                  <p className="text-[9px] font-bold text-emerald-400 uppercase tracking-tight mt-1">Entregar en {baseCurrency.code}</p>
                </div>
              )}

              {/* Linear Payment Inputs (Compact) */}
              <div className="space-y-1.5">
                {paymentLines.map((line) => (
                  <div 
                    key={line.id}
                    onClick={() => onSetActivePaymentLine(line.id)}
                    className={cn(
                      "flex items-center gap-3 p-2.5 rounded-2xl border-2 transition-all cursor-pointer",
                      activePaymentLineId === line.id ? "bg-indigo-50 dark:bg-indigo-900/20 border-indigo-200 dark:border-indigo-800" : "bg-secondary border-base"
                    )}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className={cn(
                          "px-1.5 py-0.5 rounded-md text-[7px] font-black uppercase tracking-wider",
                          line.method === 'cash' ? "bg-emerald-600 text-white" : "bg-blue-600 text-white"
                        )}>
                          {line.method === 'cash' ? 'EFECTIVO' : 'TRANSFERENCIA'}
                        </span>
                        <span className="text-[9px] font-black text-muted uppercase tracking-widest">{line.code}</span>
                      </div>
                      <div className="text-lg font-black text-primary leading-none">
                        {formatMoney(line.amount, currencies.find(c => c.code === line.code)?.symbol || '')}
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {activePaymentLineId && (
                <div className="bg-slate-50 p-4 rounded-2xl border border-slate-200 animate-in slide-in-from-bottom-2 duration-300">
                  <div className="flex gap-2 mb-4">
                    <div className="flex-1 grid grid-cols-2 gap-1 p-1 bg-white rounded-xl border border-slate-100">
                      {(['cash','transfer'] as const).map(method => (
                        <button key={method} type="button"
                          onClick={() => activePaymentLineId && onUpdatePaymentLine(activePaymentLineId, 'method', method)}
                          className={cn(
                            "py-2 rounded-lg text-[9px] font-black uppercase text-center transition-all",
                            paymentLines.find(l => l.id === activePaymentLineId)?.method === method
                              ? method === 'transfer' ? "bg-blue-600 text-white" : "bg-emerald-600 text-white"
                              : "text-slate-400 hover:bg-slate-50"
                          )}>
                          {method === 'transfer' ? 'Transferencia' : 'Efectivo'}
                        </button>
                      ))}
                    </div>

                    <div className="flex-[1.2] flex gap-1 p-1 bg-white rounded-xl border border-slate-100 overflow-x-auto scrollbar-hide">
                      {currencies
                        .filter(c => {
                          const activeLine = paymentLines.find(l => l.id === activePaymentLineId);
                          if (activeLine?.method === 'transfer') return c.code === 'CUP' || c.code === 'MN';
                          return true;
                        })
                        .map(c => (
                          <button
                            key={c.code}
                            onClick={() => {
                              const line = paymentLines.find(l => l.id === activePaymentLineId);
                              if (line && !(line.method === 'transfer' && c.code !== 'CUP' && c.code !== 'MN')) {
                                onUpdatePaymentLine(line.id, 'code', c.code);
                              }
                            }}
                            className={cn(
                              "flex-1 py-2 px-3 rounded-lg text-[9px] font-black transition-all min-w-[3.5rem]",
                              paymentLines.find(l => l.id === activePaymentLineId)?.code === c.code
                                ? "bg-indigo-600 text-white shadow-sm"
                                : "text-slate-400 hover:bg-slate-50"
                            )}
                          >{c.code}</button>
                        ))}
                    </div>
                  </div>

                  <div className="space-y-4">
                    {paymentLines.find(l => l.id === activePaymentLineId)?.method === 'transfer' && (
                      <div className="bg-slate-900 text-white rounded-2xl p-3 sm:p-3.5 border border-slate-800 shadow-md space-y-2.5 animate-in fade-in duration-200">
                        {/* Header: Selector & Bank Info */}
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-2 border-b border-slate-800/80 min-w-0">
                          <div className="flex items-center gap-1.5 shrink-0">
                            <div className="w-6 h-6 rounded-lg bg-blue-500/20 text-blue-400 border border-blue-500/30 flex items-center justify-center">
                              <CreditCard className="w-3.5 h-3.5" />
                            </div>
                            <span className="text-[10px] font-black uppercase tracking-wider text-slate-200">Cuenta de Destino:</span>
                          </div>
                          
                          <select
                            value={paymentLines.find(l => l.id === activePaymentLineId)?.bankCardId || ''}
                            onChange={(e) => onUpdatePaymentLine(activePaymentLineId, 'bankCardId', e.target.value)}
                            className="w-full sm:flex-1 sm:max-w-[240px] min-w-0 px-2.5 py-1.5 bg-slate-800 hover:bg-slate-750 text-white border border-slate-700 rounded-xl focus:ring-2 focus:ring-emerald-500 outline-none text-[10px] font-bold truncate transition-colors"
                          >
                            <option value="" className="text-slate-900 bg-white">Seleccionar Cuenta / Tarjeta...</option>
                            {(() => {
                              const activeLineCode = paymentLines.find(l => l.id === activePaymentLineId)?.code;
                              const cardsToRender = bankCards.filter(c =>
                                c.currency === activeLineCode ||
                                (activeLineCode === 'MN' && c.currency === 'CUP')
                              );
                              return cardsToRender.map(card => (
                                <option key={card.id} value={card.id} className="text-slate-900 bg-white">
                                  {card.bank || 'Banco'} - {card.name || 'Tarjeta'} ({card.currency || 'CUP'})
                                </option>
                              ));
                            })()}
                          </select>
                        </div>

                        {/* Card Details Body */}
                        {(() => {
                          const activeLine = paymentLines.find(l => l.id === activePaymentLineId);
                          const card = bankCards.find(c => c.id === activeLine?.bankCardId);
                          if (!card) {
                            return (
                              <div className="p-2.5 bg-slate-800/50 border border-slate-800 rounded-xl text-center">
                                <p className="text-[9px] font-bold text-slate-400">Seleccione arriba la cuenta receptora para ver la tarjeta y teléfono de confirmación.</p>
                              </div>
                            );
                          }

                          const rawAccount = card.accountNumber || card.lastFourDigits || card.lastFour || '';
                          const cleanAccount = rawAccount ? rawAccount.replace(/\s+/g, '') : '';
                          const cleanDigits = rawAccount ? rawAccount.replace(/\D/g, '') : '';
                          const formattedCardNumber = cleanDigits.length > 0 
                            ? cleanDigits.replace(/(\d{4})(?=\d)/g, '$1 ') 
                            : rawAccount;
                          const cleanPhone = card.phone ? card.phone.replace(/\D/g, '') : '';
                          const isCup = activeLine?.code === 'CUP' || activeLine?.code === 'MN';
                          const transferAmt = isCup ? Math.round(activeLine?.amount || 0) : (activeLine?.amount || 0);

                          const handleCopyText = (text: string, label: string) => {
                            navigator.clipboard?.writeText(text);
                            onCopyFeedback?.(`${label} copiado`);
                            setTimeout(() => onCopyFeedback?.(""), 2000);
                          };

                          const handleCopyAllTransferData = () => {
                            const bankDisplay = card.bank || card.bankName || 'Banco';
                            const holderDisplay = card.name || card.cardHolder || 'Titular';
                            const textToCopy = `Banco: ${bankDisplay}\nTitular: ${holderDisplay}\nTarjeta: ${cleanDigits || cleanAccount}\n${card.phone ? `Confirmar SMS al: ${card.phone}\n` : ''}Monto Exacto: ${transferAmt} ${activeLine?.code || 'CUP'}`;
                            navigator.clipboard?.writeText(textToCopy);
                            setCopiedTransferInfo(true);
                            setTimeout(() => setCopiedTransferInfo(false), 2500);
                          };

                          return (
                            <div className="space-y-2">
                              {/* Tarjeta Magnética */}
                              <div className="p-2.5 bg-slate-950 border border-slate-800 rounded-xl flex items-center justify-between gap-2 shadow-inner">
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-1.5 mb-0.5">
                                    <span className="text-[7px] font-black uppercase tracking-widest text-slate-400">Número de Tarjeta</span>
                                    <span className="text-[7px] font-bold text-slate-500 uppercase">({card.bank})</span>
                                  </div>
                                  <div className="font-mono font-black text-sm sm:text-base tracking-widest text-emerald-400 select-all whitespace-nowrap overflow-x-auto scrollbar-hide py-0.5">
                                    {formattedCardNumber}
                                  </div>
                                </div>
                                <button
                                  type="button"
                                  onClick={() => handleCopyText(cleanDigits || cleanAccount, 'Tarjeta')}
                                  className="px-2.5 py-1.5 bg-emerald-500 hover:bg-emerald-600 active:scale-95 text-white rounded-lg text-[9px] font-black uppercase tracking-wider flex items-center gap-1 transition-all shadow-sm shrink-0"
                                  title="Copiar número de tarjeta"
                                >
                                  <Copy className="w-3 h-3" />
                                  <span>Copiar</span>
                                </button>
                              </div>

                              {/* Monto y Teléfono SMS en fila compacta */}
                              <div className="grid grid-cols-2 gap-2">
                                {/* Monto Exacto */}
                                <div className="p-2 bg-slate-800/80 border border-slate-700/80 rounded-xl flex items-center justify-between gap-1">
                                  <div className="min-w-0">
                                    <p className="text-[7px] font-black text-emerald-400 uppercase tracking-widest leading-none mb-0.5">Monto Exacto</p>
                                    <p className="text-xs font-black text-white truncate">
                                      {transferAmt.toLocaleString('es-CU')} {activeLine?.code || 'CUP'}
                                    </p>
                                  </div>
                                  <button
                                    type="button"
                                    onClick={() => handleCopyText(transferAmt.toString(), 'Monto')}
                                    className="p-1 hover:bg-slate-700 text-slate-400 hover:text-white rounded transition-colors shrink-0"
                                    title="Copiar monto"
                                  >
                                    <Copy className="w-3 h-3" />
                                  </button>
                                </div>

                                {/* Teléfono SMS */}
                                {card.phone ? (
                                  <div className="p-2 bg-slate-800/80 border border-slate-700/80 rounded-xl flex items-center justify-between gap-1">
                                    <div className="min-w-0">
                                      <p className="text-[7px] font-black text-blue-400 uppercase tracking-widest leading-none mb-0.5">Confirmar SMS</p>
                                      <p className="text-xs font-mono font-bold text-white truncate">{card.phone}</p>
                                    </div>
                                    <button
                                      type="button"
                                      onClick={() => handleCopyText(cleanPhone, 'Teléfono')}
                                      className="p-1 hover:bg-slate-700 text-slate-400 hover:text-white rounded transition-colors shrink-0"
                                      title="Copiar teléfono"
                                    >
                                      <Copy className="w-3 h-3" />
                                    </button>
                                  </div>
                                ) : (
                                  <div className="p-2 bg-slate-800/80 border border-slate-700/80 rounded-xl flex items-center justify-between gap-1">
                                    <div className="min-w-0">
                                      <p className="text-[7px] font-black text-slate-400 uppercase tracking-widest leading-none mb-0.5">Titular</p>
                                      <p className="text-xs font-bold text-slate-200 truncate">{card?.name || 'Titular'}</p>
                                    </div>
                                  </div>
                                )}
                              </div>

                              {/* Botón para copiar todos los datos */}
                              <button
                                type="button"
                                onClick={handleCopyAllTransferData}
                                className="w-full py-1.5 px-3 bg-slate-800 hover:bg-slate-750 border border-slate-700 text-slate-200 rounded-xl text-[10px] sm:text-[10px] font-black uppercase tracking-wider transition-all flex items-center justify-center gap-1.5 active:scale-98"
                              >
                                {copiedTransferInfo ? (
                                  <>
                                    <Check className="w-3 h-3 text-emerald-400" />
                                    <span className="text-emerald-400">¡Datos de pago copiados!</span>
                                  </>
                                ) : (
                                  <>
                                    <Copy className="w-3 h-3 text-slate-400" />
                                    <span>Copiar datos de pago (WhatsApp / SMS)</span>
                                  </>
                                )}
                              </button>
                            </div>
                          );
                        })()}
                      </div>
                    )}

                    <div className="flex justify-between items-end mb-1 px-1 gap-2 flex-wrap">
                      <label className="block text-[8px] font-black text-slate-400 uppercase tracking-widest">Monto a recibir</label>
                      <div className="flex gap-2">
                        {paymentLines.find(l => l.id === activePaymentLineId)?.code === 'USD' && 
                         (paymentLines.find(l => l.id === activePaymentLineId)?.amount || 0) % 1 !== 0 && (
                          <button 
                            onClick={() => onSplitUsdPayment(activePaymentLineId)}
                            className="bg-amber-50 text-amber-700 text-[9px] font-black px-3 py-1 rounded-full border border-amber-200 hover:bg-amber-100 transition-all flex items-center gap-1 shadow-sm"
                            title="Pagar enteros en USD y el resto en CUP"
                          >
                            <DollarSign className="w-2.5 h-2.5" /> USD Entero + CUP
                          </button>
                        )}
                        {remainingBase > 0 && (
                          <button 
                            onClick={() => onAutoFillRemaining(activePaymentLineId)}
                            className={cn(
                              "px-3 py-1 rounded-full transition-all uppercase tracking-tighter shadow-lg flex items-center gap-1.5",
                              paymentLines.find(l => l.id === activePaymentLineId)?.method === 'transfer' 
                                ? "bg-blue-600 text-white text-[11px] font-black ring-4 ring-blue-100" 
                                : "bg-indigo-50 text-indigo-600 text-[9px] font-black"
                            )}
                          >
                            {paymentLines.find(l => l.id === activePaymentLineId)?.method === 'transfer' && <div className="w-2 h-2 rounded-full bg-white animate-ping" />}
                            Total a cobrar: {formatMoney(remainingBase / (currencies.find(c => c.code === paymentLines.find(l => l.id === activePaymentLineId)?.code)?.rateToBase || 1), currencies.find(c => c.code === paymentLines.find(l => l.id === activePaymentLineId)?.code)?.symbol || '')}
                          </button>
                        )}
                      </div>
                    </div>
                    <input 
                      type="number"
                      step="0.01"
                      autoFocus
                      onFocus={(e) => e.target.select()}
                      value={(() => {
                        const amt = paymentLines.find(l => l.id === activePaymentLineId)?.amount;
                        return (amt === undefined || Number.isNaN(amt)) ? '' : amt;
                      })()}
                      onChange={(e) => onUpdatePaymentLine(activePaymentLineId, 'amount', parseFloat(e.target.value) || 0)}
                      className="w-full px-4 py-3 bg-white border border-slate-200 rounded-2xl focus:ring-2 focus:ring-indigo-500 outline-none text-2xl font-black text-slate-900 shadow-inner"
                      placeholder="0.00"
                    />
                  </div>
                </div>
              )}
              <div className="flex justify-end gap-2 pt-1">
                <button type="button" onClick={onAddPaymentLine} className="px-3 py-2 rounded-xl border border-slate-200 bg-white text-[9px] font-black uppercase text-indigo-600 hover:bg-indigo-50">+ Agregar forma de pago</button>
                {paymentLines.length > 1 && activePaymentLineId && (
                  <button type="button" onClick={() => onRemovePaymentLine(activePaymentLineId)} className="px-3 py-2 rounded-xl border border-rose-200 bg-white text-[9px] font-black uppercase text-rose-600 hover:bg-rose-50">Quitar</button>
                )}
              </div>
            </div>

            <div className="p-3 sm:p-4 bg-slate-50 dark:bg-slate-900 border-t border-slate-100 dark:border-slate-800 shrink-0">
              <button 
                disabled={isSubmittingCheckout || paymentLines.length === 0}
                onClick={onHandleCheckout}
                className="w-full py-3 sm:py-3.5 bg-indigo-600 text-white rounded-xl sm:rounded-2xl font-black text-sm sm:text-base uppercase tracking-widest hover:bg-indigo-700 transition-all shadow-lg shadow-indigo-600/20 disabled:opacity-30 disabled:grayscale disabled:shadow-none active:scale-95 cursor-pointer"
              >
                {isSubmittingCheckout ? 'PROCESANDO...' : 'CONFIRMAR COBRO'}
              </button>
            </div>
          </div>
        </div>
      
  );
}
