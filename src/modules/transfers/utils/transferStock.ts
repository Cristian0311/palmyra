import type { InventoryLevel } from '../../../types';

export function getTransferStockHelpers(
  inventory: InventoryLevel[],
  productId: string,
  fromBranchId: string,
  toBranchId: string,
  variantsList: string[],
  variantQuantities: Record<string, number>
) {
  const getSourceStockForVariant = (variantLabel: string = ''): number => {
    if (!productId || !fromBranchId) return 0;
    const item = inventory.find(
      i => i.productId === productId && 
           i.branchId === fromBranchId && 
           (i.variantLabel || '') === (variantLabel || '')
    );
    return item ? Number(item.quantity) : 0;
  };

  const getTargetStockForVariant = (variantLabel: string = ''): number => {
    if (!productId || !toBranchId) return 0;
    const item = inventory.find(
      i => i.productId === productId && 
           i.branchId === toBranchId && 
           (i.variantLabel || '') === (variantLabel || '')
    );
    return item ? Number(item.quantity) : 0;
  };

  const totalSourceStock: number = variantsList.reduce((acc: number, v: string) => acc + getSourceStockForVariant(v), 0);
  const totalTargetStock: number = toBranchId 
    ? variantsList.reduce((acc: number, v: string) => acc + getTargetStockForVariant(v), 0) 
    : 0;

  const totalTransferring: number = Object.keys(variantQuantities).reduce((acc: number, key: string) => {
    const val = Number(variantQuantities[key]);
    return acc + (isNaN(val) ? 0 : val);
  }, 0);


  return { getSourceStockForVariant, getTargetStockForVariant, totalSourceStock, totalTargetStock, totalTransferring };
}
