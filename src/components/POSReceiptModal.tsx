import React from 'react';
import { Printer, Receipt, MessageSquare, X } from 'lucide-react';
import { useStore } from '../store/useStore';
import type { Currency, Product, Transaction } from '../types';

interface POSReceiptModalProps {
  showReceiptModal: Transaction | null;
  products: Product[];
  currencies: Currency[];
  baseCurrency: Currency;
  formatMoney: (amount: number, symbol: string) => string;
  onClose: () => void;
  onWhatsAppReceipt: (tx: Transaction) => void;
  onThermalPrint: (tx: Transaction) => void | Promise<void>;
}

export default function POSReceiptModal({
  showReceiptModal,
  products,
  currencies,
  baseCurrency,
  formatMoney,
  onClose,
  onWhatsAppReceipt,
  onThermalPrint
}: POSReceiptModalProps) {
  if (!showReceiptModal) return null;

  return (
  <div className="fixed inset-0 bg-slate-950/70 backdrop-blur-sm z-[95] flex items-center justify-center p-2 sm:p-4 overflow-hidden animate-in fade-in duration-200">
    <div className="bg-white dark:bg-slate-900 rounded-2xl sm:rounded-3xl shadow-2xl w-full max-w-sm sm:max-w-md max-h-[94vh] sm:max-h-[90vh] flex flex-col overflow-hidden border border-slate-200 dark:border-slate-800 animate-in zoom-in-95 print:w-full print:max-w-none print:shadow-none print:bg-white print:fixed print:inset-0 print:border-none print:max-h-none print:rounded-none">
      
      {/* Top Bar with Ticket ID and Quick Close (Hidden when printing) */}
      <div className="px-3.5 py-2.5 sm:px-4 sm:py-3 bg-slate-900 text-white flex items-center justify-between gap-2 shrink-0 border-b border-slate-800 print:hidden">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-6 h-6 rounded-lg bg-indigo-600 flex items-center justify-center text-white shrink-0 shadow-xs">
            <Receipt className="w-3.5 h-3.5" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="font-mono text-[10px] sm:text-[11px] font-black uppercase tracking-wider text-white truncate">
                Ticket #{showReceiptModal.ticketNumber || showReceiptModal.id}
              </span>
              <span className="px-1.5 py-0.2 bg-indigo-500/20 text-indigo-300 text-[8px] font-black rounded-md border border-indigo-500/30 shrink-0">
                {(showReceiptModal.items || []).reduce((s, i) => s + i.quantity, 0)} {((showReceiptModal.items || []).reduce((s, i) => s + i.quantity, 0)) === 1 ? 'artículo' : 'artículos'}
              </span>
            </div>
            <p className="text-[8px] font-medium text-slate-400 truncate">
              {new Date(showReceiptModal.date).toLocaleString('es-CU', { dateStyle: 'short', timeStyle: 'short' })}
            </p>
          </div>
        </div>
        <button 
          onClick={() => onClose()}
          className="w-7 h-7 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white flex items-center justify-center transition-all shrink-0 active:scale-95 border border-slate-700"
          title="Cerrar ticket"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Scrollable Printable Ticket Area */}
      <div className="flex-1 overflow-y-auto custom-scrollbar p-3.5 sm:p-5 text-xs text-center print:p-2 print:overflow-visible space-y-2" id="print-area">
        <div>
          <h2 className="text-base sm:text-lg font-black uppercase tracking-tight text-slate-900 dark:text-white print:text-black">
            {useStore.getState().receiptConfig.businessName || 'MARÉ'}
          </h2>
          {useStore.getState().receiptConfig.showAddress && (
            <p className="text-slate-500 dark:text-slate-400 text-[9px] sm:text-[10px] mt-0.5 leading-snug print:text-black">
              {useStore.getState().receiptConfig.businessAddress}
            </p>
          )}
          {useStore.getState().receiptConfig.showPhone && (
            <p className="text-slate-500 dark:text-slate-400 text-[9px] sm:text-[10px] print:text-black font-mono">
              {useStore.getState().receiptConfig.businessPhone}
            </p>
          )}
        </div>
        
        <div className="border-t border-dashed border-slate-300 dark:border-slate-700 my-2 print:border-black"></div>
        
        {/* Metadata Micro-Grid */}
        <div className="grid grid-cols-2 gap-x-2 gap-y-1 text-[9px] text-slate-600 dark:text-slate-400 print:text-black text-left">
          <div>
            <span className="font-bold text-slate-400 dark:text-slate-500 uppercase text-[7px] block">Fecha y Hora</span>
            <span className="font-medium text-slate-800 dark:text-slate-200 print:text-black truncate block">
              {new Date(showReceiptModal.date).toLocaleString()}
            </span>
          </div>
          <div>
            <span className="font-bold text-slate-400 dark:text-slate-500 uppercase text-[7px] block">Cliente</span>
            <span className="font-semibold text-slate-800 dark:text-slate-200 print:text-black truncate block">
              {useStore.getState().customers.find(c => c.id === showReceiptModal.customerId)?.name || 'Consumidor Final'}
            </span>
          </div>
          {showReceiptModal.cashierName && (
            <div>
              <span className="font-bold text-slate-400 dark:text-slate-500 uppercase text-[7px] block">Cajero / Vendedor</span>
              <span className="font-medium text-slate-800 dark:text-slate-200 print:text-black truncate block">
                {showReceiptModal.cashierName}
              </span>
            </div>
          )}
          <div>
            <span className="font-bold text-slate-400 dark:text-slate-500 uppercase text-[7px] block">Comprobante</span>
            <span className="font-mono font-bold text-slate-800 dark:text-slate-200 print:text-black">
              #{showReceiptModal.ticketNumber || showReceiptModal.id}
            </span>
          </div>
        </div>

        <div className="border-t border-dashed border-slate-300 dark:border-slate-700 my-2 print:border-black"></div>

        {/* Items Table Header */}
        <div className="flex justify-between items-center text-[8px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-1 px-1 text-left">
          <span>Cant • Descripción</span>
          <span className="text-right">Importe</span>
        </div>

        {/* Items List - Compact and cleanly spaced */}
        <div className="space-y-1 text-left">
          {(showReceiptModal.items || []).map((item, idx) => {
            const prodObj = typeof (item.product as any) === 'object' && item.product !== null ? item.product : (products.find(p => p.id === (item.product as any)) || null);
            const prodName = (prodObj?.name || (typeof (item.product as any) === 'string' ? (item.product as any) : 'Producto')) as string;
            const prodPrice = prodObj?.price ?? item.price ?? 0;
            const prodWarranty = prodObj?.warrantyDays ?? 0;

            return (
              <div 
                key={item.id || idx} 
                className="p-1.5 sm:p-2 rounded-xl bg-slate-50 dark:bg-slate-800/40 border border-slate-100 dark:border-slate-800/60 print:bg-transparent print:border-none print:p-0 transition-colors"
              >
                <div className="flex justify-between items-start gap-2">
                  <div className="flex items-start gap-1.5 min-w-0 flex-1">
                    <span className="font-mono font-black text-indigo-600 dark:text-indigo-400 print:text-black text-[10px] bg-indigo-50 dark:bg-indigo-950/60 px-1 py-0.5 rounded shrink-0">
                      {item.quantity}x
                    </span>
                    <div className="min-w-0 flex-1">
                      <span className="font-bold text-slate-900 dark:text-slate-100 print:text-black text-[10px] sm:text-[11px] leading-tight block">{prodName}</span>
                      <div className="flex flex-wrap items-center gap-1 mt-0.5">
                        {item.quantity > 1 && (
                          <span className="text-[8px] font-medium text-slate-500 dark:text-slate-400">
                            @{formatMoney(prodPrice, baseCurrency.symbol)}/u
                          </span>
                        )}
                        {item.variantLabel && (
                          <span className="px-1 py-0.2 bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300 rounded text-[7px] font-bold uppercase">
                            {item.variantLabel}
                          </span>
                        )}
                        {item.serialNumber && (
                          <span className="px-1 py-0.2 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 rounded font-mono text-[7px] font-bold border border-blue-200 dark:border-blue-900">
                            SN: {item.serialNumber}
                          </span>
                        )}
                        {item.warrantyCode && (
                          <span className="px-1 py-0.2 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 rounded font-mono text-[7px] font-bold border border-emerald-200 dark:border-emerald-900">
                            Gda: {item.warrantyCode} ({prodWarranty}d)
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <span className="font-mono font-black text-slate-900 dark:text-white print:text-black text-[11px] shrink-0 pt-0.5">
                    {formatMoney(prodPrice * item.quantity, baseCurrency.symbol)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        <div className="border-t border-dashed border-slate-300 dark:border-slate-700 my-2 print:border-black"></div>
        
        {/* Total Box */}
        <div className="p-2 sm:p-2.5 bg-indigo-50/80 dark:bg-indigo-950/50 border border-indigo-100 dark:border-indigo-900/50 rounded-xl print:bg-transparent print:border-none print:p-0 flex justify-between items-center">
          <div className="text-left">
            <span className="text-[9px] font-black uppercase text-indigo-950 dark:text-indigo-300 print:text-black tracking-wider block">
              TOTAL TICKET
            </span>
            <span className="text-[8px] font-medium text-slate-500 dark:text-slate-400">
              {(showReceiptModal.items || []).reduce((s, i) => s + i.quantity, 0)} {((showReceiptModal.items || []).reduce((s, i) => s + i.quantity, 0)) === 1 ? 'artículo' : 'artículos'}
            </span>
          </div>
          <span className="text-sm sm:text-base font-black text-indigo-600 dark:text-indigo-400 print:text-black font-mono">
            {baseCurrency.symbol}{showReceiptModal.total.toFixed(2)} {baseCurrency.code}
          </span>
        </div>

        {/* Payments breakdown */}
        <div className="mt-2 text-left space-y-1">
          <div className="text-[8px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest px-0.5">
            Pagos Recibidos:
          </div>
          {(showReceiptModal.payments || []).map((p, i) => (
            <div key={i} className="text-[9px] sm:text-[10px] flex justify-between items-center text-slate-700 dark:text-slate-300 print:text-black px-1.5 py-0.5 rounded bg-slate-50 dark:bg-slate-800/30">
              <span className="font-medium">
                {p.method === 'cash' ? '💵 Efectivo' : '💳 Transferencia'} ({p.currencyCode})
              </span>
              <span className="font-mono font-black">
                {formatMoney(p.amount, currencies.find(c => c.code === p.currencyCode)?.symbol || '')}
              </span>
            </div>
          ))}
        </div>

        {/* Change returned */}
        {((showReceiptModal.changePayments && showReceiptModal.changePayments.length > 0) || (showReceiptModal.changeGiven && showReceiptModal.changeGiven > 0)) && (
          <div className="mt-2 p-1.5 rounded-lg bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800/50 text-left">
            <div className="text-[8px] font-black text-emerald-800 dark:text-emerald-300 uppercase tracking-widest mb-0.5">
              Vuelto Entregado:
            </div>
            {showReceiptModal.changePayments && showReceiptModal.changePayments.length > 0 ? (
              showReceiptModal.changePayments.map((p, i) => (
                <div key={i} className="text-[9px] sm:text-[10px] flex justify-between text-emerald-700 dark:text-emerald-400 font-bold font-mono">
                  <span>Efectivo ({p.currencyCode})</span>
                  <span>{formatMoney(p.amount, currencies.find(c => c.code === p.currencyCode)?.symbol || '')}</span>
                </div>
              ))
            ) : (
              <div className="text-[9px] sm:text-[10px] flex justify-between text-emerald-700 dark:text-emerald-400 font-bold font-mono">
                <span>Efectivo ({baseCurrency.code})</span>
                <span>{formatMoney(showReceiptModal.changeGiven || 0, baseCurrency.symbol)}</span>
              </div>
            )}
          </div>
        )}

        {useStore.getState().receiptConfig.showFooter && (
          <>
            <div className="border-t border-dashed border-slate-300 dark:border-slate-700 my-2 print:border-black"></div>
            <p className="text-[8px] sm:text-[9px] text-slate-400 dark:text-slate-500 font-medium uppercase tracking-tight leading-relaxed">
              {useStore.getState().receiptConfig.footerText}
            </p>
          </>
        )}
      </div>
      
      {/* Sticky Action Footer - Fully adapted for PC, tablet and mobile */}
      <div className="p-2 sm:p-2.5 bg-slate-50 dark:bg-slate-900 border-t border-slate-200 dark:border-slate-800 shrink-0 print:hidden">
        <div className="grid grid-cols-2 sm:flex sm:flex-wrap gap-1.5 sm:gap-2 justify-end items-center">
          <button 
            onClick={() => onClose()}
            className="order-1 py-2 px-3 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 rounded-xl text-[10px] sm:text-xs font-black uppercase tracking-wider hover:bg-slate-100 dark:hover:bg-slate-750 transition-all shadow-2xs active:scale-95 text-center cursor-pointer"
          >
            Cerrar
          </button>
          
          <button 
            onClick={() => onWhatsAppReceipt(showReceiptModal)}
            className="order-2 py-2 px-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-[10px] sm:text-xs font-black uppercase tracking-wider transition-all flex items-center justify-center gap-1.5 shadow-sm shadow-emerald-200 dark:shadow-none active:scale-95 cursor-pointer"
            title="Enviar ticket por WhatsApp"
          >
            <MessageSquare className="w-3.5 h-3.5 text-white shrink-0" />
            <span>WhatsApp</span>
          </button>
          
          <button 
            onClick={() => onThermalPrint(showReceiptModal)}
            className="order-4 py-2 px-3 bg-slate-900 hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white text-white rounded-xl text-[10px] sm:text-xs font-black uppercase tracking-wider transition-all flex items-center justify-center gap-1.5 shadow-sm active:scale-95 cursor-pointer"
            title="Imprimir ticket en la impresora configurada (Bluetooth / USB)"
          >
            <Printer className="w-3.5 h-3.5 shrink-0" />
            <span>Imprimir Ticket</span>
          </button>
        </div>
      </div>
    </div>
  </div>
  );
}
