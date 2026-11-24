import { useShallow } from 'zustand/react/shallow';
import React, { useMemo } from 'react';
import { useStore } from '../store/useStore';
import { AlertTriangle, Clock, TrendingUp, Calendar, AlertCircle, Package } from 'lucide-react';
import { InfoTooltip } from './InfoTooltip';
import { isLowStockQuantity } from '../modules/inventory/utils/lowStock';
import { cn } from '../lib/utils';

export function RestockAlerts() {
  const { products, inventory, transactions, currentBranchId } = useStore(useShallow((state) => ({ products: state.products, inventory: state.inventory, transactions: state.transactions, currentBranchId: state.currentBranchId })));

  const restockData = useMemo(() => {
    // Calcular ventas por día en los últimos 30 días
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    // El stock se evalúa por sucursal, así que el ritmo de venta debe venir de
    // la misma sucursal; antes ventas de otra tienda marcaban productos como
    // críticos aquí y ocultaban los que de verdad se agotan.
    const recentTx = transactions.filter(t =>
      new Date(t.date) >= thirtyDaysAgo &&
      t.status === 'completed' &&
      !t.deletedAt &&
      (!currentBranchId || t.branchId === currentBranchId)
    );

    const salesByProduct: Record<string, number> = {};
    recentTx.forEach(tx => {
      tx.items.forEach(item => {
        salesByProduct[item.product.id] = (salesByProduct[item.product.id] || 0) + item.quantity;
      });
    });

    // Un solo recorrido en vez de filtrar el inventario entero por producto.
    const stockByProduct = new Map<string, number>();
    for (const row of inventory) {
      if (currentBranchId && row.branchId !== currentBranchId) continue;
      stockByProduct.set(row.productId, (stockByProduct.get(row.productId) || 0) + row.quantity);
    }

    return products.map(product => {
      const stock = stockByProduct.get(product.id) || 0;
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
    // Sin productos cargados no es «todo en orden»: es una vista vacía real.
    const noProducts = products.length === 0;
    return (
      <div className="bg-secondary rounded-2xl border border-base p-6 sm:p-8 text-center">
        <div className={cn(
          "w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-3",
          noProducts ? "bg-slate-100 dark:bg-slate-800 text-slate-400" : "bg-emerald-50 dark:bg-emerald-950/30 text-emerald-500"
        )}>
          {noProducts ? <Package size={24} /> : <AlertCircle size={24} />}
        </div>
        <h3 className="text-sm font-black text-primary uppercase tracking-tight mb-1">{noProducts ? 'Sin productos' : 'Todo en orden'}</h3>
        <p className="text-muted font-bold text-xs">
          {noProducts
            ? 'Aún no hay productos en el inventario para calcular sugerencias de compra.'
            : 'No hay productos en riesgo de agotarse pronto según el ritmo de ventas.'}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2.5">
      {/* Compact summary bubbles: 2 columns even on mobile */}
      <div className="grid grid-cols-2 gap-2">
        <div className="bg-secondary border border-[color-mix(in_srgb,var(--danger)_40%,transparent)] p-2 sm:p-2.5 rounded-xl shadow-xs flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-lg bg-[color-mix(in_srgb,var(--danger)_12%,transparent)] flex items-center justify-center text-[var(--danger)] shrink-0">
              <AlertTriangle className="w-3.5 h-3.5" />
            </div>
            <div>
              <h3 className="font-black text-[var(--danger)] uppercase tracking-wider text-[8px] sm:text-[9px] truncate">Crítico (&lt; 7 días)</h3>
              <p className="text-[7px] text-muted font-bold">Agotamiento inminente</p>
            </div>
          </div>
          <p className="text-lg sm:text-xl font-black text-[var(--danger)] leading-none">{restockData.filter(d => d.isCritical).length}</p>
        </div>

        <div className="bg-secondary border border-[color-mix(in_srgb,var(--warning)_40%,transparent)] p-2 sm:p-2.5 rounded-xl shadow-xs flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-lg bg-[color-mix(in_srgb,var(--warning)_12%,transparent)] flex items-center justify-center text-[var(--warning)] shrink-0">
              <Clock className="w-3.5 h-3.5" />
            </div>
            <div>
              <h3 className="font-black text-[var(--warning)] uppercase tracking-wider text-[8px] sm:text-[9px] truncate">Stock Bajo</h3>
              <p className="text-[7px] text-muted font-bold">Por debajo del mínimo</p>
            </div>
          </div>
          <p className="text-lg sm:text-xl font-black text-[var(--warning)] leading-none">{restockData.filter(d => !d.isCritical && d.isLow).length}</p>
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
                <th className="hidden sm:table-cell px-3 py-2 text-center text-[8px] sm:text-[9px] font-black text-muted uppercase tracking-wider">Ventas/Día</th>
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
                  <td className="hidden sm:table-cell px-3 py-2 text-center">
                    <div className="palmyra-pill border border-base bg-secondary text-primary">
                      <TrendingUp className="w-2.5 h-2.5 text-[var(--info)]" />
                      {data.dailySalesRate.toFixed(1)}/d
                    </div>
                  </td>
                  <td className="px-3 py-2 text-center">
                    <div className="palmyra-pill border border-base bg-secondary text-primary">
                      <Calendar className="w-2.5 h-2.5 text-muted" />
                      {data.daysUntilStockout === Infinity ? 'N/A' : `${data.daysUntilStockout} d`}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-center">
                    {data.isCritical ? (
                      <span className="palmyra-pill bg-[color-mix(in_srgb,var(--danger)_12%,transparent)] text-[var(--danger)] whitespace-nowrap">
                        Comprar Ya
                      </span>
                    ) : (
                      <span className="palmyra-pill bg-[color-mix(in_srgb,var(--warning)_12%,transparent)] text-[var(--warning)] whitespace-nowrap">
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
