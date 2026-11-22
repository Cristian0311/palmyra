const DEFAULT_LOW_STOCK_THRESHOLD = 5;

// Regla única de bajo stock para inventario, alertas y análisis:
// umbral del producto → mínimo por nivel/almacén → 5 por defecto.
export function getLowStockThreshold(
  product?: { minStockAlert?: number } | null,
  levelMinQuantity?: number
): number {
  const productThreshold = Number(product?.minStockAlert) || 0;
  if (productThreshold > 0) return productThreshold;
  const levelThreshold = Number(levelMinQuantity) || 0;
  if (levelThreshold > 0) return levelThreshold;
  return DEFAULT_LOW_STOCK_THRESHOLD;
}

export function isLowStockQuantity(
  quantity: number | null | undefined,
  product?: { minStockAlert?: number } | null,
  levelMinQuantity?: number
): boolean {
  return Number(quantity) <= getLowStockThreshold(product, levelMinQuantity);
}

type StockLevelQuantity = { quantity?: number | null };

/** Stock disponible de un producto: suma de todos sus almacenes/niveles. */
export function sumAvailableStock(
  levels: readonly StockLevelQuantity[] | null | undefined
): number {
  if (!levels) return 0;
  return levels.reduce((total, level) => total + (Number(level.quantity) || 0), 0);
}

/**
 * Regla de bajo stock a nivel de producto: se evalúa el total disponible
 * (nunca una fila aislada) contra el umbral del producto.
 */
export function isLowStockProduct(
  levels: readonly StockLevelQuantity[] | null | undefined,
  product?: { minStockAlert?: number } | null
): boolean {
  return isLowStockQuantity(sumAvailableStock(levels), product);
}
