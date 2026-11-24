import type { ReactNode } from "react";
import { AlertTriangle, ArrowRight, BarChart3, Coins, Package, Receipt, TrendingUp } from "lucide-react";
import type { Transaction } from "../../types";
import type { ReportSalesSummary } from "../../modules/reports/utils/reportSalesSummary";
import { ticketDisplay } from "../../lib/documentCodes";
import { ReportsStatBubbles } from "./ReportsStatBubbles";

type Props = {
  summary: ReportSalesSummary;
  formatMoney: (amount: number, code?: string) => string;
  onOpenSales: () => void;
  onOpenTransaction: (transaction: Transaction) => void;
  charts?: ReactNode;
};

function percent(value: number) {
  return `${Number.isFinite(value) ? value.toFixed(1) : '0.0'}%`;
}

/**
 * Read-only executive summary for the selected filter. Money, cost and margin
 * come from the same stored line totals used by the tickets, so the overview
 * can never disagree with the sales list.
 */
export function ReportsOverview({ summary, formatMoney, onOpenSales, onOpenTransaction, charts }: Props) {
  const kpis = [
    { label: 'Ventas cobradas', value: formatMoney(summary.total), icon: TrendingUp, tone: 'emerald' as const, hint: `${summary.tickets} ticket${summary.tickets === 1 ? '' : 's'} válido${summary.tickets === 1 ? '' : 's'}` },
    { label: 'Ticket promedio', value: formatMoney(summary.average), icon: Receipt, tone: 'blue' as const, hint: 'Por venta completada' },
    { label: 'Unidades vendidas', value: String(summary.units), icon: Package, tone: 'amber' as const, hint: `${summary.products.length} producto${summary.products.length === 1 ? '' : 's'} distinto${summary.products.length === 1 ? '' : 's'}` },
    { label: 'Ganancia bruta', value: formatMoney(summary.profit), icon: Coins, tone: 'violet' as const, hint: `Margen ${percent(summary.margin)}` },
  ];
  const topProducts = summary.products.slice(0, 8);
  const recent = summary.sales.slice(0, 6);

  return (
    <div className="space-y-3">
      <ReportsStatBubbles items={kpis} />

      {charts}

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[1.15fr_1fr]">        <section className="rounded-2xl border border-base bg-secondary shadow-xs">
          <header className="flex items-center justify-between border-b border-base px-3 py-2.5">
            <h3 className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-widest text-primary">
              <BarChart3 className="h-3.5 w-3.5 text-rose-600" /> Resultado financiero
            </h3>
            <span className="rounded-md border border-base bg-subtle px-1.5 py-0.5 text-[8px] font-black uppercase tracking-wider text-muted">
              Costo de adquisición
            </span>
          </header>
          <div className="space-y-1.5 p-3">
            <div className="flex items-center justify-between text-[11px] font-bold text-secondary">
              <span>Ingresos por ventas</span>
              <span className="font-black text-primary">{formatMoney(summary.total)}</span>
            </div>
            <div className="flex items-center justify-between text-[11px] font-bold text-secondary">
              <span>Costo de lo vendido</span>
              <span className="font-black text-red-600">-{formatMoney(summary.cost)}</span>
            </div>
            <div className="flex items-center justify-between border-t border-base pt-1.5 text-xs font-black text-primary">
              <span>Ganancia bruta</span>
              <span className={summary.profit < 0 ? 'text-red-600' : 'text-emerald-600'}>
                {formatMoney(summary.profit)} <span className="text-[9px] font-bold text-muted">({percent(summary.margin)})</span>
              </span>
            </div>
            {summary.missingCostUnits > 0 ? (
              <p className="mt-1 flex items-start gap-1.5 rounded-xl border border-amber-200 bg-amber-50 p-2 text-[9px] font-bold leading-relaxed text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                {summary.missingCostUnits} unidades no tienen costo registrado en el catálogo: la ganancia real puede ser menor. Corrige el costo del producto para un margen exacto.
              </p>
            ) : (
              <p className="mt-1 text-[8px] font-bold uppercase tracking-wide text-muted">
                Costo tomado del precio de compra guardado en cada venta.
              </p>
            )}
          </div>
        </section>

        <section className="rounded-2xl border border-base bg-secondary shadow-xs">
          <header className="flex items-center justify-between border-b border-base px-3 py-2.5">
            <h3 className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-widest text-primary">
              <Package className="h-3.5 w-3.5 text-amber-600" /> Productos más vendidos
            </h3>
            <span className="text-[8px] font-black uppercase tracking-wider text-muted">Unidades / Ingreso</span>
          </header>
          {topProducts.length === 0 ? (
            <p className="px-3 py-8 text-center text-[10px] font-bold uppercase tracking-wider text-muted">
              Sin productos vendidos en el periodo seleccionado.
            </p>
          ) : (
            <ol className="divide-y divide-base">
              {topProducts.map((row, index) => (
                <li key={row.key} className="flex items-center gap-2 px-3 py-2">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg border border-base bg-subtle text-[9px] font-black text-rose-600">
                    {index + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[10px] font-black uppercase tracking-tight text-primary">{row.name}</p>
                    <p className="truncate text-[8px] font-bold uppercase tracking-wide text-muted">
                      {row.variant || 'Sin variante'} · {row.ticketIds.length} tickets
                      {row.missingCostUnits > 0 ? ' · costo incompleto' : ''}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-[10px] font-black text-primary">{row.quantity} uds</p>
                    <p className="text-[8px] font-bold text-muted">{formatMoney(row.revenue)}</p>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>

      <section className="rounded-2xl border border-base bg-secondary shadow-xs">
        <header className="flex items-center justify-between border-b border-base px-3 py-2.5">
          <h3 className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-widest text-primary">
            <Receipt className="h-3.5 w-3.5 text-rose-600" /> Últimos tickets
          </h3>
          <button
            type="button"
            onClick={onOpenSales}
            className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[9px] font-black uppercase tracking-wider text-[#6535C5] hover:bg-[#6535C5]/10"
          >
            Ver todos <ArrowRight className="h-3 w-3" />
          </button>
        </header>
        {recent.length === 0 ? (
          <p className="px-3 py-8 text-center text-[10px] font-bold uppercase tracking-wider text-muted">
            No hay ventas completadas para el filtro seleccionado.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left sm:min-w-[34rem]">
              <thead>
                <tr className="border-b border-base bg-subtle/60 text-[8px] font-black uppercase tracking-[0.15em] text-muted">
                  <th className="px-3 py-2">Ticket</th>
                  <th className="px-3 py-2">Fecha y hora</th>
                  <th className="hidden px-3 py-2 sm:table-cell">Artículos</th>
                  <th className="px-3 py-2 text-right">Total</th>
                  <th className="px-3 py-2 text-center">Detalle</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-base">
                {recent.map(tx => {
                  const units = (tx.items || []).reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
                  const when = new Date(tx.date);
                  return (
                    <tr key={tx.id} className="hover:bg-subtle/60">
                      <td className="px-3 py-1.5 font-mono text-[9px] font-black text-rose-700 dark:text-rose-300">{ticketDisplay(tx.ticketNumber, tx.id)}</td>
                      <td className="whitespace-nowrap px-3 py-1.5 text-[9px] font-bold text-secondary">
                        {Number.isFinite(when.getTime())
                          ? when.toLocaleString('es-CU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
                          : '-'}
                      </td>
                      <td className="hidden whitespace-nowrap px-3 py-1.5 text-[9px] font-bold text-secondary sm:table-cell">{units} uds ({(tx.items || []).length} líneas)</td>
                      <td className="whitespace-nowrap px-3 py-1.5 text-right text-[10px] font-black tabular-nums text-primary">{formatMoney(tx.total)}</td>
                      <td className="px-3 py-1.5 text-center">
                        <button
                          type="button"
                          onClick={() => onOpenTransaction(tx)}
                          className="h-11 w-11 rounded-lg border border-base bg-subtle text-primary hover:bg-slate-200 sm:h-8 sm:w-8 dark:hover:bg-slate-800"
                          title="Ver detalle del ticket"
                          aria-label="Ver detalle del ticket"
                        >
                          <ArrowRight className="mx-auto h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
