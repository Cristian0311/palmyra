export type WarehouseScopedRecord = {
  warehouseId?: string | null;
  branchId?: string | null;
  allowedWarehouseIds?: string[] | null;
  allowedBranches?: string[] | null;
};

export function getWarehouseId(record: WarehouseScopedRecord | null | undefined): string | undefined {
  const id = record?.warehouseId ?? record?.branchId;
  return id ? String(id) : undefined;
}

export function getAuthorizedWarehouseIds(
  record: WarehouseScopedRecord | null | undefined
): string[] {
  const ids = [
    ...(record?.allowedWarehouseIds || []),
    ...(record?.allowedBranches || []),
    getWarehouseId(record),
  ];

  return Array.from(
    new Set(ids.filter((id): id is string => Boolean(id)).map(String))
  );
}

export function hasWarehouseAccess(
  record: WarehouseScopedRecord | null | undefined,
  warehouseId: string
): boolean {
  return getAuthorizedWarehouseIds(record).includes(warehouseId);
}
