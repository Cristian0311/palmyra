import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

/**
 * Traslados: estados reales del enum cloud, camino sano de historial,
 * autocuración del arranque e hidratación desde el almacén local.
 *
 * Regresiones que cubre:
 *  - posted → in_transit (el mapeo legado lo convertía en 'completed').
 *  - received → completed, cancelled → cancelled, pending → pending.
 *  - El pull corregido NUNCA usa filtros de enum (.or) sobre transfers.
 *  - La sección de traslados caída del arranque se rellena por el camino
 *    sano sin borrar filas locales que la nube no conoce.
 *  - El almacén local proyecta traslados a la store (antes no existía).
 */

(globalThis as any).__VITE_ENV__ = {};
const LOADER = [
  'export async function load(url, context, nextLoad) {',
  '  const r = await nextLoad(url, context);',
  '  if (url.includes("/src/") && r && r.source) {',
  '    const text = r.source.toString();',
  '    if (text.includes("import.meta.env")) {',
  '      return { ...r, source: text.replaceAll("import.meta.env", "(import.meta.env ?? globalThis.__VITE_ENV__)") };',
  '    }',
  '  }',
  '  return r;',
  '}'
].join('\n');
register('data:text/javascript;charset=utf-8,' + encodeURIComponent(LOADER));

const repositoriesModule = await import(
  pathToFileURL(resolve(process.cwd(), 'src/services/localDb/repositories.ts')).href
);
const transferHistoryModule = await import(
  pathToFileURL(resolve(process.cwd(), 'src/services/cloudSync/transferHistory.ts')).href
);
const hydrationModule = await import(
  pathToFileURL(resolve(process.cwd(), 'src/services/localDb/bootHydration.ts')).href
);
const bridgeModule = await import(
  pathToFileURL(resolve(process.cwd(), 'src/services/localDb/storeBridge.ts')).href
);
const importModule = await import(
  pathToFileURL(resolve(process.cwd(), 'src/services/localDb/importLegacy.ts')).href
);
const actionsModule = await import(
  pathToFileURL(resolve(process.cwd(), 'src/store/actions/syncActions.ts')).href
);

const { normalizeTransferStatus, transferFromRow } = repositoriesModule;
const { pullTransferHistoryCorrected } = transferHistoryModule;
const { hydrateFromLocalDb } = hydrationModule;
const { applyLocalSnapshotToStore, resetStoreBridgeForTests } = bridgeModule;
const { importLegacyState, applyLegacyImport } = importModule;
const { createSyncActions } = actionsModule;

const memoryDriverModule = await import(
  pathToFileURL(resolve(process.cwd(), 'src/services/localDb/memoryDriver.ts')).href
);
const { createMemoryDriver } = memoryDriverModule;

const COMPANY = "11111111-1111-4111-8111-111111111111";
const AT = "2026-11-23T12:00:00.000Z";

// ---------------------------------------------------------------------------
// 1) normalización de estados
// ---------------------------------------------------------------------------

test("normalizeTransferStatus: mapea el enum real sin destruir posted", () => {
  assert.equal(normalizeTransferStatus("posted"), "in_transit");
  assert.equal(normalizeTransferStatus("in_transit"), "in_transit");
  assert.equal(normalizeTransferStatus("received"), "completed");
  assert.equal(normalizeTransferStatus("completed"), "completed");
  assert.equal(normalizeTransferStatus("cancelled"), "cancelled");
  assert.equal(normalizeTransferStatus("pending"), "pending");
  // Desconocido/ausente: ni cancelado ni recibido → sigue en curso.
  assert.equal(normalizeTransferStatus(undefined), "in_transit");
  assert.equal(normalizeTransferStatus("draft"), "in_transit");
});

// ---------------------------------------------------------------------------
// 2) fila → entidad (columnas legadas y columnas reales de la nube)
// ---------------------------------------------------------------------------

