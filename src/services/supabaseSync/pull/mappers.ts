import type { Branch, Product, User } from '../../../types';

export function mapProduct(p: any, barcode?: string, kitComponents: any[] = []): Product {
  return {
    id: p.id,
    name: p.name,
    sku: p.sku || '',
    barcode: barcode || '',
    costPrice: Number(p.cost) || 0,
    price: Number(p.price) || 0,
    margin: (Number(p.price) || 0) - (Number(p.cost) || 0),
    categoryId: p.category_id || '',
    color: p.device_color || 'bg-rose-50 text-rose-700',
    commissionValue: Number(p.commission_fixed) || 0,
    commissionType: 'fixed',
    unit: p.base_unit || 'unidad',
    status: p.status || 'active',
    minStockAlert: Number(p.minimum_stock) || 0,
    hasSerial: Boolean(p.track_serial),
    warrantyDays: 0,
    isKit: Boolean(p.is_kit),
    kitItems: kitComponents,
    kitComponents: kitComponents.map((item: any) => ({
      productId: item.component_product_id,
      quantity: Number(item.quantity) || 0,
    })),
    image: p.image_path || undefined,
  };
}

export function mapBranch(w: any, index: number): Branch {
  return {
    id: w.id,
    name: w.name,
    isMain: w.code === 'ALM-01' || index === 0,
    isActive: w.active !== false,
  };
}

export function mapUser(e: any, locations: any[], _admin?: any): User {
  const access = locations.filter((location: any) => location.employee_id === e.id);
  const warehouseIds = access.map((location: any) => location.warehouse_id).filter(Boolean);

  return {
    id: e.user_id || e.id,
    employeeId: e.id,
    name: e.full_name,
    email: '',
    password: '',
    role: 'employee',
    baseSalary: Number(e.base_salary) || 0,
    commissionRate: Number(e.sales_percentage) || 0,
    compensationType: e.compensation_type === 'sales_percentage' ? 'sales_percentage' : 'fixed_product',
    branchId: warehouseIds.find((id: string) =>
      access.find((location: any) => location.warehouse_id === id)?.is_default
    ) || warehouseIds[0],
    allowedBranches: warehouseIds,
    permissions: ['pos_access'],
    isActive: e.active !== false,
  };
}

export function normalizeSaleItem(
  raw: any,
  productMap: Map<string, Product>,
  variantMap: Map<string, string>,
  saleId: string,
  index: number,
): any {
  const productId = raw.product_id;
  const product = productMap.get(productId);
  const rawLineTotal = raw.line_total;
  const lineTotal = rawLineTotal !== null && rawLineTotal !== undefined && rawLineTotal !== '' && Number.isFinite(Number(rawLineTotal))
    ? Number(rawLineTotal)
    : (Number(raw.unit_price) || 0) * (Number(raw.quantity) || 0);
  const unitPrice = raw.unit_price !== null && raw.unit_price !== undefined && raw.unit_price !== '' && Number.isFinite(Number(raw.unit_price))
    ? Number(raw.unit_price)
    : Number(product?.price) || 0;
  const variantLabel = raw.variant_id ? (variantMap.get(raw.variant_id) || undefined) : undefined;
  const resolvedProduct = product || {
    id: productId,
    name: 'Producto',
    sku: '',
    barcode: '',
    costPrice: 0,
    price: unitPrice,
    margin: 0,
    categoryId: '',
    color: 'bg-rose-50 text-rose-700',
    commissionValue: 0,
  };

  return {
    id: raw.id || `${saleId}-item-${index}`,
    product: { ...resolvedProduct, price: unitPrice },
    quantity: Number(raw.quantity) || 0,
    price: unitPrice,
    total: lineTotal,
    serialNumber: raw.serial_number || undefined,
    variantLabel,
  };
}
