import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

/**
 * Arranque nube→local por secciones independientes.
 *
 * (a) una tabla caída no vacía el resto ni borra la caché local;
 * (b) ámbito local vacío + filas remotas → descarga completa (autocuración);
 * (c) arranque offline → se muestra la copia local sin gastar red.
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

const pullModule = await import(pathToFileURL(resolve(process.cwd(), 'src/services/supabaseSync/pull.ts')).href);
const actionsModule = await import(pathToFileURL(resolve(process.cwd(), 'src/store/actions/syncActions.ts')).href);

const { loadBootstrapData } = pullModule;
const { createSyncActions, mergeBootstrapSnapshot, hydrateStoreFromSnapshot } = actionsModule;

const NOW = '2026-11-17T12:00:00.000Z';
const DAY_MS = 86_400_000;
const isoAgo = (days: number) => new Date(Date.parse(NOW) - days * DAY_MS).toISOString();

type FailMap = Set<string>;

function buildDb(companyId: string) {
  return {
    warehouses: [
      { id: 'wh-1', company_id: companyId, name: 'Centro', code: 'ALM-01', active: true, created_at: isoAgo(300) },
      { id: 'wh-2', company_id: companyId, name: 'Vedado', active: true, created_at: isoAgo(290) },
      { id: 'wh-3', company_id: companyId, name: 'Archivada', active: false, created_at: isoAgo(280) },
    ],
    categories: [
      { id: 'cat-1', company_id: companyId, name: 'General', active: true, created_at: isoAgo(300) },
      { id: 'cat-off', company_id: companyId, name: 'Antigua', active: false, created_at: isoAgo(280) },
    ],
    products: [
      { id: 'prod-1', company_id: companyId, name: 'Producto 1', price: 10, cost: 5, category_id: 'cat-1', status: 'active', minimum_stock: 1 },
      { id: 'prod-arch', company_id: companyId, name: 'Descontinuado', price: 7, cost: 3, category_id: 'cat-off', status: 'archived', minimum_stock: 0 },
    ],
    employees: [{ id: 'emp-1', company_id: companyId, full_name: 'Ana', active: true, user_id: 'user-1' }],
    employee_warehouse_access: [{ company_id: companyId, employee_id: 'emp-1', warehouse_id: 'wh-1' }],
    companies: [{ id: companyId, name: 'Demo', default_currency_code: 'USD' }],
    product_variants: [],
    product_barcodes: [],
    product_kit_components: [],
    currencies: [{ code: 'USD', name: 'Dólar', symbol: '$', active: true }],
    exchange_rates: [],
    product_prices: [],
    compensation_settings: [],
    company_settings: [{ company_id: companyId, settings: {} }],
    customers: [{ id: 'cus-1', company_id: companyId, name: 'Cliente 1', active: true }],
    stock_balances: [{ id: 'st-1', company_id: companyId, warehouse_id: 'wh-1', product_id: 'prod-1', quantity: 4 }],
    variant_stock_balances: [],
    cash_registers: [{ id: 'reg-1', company_id: companyId, warehouse_id: 'wh-1', name: 'Caja 1', active: true }],
    sales: [],
    sale_items: [],
    payments: [],
    cash_sessions: [],
    cash_movements: [],
    transfers: [],
    transfer_items: [],
    bank_accounts: [{ id: 'bank-1', company_id: companyId, name: 'BPA', bank_name: 'BPA', balance: 100, currency_code: 'USD', active: true }],
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
    suppliers: [{ id: 'sup-1', company_id: companyId, name: 'Proveedor', active: true }],
    purchase_orders: [],
    purchase_items: [],
  } as Record<string, any[]>;
}

function makeSupabase(companyId: string, options: { failTables?: FailMap; dbPatch?: (db: Record<string, any[]>) => void } = {}) {
  const db = buildDb(companyId);
  options.dbPatch?.(db);
  const requests: string[] = [];
  const failTables = options.failTables || new Set<string>();

  function from(table: string) {
    requests.push(table);
    const state = {
      filters: [] as Array<(row: any) => boolean>,
      limit: null as number | null,
      range: null as [number, number] | null,
      order: null as [string, boolean] | null,
      single: null as 'single' | 'maybe' | null,
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
      },
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
    ...overrides,
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

test('(a) una sección caída no vacía el resto ni borra la caché local', async () => {
  const company = 'co-section-fail';
  const fake = makeSupabase(company, { failTables: new Set(['products', 'bank_accounts']) });
  const cachedProduct = { id: 'prod-local', name: 'Caché', price: 3, costPrice: 1, categoryId: 'cat-local', status: 'active' };
  const cachedBank = { id: 'bank-local', name: 'Caja local', balance: 50 };
  const harness = createHarness(emptyState({
    products: [cachedProduct],
    categories: [{ id: 'cat-local', name: 'Local' }],
    branches: [{ id: 'wh-local', name: 'Local', isActive: true }],
    inventory: [
      { id: 'inv-local', productId: 'prod-local', branchId: 'wh-local', quantity: 2, minQuantity: 0 },
      // Referencia a una bodega archivada: debe sobrevivir al bootstrap.
      { id: 'inv-arch', productId: 'prod-local', branchId: 'wh-3', quantity: 1, minQuantity: 0 },
    ],
    bankCards: [cachedBank],
    currentBranchId: 'wh-local',
  }));

  const ok = await harness.actions.bootstrapCloudData({ force: true, supabase: fake.client, tenant: { companyId: company }, now: NOW });
  assert.equal(ok, true, 'el arranque parcial aplica lo que sí llegó');

  const state = harness.getState();
  // Productos: la consulta falló → caché intacta, nunca [].
  assert.deepEqual(state.products.map((p: any) => p.id), ['prod-local']);
  // Bancos: ídem.
  assert.deepEqual(state.bankCards.map((b: any) => b.id), ['bank-local']);
  // Almacenes: llegaron y se actualizaron (incluido el archivado referenciado).
  assert.deepEqual(state.branches.map((b: any) => b.id).sort(), ['wh-1', 'wh-2', 'wh-3']);
  assert.equal(state.branches.find((b: any) => b.id === 'wh-3').isActive, false);
  // Categorías y clientes llegaron.
  assert.ok(state.categories.some((c: any) => c.id === 'cat-1'));
  assert.deepEqual(state.customers.map((c: any) => c.id), ['cus-1']);
  // El error se informa con nombre humano y no se cachea como éxito.
  assert.equal(state.syncResult.success, false);
  assert.match(state.syncResult.message, /Productos|Bancos/);
  assert.ok(state.syncResult.errors.some((entry: string) => entry.startsWith('Productos:')));
  assert.ok(state.syncResult.errors.some((entry: string) => entry.startsWith('Bancos y cuentas:')));
});

test('(a2) el detalle del informe marca solo la sección caída', async () => {
  const company = 'co-report-shape';
  const fake = makeSupabase(company, { failTables: new Set(['customers']) });
  const { report, data } = await loadBootstrapData({
    supabase: fake.client, tenant: { companyId: company }, now: NOW, includeSaasUser: false,
  });
  assert.equal(report.ok, false);
  assert.equal(report.sections.customers.ok, false);
  assert.equal(report.sections.warehouses.ok, true);
  assert.equal(report.sections.products.ok, true);
  assert.equal(report.sections.products.hidden, 1, 'informa los archivados que el filtro oculta');
  assert.equal(report.sections.warehouses.hidden, 1);
  assert.equal(report.sections.categories.hidden, 1);
  assert.deepEqual(report.errors.map((entry: any) => entry.section), ['customers']);
  assert.equal(data.customers.length, 0);
  assert.equal(data.branches.length, 3, 'los almacenes archivados viajan para no romper referencias');
  assert.equal((data as any).report, undefined);
});

test('(b) ámbito local vacío + filas remotas → descarga completa una sola vez', async () => {
  const company = 'co-self-heal';
  const fake = makeSupabase(company);
  const harness = createHarness(emptyState());
  const fullPulls: string[] = [];

  const ok = await harness.actions.bootstrapCloudData({
    force: true,
    supabase: fake.client,
    tenant: { companyId: company },
    now: NOW,
    fullPull: async (companyId: string) => { fullPulls.push(companyId); return { status: 'pulled', applied: 3 }; },
  });
  assert.equal(ok, true);
  assert.deepEqual(fullPulls, [company], 'se fuerza la descarga completa sin cursores');
  assert.ok(harness.getState().products.some((p: any) => p.id === 'prod-1'));

  // Una segunda ejecución en la misma sesión no repite la autocuración.
  const second = makeSupabase(company);
  await harness.actions.bootstrapCloudData({
    force: true, supabase: second.client, tenant: { companyId: company }, now: NOW,
    fullPull: async (companyId: string) => { fullPulls.push(companyId); return true; },
  });
  assert.deepEqual(fullPulls, [company]);
});

test('(b2) con catálogo local presente no se dispara la autocuración', async () => {
  const company = 'co-no-self-heal';
  const fake = makeSupabase(company);
  const harness = createHarness(emptyState({
    products: [{ id: 'local-1', name: 'Local' }],
    categories: [{ id: 'cat-local', name: 'Local' }],
    branches: [{ id: 'wh-local', name: 'Local', isActive: true }],
    currentBranchId: 'wh-local',
  }));
  let calls = 0;
  await harness.actions.bootstrapCloudData({
    force: true, supabase: fake.client, tenant: { companyId: company }, now: NOW,
    fullPull: async () => { calls += 1; return true; },
  });
  assert.equal(calls, 0);
});

test('(c) arranque offline → copia local al instante, sin red', async () => {
  const company = 'co-offline';
  const snapshot = JSON.stringify({
    state: {
      products: [{ id: 'prod-cache', name: 'Cacheado', price: 9 }],
      categories: [{ id: 'cat-cache', name: 'Caché' }],
      branches: [{ id: 'wh-cache', name: 'Sucursal', isActive: true }],
      currentBranchId: 'wh-cache',
      customers: [{ id: 'cus-cache', name: 'Cliente' }],
    },
  });
  const fake = makeSupabase(company);
  const harness = createHarness(emptyState());

  const ok = await harness.actions.bootstrapCloudData({
    force: true,
    supabase: fake.client,
    tenant: { companyId: company },
    now: NOW,
    isOnline: () => false,
    localSnapshot: snapshot,
  });
  assert.equal(ok, false);
  assert.equal(fake.requests.length, 0, 'sin conexión no se pide nada');

  const state = harness.getState();
  assert.deepEqual(state.products.map((p: any) => p.id), ['prod-cache']);
  assert.deepEqual(state.categories.map((c: any) => c.id), ['cat-cache']);
  assert.deepEqual(state.branches.map((b: any) => b.id), ['wh-cache']);
  assert.equal(state.currentBranchId, 'wh-cache');
  assert.match(state.syncResult.message, /copia local/i);
});

test('(d) catálogo e inventario mayores que una página de PostgREST llegan completos', async () => {
  const company = 'co-big-catalog';
  const PRODUCTS = 1205;
  const fake = makeSupabase(company, {
    dbPatch: (db) => {
      // Simula el tope real de PostgREST: cada consulta devuelve como mucho una
      // página; sin `range` explícito, el resto de filas no llega nunca.
      db.categories = [{ id: 'cat-1', company_id: company, name: 'General', active: true, created_at: isoAgo(300) }];
      // PostgREST no recorta por sí solo en el doble, así que el doble solo
      // entrega lo que la consulta pide con range/limit (ya lo hace arriba).
      db.products = Array.from({ length: PRODUCTS }, (_, i) => ({
        id: `prod-${String(i).padStart(4, '0')}`,
        company_id: company,
        name: `Producto ${i}`,
        price: 1,
        cost: 0.5,
        category_id: 'cat-1',
        status: 'active',
        minimum_stock: 0,
        created_at: isoAgo(200),
      }));
      db.stock_balances = Array.from({ length: PRODUCTS }, (_, i) => ({
        id: `st-${String(i).padStart(4, '0')}`,
        company_id: company,
        warehouse_id: 'wh-1',
        product_id: `prod-${String(i).padStart(4, '0')}`,
        quantity: i,
      }));
      db.product_barcodes = Array.from({ length: PRODUCTS }, (_, i) => ({
        id: `bar-${String(i).padStart(4, '0')}`,
        company_id: company,
        product_id: `prod-${String(i).padStart(4, '0')}`,
        barcode: `123${i}`,
        active: true,
      }));
    },
  });

  const harness = createHarness(emptyState());
  const ok = await harness.actions.bootstrapCloudData({
    force: true,
    supabase: fake.client,
    tenant: { companyId: company },
    now: NOW,
    fullPull: async () => true,
  });
  assert.equal(ok, true);
  const state = harness.getState();
  assert.equal(state.products.length, PRODUCTS, 'ningún producto se pierde por el tope de filas');
  assert.equal(state.inventory.length, PRODUCTS, 'ninguna existencia se pierde por el tope de filas');
  assert.ok(state.products.every((p: any) => Boolean(p.barcode)), 'los códigos de barras también se paginan');
});

test('(e) un turno de una caja desactivada conserva su sucursal', async () => {
  const company = 'co-inactive-register';
  const fake = makeSupabase(company, {
    dbPatch: (db) => {
      db.cash_registers = [
        { id: 'reg-old', company_id: company, warehouse_id: 'wh-2', name: 'Caja vieja', active: false },
      ];
      db.cash_sessions = [
        { id: 'sess-old', company_id: company, status: 'closed', opened_at: isoAgo(30), closed_at: isoAgo(30), cash_register_id: 'reg-old', opening_amount: 10, employee_id: 'emp-1' },
      ];
    },
  });
  const { data } = await loadBootstrapData({
    supabase: fake.client, tenant: { companyId: company }, now: NOW, includeSaasUser: false,
  });
  const session = data.cashSessions.find((s: any) => s.id === 'sess-old');
  assert.ok(session, 'el turno histórico sigue llegando');
  assert.equal(session!.branchId, 'wh-2', 'la caja desactivada no borra la sucursal del turno');
});

test('hidratación local: solo rellena secciones vacías y nunca pisa datos frescos', () => {
  const fresh = { id: 'prod-new', name: 'Nuevo' };
  const patch = hydrateStoreFromSnapshot(
    emptyState({ products: [fresh as any] }) as any,
    { products: [{ id: 'prod-old' }], categories: [{ id: 'cat-old' }], currentBranchId: 'wh-old' }
  );
  assert.equal((patch as any).categories.length, 1);
  assert.equal((patch as any).products, undefined, 'no se sobrescribe una sección con datos');
  assert.equal((patch as any).currentBranchId, 'wh-old');
  assert.equal(hydrateStoreFromSnapshot(emptyState() as any, null), null);
});

test('merge con informe: sección fallida conserva la caché; sección ok reemplaza', () => {
  const state = emptyState({
    products: [{ id: 'prod-local', name: 'Local', price: 1 }],
    branches: [{ id: 'wh-local', name: 'Local', isActive: true }],
    currentBranchId: 'wh-local',
    bankCards: [{ id: 'bank-local' }],
  });
  const report = {
    ok: false,
    companyId: 'co-x',
    sinceIso: NOW,
    sections: {
      products: { ok: false, label: 'Productos', rows: 0, ms: 1 },
      warehouses: { ok: true, label: 'Almacenes', rows: 1, ms: 1 },
      banks: { ok: true, label: 'Bancos y cuentas', rows: 1, ms: 1 },
    },
    errors: [{ section: 'products', label: 'Productos', message: 'caído' }],
    warnings: [],
  };
  const merged = mergeBootstrapSnapshot(
    { products: [], branches: [{ id: 'wh-remote', name: 'Remoto', isActive: true }], bankCards: [], lastTurnNumber: 0 },
    state as any,
    report as any
  );
  assert.deepEqual((merged.products as any[]).map(p => p.id), ['prod-local']);
  assert.deepEqual((merged.branches as any[]).map(b => b.id), ['wh-remote']);
  // Los merges aditivos (bancos) nunca borran filas locales por una respuesta vacía.
  assert.deepEqual((merged.bankCards as any[]).map(b => b.id), ['bank-local']);
});