test("transferFromRow: columnas legadas (from_branch_id) con estado posted", () => {
  const entity = transferFromRow({
    id: "tr-line-1",
    company_id: COMPANY,
    version: 2,
    updated_at: AT,
    operation_id: "tr-1",
    product_id: "p-1",
    product_name: "Arroz",
    from_branch_id: "wh-1",
    from_branch_name: "Centro",
    to_branch_id: "wh-2",
    to_branch_name: "Vedado",
    variant_label: "Grande",
    quantity: 5,
    date: "2026-11-20T10:00:00.000Z",
    user_id: "u-1",
    batch_id: "b-1",
    status: "posted"
  } as never);

  assert.equal(entity.id, "tr-line-1");
  assert.equal(entity.operationId, "tr-1");
  assert.equal(entity.productId, "p-1");
  assert.equal(entity.fromBranchId, "wh-1");
  assert.equal(entity.toBranchId, "wh-2");
  assert.equal(entity.quantity, 5);
  assert.equal(entity.status, "in_transit");
});

test("transferFromRow: columnas reales de la nube (origin/destination_warehouse_id)", () => {
  const entity = transferFromRow({
    id: "tr-cloud-1",
    company_id: COMPANY,
    origin_warehouse_id: "wh-1",
    destination_warehouse_id: "wh-2",
    product_id: "p-1",
    quantity: 3,
    created_at: "2026-11-21T09:00:00.000Z",
    created_by: "u-9",
    batch_id: "b-2",
    status: "received"
  } as never);

  assert.equal(entity.fromBranchId, "wh-1");
  assert.equal(entity.toBranchId, "wh-2");
  assert.equal(entity.fromWarehouseId, "wh-1");
  assert.equal(entity.toWarehouseId, "wh-2");
  assert.equal(entity.date, "2026-11-21T09:00:00.000Z");
  assert.equal(entity.userId, "u-9");
  assert.equal(entity.status, "completed");
});

// ---------------------------------------------------------------------------
// 3) camino sano del historial (sin filtros de enum)
// ---------------------------------------------------------------------------

function makeSupabase(db: Record<string, any[]>, failTables: Set<string> = new Set()) {
  const orCalls: string[] = [];
  const requests: string[] = [];
  function from(table: string) {
    requests.push(table);
    const state = {
      filters: [] as Array<(row: any) => boolean>,
      range: null as [number, number] | null,
      limit: null as number | null,
      order: null as [string, boolean] | null
    };
    const builder: any = {
      select() { return builder; },
      eq(col: string, val: any) { state.filters.push(r => String(r?.[col] ?? '') === String(val)); return builder; },
      in(col: string, values: any[]) { const set = new Set((values || []).map(String)); state.filters.push(r => set.has(String(r?.[col] ?? ''))); return builder; },
      or(_filter: string) { orCalls.push(_filter); return builder; },
      order(col: string, opts?: { ascending?: boolean }) { state.order = [col, opts?.ascending !== false]; return builder; },
      range(a: number, b: number) { state.range = [Number(a), Number(b)]; return builder; },
      limit(n: number) { state.limit = Number(n); return builder; },
      then(onFulfilled?: any, onRejected?: any) {
        if (failTables.has(table)) {
          return Promise.resolve({ data: null, error: { message: `fallo simulado en ${table}` } }).then(onFulfilled, onRejected);
        }
        let rows = (db[table] || []).slice();
        for (const filter of state.filters) rows = rows.filter(filter);
        if (state.order) {
          const [col, ascending] = state.order;
          rows.sort((a, b) => {
            const left = String(a?.[col] ?? '');
            const right = String(b?.[col] ?? '');
            if (left === right) return 0;
            return (left < right ? -1 : 1) * (ascending ? 1 : -1);
          });
        }
        if (state.range) rows = rows.slice(state.range[0], state.range[1] + 1);
        else if (state.limit != null) rows = rows.slice(0, state.limit);
        return Promise.resolve({ data: rows, error: null }).then(onFulfilled, onRejected);
      }
    };
    return builder;
  }
  return { client: { from }, orCalls, requests };
}

