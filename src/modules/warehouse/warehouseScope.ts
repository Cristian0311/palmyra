export type WarehouseScopedRecord = {
  warehouseId?: string | null;
  branchId?: string | null;
  allowedWarehouseIds?: string[] | null;
  allowedBranches?: string[] | null;
};

function uniqueIds(ids: unknown[]): string[] {
  return Array.from(
    new Set(ids.filter((id): id is string => Boolean(id)).map(String))
  );
}

export function getWarehouseId(
  record: WarehouseScopedRecord | null | undefined
): string | undefined {
  const id = record?.warehouseId ?? record?.branchId;
  return id ? String(id) : undefined;
}

/**
 * Compatibility rule:
 * 1. canonical allowedWarehouseIds, when present, is authoritative;
 * 2. otherwise legacy allowedBranches, when non-empty, is authoritative;
 * 3. otherwise fall back to the single warehouse/branch assignment.
 *
 * We intentionally do not union these sources because doing so could
 * accidentally expand a user's warehouse permissions during migration.
 */
export function getAuthorizedWarehouseIds(
  record: WarehouseScopedRecord | null | undefined
): string[] {
  if (Array.isArray(record?.allowedWarehouseIds)) {
    return uniqueIds(record.allowedWarehouseIds);
  }

  if (Array.isArray(record?.allowedBranches) && record.allowedBranches.length > 0) {
    return uniqueIds(record.allowedBranches);
  }

  const id = getWarehouseId(record);
  return id ? [id] : [];
}

export function hasWarehouseAccess(
  record: WarehouseScopedRecord | null | undefined,
  warehouseId: string
): boolean {
  return getAuthorizedWarehouseIds(record).includes(warehouseId);
}
