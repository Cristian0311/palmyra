import assert from "node:assert/strict";
import test from "node:test";
import {
  assertLocalRow,
  type LocalDbDriver,
  type LocalDbTransaction,
  type LocalRow,
  type LocalTable,
  type MutationMeta,
  type QuerySpec,
} from "../../src/services/localDb/contract";
import {
  applyLegacyImport,
  importLegacyState,
  type ImportMeta,
} from "../../src/services/localDb/importLegacy";

/** Driver falso: registra qué se escribe y dentro de qué transacción. */
class FakeDriver implements LocalDbDriver {
  readonly kind = "memory" as const;
  transactionCount = 0;
  directPuts = 0;
  writes: { table: LocalTable; ids: string[] }[] = [];

  private record<T extends LocalRow>(table: LocalTable, rows: T[]): number {
    this.writes.push({ table, ids: rows.map((row) => row.id) });
    return rows.length;
  }

  async ready(): Promise<void> {}
  async get<T extends LocalRow>(_table: LocalTable, _id: string): Promise<T | null> {
    return null;
  }
  async query<T extends LocalRow>(_spec: QuerySpec): Promise<T[]> {
    return [];
  }
  async put<T extends LocalRow>(table: LocalTable, rows: T[]): Promise<number> {
    this.directPuts += 1;
    return this.record(table, rows);
  }
  async remove(_table: LocalTable, _ids: string[], _meta: MutationMeta): Promise<void> {}
  async transaction<T>(fn: (tx: LocalDbTransaction) => Promise<T>): Promise<T> {
    this.transactionCount += 1;
    const tx: LocalDbTransaction = {
      get: async () => null,
      query: async () => [],
      put: async (table, rows) => this.record(table, rows),
      remove: async () => {},
    };
    return fn(tx);
  }
  async changes() {
    return [];
  }
  async latestSeq(): Promise<number> {
    return 0;
  }
  async close(): Promise<void> {}
}

const META: ImportMeta = {
  companyId: "co-1",
  originDevice: "device-aaa",
  now: "2026-03-01T12:00:00.000Z",
};

/** Estado legado pequeño pero realista, tal como lo persiste zustand/persist. */
function legacyState() {
  return {
    state: {
      currentBranchId: "b1",
      storeConfig: { storeName: "PALMYRA", address: "", phone: "" },
      branches: [
        { id: "b1", name: "Centro", address: "Calle 1", isMain: true, isActive: true },
        { id: "b2", name: "Vedado" },
      ],
      products: [
        {
          id: "p1",
          name: "Cemento gris",
          sku: "CEM-1",
          costPrice: 100,
          price: 150,
          margin: 50,
          categoryId: "cat1",
          color: "bg-gray-500",
          commissionValue: 0,
          createdAt: "2026-01-05T09:00:00.000Z",
          kitComponents: [{ productId: "p9", quantity: 2 }],
        },
        { name: "Producto sin id", sku: "X-1", price: 10, costPrice: 5 },
        {
          id: "p2",
          name: "Arena fina",
          sku: "ARE-1",
          costPrice: 40,
          price: 60,
          margin: 20,
          categoryId: "cat1",
          color: "bg-yellow-600",
          commissionValue: 0,
        },
        {
          id: "p1",
          name: "Cemento gris (corregido)",
          sku: "CEM-1",
          costPrice: 110,
          price: 160,
          margin: 50,
          categoryId: "cat1",
          color: "bg-gray-500",
          commissionValue: 0,
          updatedAt: "2026-02-10T08:00:00.000Z",
          version: 4,
          kitComponents: [{ productId: "p9", quantity: 2 }],
        },
      ],
      transactions: [
        {
          id: "t1",
          branchId: "b1",
          userId: "u1",
          date: "2026-02-01T10:00:00.000Z",
          total: 1500,
          payments: [{ currencyCode: "CUP", amount: 1500, exchangeRate: 1, method: "cash" }],
          items: [
            {
              id: "line-1",
              product: { id: "p1", name: "Cemento gris", price: 150 },
              quantity: 10,
              price: 150,
              total: 1500,
            },
          ],
          status: "completed",
        },
        {
          id: "t2",
          companyId: "co-2",
          branchId: "b2",
          userId: "u2",
          date: "2026-02-02T10:00:00.000Z",
          total: 250.5,
          payments: [],
          items: [],
          status: "completed",
          version: 3,
          deletedAt: "2026-02-03T10:00:00.000Z",
        },
      ],
      cashSessions: [
        {
          id: "s1",
          branchId: "b1",
          openedAt: "2026-02-01T08:00:00.000Z",
          openingBalance: 0,
          status: "open",
          userId: "u1",
          turnNumber: 7,
          movements: [{ id: "m1", type: "income", amount: 100, currencyCode: "CUP", description: "Fondo", date: "2026-02-01T08:05:00.000Z" }],
        },
      ],
      categories: [
        { id: "cat1", name: "Materiales", department: "Ferretería" },
        { id: "cat2", name: "Ropa", department: "Textil" },
      ],
      users: [{ id: "u1", name: "Ana", email: "ana@x.cu", role: "admin", baseSalary: 0 }],
      cart: [{ id: "c1", product: { id: "p1" }, quantity: 1, price: 150, total: 150 }],
      notifications: [{ id: "n1", message: "ok", type: "success" }],
    },
    version: 0,
  };
}