function transferDb() {
  return {
    transfers: [
      { id: "tr-1", company_id: COMPANY, origin_warehouse_id: "wh-1", destination_warehouse_id: "wh-2", status: "posted", created_at: "2026-11-20T10:00:00.000Z", created_by: "u-1", batch_id: "b-1" },
      { id: "tr-2", company_id: COMPANY, origin_warehouse_id: "wh-3", destination_warehouse_id: "wh-3", status: "received", created_at: "2026-11-19T10:00:00.000Z", created_by: "u-2" },
      { id: "tr-3", company_id: COMPANY, origin_warehouse_id: "wh-2", destination_warehouse_id: "wh-1", status: "cancelled", created_at: "2026-11-18T10:00:00.000Z", created_by: "u-3" }
    ],
    transfer_items: [
      { id: "ti-1", transfer_id: "tr-1", product_id: "p-1", quantity: 5, variant_id: "v-1" },
      { id: "ti-2", transfer_id: "tr-2", product_id: "p-2", quantity: 2, variant_id: null },
      { id: "ti-3", transfer_id: "tr-3", product_id: "p-3", quantity: 1, variant_id: null }
    ],
    products: [
      { id: "p-1", company_id: COMPANY, name: "Arroz" },
      { id: "p-2", company_id: COMPANY, name: "Frijol" },
      { id: "p-3", company_id: COMPANY, name: "Azúcar" }
    ],
    warehouses: [
      { id: "wh-1", company_id: COMPANY, name: "Centro" },
      { id: "wh-2", company_id: COMPANY, name: "Vedado" },
      { id: "wh-3", company_id: COMPANY, name: "Miramar" }
    ],
    product_variants: [{ id: "v-1", company_id: COMPANY, name: "Grande" }]
  } as Record<string, any[]>;
}

test("pullTransferHistoryCorrected: estados reales y sin filtros de enum", async () => {
  const fake = makeSupabase(transferDb());
  const result = await pullTransferHistoryCorrected({ client: fake.client, tenant: { companyId: COMPANY } });
  assert.equal(result.success, true);
  assert.equal(fake.orCalls.length, 0, "nunca usa .or(): era el filtro de enum que lanzaba 22P02");

  const rows = result.transfers;
  assert.equal(rows.length, 3);
  const posted = rows.find(r => r.operationId === "tr-1")!;
  assert.equal(posted.status, "in_transit", "posted debe quedar en tránsito, no 'completed'");
  assert.equal(posted.productName, "Arroz");
  assert.equal(posted.variantLabel, "Grande");
  assert.equal(posted.fromBranchId, "wh-1");
  assert.equal(posted.toBranchName, "Vedado");
  assert.equal(posted.batchId, "b-1");

  const received = rows.find(r => r.operationId === "tr-2")!;
  assert.equal(received.status, "completed");
  const cancelled = rows.find(r => r.operationId === "tr-3")!;
  assert.equal(cancelled.status, "cancelled");
});

test("pullTransferHistoryCorrected: reutiliza refs y filtra por sucursal", async () => {
  const fake = makeSupabase(transferDb());
  const result = await pullTransferHistoryCorrected({
    client: fake.client,
    tenant: { companyId: COMPANY },
    branchId: "wh-2",
    refs: {
      productNames: new Map([["p-1", "Arroz Ref"]]),
      warehouseNames: new Map([["wh-2", "Vedado Ref"]])
    }
  });
  assert.equal(result.success, true);
  // Con refs no se consultan productos/almacenes/variantes; solo traslados y líneas.
  assert.deepEqual(fake.requests.filter(t => t === "products"), []);
  assert.deepEqual(fake.requests.filter(t => t === "warehouses"), []);
  // El filtro por sucursal deja tr-1 y tr-3 (wh-2 participa), fuera tr-2.
  const ids = result.transfers.map(r => r.operationId).sort();
  assert.deepEqual(ids, ["tr-1", "tr-3"]);
  assert.equal(result.transfers.find(r => r.operationId === "tr-1")!.productName, "Arroz Ref");
});

