import type { Category } from '../../../types';

type InventoryCsvRow = {
  id: string;
  name: string;
  sku: string;
  barcode?: string;
  categoryId: string;
  costPrice: number;
  price: number;
  totalStock: number;
  unit?: string;
  status?: string;
};

function escapeCsvCell(value: unknown): string {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function buildInventoryCsv(products: InventoryCsvRow[], categories: Category[]): string {
  const headers = ["ID", "Nombre", "SKU", "EAN", "Departamento", "Costo", "Precio", "Stock Total", "Unidad", "Estado"];
  const categoryById = new Map(categories.map(category => [category.id, category.name]));
  const rows = products.map(product => [
    product.id,
    product.name,
    product.sku,
    product.barcode || "",
    categoryById.get(product.categoryId) || "",
    product.costPrice,
    product.price,
    product.totalStock,
    product.unit || "uds",
    product.status || "active",
  ]);

  return [
    headers.map(escapeCsvCell).join(","),
    ...rows.map(row => row.map(escapeCsvCell).join(",")),
  ].join("\n");
}
