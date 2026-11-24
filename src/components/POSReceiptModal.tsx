import React, { useEffect } from 'react';
import { Printer, Receipt, MessageSquare, X, Banknote, CreditCard } from 'lucide-react';
import { useStore } from '../store/useStore';
import { ticketDisplay } from '../lib/documentCodes';
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
  // Escape cierra el ticket con el mismo manejador del botón Cerrar.
  useEffect(() => {
    if (!showReceiptModal) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [showReceiptModal, onClose]);

  if (!showReceiptModal) return null;

  return (
  <div
    className="palmyra-overlay z-[var(--z-modal)] flex items-center justify-center p-2 sm:p-4 overflow-hidden animate-in fade-in duration-200"
    role="presentation"
    onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}
  >
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Ticket ${ticketDisplay(showReceiptModal.ticketNumber, showReceiptModal.id)}`}
      className="palmyra-modal-panel w-full max-w-sm sm:max-w-md max-h-[92dvh] flex flex-col overflow-hidden animate-in zoom-in-95 print:w-full print:max-w-none print:shadow-none print:bg-white print:fixed print:inset-0 print:border-none print:max-h-none print:rounded-none"
    >
      
      {/* Top Bar with Ticket ID and Quick Close (Hidden when printing) */}
      <div className="flex items-center justify-between gap-2 shrink-0 border-b border-white/10 bg-gradient-to-r from-violet-600 to-indigo-600 px-3 py-2.5 sm:px-4 sm:py-3 text-white print:hidden">
        <div className="flex items-center gap-2 min-w-0">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/15 shadow-xs backdrop-blur-sm">
            <Receipt className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="truncate font-mono text-xs sm:text-sm font-black uppercase tracking-wide text-white">
                Ticket {ticketDisplay(showReceiptModal.ticketNumber, showReceiptModal.id)}
              </span>
              <span className="px-1.5 py-0.5 rounded-md border border-white/30 bg-white/15 text-[8px] font-black text-white shrink-0">
                {(showReceiptModal.items || []).reduce((s, i) => s + i.quantity, 0)} {((showReceiptModal.items || []).reduce((s, i) => s + i.quantity, 0)) === 1 ? 'artículo' : 'artículos'}
              </span>
            </div>
            <p className="text-[9px] font-medium text-white/70 truncate">
              {new Date(showReceiptModal.date).toLocaleString('es-CU', { dateStyle: 'short', timeStyle: 'short' })}
            </p>
          </div>
        </div>
        <button 
          onClick={() => onClose()}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/20 bg-white/10 text-white/80 transition-all hover:bg-white/20 hover:text-white active:scale-95"
          title="Cerrar ticket"
          aria-label="Cerrar ticket"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Scrollable Printable Ticket Area */}
      <div className="flex-1 overflow-y-auto custom-scrollbar p-3 sm:p-4 text-[11px] sm:text-xs text-center print:p-2 print:overflow-visible space-y-2" id="print-area">
        <div>
          <h2 className="text-sm sm:text-base font-black uppercase tracking-tight text-primary print:text-black">
            {useStore.getState().receiptConfig.businessName || 'PALMYRA'}
          </h2>
          {useStore.getState().receiptConfig.showAddress && (
            <p className="text-muted text-[9px] sm:text-[10px] mt-0.5 leading-snug break-words print:text-black">
              {useStore.getState().receiptConfig.businessAddress}
            </p>
          )}
          {useStore.getState().receiptConfig.showPhone && (
            <p className="text-muted text-[9px] sm:text-[10px] print:text-black font-mono">
              {useStore.getState().receiptConfig.businessPhone}
            </p>
          )}
        </div>
        
        <div className="border-t border-dashed border-base my-2 print:border-black"></div>
        
        {/* Metadata Micro-Grid */}
        <div className="grid grid-cols-2 gap-x-2 gap-y-1.5 text-[9px] sm:text-[10px] print:text-black text-left">
          <div className="min-w-0">
            <span className="font-bold text-muted uppercase text-[8px] block">Fecha y Hora</span>
            <span className="font-medium text-primary print:text-black truncate block">
              {new Date(showReceiptModal.date).toLocaleString()}
            </span>
          </div>
          <div className="min-w-0">
            <span className="font-bold text-muted uppercase text-[8px] block">Cliente</span>
            <span className="font-semibold text-primary print:text-black truncate block">
              {useStore.getState().customers.find(c => c.id === showReceiptModal.customerId)?.name || 'Consumidor Final'}
            </span>
          </div>
          {showReceiptModal.cashierName && (
            <div className="min-w-0">
              <span className="font-bold text-muted uppercase text-[8px] block">Cajero / Vendedor</span>
              <span className="font-medium text-primary print:text-black truncate block">
                {showReceiptModal.cashierName}
              </span>
            </div>
          )}
          <div className="min-w-0">
            <span className="font-bold text-muted uppercase text-[8px] block">Comprobante</span>
            <span className="font-mono font-bold text-primary tabular-nums print:text-black">
              {ticketDisplay(showReceiptModal.ticketNumber, showReceiptModal.id)}
            </span>
          </div>
        </div>

        <div className="border-t border-dashed border-base my-2 print:border-black"></div>

        {/* Items Table Header */}
        <div className="flex justify-between items-center text-[8px] font-black text-muted uppercase tracking-wider mb-1 px-1 text-left">
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
                className="p-1.5 sm:p-2 rounded-xl bg-subtle border border-base print:bg-transparent print:border-none print:p-0 transition-colors"
              >
                <div className="flex justify-between items-start gap-2">
                  <div className="flex items-start gap-1.5 min-w-0 flex-1">
                    <span className="font-mono font-black text-indigo-600 dark:text-indigo-400 print:text-black text-[10px] bg-indigo-50 dark:bg-indigo-950/60 px-1 py-0.5 rounded shrink-0 tabular-nums">
                      {item.quantity}x
                    </span>
                    <div className="min-w-0 flex-1">
                      <span className="font-bold text-primary print:text-black text-[10px] sm:text-[11px] leading-tight block break-words">{prodName}</span>
                      <div className="flex flex-wrap items-center gap-1 mt-0.5">
                        {item.quantity > 1 && (
                          <span className="text-[8px] font-medium text-muted">
                            @{formatMoney(prodPrice, baseCurrency.symbol)}/u
                          </span>
                        )}
                        {item.variantLabel && (
                          <span className="px-1 py-0.2 bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300 rounded text-[7px] font-bold uppercase">
                            {item.variantLabel}
                          </span>
                        )}
                        {item.serialNumber && (
                          <span className="px-1 py-0.2 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 rounded font-mono text-[7px] font-bold border border-blue-200 dark:border-blue-900 break-words">
                            SN: {item.serialNumber}
                          </span>
                        )}
                        {item.warrantyCode && (
                          <span className="px-1 py-0.2 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 rounded font-mono text-[7px] font-bold border border-emerald-200 dark:border-emerald-900 break-words">
                            Gda: {item.warrantyCode} ({prodWarranty}d)
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <span className="font-mono font-black text-primary print:text-black text-[10px] sm:text-[11px] shrink-0 pt-0.5 tabular-nums">
                    {formatMoney(prodPrice * item.quantity, baseCurrency.symbol)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        <div className="border-t border-dashed border-base my-2 print:border-black"></div>
        
        {/* Total Box */}
        <div className="p-2 sm:p-2.5 bg-violet-50/80 dark:bg-violet-950/40 border border-violet-100 dark:border-violet-900/40 rounded-xl print:bg-transparent print:border-none print:p-0 flex justify-between items-center gap-2">
          <div className="text-left min-w-0">
            <span className="text-[9px] font-black uppercase text-violet-950 dark:text-violet-300 print:text-black tracking-wider block">
              TOTAL TICKET
            </span>
            <span className="text-[8px] font-medium text-muted">
              {(showReceiptModal.items || []).reduce((s, i) => s + i.quantity, 0)} {((showReceiptModal.items || []).reduce((s, i) => s + i.quantity, 0)) === 1 ? 'artículo' : 'artículos'}
            </span>
          </div>
          <span className="text-sm sm:text-base font-black text-violet-700 dark:text-violet-300 print:text-black font-mono tabular-nums shrink-0 text-right">
            {baseCurrency.symbol}{showReceiptModal.total.toFixed(2)} {baseCurrency.code}
          </span>
        </div>

        {/* Payments breakdown */}
        <div className="mt-2 text-left space-y-1">
          <div className="text-[8px] font-black text-muted uppercase tracking-widest px-0.5">
            Pagos Recibidos:
          </div>
          {(showReceiptModal.payments || []).map((p, i) => (
            <div key={i} className="text-[9px] sm:text-[10px] flex justify-between items-center gap-2 text-primary print:text-black px-1.5 py-0.5 rounded bg-subtle border border-base print:border-none">
              <span className="inline-flex items-center gap-1 font-medium min-w-0">
                {p.method === 'cash'
                  ? <Banknote className="h-3 w-3 shrink-0 print:hidden" aria-hidden="true" />
                  : <CreditCard className="h-3 w-3 shrink-0 print:hidden" aria-hidden="true" />}
                {p.method === 'cash' ? 'Efectivo' : 'Transferencia'} ({p.currencyCode})
              </span>
              <span className="font-mono font-black tabular-nums shrink-0">
                {formatMoney(p.amount, currencies.find(c => c.code === p.currencyCode)?.symbol || '')}
              </span>
            </div>
          ))}
        </div>

        {/* Change returned */}
        {((showReceiptModal.changePayments && showReceiptModal.changePayments.length > 0) || (showReceiptModal.changeGiven && showReceiptModal.changeGiven > 0)) && (
          <div className="mt-2 p-1.5 rounded-lg bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800/50 text-left print:bg-transparent print:border-none print:p-0">
            <div className="text-[8px] font-black text-emerald-800 dark:text-emerald-300 uppercase tracking-widest mb-0.5">
              Vuelto Entregado:
            </div>
            {showReceiptModal.changePayments && showReceiptModal.changePayments.length > 0 ? (
              showReceiptModal.changePayments.map((p, i) => (
                <div key={i} className="text-[9px] sm:text-[10px] flex justify-between text-emerald-700 dark:text-emerald-400 print:text-black font-bold font-mono tabular-nums">
                  <span>Efectivo ({p.currencyCode})</span>
                  <span>{formatMoney(p.amount, currencies.find(c => c.code === p.currencyCode)?.symbol || '')}</span>
                </div>
              ))
            ) : (
              <div className="text-[9px] sm:text-[10px] flex justify-between text-emerald-700 dark:text-emerald-400 print:text-black font-bold font-mono tabular-nums">
                <span>Efectivo ({baseCurrency.code})</span>
                <span>{formatMoney(showReceiptModal.changeGiven || 0, baseCurrency.symbol)}</span>
              </div>
            )}
          </div>
        )}

        {useStore.getState().receiptConfig.showFooter && (
          <>
            <div className="border-t border-dashed border-base my-2 print:border-black"></div>
            <p className="text-[8px] sm:text-[9px] text-muted font-medium uppercase tracking-tight leading-relaxed break-words print:text-black">
              {useStore.getState().receiptConfig.footerText}
            </p>
          </>
        )}
      </div>
      
      {/* Sticky Action Footer - Fully adapted for PC, tablet and mobile */}
      <div className="p-2 sm:p-2.5 bg-secondary border-t border-base shrink-0 print:hidden">
        <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:justify-end sm:gap-2">
          <button 
            onClick={() => onClose()}
            className="order-1 inline-flex h-9 items-center justify-center rounded-xl border border-base bg-subtle px-3 text-[10px] sm:text-[11px] font-black uppercase tracking-wider text-primary transition-all hover:bg-slate-200 dark:hover:bg-slate-800 active:scale-95 cursor-pointer"
          >
            Cerrar
          </button>
          
          <button 
            onClick={() => onWhatsAppReceipt(showReceiptModal)}
            className="order-2 inline-flex h-9 items-center justify-center gap-1.5 rounded-xl bg-emerald-600 px-3 text-[10px] sm:text-[11px] font-black uppercase tracking-wider text-white transition-all hover:bg-emerald-700 shadow-sm shadow-emerald-200 dark:shadow-none active:scale-95 cursor-pointer"
            title="Enviar ticket por WhatsApp"
          >
            <MessageSquare className="h-3.5 w-3.5 shrink-0" />
            <span>WhatsApp</span>
          </button>
          
          <button 
            onClick={() => onThermalPrint(showReceiptModal)}
            className="order-4 col-span-2 sm:col-span-1 inline-flex h-9 items-center justify-center gap-1.5 rounded-xl bg-slate-900 px-3 text-[10px] sm:text-[11px] font-black uppercase tracking-wider text-white transition-all hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white shadow-sm active:scale-95 cursor-pointer"
            title="Imprimir ticket en la impresora configurada (Bluetooth / USB)"
          >
            <Printer className="h-3.5 w-3.5 shrink-0" />
            <span>Imprimir Ticket</span>
          </button>
        </div>
      </div>
    </div>
  </div>
  );
}
