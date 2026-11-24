/**
 * Utilidades puras de rentabilidad para el inventario.
 *
 * Ganancia neta por unidad = precio de venta − costo de compra − salario.
 * El salario por unidad depende de la configuración de compensación de la
 * empresa:
 *  - `sales_percent` (o `sales_percentage`): precio × percentRate / 100
 *  - `fixed_product`: el `commissionValue` del producto
 *  - cualquier otro modo: 0
 * El margen % siempre se expresa sobre el precio de venta.
 */

export interface ProfitCompensationInput {
  mode?: string | null;
  percentRate?: number | null;
}

export interface UnitProfitInput {
  price?: number | null;
  costPrice?: number | null;
  commissionValue?: number | null;
  compensation?: ProfitCompensationInput | null;
}

export interface UnitProfitResult {
  /** Salario (compensación del vendedor) atribuible a una unidad vendida. */
  salaryShare: number;
  /** Precio de venta − costo − salario. Puede ser negativo. */
  netProfit: number;
  /** Ganancia neta sobre el precio de venta. 0 si el precio no es válido. */
  marginPct: number;
}

export interface InventoryProfitRowInput {
  price?: number | null;
  costPrice?: number | null;
  commissionValue?: number | null;
  totalStock?: number | null;
}

export interface InventoryProfitSummary {
  valueCost: number;
  valueSale: number;
  salaryTotal: number;
  netProfit: number;
  marginPct: number;
}

function finiteNumber(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function nonNegative(value: unknown): number {
  return Math.max(0, finiteNumber(value));
}

function resolveMode(mode: string | null | undefined): 'fixed_product' | 'sales_percent' | null {
  if (mode === 'sales_percent' || mode === 'sales_percentage') return 'sales_percent';
  if (mode === 'fixed_product') return 'fixed_product';
  return null;
}

/** Ganancia neta y margen de una sola unidad. Tolera NaN, precios ≤ 0 y datos faltantes. */
export function unitProfit(input: UnitProfitInput): UnitProfitResult {
  const price = nonNegative(input?.price);
  const costPrice = nonNegative(input?.costPrice);
  const mode = resolveMode(input?.compensation?.mode);

  let salaryShare = 0;
  if (mode === 'sales_percent') {
    const percentRate = Math.min(100, nonNegative(input?.compensation?.percentRate));
    salaryShare = (price * percentRate) / 100;
  } else if (mode === 'fixed_product') {
    salaryShare = nonNegative(input?.commissionValue);
  }

  const netProfit = price - costPrice - salaryShare;
  const marginPct = price > 0 ? (netProfit / price) * 100 : 0;

  return { salaryShare, netProfit, marginPct };
}

/** Agrega costo, venta, salarios y ganancia neta sobre las unidades en stock. */
export function summarizeInventoryProfit(
  rows: InventoryProfitRowInput[] | null | undefined,
  compensation?: ProfitCompensationInput | null
): InventoryProfitSummary {
  let valueCost = 0;
  let valueSale = 0;
  let salaryTotal = 0;

  for (const row of rows || []) {
    const units = nonNegative(row?.totalStock);
    if (units <= 0) continue;
    const price = nonNegative(row?.price);
    const unit = unitProfit({
      price,
      costPrice: row?.costPrice,
      commissionValue: row?.commissionValue,
      compensation
    });
    valueSale += price * units;
    valueCost += nonNegative(row?.costPrice) * units;
    salaryTotal += unit.salaryShare * units;
  }

  const netProfit = valueSale - valueCost - salaryTotal;
  const marginPct = valueSale > 0 ? (netProfit / valueSale) * 100 : 0;

  return { valueCost, valueSale, salaryTotal, netProfit, marginPct };
}