test("pullTransferHistoryCorrected: error de página → success false, sin filas a medias", async () => {
  const db = transferDb();
  const fake = makeSupabase(db, new Set(["transfer_items"]));
  const result = await pullTransferHistoryCorrected({ client: fake.client, tenant: { companyId: COMPANY } });
  assert.equal(result.success, false);
  assert.deepEqual(result.transfers, []);
});

// ---------------------------------------------------------------------------
// 4) autocuración del arranque: sección caída o historial vacío
// ---------------------------------------------------------------------------

function buildBootstrapDb(companyId: string, transfers: any[], transferItems: any[]) {
  return {
    warehouses: [{ id: 'wh-1', company_id: companyId, name: 'Centro', active: true, created_at: '2026-11-01T00:00:00.000Z' }],
    categories: [],
    products: [{ id: 'prod-1', company_id: companyId, name: 'Producto 1', price: 10, cost: 5, category_id: null, status: 'active', minimum_stock: 1 }],
    employees: [],
    employee_warehouse_access: [],
    companies: [{ id: companyId, name: 'Demo', default_currency_code: 'USD' }],
    product_variants: [],
    product_barcodes: [],
    product_kit_components: [],
    currencies: [],
    exchange_rates: [],
    product_prices: [],
    compensation_settings: [],
    company_settings: [{ company_id: companyId, settings: {} }],
    customers: [],
    stock_balances: [],
    variant_stock_balances: [],
    cash_registers: [],
    sales: [],
    sale_items: [],
    payments: [],
    cash_sessions: [],
    cash_movements: [],
    transfers,
    transfer_items: transferItems,
    bank_accounts: [],
    bank_transactions: [],
    sales_returns: [],
    sales_return_items: [],
    warranties: [],
    quotes: [],
    quote_items: [],
    employee_time_shifts: [],
    payroll_runs: [],
    payroll_items: [],
    inventory_audits: [],
    inventory_audit_items: [],
    suppliers: [],
    purchase_orders: [],
    purchase_items: []
  } as Record<string, any[]>;
}

function bootstrapSupabase(companyId: string, options: { failTables?: Set<string> } = {}) {
  const db = buildBootstrapDb(companyId, [], []);
  const failTables = options.failTables || new Set<string>();
  const requests: string[] = [];
  function from(table: string) {
    requests.push(table);
    const state = {
      filters: [] as Array<(row: any) => boolean>,
      limit: null as number | null,
      range: null as [number, number] | null,
      order: null as [string, boolean] | null,
      single: null as 'single' | 'maybe' | null
    };
    const builder: any = {
      select() { return builder; },
      eq(col: string, val: any) { state.filters.push(r => String(r?.[col] ?? '') === String(val)); return builder; },
      neq(col: string, val: any) { state.filters.push(r => String(r?.[col] ?? '') !== String(val)); return builder; },
      in(col: string, values: any[]) { const set = new Set((values || []).map(String)); state.filters.push(r => set.has(String(r?.[col] ?? ''))); return builder; },
      is(col: string, val: any) { state.filters.push(r => (r?.[col] ?? null) === val); return builder; },
      gte(col: string, val: string) { state.filters.push(r => String(r?.[col] ?? '') >= String(val)); return builder; },
      lt(col: string, val: string) { state.filters.push(r => String(r?.[col] ?? '') < String(val)); return builder; },
      or() { return builder; },
      order(col: string, opts?: { ascending?: boolean }) { state.order = [col, opts?.ascending !== false]; return builder; },
      limit(n: number) { state.limit = Number(n); return builder; },
      range(a: number, b: number) { state.range = [Number(a), Number(b)]; return builder; },
      single() { state.single = 'single'; return builder; },
      maybeSingle() { state.single = 'maybe'; return builder; },
      then(onFulfilled?: any, onRejected?: any) {
        if (failTables.has(table)) {
          return Promise.resolve({ data: null, error: new Error(`fallo simulado en ${table}`) }).then(onFulfilled, onRejected);
        }
        let rows = (db[table] || []).slice();
        for (const filter of state.filters) rows = rows.filter(filter);
        if (state.order) {
          const [col, ascending] = state.order;
          rows.sort((a, b) => {
            const left = String(a?.[col] ?? '');
            const right = String(b?.[col] ?? '');
            if (left === right) return 0;
            return (left < right ? -1 : 1) * (ascending ? 1 : -1);
          });
        }
        if (state.range) rows = rows.slice(state.range[0], state.range[1] + 1);
        else if (state.limit != null) rows = rows.slice(0, state.limit);
        const data = state.single ? (rows[0] ?? null) : rows;
        return Promise.resolve({ data, error: null }).then(onFulfilled, onRejected);
      }
    };
    return builder;
  }
  return { client: { from }, requests };
}

