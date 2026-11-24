import { useShallow } from 'zustand/react/shallow';
import React, { useMemo } from 'react';
import { useStore } from '../store/useStore';
import { formatMoney, cn } from '../lib/utils';
import { TrendingUp, TrendingDown, AlertCircle, Minus } from 'lucide-react';
import { InfoTooltip } from './InfoTooltip';

export function ABCAnalysis() {
  const { products, inventory, transactions, getBaseCurrency } = useStore(useShallow((state) => ({ products: state.products, inventory: state.inventory, transactions: state.transactions, getBaseCurrency: state.getBaseCurrency })));
  const baseCurrency = getBaseCurrency();

  // ABC Analysis logic
  // A: 70% of value, B: 20% of value, C: 10% of value (or similar)
  // Value can be calculated based on sales history or current stock value.
  // We'll use sales history if available, otherwise stock value.
  
  const abcData = useMemo(() => {
    // Solo ventas efectivas: anuladas, reembolsadas y ocultas del reporte no
    // cuentan como consumo, igual que en el reporte de ventas.
    const effectiveSales = transactions.filter(tx => tx.status === 'completed' && !tx.reportHidden);

    // 1. Calculate value per product
    const productValues = products.map(p => {
      // Find total sales for this product
      let totalSales = 0;
      let quantitySold = 0;
      effectiveSales.forEach(tx => {
        tx.items.forEach(item => {
          if ((typeof item.product === 'string' ? item.product : item.product?.id) === p.id) {
            totalSales += item.product.price * item.quantity;
            quantitySold += item.quantity;
          }
        });
      });

      // Find current stock
      const currentStock = inventory.filter(i => i.productId === p.id).reduce((s, i) => s + i.quantity, 0);
      const stockValue = currentStock * p.costPrice;

      // Primary metric for ABC is usually consumption value (sales) over a period.
      // If no sales, fallback to stock value.
      const valueMetric = totalSales > 0 ? totalSales : stockValue;

      return {
        product: p,
        totalSales,
        quantitySold,
        currentStock,
        stockValue,
        valueMetric
      };
    });

    // 2. Sort by value descending
    productValues.sort((a, b) => b.valueMetric - a.valueMetric);

    // 3. Calculate cumulative percentages and classify
    const totalValue = productValues.reduce((sum, p) => sum + p.valueMetric, 0);
    let cumulativeValue = 0;

    return productValues.map(p => {
      cumulativeValue += p.valueMetric;
      const cumulativePercentage = totalValue > 0 ? (cumulativeValue / totalValue) * 100 : 0;
      
      let classification = 'C';
      if (cumulativePercentage <= 70) classification = 'A';
      else if (cumulativePercentage <= 90) classification = 'B';

      return { ...p, classification, cumulativePercentage };
    });
  }, [products, inventory, transactions]);

  const stats = {
    A: abcData.filter(d => d.classification === 'A'),
    B: abcData.filter(d => d.classification === 'B'),
    C: abcData.filter(d => d.classification === 'C'),
  };

  return (
    <div className="bg-white rounded-[2rem] shadow-sm border border-slate-100 p-6 flex flex-col gap-6">
      <div className="flex justify-between items-center border-b border-slate-100 pb-4">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-black text-slate-900 uppercase tracking-tight">Análisis ABC de Inventario</h2>
          <InfoTooltip text="Clasifica tus productos según su valor de ventas. Clase A: 70% del valor (muy importantes), Clase B: 20%, Clase C: 10%. Ayuda a priorizar pedidos y auditorías." position="bottom" />
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-emerald-50 rounded-2xl p-4 border border-emerald-100">
          <div className="flex items-center justify-between mb-2">
            <span className="text-lg font-black text-emerald-700 uppercase tracking-tight">Clase A</span>
            <TrendingUp className="w-5 h-5 text-emerald-500" />
          </div>
          <p className="text-[10px] font-bold text-emerald-600/70 uppercase tracking-widest mb-4">Alta Rotación / Mayor Valor (70%)</p>
          <div className="text-2xl font-black text-emerald-800">{stats.A.length} <span className="text-sm">prods</span></div>
          <p className="text-xs font-bold text-emerald-600 mt-1">Control estricto requerido</p>
        </div>
        <div className="bg-blue-50 rounded-2xl p-4 border border-blue-100">
          <div className="flex items-center justify-between mb-2">
            <span className="text-lg font-black text-blue-700 uppercase tracking-tight">Clase B</span>
            <Minus className="w-5 h-5 text-blue-500" />
          </div>
          <p className="text-[10px] font-bold text-blue-600/70 uppercase tracking-widest mb-4">Valor Medio (20%)</p>
          <div className="text-2xl font-black text-blue-800">{stats.B.length} <span className="text-sm">prods</span></div>
          <p className="text-xs font-bold text-blue-600 mt-1">Control moderado</p>
        </div>
        <div className="bg-slate-50 rounded-2xl p-4 border border-slate-200">
          <div className="flex items-center justify-between mb-2">
            <span className="text-lg font-black text-slate-700 uppercase tracking-tight">Clase C</span>
            <TrendingDown className="w-5 h-5 text-slate-400" />
          </div>
          <p className="text-[10px] font-bold text-slate-500/70 uppercase tracking-widest mb-4">Baja Rotación / Stock Muerto (10%)</p>
          <div className="text-2xl font-black text-slate-800">{stats.C.length} <span className="text-sm">prods</span></div>
          <p className="text-xs font-bold text-slate-500 mt-1">Liquidar o reducir compras</p>
        </div>
      </div>

      <div className="mt-4 border border-slate-100 rounded-2xl overflow-hidden">
        <div className="overflow-x-auto max-h-[500px]">
          <table className="w-full text-left border-collapse">
            <thead className="bg-slate-50 sticky top-0 z-10">
              <tr>
                <th className="px-4 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest">Clase</th>
                <th className="px-4 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest">Producto</th>
                <th className="px-4 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">Stock Actual</th>
                <th className="px-4 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">Ventas Acum.</th>
                <th className="px-4 py-3 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">Métrica Valor</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {abcData.map((item, idx) => (
                <tr key={item.product.id} className="hover:bg-slate-50/50">
                  <td className="px-4 py-3">
                    <span className={cn(
                      "palmyra-pill",
                      item.classification === 'A' ? "bg-[color-mix(in_srgb,var(--success)_12%,transparent)] text-[var(--success)]" :
                      item.classification === 'B' ? "bg-[color-mix(in_srgb,var(--info)_12%,transparent)] text-[var(--info)]" :
                      "border border-base bg-subtle text-[var(--text-muted)]"
                    )}>
                      Clase {item.classification}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm font-bold text-slate-900">{item.product.name}</td>
                  <td className="px-4 py-3 text-sm text-right font-medium">
                    {item.currentStock}
                    {item.currentStock <= 0 && <span className="palmyra-pill ml-2 bg-[color-mix(in_srgb,var(--danger)_12%,transparent)] text-[var(--danger)]">Agotado</span>}
                  </td>
                  <td className="px-4 py-3 text-sm text-right font-medium">{formatMoney(item.totalSales, baseCurrency.symbol)}</td>
                  <td className="px-4 py-3 text-sm text-right font-black text-slate-700">{formatMoney(item.valueMetric, baseCurrency.symbol)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
