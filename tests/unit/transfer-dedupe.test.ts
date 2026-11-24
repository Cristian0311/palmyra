import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve, join } from "node:path";

/**
 * Duplicidad de traslados: identidad estable (operationId || id), merge
 * local/remoto sin duplicados, paginación idempotente y recepción/cancelación
 * idempotentes.
 *
 * Regresiones que cubre:
 *  - Un despacho local pendiente cuya operación YA llegó de la nube no debe
 *    convivir con sus filas remotas (misma operación, distinto id).
 *  - Las páginas por offset que se solapan (escritura concurrente) no deben
 *    reintroducir la misma fila dos veces.
 *  - El camino simple de despacho debe dejar el registro local en 'in_transit'
 *    tras la confirmación (nunca 'completed': el servidor lo deja posted).
 *  - Aplicar dos veces la recepción/cancelación solo mueve stock una vez.
 *  - El resumen de lotes desduplica aplicados/fallidos por operationId.
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
const pullModule = await import(
  pathToFileURL(resolve(process.cwd(), 'src/services/supabaseSync/pull.ts')).href
);
const syncActionsModule = await import(
  pathToFileURL(resolve(process.cwd(), 'src/store/actions/syncActions.ts')).href
);
const inventoryActionsModule = await import(
  pathToFileURL(resolve(process.cwd(), 'src/store/actions/inventoryActions.ts')).href
);
const transferBatchModule = await import(
  pathToFileURL(resolve(process.cwd(), 'src/services/offline/transferBatch.ts')).href
);

const COMPANY = "11111111-1111-4111-8111-111111111111";
const AT = "2026-11-23T12:00:00.000Z";

function transferRow(id: string, operationId: string, status: string, extra: Record<string, any> = {}) {
  return {
    id, operationId, productId: "p-1", productName: "Arroz",
    fromBranchId: "wh-1", fromBranchName: "Centro",
    toBranchId: "wh-2", toBranchName: "Vedado",
    quantity: 4, date: AT, userId: "u-1", status, ...extra
  };
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

// ---------------------------------------------------------------------------
// Identidad estable y desduplicación de filas (repositories)
// ---------------------------------------------------------------------------

test("transferIdentity: operationId define la identidad; id es el respaldo", () => {
  const { transferIdentity } = repositoriesModule as any;
  assert.equal(typeof transferIdentity, "function");
  assert.equal(transferIdentity({ id: "ti-1", operationId: "op-x" }), "op-x");
  assert.equal(transferIdentity({ id: "op-y" }), "op-y");
  assert.equal(transferIdentity({ id: "  op-z  " }), "op-z");
  assert.equal(transferIdentity(null), "");
});

test("dedupeTransferRows: conserva líneas distintas del mismo traslado y elimina ids repetidos", () => {
  const { dedupeTransferRows } = repositoriesModule as any;
  assert.equal(typeof dedupeTransferRows, "function");
  const rows = dedupeTransferRows([
    transferRow("ti-1", "op-x", "in_transit"),
    transferRow("ti-2", "op-x", "in_transit"),
    transferRow("ti-1", "op-x", "in_transit")
  ] as any);
  // Dos líneas del MISMO traslado son filas distintas (id de línea único);
  // la tercera fila con id repetido es el duplicado que se descarta.
  assert.deepEqual(rows.map((r: any) => r.id), ["ti-1", "ti-2"]);
});

// ---------------------------------------------------------------------------
// Escenario 1/3: merge bootstrap y autocuración (local pendiente vs remoto)
// ---------------------------------------------------------------------------

test("mergeBootstrapSnapshot: la fila remota de la misma operación reemplaza al pendiente local sin duplicar", () => {
  const { mergeBootstrapSnapshot } = syncActionsModule;
  const localPending = transferRow("op-x", "op-x", "pending");
  const remote = [
    transferRow("ti-1", "op-x", "in_transit", { quantity: 2 }),
    transferRow("ti-2", "op-x", "in_transit", { quantity: 2 })
  ];
  const state = emptyState({ transfers: [localPending] });
  const patch = mergeBootstrapSnapshot({ transfers: remote }, state);
  const rows = (patch.transfers || []) as any[];
  assert.equal(rows.length, 2, "solo las dos líneas remotas, sin el pendiente local");
  assert.ok(!rows.some(r => r.id === "op-x" && r.status === "pending"), "el pendiente local ya no convive con su copia remota");
  assert.deepEqual(new Set(rows.map(r => r.id)), new Set(["ti-1", "ti-2"]));
});

// Harness mínimo del arranque (mismo patrón que transfer-history-heal).
function buildBootstrapDb(companyId: string) {
  return {
    warehouses: [{ id: 'wh-1', company_id: companyId, name: 'Centro', active: true, created_at: AT }],
    categories: [],
    products: [{ id: 'p-1', company_id: companyId, name: 'Arroz', price: 10, cost: 5, category_id: null, status: 'active', minimum_stock: 1 }],
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
    transfers: [],
    transfer_items: [],
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
  const db = buildBootstrapDb(companyId);
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

function createHarness(initial: any) {
  let state = initial;
  const set = (partial: any) => {
    const patch = typeof partial === 'function' ? partial(state) : partial;
    state = { ...state, ...patch };
  };
  const get = () => state;
  return { actions: syncActionsModule.createSyncActions(set as any, get as any), getState: () => state };
}

test("autocuración: no reintroduce un pendiente local que la nube ya trae (misma operación, distinto id)", async () => {
  const company = 'co-dedupe-heal';
  const fake = bootstrapSupabase(company, { failTables: new Set(['transfers']) });
  const localPending = transferRow("local-x", "op-x", "pending");
  const harness = createHarness(emptyState({ transfers: [localPending] }));
  const healedRows = [transferRow("ti-9", "op-x", "in_transit", { quantity: 7 })];
  const ok = await harness.actions.bootstrapCloudData({
    force: true,
    supabase: fake.client,
    tenant: { companyId: company },
    now: '2026-11-17T12:00:00.000Z',
    transferHistoryPull: async () => ({ success: true, transfers: healedRows })
  });
  assert.equal(ok, true);
  const transfers = harness.getState().transfers as any[];
  assert.equal(transfers.length, 1, "una sola fila para la operación ya confirmada");
  assert.equal(transfers[0].id, "ti-9");
});

test("syncTransferHistory: reemplaza pendientes locales confirmados, conserva lo que la nube no conoce y es idempotente", async () => {
  const syncTransferHistory = (inventoryActionsModule as any).syncTransferHistory;
  assert.equal(typeof syncTransferHistory, "function");
  let state = emptyState({
    transfers: [
      transferRow("op-x", "op-x", "pending"),
      transferRow("local-y", "op-y", "pending")
    ]
  });
  const set = (partial: any) => {
    const patch = typeof partial === 'function' ? partial(state) : partial;
    state = { ...state, ...patch };
  };
  const remoteRows = [transferRow("ti-1", "op-x", "in_transit", { quantity: 2 })];
  let pulls = 0;
  const pull = async () => { pulls += 1; return { success: true, transfers: remoteRows }; };
  await syncTransferHistory(set, pull);
  assert.equal(state.transfers.length, 2, "remoto (ti-1) + local que la nube no conoce (local-y)");
  assert.ok(!state.transfers.some((t: any) => (t.operationId || t.id) === "op-x" && t.status === "pending"), "el pendiente confirmado ya no aparece");
  assert.ok(state.transfers.some((t: any) => t.id === "ti-1"));
  assert.ok(state.transfers.some((t: any) => t.id === "local-y"));
  const identities = state.transfers.map((t: any) => t.operationId || t.id);
  assert.equal(new Set(identities).size, identities.length, "identidades únicas");
  const snapshot = state.transfers;
  await syncTransferHistory(set, pull);
  assert.equal(pulls, 2);
  assert.deepEqual(state.transfers, snapshot, "una segunda reconciliación no cambia nada");
});

// ---------------------------------------------------------------------------
// Escenario 2: paginación con solape de páginas
// ---------------------------------------------------------------------------

function pagingClient(plans: Record<string, Array<() => any[]>>) {
  const calls: Record<string, number> = {};
  function from(table: string) {
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
      or() { return builder; },
      order(col: string, opts?: { ascending?: boolean }) { state.order = [col, opts?.ascending !== false]; return builder; },
      range(a: number, b: number) { state.range = [Number(a), Number(b)]; return builder; },
      limit(n: number) { state.limit = Number(n); return builder; },
      then(onFulfilled?: any, onRejected?: any) {
        calls[table] = (calls[table] || 0) + 1;
        const plan = plans[table];
        let rows: any[] = [];
        if (plan) {
          const index = Math.min(calls[table] - 1, plan.length - 1);
          rows = (plan[index]() || []).slice();
        }
        rows = rows.filter(r => state.filters.every(f => f(r)));
        return Promise.resolve({ data: rows, error: null }).then(onFulfilled, onRejected);
      }
    };
    return builder;
  }
  return { client: { from }, calls };
}

/**
 * Dos páginas que se solapan: 'tr-2' aparece al final de la página 1 y al
 * principio de la página 2 (una escritura concurrente lo desplazó), igual
 * para la línea 'ti-2'. Sin desduplicación, el historial proyecta la misma
 * línea varias veces.
 */