function emptyState(overrides: Record<string, any> = {}) {
  return {
    transactions: [], cashSessions: [], transfers: [], branches: [], users: [], products: [],
    categories: [], customers: [], currencies: [], inventory: [], bankCards: [], bankTransactions: [],
    suppliers: [], supplierOrders: [], returns: [], warranties: [], quotes: [], timeShifts: [],
    salarySettlements: [], inventoryAudits: [], storeConfig: { storeName: 'Local' }, receiptConfig: {},
    lastTurnNumber: 0, currentBranchId: '', syncResult: null, lastSyncTime: null,
    ...overrides
  };
}

function createHarness(initial: any) {
  let state = initial;
  const set = (partial: any) => {
    const patch = typeof partial === 'function' ? partial(state) : partial;
    state = { ...state, ...patch };
  };
  const get = () => state;
  return { actions: createSyncActions(set as any, get as any), getState: () => state };
}

test("arranque: sección de traslados caída → la autocuración rellena el historial y conserva lo local", async () => {
  const company = 'co-heal-failed';
  const fake = bootstrapSupabase(company, { failTables: new Set(['transfers']) });
  const localPending = {
    id: 'local-pending', operationId: 'op-pending', productId: 'prod-1', productName: 'Producto 1',
    fromBranchId: 'wh-1', fromBranchName: 'Centro', toBranchId: 'wh-2', toBranchName: 'Vedado',
    quantity: 2, date: '2026-11-20T10:00:00.000Z', userId: 'u-1', status: 'pending'
  };
  const harness = createHarness(emptyState({
    products: [{ id: 'prod-1', name: 'Producto 1' }],
    transfers: [localPending]
  }));
  const healedRows = [
    {
      id: 'ti-9', operationId: 'tr-9', productId: 'prod-1', productName: 'Producto 1',
      fromBranchId: 'wh-1', fromBranchName: 'Centro', toBranchId: 'wh-2', toBranchName: 'Vedado',
      quantity: 7, date: '2026-11-20T10:00:00.000Z', userId: 'u-1', status: 'in_transit'
    }
  ];
  let healCalls = 0;
  const ok = await harness.actions.bootstrapCloudData({
    force: true,
    supabase: fake.client,
    tenant: { companyId: company },
    now: '2026-11-17T12:00:00.000Z',
    transferHistoryPull: async (companyId: string) => { healCalls += 1; assert.equal(companyId, company); return { success: true, transfers: healedRows }; }
  });
  assert.equal(ok, true);
  assert.equal(healCalls, 1, 'la sección caída dispara la autocuración');
  const state = harness.getState();
  const ids = state.transfers.map((t: any) => t.operationId || t.id).sort();
  assert.deepEqual(ids, ['op-pending', 'tr-9'], 'remoto canónico + local que la nube no conoce');
  assert.equal(state.transfers.find((t: any) => t.operationId === 'tr-9').status, 'in_transit');
});

