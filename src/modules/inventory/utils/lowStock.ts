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