function overlapPlan() {
  const parent = (id: string, status = "posted") => ({
    id, company_id: COMPANY, origin_warehouse_id: "wh-1", destination_warehouse_id: "wh-2",
    status, created_at: AT, created_by: "u-1", batch_id: "b-1"
  });
  const line = (id: string, transferId: string, qty = 1) => ({
    id, transfer_id: transferId, product_id: "p-1", quantity: qty, variant_id: null
  });
  const parentsPage1 = [parent("tr-2"), ...Array.from({ length: 499 }, (_, k) => parent(`tr-f${k + 1}`))];
  const parentsPage2 = [parent("tr-2"), parent("tr-3", "received")];
  // La página 2 de líneas repite las 500 filas de la página 1 (desplazadas
  // por la escritura concurrente) y añade la línea de tr-3: cada lote de ids
  // encuentra sus líneas y el solape de ti-2 sigue presente en ambas páginas.
  const itemsPage1 = [line("ti-2", "tr-2", 5), ...Array.from({ length: 499 }, (_, k) => line(`ti-f${k + 1}`, `tr-f${k + 1}`))];
  const itemsPage2 = [
    line("ti-2", "tr-2", 5),
    ...Array.from({ length: 499 }, (_, k) => line(`ti-f${k + 1}`, `tr-f${k + 1}`)),
    line("ti-3", "tr-3", 2)
  ];
  return {
    plans: {
      transfers: [() => parentsPage1, () => parentsPage2, () => []],
      transfer_items: [() => itemsPage1, () => itemsPage2, () => []]
    } as Record<string, Array<() => any[]>>,
    refs: {
      productNames: new Map([["p-1", "Arroz"]]),
      warehouseNames: new Map([["wh-1", "Centro"], ["wh-2", "Vedado"]]),
      variantNames: new Map()
    }
  };
}