test("arranque: historial local vacío con sección ok → la autocuración trae la nube", async () => {
  const company = 'co-heal-empty';
  const fake = bootstrapSupabase(company);
  const harness = createHarness(emptyState());
  let healCalls = 0;
  const ok = await harness.actions.bootstrapCloudData({
    force: true,
    supabase: fake.client,
    tenant: { companyId: company },
    now: '2026-11-17T12:00:00.000Z',
    transferHistoryPull: async () => { healCalls += 1; return { success: true, transfers: [{ id: 'ti-1', operationId: 'tr-1', productId: 'prod-1', productName: 'Producto 1', fromBranchId: 'wh-1', fromBranchName: 'Centro', toBranchId: 'wh-2', toBranchName: 'Vedado', quantity: 1, date: '2026-11-20T10:00:00.000Z', userId: 'u-1', status: 'completed' }] }; }
  });
  assert.equal(ok, true);
  assert.equal(healCalls, 1);
  assert.equal(harness.getState().transfers.length, 1);
});

test("arranque: historial presente y sección ok → sin autocuración (no gasta red)", async () => {
  const company = 'co-heal-skip';
  const fake = bootstrapSupabase(company);
  const harness = createHarness(emptyState({
    transfers: [{ id: 'ti-1', operationId: 'tr-1', productId: 'prod-1', productName: 'Producto 1', fromBranchId: 'wh-1', fromBranchName: 'Centro', toBranchId: 'wh-2', toBranchName: 'Vedado', quantity: 1, date: '2026-11-20T10:00:00.000Z', userId: 'u-1', status: 'completed' }]
  }));
  let healCalls = 0;
  await harness.actions.bootstrapCloudData({
    force: true,
    supabase: fake.client,
    tenant: { companyId: company },
    now: '2026-11-17T12:00:00.000Z',
    transferHistoryPull: async () => { healCalls += 1; return { success: true, transfers: [] }; }
  });
  assert.equal(healCalls, 0);
});

// ---------------------------------------------------------------------------
// 5) hidratación del almacén local → store (transfers)
// ---------------------------------------------------------------------------

test("hidratación: traslados legados se proyectan con variantes y estados", async () => {
  const legacy = {
    state: {
      storeConfig: { storeName: "Bodega", address: "", phone: "" },
      branches: [
        { id: "wh-1", name: "Centro", isMain: true },
        { id: "wh-2", name: "Vedado" }
      ],
      products: [{ id: "p-1", name: "Arroz", sku: "A-1", price: 120, costPrice: 90, margin: 30, categoryId: "c-1", color: "bg-white", commissionValue: 0 }],
      inventory: [{ productId: "p-1", warehouseId: "wh-1", quantity: 10, minQuantity: 2 }],
      transfers: [
        {
          id: "ti-1", operationId: "tr-1", productId: "p-1", productName: "Arroz",
          fromBranchId: "wh-1", fromBranchName: "Centro", toBranchId: "wh-2", toBranchName: "Vedado",
          variantLabel: "Grande, Pequeño", quantity: 7, date: "2026-11-20T10:00:00.000Z", userId: "u-1",
          batchId: "b-1", status: "in_transit",
          variants: [
            { variantLabel: "Grande", quantity: 5 },
            { variantLabel: "Pequeño", quantity: 2 }
          ]
        },
        {
          id: "ti-2", operationId: "tr-2", productId: "p-1", productName: "Arroz",
          fromBranchId: "wh-1", fromBranchName: "Centro", toBranchId: "wh-2", toBranchName: "Vedado",
          variantLabel: "Producto Base", quantity: 3, date: "2026-11-21T10:00:00.000Z", userId: "u-1",
          status: "completed", variants: []
        }
      ]
    },
    version: 2
  };

  const driver = createMemoryDriver({ now: () => AT });
  await driver.ready();
  const imported = importLegacyState(legacy, { companyId: COMPANY, originDevice: "device-a", now: AT });
  await applyLegacyImport(driver, imported);

  const snapshot = await hydrateFromLocalDb(COMPANY, { driver });
  assert.ok(snapshot, "el snapshot existe");
  const transfers = snapshot!.transfers;
  assert.equal(transfers.length, 2);

  const grouped = transfers.find(t => t.operationId === "tr-1")!;
  assert.equal(grouped.status, "in_transit");
  assert.equal(grouped.quantity, 7);
  assert.deepEqual(grouped.variants, [
    { variantLabel: "Grande", quantity: 5 },
    { variantLabel: "Pequeño", quantity: 2 }
  ]);

  const single = transfers.find(t => t.operationId === "tr-2")!;
  assert.equal(single.status, "completed");
  assert.equal(single.quantity, 3);
});