test("mapea las colecciones de negocio a sus tablas normalizadas", () => {
  const { batches, report } = importLegacyState(legacyState(), META);

  assert.deepEqual(Object.keys(batches).sort(), [
    "cash_sessions",
    "products",
    "sale_items",
    "sale_payments",
    "sales",
    "warehouses",
  ]);
  assert.equal(batches.warehouses?.length, 2);
  assert.equal(batches.products?.length, 2);
  assert.equal(batches.sales?.length, 2);
  assert.equal(batches.sale_items?.length, 1);
  assert.equal(batches.sale_payments?.length, 1);
  assert.equal(batches.cash_sessions?.length, 1);
  assert.deepEqual(report.tables, {
    warehouses: 2,
    products: 2,
    sales: 2,
    sale_items: 1,
    sale_payments: 1,
    cash_sessions: 1,
  });
  assert.equal(report.totals.products, 2);
  assert.equal(report.totals.sales, 2);
  assert.equal(report.totals.salesTotal, 1750.5);
  assert.equal(report.totals.cashSessions, 1);
});

test("normaliza columnas comunes y convierte claves a snake_case sin tocar anidados", () => {
  const { batches } = importLegacyState(legacyState(), META);
  const product = batches.products!.find((row) => row.id === "p1") as LocalRow;

  assert.equal(product.company_id, "co-1");
  assert.equal(product.version, 4);
  assert.equal(product.updated_at, "2026-02-10T08:00:00.000Z");
  assert.equal(product.origin_device, "device-aaa");
  assert.equal(product.deleted_at, null);
  // El último registro del id duplicado es el que sobrevive.
  assert.equal(product.name, "Cemento gris (corregido)");
  assert.equal(product.cost_price, 110);
  assert.equal(product.category_id, "cat1");
  assert.equal(product.commission_value, 0);
  assert.equal(product.updatedAt, undefined);
  assert.equal(product.companyId, undefined);

  const secondProduct = batches.products!.find((row) => row.id === "p2") as LocalRow;
  assert.equal(secondProduct.updated_at, META.now);
  assert.equal(secondProduct.version, 1);

  // El objeto anidado se conserva como valor JSON, con sus claves originales.
  assert.deepEqual(product.kit_components, [{ productId: "p9", quantity: 2 }]);

  const sale = batches.sales!.find((row) => row.id === "t1") as LocalRow;
  assert.equal(sale.company_id, "co-1");
  assert.equal(sale.version, 1);
  assert.equal(sale.updated_at, META.now);
  assert.equal(sale.deleted_at, null);
  assert.equal(sale.branch_id, "b1");
  assert.deepEqual(sale.items, legacyState().state.transactions[0].items);
  assert.deepEqual(sale.payments, legacyState().state.transactions[0].payments);
});

