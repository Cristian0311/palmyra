import type { InventoryLevel } from '../../types';

export type TransferStockRequirement = {
  productId: string;
  branchId: string;
  variantLabel?: string;
  quantity: number;
};

export function validateTransferStock(
  inventory: InventoryLevel[],
  requirements: TransferStockRequirement[]
): { ok: boolean; message?: string } {
  const needed = new Map<string, TransferStockRequirement & { variantLabel: string }>();

  for (const req of requirements) {
    const quantity = Number(req.quantity);
    if (!req.productId || !req.branchId || !Number.isInteger(quantity) || quantity <= 0) {
      return { ok: false, message: 'La cantidad de traslado debe ser un número entero mayor que 0.' };
    }

    const variantLabel = req.variantLabel || '';
    const key = req.productId + ':' + req.branchId + ':' + variantLabel;
    const previous = needed.get(key);
    if (previous) previous.quantity += quantity;
    else needed.set(key, { ...req, variantLabel, quantity });
  }

  for (const req of needed.values()) {
    const current = inventory.find((item) =>
      item.productId === req.productId &&
      item.branchId === req.branchId &&
      (item.variantLabel || '') === req.variantLabel
    );
    const available = Number(current?.quantity || 0);
    if (available < req.quantity) {
      const label = req.variantLabel ? ' (' + req.variantLabel + ')' : '';
      return {
        ok: false,
        message:
          'Stock insuficiente en la sucursal de origen para ' +
          req.productId +
          label +
          ': disponible ' +
          available +
          ', requerido ' +
          req.quantity +
          '.'
      };
    }
  }

  return { ok: true };
}

export function setCanonicalInventoryQuantity(
  inventory: InventoryLevel[],
  productId: string,
  branchId: string,
  variantLabel: string | undefined,
  quantity: number
): InventoryLevel[] {
  const label = variantLabel || '';
  return inventory.map((item) =>
    item.productId === productId &&
    item.branchId === branchId &&
    (item.variantLabel || '') === label
      ? { ...item, quantity: Math.max(0, Number(quantity) || 0) }
      : item
  );
}
