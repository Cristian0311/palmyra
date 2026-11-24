import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer,
} from "recharts";
import { PieChart as PieChartIcon, BarChart3 } from "lucide-react";

type HourRow = { hour: string | number; total: number };
type CategoryRow = { name: string; value: number };

export interface ReportsChartsProps {
  hourData: HourRow[];
  categoryData: CategoryRow[];
  formatMoney: (amount: number) => string;
}

function CustomTooltip({ active, payload, label, formatMoney }: any) {
  if (!active || !payload || !payload.length) return null;
  const value = Number(payload[0]?.value);
  const formatted = typeof formatMoney === 'function'
    ? formatMoney(Number.isFinite(value) ? value : 0)
    : String(payload[0]?.value ?? '');
  return (
    <div className="rounded-xl border p-2"
      style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-base)', boxShadow: 'var(--shadow-md)' }}
    >
      <p className="text-[10px] font-black text-primary uppercase mb-1">{label ?? payload[0]?.name}</p>
      <p className="text-[11px] font-bold text-violet-600 dark:text-violet-300">{formatted}</p>
    </div>
  );
}

export default function ReportsCharts({ hourData, categoryData, formatMoney }: ReportsChartsProps) {
  const totalCategoryValue = categoryData.reduce((sum, item) => sum + (Number(item.value) || 0), 0);
  const rankedCategories = categoryData.slice(0, 8);
  const maxCategoryValue = Math.max(1, ...rankedCategories.map(item => Number(item.value) || 0));

  return (
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 sm:gap-4">
        {/* Sales by Hour Bar Chart */}
        <div className="lg:col-span-2 bg-secondary rounded-2xl p-5 shadow-sm border border-base flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-xs font-black text-primary uppercase tracking-wider flex items-center gap-2">
                <BarChart3 className="w-4 h-4 text-violet-600" />
                Ventas por Horario
              </h3>
              <p className="text-[8px] font-bold text-muted uppercase tracking-tight">Distribución del volumen de facturación por hora</p>
            </div>
            <div className="px-2 py-1 bg-white dark:bg-slate-800 rounded-lg border border-base text-[8px] font-black uppercase text-violet-600">
              Actividad Diaria
            </div>
          </div>
          
          <div className="h-[200px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={hourData}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                <XAxis 
                  dataKey="hour" 
                  fontSize={8} 
                  fontWeight="bold" 
                  tickLine={false} 
                  axisLine={false}
                  interval={2}
                />
                <YAxis hide />
                <Tooltip content={<CustomTooltip formatMoney={formatMoney} />} />
                <Bar 
                  dataKey="total" 
                  fill="#6535C5" 
                  radius={[4, 4, 0, 0]} 
                  barSize={20}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Top Categories ranked list with proportional bars */}
        <div className="bg-secondary rounded-2xl p-5 shadow-sm border border-base flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-xs font-black text-primary uppercase tracking-wider flex items-center gap-2">
                <PieChartIcon className="w-4 h-4 text-emerald-600" />
                Top Categorías
              </h3>
              <p className="text-[8px] font-bold text-muted uppercase tracking-tight">Distribución por volumen de venta</p>
            </div>
          </div>

          {rankedCategories.length === 0 ? (
            <p className="py-6 text-center text-[10px] font-bold uppercase tracking-wider text-muted">
              Sin ventas por categoría en el periodo seleccionado.
            </p>
          ) : (
            <ol className="flex flex-1 flex-col justify-center gap-2.5">
              {rankedCategories.map((item, index) => {
                const value = Number(item.value) || 0;
                const pct = totalCategoryValue > 0 ? (value / totalCategoryValue) * 100 : 0;
                return (
                  <li key={item.name} className="space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded bg-subtle text-[8px] font-black text-muted">
                          {index + 1}
                        </span>
                        <span className="truncate text-[9px] font-bold uppercase tracking-tight text-secondary" title={item.name}>
                          {item.name}
                        </span>
                      </span>
                      <span className="shrink-0 text-[9px] font-black tabular-nums text-primary">
                        {formatMoney(value)} · {pct.toFixed(0)}%
                      </span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-subtle">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-violet-600 to-indigo-600"
                        style={{ width: `${Math.max(4, (value / maxCategoryValue) * 100)}%` }}
                      />
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </div>

  );
}