test("genera líneas de venta y pagos con ids estables y columnas heredadas del padre", () => {
  const { batches } = importLegacyState(legacyState(), META);

  const items = batches.sale_items!;
  assert.deepEqual(items.map((row) => row.id), ["t1:item:line-1"]);
  const item = items[0];
  assert.equal(item.sale_id, "t1");
  assert.equal(item.company_id, "co-1");
  assert.equal(item.version, 1);
  assert.equal(item.updated_at, META.now);
  assert.equal(item.origin_device, "device-aaa");
  assert.equal(item.deleted_at, null);
  // El alcance de la línea es el de la venta.
  assert.equal(item.warehouse_id, "b1");
  assert.equal(item.product_id, "p1");
  assert.equal(item.product_name, "Cemento gris");
  assert.equal(item.quantity, 10);
  assert.equal(item.price, 150);
  assert.equal(item.total, 1500);
  // El snapshot completo del producto se queda en la fila padre.
  assert.equal(item.product, undefined);

  const payments = batches.sale_payments!;
  assert.deepEqual(payments.map((row) => row.id), ["t1:pay:0"]);
  const payment = payments[0];
  assert.equal(payment.sale_id, "t1");
  assert.equal(payment.company_id, "co-1");
  assert.equal(payment.warehouse_id, "b1");
  assert.equal(payment.currency_code, "CUP");
  assert.equal(payment.amount, 1500);
  assert.equal(payment.exchange_rate, 1);
  assert.equal(payment.method, "cash");
  // Una venta sin líneas ni pagos no inventa hijos.
  assert.equal(batches.sale_items!.some((row) => row.id.startsWith("t2:")), false);
});

test("las líneas sin id usan el índice y heredan deleted_at, versión y empresa", () => {
  const { batches } = importLegacyState(
    {
      state: {
        transactions: [
          {
            id: "t-del",
            companyId: "co-9",
            version: 5,
            branchId: "b1",
            deletedAt: "2026-02-03T10:00:00.000Z",
            items: [
              { productId: "p2", quantity: 1, price: 60, total: 60 },
              { id: "line-2", productId: "p2", quantity: 2, price: 60, total: 120 },
            ],
            payments: [{ currencyCode: "USD", amount: 2, exchangeRate: 250, method: "transfer" }],
          },
        ],
      },
    },
    META
  );

  assert.deepEqual(batches.sale_items!.map((row) => row.id), ["t-del:item:0", "t-del:item:line-2"]);
  for (const row of batches.sale_items!) {
    assert.equal(row.sale_id, "t-del");
    assert.equal(row.company_id, "co-9");
    assert.equal(row.version, 5);
    assert.equal(row.updated_at, META.now);
    assert.equal(row.origin_device, "device-aaa");
    assert.equal(row.deleted_at, "2026-02-03T10:00:00.000Z");
    assert.equal(row.warehouse_id, "b1");
    assert.equal(row.product_id, "p2");
  }
  assert.equal(batches.sale_payments![0].id, "t-del:pay:0");
  assert.equal(batches.sale_payments![0].deleted_at, "2026-02-03T10:00:00.000Z");
  assert.equal(batches.sale_payments![0].currency_code, "USD");
});

