import { useShallow } from 'zustand/react/shallow';
import React, { useMemo } from 'react';
import { useStore } from '../store/useStore';
import { AlertTriangle, Clock, TrendingUp, Calendar, AlertCircle, HelpCircle } from 'lucide-react';
import { InfoTooltip } from './InfoTooltip';
import { isLowStockQuantity } from '../modules/inventory/utils/lowStock';

export function RestockAlerts() {
  const { products, inventory, transactions, currentBranchId } = useStore(useShallow((state) => ({ products: state.products, inventory: state.inventory, transactions: state.transactions, currentBranchId: state.currentBranchId })));

  const restockData = useMemo(() => {
    // Calcular ventas por día en los últimos 30 días
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    const recentTx = transactions.filter(t => new Date(t.date) >= thirtyDaysAgo && t.status === 'completed');

    const salesByProduct: Record<string, number> = {};
    recentTx.forEach(tx => {
      tx.items.forEach(item => {
        salesByProduct[item.product.id] = (salesByProduct[item.product.id] || 0) + item.quantity;
      });
    });

    return products.map(product => {
      const stock = inventory
        .filter(i => i.productId === product.id && (!currentBranchId || i.branchId === currentBranchId))
        .reduce((sum, i) => sum + i.quantity, 0);
      const soldLast30Days = salesByProduct[product.id] || 0;
      const dailySalesRate = soldLast30Days / 30;
      
      let daysUntilStockout = Infinity;
      if (dailySalesRate > 0) {
        daysUntilStockout = Math.floor(stock / dailySalesRate);
      }

      const isLow = isLowStockQuantity(stock, product);
      const isCritical = daysUntilStockout <= 7;

      return {
        product,
        stock,
        dailySalesRate,
        daysUntilStockout,
        isLow,
        isCritical
      };
    }).filter(p => p.isLow || p.isCritical).sort((a, b) => a.daysUntilStockout - b.daysUntilStockout);

  }, [products, inventory, transactions, currentBranchId]);

  if (restockData.length === 0) {
    return (
      <div className="bg-secondary rounded-2xl border border-base p-6 sm:p-8 text-center">
        <div className="w-12 h-12 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-500 rounded-full flex items-center justify-center mx-auto mb-3">
          <AlertCircle size={24} />
        </div>
        <h3 className="text-sm font-black text-primary uppercase tracking-tight mb-1">Todo en Orden</h3>
        <p className="text-muted font-bold text-xs">No hay productos en riesgo de agotarse pronto según el ritmo de ventas.</p>
      </div>
    );
  }

  return (
    <div className="space-y-2.5">
      {/* Compact summary bubbles: 2 columns even on mobile */}
      <div className="grid grid-cols-2 gap-2">
        <div className="bg-secondary border border-rose-200/80 dark:border-rose-900/40 p-2 sm:p-2.5 rounded-xl shadow-xs flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-lg bg-rose-50 dark:bg-rose-950/50 flex items-center justify-center text-rose-600 dark:text-rose-400 shrink-0">
              <AlertTriangle className="w-3.5 h-3.5" />
            </div>
            <div>
              <h3 className="font-black text-rose-700 dark:text-rose-300 uppercase tracking-wider text-[8px] sm:text-[9px] truncate">Crítico (&lt; 7 días)</h3>
              <p className="text-[7px] text-muted font-bold">Agotamiento inminente</p>
            </div>
          </div>
          <p className="text-lg sm:text-xl font-black text-rose-600 dark:text-rose-400 leading-none">{restockData.filter(d => d.isCritical).length}</p>
        </div>

        <div className="bg-secondary border border-amber-200/80 dark:border-amber-900/40 p-2 sm:p-2.5 rounded-xl shadow-xs flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-lg bg-amber-50 dark:bg-amber-950/50 flex items-center justify-center text-amber-600 dark:text-amber-400 shrink-0">
              <Clock className="w-3.5 h-3.5" />
            </div>
            <div>
              <h3 className="font-black text-amber-700 dark:text-amber-300 uppercase tracking-wider text-[8px] sm:text-[9px] truncate">Stock Bajo</h3>
              <p className="text-[7px] text-muted font-bold">Por debajo del mínimo</p>
            </div>
          </div>
          <p className="text-lg sm:text-xl font-black text-amber-600 dark:text-amber-400 leading-none">{restockData.filter(d => !d.isCritical && d.isLow).length}</p>
        </div>
      </div>

      <div className="bg-secondary border border-base rounded-xl overflow-hidden shadow-xs">
        <div className="px-3 py-2 border-b border-base flex items-center justify-between bg-secondary">
          <div className="flex items-center gap-1.5">
            <h2 className="text-[11px] font-black text-primary uppercase tracking-tight">Sugerencias de Compra</h2>
            <InfoTooltip text="Calcula cuánto tiempo durará tu inventario actual basándose en el ritmo de ventas diario de los últimos 30 días. Ayuda a evitar quiebres de stock." position="bottom" />
          </div>
          <span className="text-[8px] font-black text-muted uppercase tracking-wider">{restockData.length} productos</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead className="bg-secondary border-b border-base">
              <tr>
                <th className="px-3 py-2 text-[8px] sm:text-[9px] font-black text-muted uppercase tracking-wider">Producto</th>
                <th className="px-3 py-2 text-center text-[8px] sm:text-[9px] font-black text-muted uppercase tracking-wider">Stock</th>
                <th className="px-3 py-2 text-center text-[8px] sm:text-[9px] font-black text-muted uppercase tracking-wider">Ventas/Día</th>
                <th className="px-3 py-2 text-center text-[8px] sm:text-[9px] font-black text-muted uppercase tracking-wider">Días Restantes</th>
                <th className="px-3 py-2 text-center text-[8px] sm:text-[9px] font-black text-muted uppercase tracking-wider">Acción</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-base">
              {restockData.map((data) => (
                <tr key={data.product.id} className="hover:bg-subtle/50 transition-colors">
                  <td className="px-3 py-2">
                    <div className="font-black text-xs text-primary truncate max-w-[150px] sm:max-w-[200px]">{data.product.name}</div>
                    <div className="text-[9px] font-bold text-muted">SKU: {data.product.sku}</div>
                  </td>
                  <td className="px-3 py-2 text-center font-black text-xs text-primary">{data.stock}</td>
                  <td className="px-3 py-2 text-center">
                    <div className="inline-flex items-center justify-center gap-1 bg-secondary border border-base px-1.5 py-0.5 rounded text-[10px] font-bold text-primary">
                      <TrendingUp className="w-2.5 h-2.5 text-indigo-500" />
                      {data.dailySalesRate.toFixed(1)}/d
                    </div>
                  </td>
                  <td className="px-3 py-2 text-center">
                    <div className="inline-flex items-center justify-center gap-1 bg-secondary border border-base px-1.5 py-0.5 rounded text-[10px] font-bold text-primary">
                      <Calendar className="w-2.5 h-2.5 text-muted" />
                      {data.daysUntilStockout === Infinity ? 'N/A' : `${data.daysUntilStockout} d`}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-center">
                    {data.isCritical ? (
                      <span className="bg-rose-100 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 px-2 py-0.5 rounded-lg text-[8px] font-black uppercase tracking-wider inline-block whitespace-nowrap">
                        Comprar Ya
                      </span>
                    ) : (
                      <span className="bg-amber-100 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 px-2 py-0.5 rounded-lg text-[8px] font-black uppercase tracking-wider inline-block whitespace-nowrap">
                        Alerta
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
