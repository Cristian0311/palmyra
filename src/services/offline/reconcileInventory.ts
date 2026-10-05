import type { InventoryLevel } from '../../types';
import { useStore } from '../../store/useStore';

export function replaceWarehouseInventory(warehouseId: string, inventory: InventoryLevel[]): void {
  if (!warehouseId) return;
  useStore.setState((state) => ({
    inventory: [
      ...(state.inventory || []).filter((item) => item.branchId !== warehouseId),
      ...(inventory || [])
    ]
  }));
}

export function replaceWarehousesInventory(
  warehouseIds: string[],
  inventory: InventoryLevel[]
): void {
  const ids = Array.from(new Set(warehouseIds.filter(Boolean)));
  if (!ids.length) return;
  useStore.setState((state) => ({
    inventory: [
      ...(state.inventory || []).filter((item) => !ids.includes(item.branchId)),
      ...(inventory || [])
    ]
  }));
}