test("normaliza líneas de compras, cotizaciones, devoluciones y traslados", () => {
  const { batches } = importLegacyState(
    {
      state: {
        supplierOrders: [
          {
            id: "po-1",
            supplierId: "sup-1",
            branchId: "b1",
            items: [
              { productId: "p1", productName: "Cemento gris", quantity: 5, cost: 100 },
              { productId: "p2", productName: "Arena fina", quantity: 2, cost: 40 },
            ],
          },
        ],
        quotes: [
          {
            id: "q-1",
            branchId: "b1",
            items: [
              { id: "ql-1", product: { id: "p1", name: "Cemento gris" }, quantity: 3, price: 150, total: 450 },
            ],
          },
        ],
        returns: [
          { id: "r-1", transactionId: "t1", productId: "p1", quantity: 1, reason: "defective", branchId: "b1" },
        ],
        transfers: [
          {
            id: "tr-1",
            productId: "p1",
            productName: "Cemento gris",
            quantity: 4,
            fromBranchId: "b1",
            toBranchId: "b2",
          },
          {
            id: "tr-2",
            productId: "p2",
            productName: "Arena fina",
            variants: [
              { variantLabel: "M", quantity: 1 },
              { variantLabel: "L", quantity: 2 },
            ],
          },
        ],
      },
    },
    META
  );

  assert.deepEqual(batches.purchase_items!.map((row) => row.id), ["po-1:item:0", "po-1:item:1"]);
  const purchaseItem = batches.purchase_items![0];
  assert.equal(purchaseItem.purchase_id, "po-1");
  assert.equal(purchaseItem.product_id, "p1");
  assert.equal(purchaseItem.product_name, "Cemento gris");
  assert.equal(purchaseItem.cost, 100);
  assert.equal(purchaseItem.warehouse_id, "b1");

  assert.deepEqual(batches.quote_items!.map((row) => row.id), ["q-1:item:ql-1"]);
  assert.equal(batches.quote_items![0].quote_id, "q-1");
  assert.equal(batches.quote_items![0].product_id, "p1");
  assert.equal(batches.quote_items![0].total, 450);

  assert.deepEqual(batches.return_items!.map((row) => row.id), ["r-1:item:0"]);
  const returnItem = batches.return_items![0];
  assert.equal(returnItem.return_id, "r-1");
  assert.equal(returnItem.product_id, "p1");
  assert.equal(returnItem.quantity, 1);
  assert.equal(returnItem.reason, "defective");
  assert.equal(returnItem.transaction_id, "t1");

  // Traslado simple: una línea desde la propia fila. Traslado agrupado: una
  // línea por variante, heredando el producto del padre.
  assert.deepEqual(batches.transfer_items!.map((row) => row.id), [
    "tr-1:item:0",
    "tr-2:item:0",
    "tr-2:item:1",
  ]);
  const flatTransfer = batches.transfer_items![0];
  assert.equal(flatTransfer.transfer_id, "tr-1");
  assert.equal(flatTransfer.product_id, "p1");
  assert.equal(flatTransfer.quantity, 4);
  assert.equal(flatTransfer.variants, undefined);
  assert.equal(batches.transfer_items![1].transfer_id, "tr-2");
  assert.equal(batches.transfer_items![1].product_id, "p2");
  assert.equal(batches.transfer_items![1].variant_label, "M");
  assert.equal(batches.transfer_items![2].quantity, 2);
});

test("reimportar el mismo estado produce exactamente las mismas filas hijas", () => {
  const first = importLegacyState(legacyState(), META);
  const second = importLegacyState(legacyState(), META);

  assert.deepEqual(first.batches, second.batches);
  assert.deepEqual(
    [...first.batches.sale_items!, ...first.batches.sale_payments!].map((row) => row.id),
    [...second.batches.sale_items!, ...second.batches.sale_payments!].map((row) => row.id)
  );
});

test("las filas hijas cumplen assertLocalRow", () => {
  const { batches } = importLegacyState(legacyState(), META);
  const childTables: LocalTable[] = ["sale_items", "sale_payments"];
  for (const table of childTables) {
    for (const row of batches[table] ?? []) assertLocalRow(table, row);
  }
});

test("respeta company_id, version, deleted_at y fechas ya presentes en la fila", () => {
  const { batches } = importLegacyState(legacyState(), META);
  const sale = batches.sales!.find((row) => row.id === "t2") as LocalRow;

  assert.equal(sale.company_id, "co-2");
  assert.equal(sale.version, 3);
  assert.equal(sale.updated_at, META.now);
  assert.equal(sale.deleted_at, "2026-02-03T10:00:00.000Z");
  assert.equal((sale.total as number), 250.5);
});

test("descarta filas sin id e informa duplicados con tabla e id", () => {
  const { batches, report } = importLegacyState(legacyState(), META);

  assert.equal(batches.products!.some((row) => row.sku === "X-1"), false);
  assert.ok(report.warnings.some((warning) => warning === "products: 1 filas sin id"));
  assert.ok(report.warnings.some((warning) => warning.includes('products: id duplicado "p1"')));
  assert.equal(report.warnings.some((warning) => warning.startsWith("sales: id duplicado")), false);
});

