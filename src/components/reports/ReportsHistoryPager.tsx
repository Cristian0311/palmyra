import React from 'react';
import { ChevronDown, History, Loader2, WifiOff } from 'lucide-react';
import { cn } from '../../lib/utils';

type ReportsHistoryPagerProps = {
  loadedCount: number;
  isLoading: boolean;
  hasMore: boolean;
  offline: boolean;
  onLoadMore: () => void;
};

/**
 * Historial bajo demanda: muestra cuántas ventas hay cargadas y pide la
 * siguiente página por keyset. Sin conexión sigue mostrando lo cacheado.
 */
export function ReportsHistoryPager({ loadedCount, isLoading, hasMore, offline, onLoadMore }: ReportsHistoryPagerProps) {
  const disabled = isLoading || offline || !hasMore;
  const label = isLoading
    ? 'Cargando…'
    : !hasMore
      ? 'Historial completo'
      : loadedCount > 0
        ? 'Cargar más'
        : 'Ver historial';

  return (
    <div className="flex items-center gap-1.5 shrink-0">
      <span className="hidden sm:inline text-[9px] font-black uppercase tracking-wider text-muted" title="Ventas cargadas en este equipo">
        {loadedCount.toLocaleString('es-ES')} cargadas
      </span>
      <button
        type="button"
        onClick={onLoadMore}
        disabled={disabled}
        title={offline ? 'Sin conexión: se muestran las ventas guardadas en el equipo' : 'Carga 100 ventas anteriores'}
        className={cn(
          'flex items-center gap-1 h-9 px-2.5 rounded-xl text-[10px] font-black uppercase tracking-wider border transition-all',
          disabled
            ? 'bg-secondary text-muted border-base cursor-not-allowed opacity-70'
            : 'bg-indigo-600 hover:bg-indigo-700 text-white border-indigo-600 shadow-sm active:scale-95'
        )}
      >
        {isLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : offline ? <WifiOff className="w-3.5 h-3.5" /> : hasMore && loadedCount > 0 ? <ChevronDown className="w-3.5 h-3.5" /> : <History className="w-3.5 h-3.5" />}
        <span>{label}</span>
      </button>
    </div>
  );
}
