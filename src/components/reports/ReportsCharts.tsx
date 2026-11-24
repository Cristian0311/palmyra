import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, PieChart, Pie, Cell
} from "recharts";
import { PieChart as PieChartIcon, BarChart3 } from "lucide-react";
import { cn } from "../../lib/utils";

type HourRow = { hour: string | number; total: number };
type CategoryRow = { name: string; value: number };

export interface ReportsChartsProps {
  hourData: HourRow[];
  categoryData: CategoryRow[];
  formatMoney: (amount: number) => string;
}

const COLORS = ['#6535C5', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899'];

function CustomTooltip({ active, payload, label, formatMoney }: any) {
  if (!active || !payload || !payload.length) return null;
  const value = Number(payload[0]?.value);
  const formatted = typeof formatMoney === 'function'
    ? formatMoney(Number.isFinite(value) ? value : 0)
    : String(payload[0]?.value ?? '');
  return (
    <div className="bg-white dark:bg-slate-900 border border-base p-2 rounded-xl shadow-xl">
      <p className="text-[10px] font-black text-primary uppercase mb-1">{label ?? payload[0]?.name}</p>
      <p className="text-[11px] font-bold text-violet-600">{formatted}</p>
    </div>
  );
}

export default function ReportsCharts({ hourData, categoryData, formatMoney }: ReportsChartsProps) {
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

        {/* Top Categories Pie Chart */}
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

          <div className="flex-1 flex flex-col">
            <div className="h-[140px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={categoryData}
                    cx="50%"
                    cy="50%"
                    innerRadius={40}
                    outerRadius={60}
                    paddingAngle={5}
                    dataKey="value"
                  >
                    {categoryData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip content={<CustomTooltip formatMoney={formatMoney} />} />
                </PieChart>
              </ResponsiveContainer>
            </div>

            <div className="mt-2 space-y-1.5">
              {categoryData.map((item, index) => (
                <div key={item.name} className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full" style={{ backgroundColor: COLORS[index % COLORS.length] }} />
                    <span className="text-[9px] font-bold text-secondary uppercase truncate max-w-[100px]">{item.name}</span>
                  </div>
                  <span className="text-[9px] font-black text-primary">{formatMoney(item.value)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

  );
}