test("lista colecciones sin tabla en unmappedKeys y omite UI/sesión efímera", () => {
  const { report } = importLegacyState(legacyState(), META);

  assert.ok(report.unmappedKeys.includes("categories: 2"));
  assert.ok(report.unmappedKeys.includes("users: 1"));
  assert.equal(report.unmappedKeys.some((entry) => entry.startsWith("cart")), false);
  assert.equal(report.unmappedKeys.some((entry) => entry.startsWith("notifications")), false);
  assert.equal(report.unmappedKeys.some((entry) => entry.startsWith("products")), false);
});

test("acepta el estado sin envoltorio { state } y no muta la entrada", () => {
  const legacy = legacyState();
  const snapshot = JSON.stringify(legacy);
  const rawState = legacy.state as unknown;

  const unwrapped = importLegacyState(rawState, META);
  assert.equal(unwrapped.batches.products?.length, 2);
  assert.equal(JSON.stringify(legacy), snapshot);

  const wrapped = importLegacyState(legacy, META);
  assert.equal(wrapped.report.totals.salesTotal, 1750.5);
});

test("un valor corrupto no rompe la importación: se informa y se omite", () => {
  const { batches, report } = importLegacyState(
    { state: { transactions: { id: "t1" }, products: [{ id: "p1", price: 1 }] } },
    META
  );

  assert.equal(batches.sales, undefined);
  assert.ok(report.warnings.includes('sales: el valor legado "transactions" no es un arreglo (omitido)'));
  assert.equal(report.totals.salesTotal, 0);
});

test("applyLegacyImport escribe todas las tablas en una sola transacción", async () => {
  const driver = new FakeDriver();
  const result = importLegacyState(legacyState(), META);

  await applyLegacyImport(driver, result);

  assert.equal(driver.transactionCount, 1);
  assert.equal(driver.directPuts, 0);
  assert.deepEqual(
    driver.writes.map((write) => write.table),
    ["warehouses", "products", "sales", "sale_items", "sale_payments", "cash_sessions"]
  );
  assert.deepEqual(driver.writes.map((write) => write.ids.length), [2, 2, 2, 1, 1, 1]);
  assert.deepEqual(
    driver.writes.find((write) => write.table === "products")!.ids,
    ["p1", "p2"]
  );
  // Las líneas se escriben después de su venta y con ids derivados.
  assert.deepEqual(
    driver.writes.find((write) => write.table === "sale_items")!.ids,
    ["t1:item:line-1"]
  );
  // Los lotes entregados al driver son los mismos que reporta el importador.
  assert.deepEqual(driver.writes.map((write) => write.ids.length), [
    result.batches.warehouses!.length,
    result.batches.products!.length,
    result.batches.sales!.length,
    result.batches.sale_items!.length,
    result.batches.sale_payments!.length,
    result.batches.cash_sessions!.length,
  ]);
});

test("inventario sin id obtiene id derivado y warehouse_id desde branchId", () => {
  const { batches, report } = importLegacyState(
    {
      state: {
        inventory: [
          { productId: "p1", branchId: "b1", quantity: 5, minQuantity: 1 },
          { productId: "p1", branchId: "b1", variantLabel: "M", quantity: 2, minQuantity: 0 },
          { quantity: 1 },
        ],
        transactions: [{ id: "t9", branchId: "b1", total: 10, items: [], payments: [] }],
      },
    },
    META
  );

  const stock = batches.stock_balances!;
  assert.deepEqual(stock.map((row) => row.id), ["stock:p1:b1:base", "stock:p1:b1:M"]);
  assert.equal(stock[0].warehouse_id, "b1");
  assert.equal(stock[0].branch_id, "b1");
  assert.equal(stock[0].quantity, 5);
  assert.ok(report.warnings.includes("stock_balances: 2 filas sin id con id derivado"));
  assert.ok(report.warnings.includes("stock_balances: 1 filas sin id"));
  assert.equal(batches.sales![0].warehouse_id, "b1");
});

test("applyLegacyImport valida las filas antes de escribir", async () => {
  const driver = new FakeDriver();
  const result = importLegacyState({ state: { products: [{ id: "p1" }] } }, META);
  delete (result.batches.products![0] as Partial<LocalRow>).company_id;

  await assert.rejects(() => applyLegacyImport(driver, result), /sin company_id/);
  assert.equal(driver.transactionCount, 1);
  assert.equal(driver.writes.length, 0);
});
