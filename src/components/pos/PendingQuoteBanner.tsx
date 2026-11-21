import { useState } from 'react';
import { ArrowRight, FileText, ShieldAlert, Trash2, X } from 'lucide-react';
import { cn } from '../../lib/utils';
import { formatMoney } from '../../modules/pos/utils/paymentMath';
import type { Quote } from '../../types';

type Props = {
  quote: Quote;
  customerName?: string;
  currencySymbol: string;
  onCancel: () => void;
  onOpenQuotes?: () => void;
  variant?: 'cart' | 'startup';
};

export default function PendingQuoteBanner({
  quote,
  customerName,
  currencySymbol,
  onCancel,
  onOpenQuotes,
  variant = 'cart'
}: Props) {
  const [confirming, setConfirming] = useState(false);
  const compact = variant === 'startup';
  const itemsCount = (quote.items || []).reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);

  if (confirming) {
    return (
      <div
        role="alertdialog"
        aria-label="Descartar cotización cargada"
        className={cn(
          'rounded-xl border border-[var(--danger)]/40 bg-[var(--danger)]/8 text-left',
          compact ? 'mx-0 mb-2 p-2' : 'm-2.5 p-2.5'
        )}
      >
        <div className="flex items-start gap-2">
          <ShieldAlert className="mt-0.5 w-3.5 h-3.5 shrink-0 text-[var(--danger)]" />
          <div className="min-w-0 flex-1">
            <p className={cn('font-black text-primary leading-tight', compact ? 'text-[9px]' : 'text-[11px]')}>
              ¿Descartar la cotización y vaciar el ticket?
            </p>
            <p className={cn('mt-0.5 leading-tight text-secondary', compact ? 'text-[7.5px]' : 'text-[9px]')}>
              La cotización seguirá guardada en Cotizaciones.
            </p>
            <div className="mt-1.5 flex gap-1.5">
              <button
                type="button"
                onClick={() => { setConfirming(false); onCancel(); }}
                className={cn(
                  'h-8 px-2.5 rounded-lg bg-[var(--danger)] text-white font-black uppercase tracking-wider',
                  compact ? 'text-[7px]' : 'text-[8px]'
                )}
              >
                Sí, descartar
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className={cn(
                  'h-8 px-2.5 rounded-lg border border-base bg-primary text-primary font-black uppercase tracking-wider',
                  compact ? 'text-[7px]' : 'text-[8px]'
                )}
              >
                Mantener
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'relative overflow-hidden rounded-xl border border-violet-300/70 bg-violet-50/90 dark:border-violet-800/70 dark:bg-violet-950/40',
        compact ? 'mb-2 p-2' : 'm-2.5 p-2.5'
      )}
    >
      <div className="flex items-start gap-2">
        <span
          className={cn(
            'flex shrink-0 items-center justify-center rounded-lg bg-violet-600 text-white shadow-sm',
            compact ? 'h-6 w-6' : 'h-8 w-8'
          )}
        >
          <FileText className={compact ? 'w-3 h-3' : 'w-4 h-4'} />
        </span>
        <div className="min-w-0 flex-1">
          <p className={cn('font-black uppercase tracking-wide text-violet-900 dark:text-violet-100 leading-tight', compact ? 'text-[8px]' : 'text-[10px]')}>
            Cotización cargada
          </p>
          <p className={cn('mt-0.5 leading-tight text-violet-800/85 dark:text-violet-200/85 font-bold', compact ? 'text-[7px]' : 'text-[9px]')}>
            {itemsCount} {itemsCount === 1 ? 'artículo' : 'artículos'} · {formatMoney(quote.total || 0, currencySymbol)}
            {customerName ? ` · ${customerName}` : ''}
          </p>
          <p className={cn('mt-0.5 leading-tight text-violet-700/70 dark:text-violet-300/70 font-semibold', compact ? 'text-[6.5px]' : 'text-[8px]')}>
            Se cobrará al confirmar la venta. No queda pendiente en el aire.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {onOpenQuotes && (
            <button
              type="button"
              onClick={onOpenQuotes}
              title="Ver cotizaciones"
              aria-label="Ver cotizaciones"
              className={cn('flex items-center justify-center rounded-lg border border-violet-200 bg-white/80 text-violet-700 hover:bg-white dark:border-violet-700 dark:bg-violet-900/50 dark:text-violet-200', compact ? 'h-6 w-6' : 'h-8 w-8')}
            >
              <ArrowRight className={compact ? 'w-3 h-3' : 'w-4 h-4'} />
            </button>
          )}
          <button
            type="button"
            onClick={() => setConfirming(true)}
            title="Cancelar la cotización cargada"
            aria-label="Cancelar la cotización cargada"
            className={cn('flex items-center justify-center rounded-lg border border-[var(--danger)]/30 bg-white/80 text-[var(--danger)] hover:bg-[var(--danger)]/10 dark:bg-violet-900/50', compact ? 'h-6 w-6' : 'h-8 w-8')}
          >
            {compact ? <X className="w-3 h-3" /> : <Trash2 className="w-4 h-4" />}
          </button>
        </div>
      </div>
    </div>
  );
}