test("pullTransferHistoryCorrected: el solape de páginas no duplica líneas", async () => {
  const plan = overlapPlan();
  const { client, calls } = pagingClient(plan.plans);
  const result = await transferHistoryModule.pullTransferHistoryCorrected({
    client,
    tenant: { companyId: COMPANY },
    refs: plan.refs
  });
  assert.equal(result.success, true);
  assert.equal(calls.transfers, 2, "pagina los padres");
  assert.equal(calls.transfer_items, 2, "pagina las líneas");
  const rows = result.transfers;
  assert.equal(rows.filter(r => r.id === "ti-2").length, 1, "la línea solapada entre páginas aparece una sola vez");
  assert.equal(rows.filter(r => r.operationId === "tr-2").length, 1, "una sola fila por operación");
  const ids = rows.map(r => r.id);
  assert.equal(new Set(ids).size, ids.length, "todos los ids son únicos");
  assert.equal(rows.length, 501, "501 filas: 500 padres únicos de la página 1 + tr-3");
});

test("loadTransfers (arranque): el solape de páginas no duplica líneas", async () => {
  const loadTransfers = (pullModule as any).loadTransfers;
  assert.equal(typeof loadTransfers, "function");
  const plan = overlapPlan();
  const { client, calls } = pagingClient(plan.plans);
  const rows = await loadTransfers(undefined, {
    client,
    tenant: { companyId: COMPANY },
    refs: plan.refs
  });
  assert.equal(calls.transfers, 2);
  assert.equal(calls.transfer_items, 2);
  assert.equal(rows.filter((r: any) => r.id === "ti-2").length, 1);
  assert.equal(rows.filter((r: any) => r.operationId === "tr-2").length, 1);
  const ids = rows.map((r: any) => r.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(rows.length, 501);
});

// ---------------------------------------------------------------------------
// Escenario 3: despacho simple — posted del servidor debe verse como in_transit
// ---------------------------------------------------------------------------

test("transferInventoryBatch: tras confirmar el despacho el registro local queda in_transit, nunca completed", () => {
  const sourceText = readFileSync(join(process.cwd(), "src/store/actions/inventoryActions.ts"), "utf8");
  assert.ok(
    !/serverConfirmed && canonicalRefreshed \? 'completed'/.test(sourceText),
    "el camino simple ya no marca 'completed' al despachar (el servidor lo deja posted/in_transit)"
  );
  const matches = sourceText.match(/status: serverConfirmed \? 'in_transit' as const : 'pending' as const/g) || [];
  assert.equal(matches.length, 2, "ambos caminos (simple y lote) usan in_transit tras confirmar el despacho");
});

// ---------------------------------------------------------------------------
// Escenario 4: recepción/cancelación idempotentes
// ---------------------------------------------------------------------------

test("settleTransferResolutions: aplicar la recepción dos veces solo suma stock una vez", () => {
  const settleTransferResolutions = (inventoryActionsModule as any).settleTransferResolutions;
  assert.equal(typeof settleTransferResolutions, "function");
  const inTransit = transferRow("op-x", "op-x", "in_transit", { quantity: 5, variantLabel: undefined });
  const inventory = [
    { id: "inv-1", productId: "p-1", branchId: "wh-2", variantLabel: undefined, quantity: 10, minQuantity: 5 }
  ];
  const first = settleTransferResolutions([inTransit], inventory, ["op-x"], "receive");
  assert.equal(first.changed, true);
  assert.equal(first.transfers[0].status, "completed");
  assert.equal(first.inventory[0].quantity, 15, "crédito al destino una sola vez");

  const second = settleTransferResolutions(first.transfers, first.inventory, ["op-x"], "receive");
  assert.equal(second.changed, false, "segunda aplicación no toca nada");
  assert.equal(second.inventory[0].quantity, 15, "sin doble crédito");
  assert.equal(second.transfers[0].status, "completed");

  // Cancelación: el stock regresa al origen y tampoco se repite.
  const cancel = settleTransferResolutions(
    [transferRow("op-y", "op-y", "in_transit", { quantity: 3, variantLabel: undefined })],
    [{ id: "inv-2", productId: "p-1", branchId: "wh-1", variantLabel: undefined, quantity: 3, minQuantity: 5 }],
    ["op-y"],
    "cancel"
  );
  assert.equal(cancel.transfers[0].status, "cancelled");
  assert.equal(cancel.inventory[0].quantity, 6);
  const cancelTwice = settleTransferResolutions(cancel.transfers, cancel.inventory, ["op-y"], "cancel");
  assert.equal(cancelTwice.changed, false);
  assert.equal(cancelTwice.inventory[0].quantity, 6, "sin doble devolución al origen");
});

test("inventoryActions: la recepción y la cancelación usan el asentamiento idempotente y guardia en vuelo", () => {
  const sourceText = readFileSync(join(process.cwd(), "src/store/actions/inventoryActions.ts"), "utf8");
  assert.ok(sourceText.includes("settleTransferResolutions("), "receive/cancel asientan mediante el helper idempotente");
  assert.ok(sourceText.includes("transferResolutionInFlight"), "existe guardia de doble invocación en vuelo");
});

// ---------------------------------------------------------------------------
// Escenario 5: resumen de lotes sin duplicados
// ---------------------------------------------------------------------------

test("summarizeTransferBatch: deduplica aplicados y descarta fallidos ya aplicados", () => {
  const { summarizeTransferBatch } = transferBatchModule;
  const summary = summarizeTransferBatch(4, ["op-1", "op-1", "op-2"], [
    { operationId: "op-2", productId: "p-2", error: "ya aplicado", errorCode: "23505" },
    { operationId: "op-3", productId: "p-3", error: "sin stock", errorCode: "P0001" }
  ]);
  assert.deepEqual(summary.appliedOperationIds, ["op-1", "op-2"], "aplicados únicos en orden");
  assert.equal(summary.failedItems.length, 1);
  assert.equal(summary.failedItems[0].operationId, "op-3", "un fallido ya aplicado no se reporta como fallido");
  assert.equal(summary.partial, true);

  const clean = summarizeTransferBatch(2, ["op-1", "op-1"], []);
  assert.deepEqual(clean.appliedOperationIds, ["op-1"]);
});

// ---------------------------------------------------------------------------
// Cableado en el refresco operativo (mergeBranchOperationalData recibe
// entradas ya desduplicadas)
// ---------------------------------------------------------------------------

test("refreshBranchOperationalData: pre-filtra locales confirmados y desduplica el remoto antes del merge", () => {
  const sourceText = readFileSync(join(process.cwd(), "src/store/actions/syncActions.ts"), "utf8");
  assert.ok(sourceText.includes("filterLocalTransfers"), "las filas locales ya confirmadas se descartan antes de mergeBranchOperationalData");
  assert.ok(sourceText.includes("dedupeTransferRows"), "las filas remotas se desduplican antes del merge");
});
