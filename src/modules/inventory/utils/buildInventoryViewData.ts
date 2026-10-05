import type { InventoryLevel, Product } from '../../../types';

export function buildInventoryViewData(
  products: Product[],
  inventory: InventoryLevel[],
  queryText: string,
  selectedBranch: string,
  selectedCategory: string,
  stockFilter: 'all' | 'in_stock' | 'low' | 'out',
  displayLimit: number
) {
  const inventoryByProduct = new Map<string, InventoryLevel[]>();
  for (const level of inventory || []) {
    const existing = inventoryByProduct.get(level.productId);
    if (existing) existing.push(level);
    else inventoryByProduct.set(level.productId, [level]);
  }
const inventoryData = (() => {
    if (!products || !inventory) return { full: [], paginated: [] };

    const query = debouncedSearchQuery.trim().toLowerCase();
    // Apply cheap text/category filters before calculating stock levels.
    // This avoids touching every inventory row when the user is searching.
    let candidateProducts = products;

    if (query) {
      candidateProducts = candidateProducts.filter(product =>
        (product.name || '').toLowerCase().includes(query) ||
        (product.sku || '').toLowerCase().includes(query) ||
        (!!product.barcode && product.barcode.toLowerCase().includes(query))
      );
    }

    if (selectedCategory !== "all") {
      candidateProducts = candidateProducts.filter(product => product.categoryId === selectedCategory);
    }

    let filtered = candidateProducts.map(product => {
      const allLevels = inventoryByProduct.get(product.id) || [];
      const productLevels = selectedBranch === 'all'
        ? allLevels
        : allLevels.filter(level => level.branchId === selectedBranch);

      const totalStock = productLevels.reduce((acc, curr) => acc + curr.quantity, 0);
      const isLowStock = productLevels.some(i => i.quantity <= (product.minStockAlert || i.minQuantity));
      const variantLevels = productLevels.filter(level => !!level.variantLabel);

      return {
        ...product,
        totalStock,
        isLowStock,
        levels: productLevels,
        variantLevels
      };
    });

    if (stockFilter === 'in_stock') {
      filtered = filtered.filter(p => p.totalStock > 0);
    } else if (stockFilter === 'low') {
      filtered = filtered.filter(p => p.isLowStock);
    } else if (stockFilter === 'out') {
      filtered = filtered.filter(p => p.totalStock === 0);
    }

    return {
      full: filtered,
      paginated: filtered.slice(0, displayLimit)
    };
  })();

}
