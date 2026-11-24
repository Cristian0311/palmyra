import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

/**
 * F6-B: el arranque desde la nube nunca descarga historial completo.
 * Se simula PostgREST con un cliente falso que cuenta solicitudes, aplica
 * filtros y topes reales, y falla a demanda.
 */

// saas.ts lee import.meta.env en el ámbito del módulo y tsx no lo define.
// Un hook de carga mínimo lo neutraliza para poder importar pull/syncActions.
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

const {
  loadBootstrapData,
  loadHistoryPage,
  pullSalesHistoryPage,
  clampHistoryLimit,
  HISTORY_PAGE_MAX_LIMIT,
  HISTORY_PAGE_DEFAULT_LIMIT,
  BOOTSTRAP_REQUEST_BUDGET,
  BOOTSTRAP_SALES_LIMIT,
  BOOTSTRAP_WINDOW_DAYS,
} = pullModule;
const { createSyncActions, mergeBootstrapSnapshot, BOOTSTRAP_COOLDOWN_MS } = actionsModule;

const COMPANY = 'co-bootstrap';
const NOW = '2026-11-17T12:00:00.000Z';
const NOW_MS = Date.parse(NOW);
const DAY_MS = 86_400_000;
const TENANT = { companyId: COMPANY };

const CATALOG_TABLES = new Set([
  'warehouses', 'categories', 'products', 'employees', 'employee_warehouse_access',
  'companies', 'product_variants', 'product_barcodes', 'product_kit_components',
  'currencies', 'exchange_rates', 'product_prices', 'compensation_settings', 'company_settings',
]);
const HISTORY_TABLES = new Set(['sales', 'sale_items', 'payments', 'cash_sessions', 'cash_movements', 'transfers', 'purchase_orders']);

type Capture = {
  table: string;
  limit: number | null;
  range: [number, number] | null;
  gte: Array<[string, string]>;
  lt: Array<[string, string]>;
  or: string[];
  neq: Array<[string, string]>;
  order: [string, boolean] | null;
};

function splitTop(expr: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of expr) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current) parts.push(current);
  return parts;
}

function matchesOr(row: any, expr: string): boolean {
  return splitTop(expr).some(part => {
    const simple = part.match(/^([a-z_]+)\.(eq|neq|gte|lte|gt|lt)\.(.*)$/);
    if (simple) {
      const [, col, op, value] = simple;
      const left = String(row?.[col] ?? '');
      const right = String(value);
      if (op === 'eq') return left === right;
      if (op === 'neq') return left !== right;
      if (op === 'gte') return left >= right;
      if (op === 'lte') return left <= right;
      if (op === 'gt') return left > right;
      return left < right;
    }
    const notIn = part.match(/^([a-z_]+)\.not\.in\.\((.*)\)$/);
    if (notIn) return !notIn[2].split(',').map(v => v.trim()).includes(String(row?.[notIn[1]] ?? ''));
    const inn = part.match(/^([a-z_]+)\.in\.\((.*)\)$/);
    if (inn) return inn[2].split(',').map(v => v.trim()).includes(String(row?.[inn[1]] ?? ''));
    return false;
  });
}

function isoAgo(days: number): string {
  return new Date(NOW_MS - days * DAY_MS).toISOString();
}