test("hidratación: padre de la nube sin líneas no inventa filas engañosas", async () => {
  const driver = createMemoryDriver({ now: () => AT });
  await driver.ready();
  // Fila tal como la escribe el pull de la nube: solo columnas del padre real.
  await driver.put("transfers", [
    {
      id: "tr-cloud-only",
      company_id: COMPANY,
      version: 1,
      updated_at: AT,
      origin_device: "cloud",
      deleted_at: null,
      origin_warehouse_id: "wh-1",
      destination_warehouse_id: "wh-2",
      status: "posted",
      created_at: "2026-11-20T10:00:00.000Z",
      batch_id: "b-9"
    } as never
  ]);
  // Un almacén da contenido al snapshot para poder comprobar la colección.
  await driver.put("warehouses", [
    {
      id: "wh-1",
      company_id: COMPANY,
      version: 1,
      updated_at: AT,
      origin_device: "cloud",
      deleted_at: null,
      name: "Centro",
      is_main: true,
      is_active: true
    } as never
  ]);
  const snapshot = await hydrateFromLocalDb(COMPANY, { driver });
  assert.ok(snapshot);
  assert.equal(snapshot!.transfers.length, 0, "sin producto ni líneas no se proyecta nada");
  assert.equal(snapshot!.branches.length, 1);
});

// ---------------------------------------------------------------------------
// 6) puente snapshot → store
// ---------------------------------------------------------------------------

test("puente: un snapshot con traslados los aplica a la store", () => {
  resetStoreBridgeForTests();
  const store: any = {
    state: { transfers: [] },
    getState() { return this.state; },
    setState(patch: Record<string, unknown>) { this.state = { ...this.state, ...patch }; }
  };
  const snapshot: any = {
    products: [], inventory: [], customers: [], suppliers: [], transactions: [],
    cashSessions: [], branches: [], returns: [],
    transfers: [
      {
        id: "ti-1", operationId: "tr-1", productId: "p-1", productName: "Arroz",
        fromBranchId: "wh-1", fromBranchName: "Centro", toBranchId: "wh-2", toBranchName: "Vedado",
        quantity: 4, date: "2026-11-20T10:00:00.000Z", userId: "u-1", status: "in_transit"
      }
    ],
    sync: {
      transfers: {
        "ti-1": { version: 2, updatedAt: "2026-11-20T11:00:00.000Z", originDevice: "device-a" }
      }
    }
  };
  const result = applyLocalSnapshotToStore({ store, snapshot, companyId: COMPANY });
  assert.equal(result.applied, 1);
  assert.equal(store.state.transfers.length, 1);
  assert.equal(store.state.transfers[0].status, "in_transit");
  resetStoreBridgeForTests();
});
