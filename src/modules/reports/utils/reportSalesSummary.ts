import type { Product, Transaction } from '../../../types';
import { matchesReportSaleDateFilter, saleBusinessDateYMD, type ReportDateFilter } from './reportDateFilter';

export function filterReportTransactions(transactions: Transaction[], filters: {
  branchId: string; workerId: string; workerAliases?: string[]; date: string; period: ReportDateFilter;
}, now = new Date()) {
  // Legacy tickets may only store the cashier name or the employee id, so the
  // worker filter accepts every known spelling of the selected person.
  const workerTokens = new Set(
    [filters.workerId, ...(filters.workerAliases || [])]
      .filter(Boolean)
      .map(value => String(value).toLowerCase()),
  );
  const matchesWorker = (tx: Transaction) => filters.workerId === 'all' ||
    workerTokens.has(String(tx.userId || '').toLowerCase()) ||
    (tx.sellerEmployeeIds || []).some(id => workerTokens.has(String(id).toLowerCase())) ||
    (!!tx.cashierName && workerTokens.has(tx.cashierName.toLowerCase()));
  return transactions.filter(tx =>
    (filters.branchId === 'all' || tx.branchId === filters.branchId) &&
    matchesWorker(tx) &&
    // La fecha de negocio elegida en caja manda sobre la hora de creación.
    matchesReportSaleDateFilter(tx, filters.date, filters.period, now)
  ).sort((a, b) => {
    const business = saleBusinessDateYMD(b).localeCompare(saleBusinessDateYMD(a));
    if (business !== 0) return business;
    return new Date(b.date).getTime() - new Date(a.date).getTime();
  });
}

export function isReportSale(tx: Transaction) {
  return tx.status === 'completed' && !tx.deletedAt && !String(tx.notes || '').startsWith('AJUSTE_');
}

export function reportLineTotal(item: Transaction['items'][number]) {
  return typeof item.total === 'number' && Number.isFinite(item.total)
    ? item.total : (Number(item.price) || 0) * (Number(item.quantity) || 0);
}

/**
 * Unit cost for one sold line. The historical product snapshot wins; otherwise
 * the catalog is used. Kits are valued by their components so a bundle is not
 * reported as 100% margin. Returns `missing` when no trustworthy cost exists,
 * so the UI can flag the figure instead of silently reporting pure profit.
 */
export function resolveUnitCost(
  item: Transaction['items'][number],
  productById: Map<string, Product>,
): { cost: number; missing: boolean } {
  const snapshot = typeof item.product === 'string' ? undefined : item.product;
  const product = typeof item.product === 'string'
    ? productById.get(item.product) || snapshot
    : snapshot;

  if (product?.isKit && Array.isArray(product.kitComponents) && product.kitComponents.length) {
    let kitCost = 0;
    let complete = true;
    for (const component of product.kitComponents) {
      const componentProduct = productById.get(component.productId);
      const unitCost = Number(componentProduct?.costPrice);
      if (!componentProduct || !Number.isFinite(unitCost) || unitCost < 0) {
        complete = false;
        break;
      }
      kitCost += unitCost * (Number(component.quantity) || 0);
    }
    if (complete) return { cost: kitCost, missing: false };
  }

  const recorded = Number(product?.costPrice);
  if (product && Number.isFinite(recorded) && recorded >= 0) return { cost: recorded, missing: false };
  return { cost: 0, missing: true };
}

export function summarizeReportSales(transactions: Transaction[], catalog: Product[] = []) {
  const productById = new Map(catalog.map(product => [product.id, product]));
  const sales = transactions.filter(isReportSale);
  const products = new Map<string, {
    key: string; productId: string; name: string; variant: string;
    quantity: number; revenue: number; cost: number; profit: number; missingCostUnits: number; ticketIds: string[];
  }>();
  let totalCost = 0;
  let missingCostUnits = 0;

  for (const tx of sales) for (const item of tx.items || []) {
    const product = item.product;
    const productId = typeof product === 'string' ? product : product?.id;
    const variant = item.variantLabel || '';
    const key = JSON.stringify([productId, variant]);
    const quantity = Number(item.quantity) || 0;
    const unitCost = resolveUnitCost(item, productById);
    const revenue = reportLineTotal(item);
    const row = products.get(key) || {
      key, productId, name: typeof product === 'string' ? productId : product?.name || 'Producto',
      variant, quantity: 0, revenue: 0, cost: 0, profit: 0, missingCostUnits: 0, ticketIds: [],
    };
    row.quantity += quantity;
    row.revenue += revenue;
    row.cost += unitCost.cost * quantity;
    row.profit = row.revenue - row.cost;
    if (unitCost.missing) {
      row.missingCostUnits += quantity;
      missingCostUnits += quantity;
    }
    if (!row.ticketIds.includes(tx.id)) row.ticketIds.push(tx.id);
    totalCost += unitCost.cost * quantity;
    products.set(key, row);
  }

  const total = sales.reduce((sum, tx) => sum + Math.max(0, Number(tx.total) || 0), 0);
  const rows = [...products.values()].sort((a, b) => b.quantity - a.quantity || b.revenue - a.revenue || a.key.localeCompare(b.key));
  const profit = total - totalCost;
  return {
    sales,
    total,
    tickets: sales.length,
    units: rows.reduce((sum, row) => sum + row.quantity, 0),
    average: sales.length ? total / sales.length : 0,
    products: rows,
    cost: totalCost,
    profit,
    margin: total > 0 ? (profit / total) * 100 : 0,
    missingCostUnits,
  };
}

export type ReportSalesSummary = ReturnType<typeof summarizeReportSales>;