function buildDb(salesCount: number): Record<string, any[]> {
  const db: Record<string, any[]> = {
    warehouses: [{ id: 'wh-1', company_id: COMPANY, name: 'Centro', active: true, created_at: isoAgo(300) }],
    categories: [{ id: 'cat-1', company_id: COMPANY, name: 'General', active: true, created_at: isoAgo(300) }],
    products: [{ id: 'prod-1', company_id: COMPANY, name: 'Producto 1', price: 10, cost_price: 5, category_id: 'cat-1', status: 'active', minimum_stock: 1 }],
    employees: [{ id: 'emp-1', company_id: COMPANY, full_name: 'Ana', active: true, user_id: 'user-1' }],
    employee_warehouse_access: [{ company_id: COMPANY, employee_id: 'emp-1', warehouse_id: 'wh-1' }],
    companies: [{ id: COMPANY, name: 'Demo', default_currency_code: 'USD' }],
    product_variants: [],
    product_barcodes: [{ id: 'bar-1', company_id: COMPANY, product_id: 'prod-1', barcode: '123', active: true }],
    product_kit_components: [],
    currencies: [{ code: 'USD', name: 'Dólar', symbol: '$', active: true }],
    exchange_rates: [],
    product_prices: [],
    compensation_settings: [],
    company_settings: [{ company_id: COMPANY, settings: {} }],
    customers: [],
    stock_balances: [],
    variant_stock_balances: [],
    cash_registers: [{ id: 'reg-1', company_id: COMPANY, warehouse_id: 'wh-1', name: 'Caja 1', active: true }],
    sales: Array.from({ length: salesCount }, (_, i) => ({
      id: `sale-${i}`,
      company_id: COMPANY,
      warehouse_id: 'wh-1',
      created_at: new Date(NOW_MS - i * 4 * 3_600_000).toISOString(),
      subtotal: 10 + i,
      tax: 0,
      discount: 0,
      total: 10 + i,
      status: 'completed',
      employee_id: 'emp-1',
      cash_session_id: 'sess-closed',
    })),
    sale_items: [],
    payments: [],
    cash_sessions: [
      // Abierto hace 200 días: fuera de ventana pero imprescindible.
      { id: 'sess-open-old', company_id: COMPANY, status: 'open', opened_at: isoAgo(200), cash_register_id: 'reg-1', opening_amount: 100, turn_number: 7, employee_id: 'emp-1' },
      { id: 'sess-closed', company_id: COMPANY, status: 'closed', opened_at: isoAgo(2), closed_at: isoAgo(2), cash_register_id: 'reg-1', opening_amount: 50, turn_number: 8, employee_id: 'emp-1' },
      { id: 'sess-voided', company_id: COMPANY, status: 'voided', opened_at: isoAgo(1), cash_register_id: 'reg-1', opening_amount: 0, turn_number: 9 },
    ],
    cash_movements: [
      { id: 'mov-1', company_id: COMPANY, cash_session_id: 'sess-open-old', movement_type: 'cash_in', amount: 10, created_at: isoAgo(10) },
      { id: 'mov-2', company_id: COMPANY, cash_session_id: 'sess-closed', movement_type: 'cash_out', amount: 5, created_at: isoAgo(2) },
    ],
    transfers: [
      // Abierta vieja: entra por no estar cerrada.
      { id: 'tr-old-pending', company_id: COMPANY, status: 'pending', created_at: isoAgo(200), origin_warehouse_id: 'wh-1', destination_warehouse_id: 'wh-2' },
      // Cerrada vieja: fuera de ventana.
      { id: 'tr-old-done', company_id: COMPANY, status: 'completed', created_at: isoAgo(200), origin_warehouse_id: 'wh-1', destination_warehouse_id: 'wh-2' },
      { id: 'tr-recent-done', company_id: COMPANY, status: 'completed', created_at: isoAgo(3), origin_warehouse_id: 'wh-1', destination_warehouse_id: 'wh-2' },
    ],
    transfer_items: [
      { id: 'ti-1', transfer_id: 'tr-old-pending', product_id: 'prod-1', quantity: 2 },
      { id: 'ti-2', transfer_id: 'tr-recent-done', product_id: 'prod-1', quantity: 1 },
    ],
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
    purchase_items: [],
  };
  return db;
}

