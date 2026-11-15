import { useMemo, useState } from 'react';
import { CheckCircle2, Copy, FileText, Plus, Search } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../store/useStore';
import { formatMoney } from '../lib/utils';
import { InfoTooltip } from '../components/InfoTooltip';

type QuoteStatus = 'pending' | 'converted' | 'expired';

const STATUS_LABEL: Record<QuoteStatus, string> = {
  pending: 'Pendiente',
  converted: 'Convertida',
  expired: 'Expirada',
};

const STATUS_CLASS: Record<QuoteStatus, string> = {
  pending: 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-900/50',
  converted: 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-900/50',
  expired: 'bg-subtle text-muted border-base',
};

const FILTERS: Array<{ id: 'all' | QuoteStatus; label: string }> = [
  { id: 'all', label: 'Todas' },
  { id: 'pending', label: 'Pendientes' },
  { id: 'converted', label: 'Convertidas' },
  { id: 'expired', label: 'Expiradas' },
];

export default function Quotes() {
  const { quotes, customers, getBaseCurrency } = useStore();
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | QuoteStatus>('all');
  const navigate = useNavigate();
  const baseCurrency = getBaseCurrency();

  const filteredQuotes = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    return (quotes || [])
      .filter(quote => {
        const customer = customers.find(c => c.id === quote.customerId);
        const matchesSearch = !term
          || String(quote.id).toLowerCase().includes(term)
          || (customer?.name || '').toLowerCase().includes(term);
        const matchesStatus = statusFilter === 'all' || quote.status === statusFilter;
        return matchesSearch && matchesStatus;
      })
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }, [quotes, customers, searchTerm, statusFilter]);

  const handleConvertToSale = (quoteId: string) => {
    navigate(`/pos?loadQuote=${quoteId}`);
  };

  return (
    <div className="space-y-4 animate-in fade-in duration-200">
      <div className="bg-secondary rounded-2xl shadow-sm border border-base p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h3 className="text-xs font-black text-primary uppercase tracking-wider flex items-center gap-2">
            <FileText className="w-4 h-4 text-rose-600 dark:text-rose-400" />
            Cotizaciones y Presupuestos
            <InfoTooltip text="Crea y gestiona presupuestos para tus clientes. Las cotizaciones se convierten en ventas reales desde el Punto de Venta." />
          </h3>
          <p className="text-[8px] font-bold text-muted uppercase tracking-widest mt-0.5">
            Presupuestos pendientes, convertidos y vencidos
          </p>
        </div>

        <button
          type="button"
          onClick={() => navigate('/pos?mode=quote')}
          className="h-9 px-3.5 inline-flex items-center justify-center gap-1.5 bg-rose-600 hover:bg-rose-700 text-white rounded-xl text-[10px] font-black uppercase tracking-wider transition-all active:scale-95 shadow-sm cursor-pointer shrink-0"
        >
          <Plus className="w-4 h-4" />
          Nueva Cotización
        </button>
      </div>

      <div className="bg-secondary rounded-2xl shadow-sm border border-base p-3.5 flex flex-col sm:flex-row gap-3">
        <div className="flex-1 relative">
          <Search className="w-4 h-4 text-muted absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="search"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Buscar por ID o cliente…"
            aria-label="Buscar cotizaciones"
            className="w-full h-9 pl-9 pr-3 bg-subtle border border-base rounded-xl text-[11px] font-bold text-primary placeholder:text-muted focus:ring-2 focus:ring-rose-500/20 focus:border-rose-500 transition-all"
          />
        </div>

        <div className="flex gap-1.5 overflow-x-auto pb-1 sm:pb-0 shrink-0">
          {FILTERS.map((filter) => (
            <button
              key={filter.id}
              type="button"
              onClick={() => setStatusFilter(filter.id)}
              aria-pressed={statusFilter === filter.id}
              className={
                statusFilter === filter.id
                  ? 'px-3 py-1.5 rounded-lg text-[9px] font-black uppercase tracking-wider whitespace-nowrap bg-rose-600 text-white shadow-xs cursor-pointer'
                  : 'px-3 py-1.5 rounded-lg text-[9px] font-black uppercase tracking-wider whitespace-nowrap text-secondary hover:text-primary hover:bg-subtle border border-transparent cursor-pointer'
              }
            >
              {filter.label}
            </button>
          ))}
        </div>
      </div>

      <div className="bg-secondary rounded-2xl shadow-sm border border-base overflow-hidden">
        <div className="p-3 border-b border-base flex items-center justify-between bg-subtle/50">
          <span className="text-[9px] font-black text-primary uppercase tracking-wider">Listado de Cotizaciones</span>
          <span className="text-[9px] font-bold text-muted">{filteredQuotes.length} registros</span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-left border-collapse">
            <thead>
              <tr className="bg-subtle border-b border-base text-[8px] font-black text-muted uppercase tracking-[0.15em]">
                <th className="px-3 py-2.5">Cotización</th>
                <th className="px-3 py-2.5">Cliente</th>
                <th className="px-3 py-2.5">Fecha</th>
                <th className="px-3 py-2.5 text-center">Estado</th>
                <th className="px-3 py-2.5 text-right">Total</th>
                <th className="px-3 py-2.5 text-center">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-base">
              {filteredQuotes.map((quote) => {
                const customer = customers.find(c => c.id === quote.customerId);
                const status = (quote.status || 'pending') as QuoteStatus;
                return (
                  <tr key={quote.id} className="hover:bg-subtle transition-colors">
                    <td className="px-3 py-2 whitespace-nowrap">
                      <div className="flex items-center gap-2">
                        <span className="w-8 h-8 rounded-lg bg-subtle border border-base flex items-center justify-center text-secondary shrink-0">
                          <FileText className="w-4 h-4" />
                        </span>
                        <div>
                          <p className="text-[11px] font-black font-mono text-primary tracking-wider">
                            {String(quote.id).slice(0, 8).toUpperCase()}
                          </p>
                          <p className="text-[8px] font-bold text-muted uppercase">
                            {(quote.items || []).length} artículos
                          </p>
                        </div>
                      </div>
                    </td>

                    <td className="px-3 py-2 whitespace-nowrap">
                      <span className="text-[11px] font-black text-primary uppercase">
                        {customer?.name || 'Consumidor Final'}
                      </span>
                    </td>

                    <td className="px-3 py-2 whitespace-nowrap">
                      <div className="flex items-center gap-1.5 text-[11px] font-bold text-primary">
                        <span>{new Date(quote.date).toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' })}</span>
                        <span className="text-[9px] font-mono text-muted">
                          {new Date(quote.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </div>
                    </td>

                    <td className="px-3 py-2 text-center whitespace-nowrap">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-[8px] font-black uppercase tracking-wider border ${STATUS_CLASS[status]}`}>
                        {STATUS_LABEL[status]}
                      </span>
                    </td>

                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      <span className="text-xs font-black text-primary">{formatMoney(quote.total, baseCurrency.symbol)}</span>
                    </td>

                    <td className="px-3 py-2 text-center whitespace-nowrap">
                      <button
                        type="button"
                        onClick={() => handleConvertToSale(quote.id)}
                        title="Cargar esta cotización en el Punto de Venta"
                        aria-label="Cargar cotización en el Punto de Venta"
                        className="h-7 px-2.5 inline-flex items-center justify-center gap-1 bg-rose-50 hover:bg-rose-100 dark:bg-rose-950/60 dark:hover:bg-rose-900/80 text-rose-700 dark:text-rose-300 text-[9px] font-black uppercase rounded-lg border border-rose-200 dark:border-rose-900/50 transition-all active:scale-95 cursor-pointer"
                      >
                        <Copy className="w-3 h-3" />
                        <span>Al TPV</span>
                      </button>
                    </td>
                  </tr>
                );
              })}

              {filteredQuotes.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-6 py-12 text-center">
                    <div className="flex flex-col items-center gap-2">
                      <CheckCircle2 className="w-8 h-8 text-muted opacity-60" />
                      <p className="text-[10px] font-black text-secondary uppercase tracking-wider">
                        No hay cotizaciones para este filtro
                      </p>
                      <p className="text-[9px] font-bold text-muted">
                        Crea una nueva cotización o cambia el filtro de estado.
                      </p>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