function makeSupabase(options: { salesCount?: number; fail?: boolean } = {}) {
  const db = buildDb(options.salesCount ?? 900);
  const requests: Capture[] = [];
  let calls = 0;

  function from(table: string) {
    calls += 1;
    const state = {
      filters: [] as Array<(row: any) => boolean>,
      ors: [] as string[],
      limit: null as number | null,
      range: null as [number, number] | null,
      order: null as [string, boolean] | null,
      single: null as 'single' | 'maybe' | null,
      gte: [] as Array<[string, string]>,
      lt: [] as Array<[string, string]>,
      neq: [] as Array<[string, string]>,
    };
    const builder: any = {
      select() { return builder; },
      eq(col: string, val: any) { state.filters.push(r => String(r?.[col] ?? '') === String(val)); return builder; },
      neq(col: string, val: any) { state.neq.push([col, String(val)]); state.filters.push(r => String(r?.[col] ?? '') !== String(val)); return builder; },
      in(col: string, values: any[]) { const set = new Set((values || []).map(String)); state.filters.push(r => set.has(String(r?.[col] ?? ''))); return builder; },
      is(col: string, val: any) { state.filters.push(r => (r?.[col] ?? null) === val); return builder; },
      gte(col: string, val: string) { state.gte.push([col, String(val)]); state.filters.push(r => String(r?.[col] ?? '') >= String(val)); return builder; },
      lt(col: string, val: string) { state.lt.push([col, String(val)]); state.filters.push(r => String(r?.[col] ?? '') < String(val)); return builder; },
      or(expr: string) { state.ors.push(String(expr)); return builder; },
      order(col: string, opts?: { ascending?: boolean }) { state.order = [col, opts?.ascending !== false]; return builder; },
      limit(n: number) { state.limit = Number(n); return builder; },
      range(a: number, b: number) { state.range = [Number(a), Number(b)]; return builder; },
      single() { state.single = 'single'; return builder; },
      maybeSingle() { state.single = 'maybe'; return builder; },
      then(onFulfilled?: any, onRejected?: any) {
        const capture: Capture = {
          table,
          limit: state.limit,
          range: state.range,
          gte: [...state.gte],
          lt: [...state.lt],
          or: [...state.ors],
          neq: [...state.neq],
          order: state.order,
        };
        requests.push(capture);
        let rows = (db[table] || []).slice();
        for (const filter of state.filters) rows = rows.filter(filter);
        if (state.ors.length) rows = rows.filter(row => state.ors.some(expr => matchesOr(row, expr)));
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
        const result = options.fail
          ? { data: null, error: new Error('fallo de red simulado') }
          : { data: state.single ? (rows[0] ?? null) : rows, error: null };
        return Promise.resolve(result).then(onFulfilled, onRejected);
      },
    };
    return builder;
  }

  return { client: { from }, requests, calls: () => calls };
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

function emptyState(overrides: Record<string, any> = {}) {
  return {
    transactions: [],
    cashSessions: [],
    transfers: [],
    branches: [],
    users: [],
    products: [],
    categories: [],
    customers: [],
    currencies: [],
    inventory: [],
    bankCards: [],
    bankTransactions: [],
    suppliers: [],
    supplierOrders: [],
    returns: [],
    warranties: [],
    quotes: [],
    timeShifts: [],
    salarySettlements: [],
    inventoryAudits: [],
    storeConfig: { storeName: 'Local' },
    receiptConfig: {},
    lastTurnNumber: 0,
    currentBranchId: 'wh-local',
    ...overrides,
  };
}

test('bootstrap: presupuesto acotado, ventas limitadas y sesiones abiertas', async () => {
  const fake = makeSupabase();
  const { data, metrics } = await loadBootstrapData({ supabase: fake.client, tenant: TENANT, now: NOW, includeSaasUser: false });

  assert.equal(metrics.budgetDenied, 0);
  assert.ok(metrics.windowRequests <= BOOTSTRAP_REQUEST_BUDGET, `ventana ${metrics.windowRequests} > ${BOOTSTRAP_REQUEST_BUDGET}`);
  const catalogRequests = fake.requests.filter(r => CATALOG_TABLES.has(r.table)).length;
  assert.equal(catalogRequests, 14);
  assert.equal(metrics.requests, fake.requests.length);
  assert.equal(metrics.windowRequests, fake.requests.length - catalogRequests);
  assert.ok(metrics.rows > 0);

  // Ventana de 90 días explícita en ventas.
  assert.equal(data.window.days, BOOTSTRAP_WINDOW_DAYS);
  assert.equal(data.window.sinceIso, isoAgo(BOOTSTRAP_WINDOW_DAYS));
  const salesQuery = fake.requests.find(r => r.table === 'sales');
  assert.ok(salesQuery);
  assert.ok(salesQuery!.gte.some(([col, value]) => col === 'created_at' && value === isoAgo(BOOTSTRAP_WINDOW_DAYS)));
  assert.equal(data.transactions.length, BOOTSTRAP_SALES_LIMIT);
  assert.ok(data.transactions.length <= 500);
  assert.ok(data.transactions.every(tx => String(tx.date) >= isoAgo(BOOTSTRAP_WINDOW_DAYS)));

  // Nunca consultas sin tope en tablas de historial.
  const unbounded = fake.requests.filter(r => HISTORY_TABLES.has(r.table) && r.limit == null && r.range == null);
  assert.deepEqual(unbounded.map(r => r.table), []);

  // Turno abierto viejo incluido aunque esté fuera de ventana.
  const open = data.cashSessions.find(s => s.id === 'sess-open-old');
  assert.ok(open, 'el turno abierto debe llegar siempre');
  assert.equal(open!.status, 'open');
  assert.ok(String(open!.openedAt) < isoAgo(BOOTSTRAP_WINDOW_DAYS));
  assert.ok(!data.cashSessions.some(s => s.id === 'sess-voided'));
  const sessionsQuery = fake.requests.find(r => r.table === 'cash_sessions');
  assert.ok(sessionsQuery!.or.some(expr => expr.includes('status.eq.open')));

  // Traslados: abiertos viejos sí, cerrados viejos no.
  const operations = new Set(data.transfers.map((t: any) => t.operationId));
  assert.ok(operations.has('tr-old-pending'));
  assert.ok(operations.has('tr-recent-done'));
  assert.ok(!operations.has('tr-old-done'));
});

test('historial: keyset por created_at, sin solape y se detiene al vaciar', async () => {
  const fake = makeSupabase({ salesCount: 7 });
  const seen = new Set<string>();
  let beforeIso: string | null = null;
  const pages = [];

  for (let page = 0; page < 10; page += 1) {
    const result = await loadHistoryPage({ table: 'sales', beforeIso, limit: 3, supabase: fake.client, tenant: TENANT });
    const ids = result.rows.map((r: any) => r.id);
    for (const id of ids) assert.ok(!seen.has(id), `solape en ${id}`);
    ids.forEach((id: string) => seen.add(id));
    pages.push(result);
    if (!result.hasMore) break;
    beforeIso = result.nextBefore;
  }

  assert.equal(seen.size, 7);
  assert.equal(pages[0].rows.length, 3);
  assert.equal(pages[1].rows.length, 3);
  assert.equal(pages[2].rows.length, 1);
  assert.equal(pages[2].hasMore, false);

  // Página final vacía con el mismo cursor.
  const empty = await loadHistoryPage({ table: 'sales', beforeIso: pages[2].nextBefore, limit: 3, supabase: fake.client, tenant: TENANT });
  assert.equal(empty.rows.length, 0);
  assert.equal(empty.hasMore, false);
  assert.equal(empty.nextBefore, null);

  // Keyset puro: lt(created_at) y limit, sin rangos/offset.
  const laterQueries = fake.requests.filter(r => r.table === 'sales');
  assert.ok(laterQueries.some(r => r.lt.some(([col]) => col === 'created_at')));
  assert.ok(laterQueries.every(r => r.range == null));
  assert.ok(laterQueries.every(r => r.limit === 4));
});

test('historial: lista blanca, límites y paginador de ventas del POS', async () => {
  assert.equal(clampHistoryLimit(0), 1);
  assert.equal(clampHistoryLimit(5000), HISTORY_PAGE_MAX_LIMIT);
  assert.equal(clampHistoryLimit(undefined), HISTORY_PAGE_DEFAULT_LIMIT);

  const fake = makeSupabase({ salesCount: 5 });
  await assert.rejects(
    () => loadHistoryPage({ table: 'users', supabase: fake.client, tenant: TENANT, limit: 10 }),
    /no permitida/
  );
  const first = await loadHistoryPage({ table: 'sales', limit: 5000, supabase: fake.client, tenant: TENANT });
  assert.equal(first.rows.length, 5);
  assert.equal(first.hasMore, false);
  assert.equal(fake.requests[0].limit, HISTORY_PAGE_MAX_LIMIT + 1);

  const posFake = makeSupabase({ salesCount: 7 });
  const page = await pullSalesHistoryPage({ limit: 2, supabase: posFake.client, tenant: TENANT });
  assert.equal(page.transactions.length, 2);
  assert.equal(page.hasMore, true);
  assert.ok(page.nextBefore);
  const next = await pullSalesHistoryPage({ limit: 2, beforeIso: page.nextBefore, supabase: posFake.client, tenant: TENANT });
  assert.equal(next.transactions.length, 2);
  const firstIds = new Set(page.transactions.map((tx: any) => tx.id));
  assert.ok(next.transactions.every((tx: any) => !firstIds.has(tx.id)));
});

test('acción de arranque: cooldown sin red y errores que no tocan la caché', async () => {
  const localOnly = { id: 'local-old', date: '2020-01-01T00:00:00.000Z', total: 5, items: [], payments: [] };
  const harness = createHarness(emptyState({ transactions: [localOnly], lastTurnNumber: 3 }));
  const fake = makeSupabase();

  const ok = await harness.actions.bootstrapCloudData({ force: true, supabase: fake.client, tenant: TENANT, now: NOW });
  assert.equal(ok, true);
  const afterSuccess = harness.getState();
  assert.equal(afterSuccess.syncResult.success, true);
  assert.ok(fake.requests.length > 0);
  assert.equal(afterSuccess.transactions.length, 1 + BOOTSTRAP_SALES_LIMIT);
  assert.ok(afterSuccess.transactions.some((tx: any) => tx.id === 'local-old'), 'el historial local no se purga');
  assert.ok(afterSuccess.transactions.some((tx: any) => tx.id === 'sale-0'));
  assert.equal(afterSuccess.lastTurnNumber, 8);
  assert.ok(afterSuccess.lastSyncTime);

  // Repetir sin force dentro del cooldown no gasta red ni toca el estado.
  assert.equal(BOOTSTRAP_COOLDOWN_MS, 10 * 60 * 1000);
  const blocked = makeSupabase();
  const snapshot = afterSuccess.transactions.length;
  const again = await harness.actions.bootstrapCloudData({ force: false, supabase: blocked.client, tenant: TENANT, now: NOW });
  assert.equal(again, false);
  assert.equal(blocked.requests.length, 0);
  assert.equal(harness.getState().transactions.length, snapshot);

  // Un fallo de red deja intactos los datos locales.
  const failing = makeSupabase({ fail: true });
  const failed = await harness.actions.bootstrapCloudData({ force: true, supabase: failing.client, tenant: TENANT, now: NOW });
  assert.equal(failed, false);
  const afterFailure = harness.getState();
  assert.equal(afterFailure.syncResult.success, false);
  assert.equal(afterFailure.transactions.length, snapshot);
  assert.ok(afterFailure.transactions.some((tx: any) => tx.id === 'local-old'));
  assert.equal(afterFailure.syncResult.message, 'fallo de red simulado');
  assert.equal(afterFailure.lastTurnNumber, 8);
  assert.deepEqual(afterFailure.products, afterSuccess.products);

  // La fusión directa tampoco reabre un cierre local.
  const state = emptyState({
    cashSessions: [{ id: 'sess-closed', status: 'closed', openedAt: isoAgo(2) }],
  });
  const merged = mergeBootstrapSnapshot(
    { cashSessions: [{ id: 'sess-closed', status: 'open', openedAt: isoAgo(2) }], transactions: [], transfers: [], branches: [], users: [], products: [], categories: [], customers: [], currencies: [], inventory: [], bankCards: [], bankTransactions: [], suppliers: [], supplierOrders: [], returns: [], warranties: [], quotes: [], timeShifts: [], salarySettlements: [], inventoryAudits: [], lastTurnNumber: 0 },
    state as any
  );
  assert.equal((merged.cashSessions as any[])[0].status, 'closed');
});
