import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve, join } from "node:path";

/**
 * Regresión del flujo "Recibir" / "Cancelar" (traslados en dos fases).
 *
 * Bug de producción confirmado en BD: los traslados legacy 'posted' (una sola
 * fase) ya tienen sus DOS movimientos aplicados en la nube, y
 * `palmyra_receive_transfer` responde success con `status:'posted',
 * already_existed:true` SIN mover el estado a 'received'. El cliente mapea
 * posted → in_transit, así que tras pulsar "Recibir" la fila volvía a
 * aparecer EN TRÁNSITO para siempre (el toast decía "recibida").
 *
 * Regresiones que cubre:
 *  1) posted ya aplicado → la fila local pasa a Recibido SIN doble crédito de
 *     stock y la reconciliación del historial no la devuelve a 'en tránsito'
 *     (override persistente).
 *  2) Éxito online con fallo del pull de historial/inventario → el cambio
 *     visible local se mantiene (antes dependía 100% del pull).
 *  3) Error transitorio del RPC → error claro reintentable, fila en tránsito,
 *     stock intacto y el id se encola.
 *  4) Guard in-flight: se limpia en finally (tras error y tras doble clic).
 *  5) Cancelación online con fallo del pull → cancelada localmente y stock
 *     devuelto al origen.
 *  6) Cancelar un posted de una sola fase → error claro no reintentable, sin
 *     encolado infinito.
 *  7) Recibir un traslado que la nube ya canceló → asienta cancelado local.
 *  8) transfer_not_found → asienta el estado visible local sin crédito.
 */

(globalThis as any).__VITE_ENV__ = {};
Object.defineProperty(globalThis, "navigator", {
  value: { onLine: true },
  configurable: true,
  writable: true
});

const SUPABASE_SYNC_MOCK = `
const M = () => (globalThis.__transferMocks__ || {});
export async function pullBranchInventoryFromSupabase(branchId) {
  const m = M();
  if (m.pullBranchInventoryFromSupabase) return m.pullBranchInventoryFromSupabase(branchId);
  return { success: false, inventory: [] };
}
export async function callReceiveTransferRPC(operationId) {
  const m = M();
  if (!m.calls) m.calls = { receive: [], cancel: [] };
  m.calls.receive.push(operationId);
  if (m.callReceiveTransferRPC) return m.callReceiveTransferRPC(operationId);
  return { success: true, data: { status: 'received', already_existed: false } };
}
export async function callCancelTransferRPC(operationId) {
  const m = M();
  if (!m.calls) m.calls = { receive: [], cancel: [] };
  m.calls.cancel.push(operationId);
  if (m.callCancelTransferRPC) return m.callCancelTransferRPC(operationId);
  return { success: true, data: { status: 'cancelled', already_existed: false } };
}
export async function callTransferInventoryRPC() { return { success: true, data: {} }; }
export async function callTransferInventoryBulkRPC() { return { success: true, appliedOperationIds: [], failedItems: [], partial: false }; }
export async function pushProductToSupabase() { return { success: true }; }
export async function deleteProductFromSupabase() { return { success: true }; }
export async function reconcileInventoryToSupabase() { return { success: true }; }
export async function applyInventoryAdjustmentToSupabase() { return { success: true }; }
`;

const OFFLINE_QUEUE_MOCK = `
const M = () => (globalThis.__transferMocks__ || {});
export async function enqueueOfflineItem(type, payload, actionId) {
  const m = M();
  if (m.enqueueOfflineItem) return m.enqueueOfflineItem(type, payload, actionId);
  if (!m.enqueued) m.enqueued = [];
  m.enqueued.push({ type, payload, actionId });
  return { success: true };
}
export async function getOfflineQueue() { return []; }
export async function removeFromOfflineQueue() { return true; }
`;

const OUTBOX_UTILS_MOCK = `
export async function removeFromOfflineQueueByAction() { return true; }
`;

const LOCAL_PLAN_MODE_MOCK = `
export function isCloudBusinessSyncAllowed() { return true; }
export function isLocalPlanMode() { return false; }
`;

const TENANT_MOCK = `
export async function getActiveTenant() {
  return { companyId: '11111111-1111-4111-8111-111111111111' };
}
`;

const MOCKS: Record<string, string> = {
  "/src/services/supabaseSync.ts": SUPABASE_SYNC_MOCK,
  "/src/services/offlineQueue.ts": OFFLINE_QUEUE_MOCK,
  "/src/services/offlineQueue/outboxUtils.ts": OUTBOX_UTILS_MOCK,
  "/src/services/localPlanMode.ts": LOCAL_PLAN_MODE_MOCK,
  "/src/services/tenant.ts": TENANT_MOCK
};

const LOADER = [
  "export async function load(url, context, nextLoad) {",
  "  const mocks = " + JSON.stringify(MOCKS) + ";",
  "  const clean = String(url).split('?')[0];",
  "  for (const suffix of Object.keys(mocks)) {",
  "    if (clean.endsWith(suffix)) {",
  "      return { format: 'module', shortCircuit: true, source: mocks[suffix] };",
  "    }",
  "  }",
  "  const r = await nextLoad(url, context);",
  "  if (clean.includes('/src/') && r && r.source) {",
  "    const text = r.source.toString();",
  "    if (text.includes('import.meta.env')) {",
  "      return { ...r, source: text.replaceAll('import.meta.env', '(import.meta.env ?? globalThis.__VITE_ENV__)') };",
  "    }",
  "  }",
  "  return r;",
  "}"
].join("\n");
register("data:text/javascript;charset=utf-8," + encodeURIComponent(LOADER));

const inventoryActionsModule = await import(
  pathToFileURL(resolve(process.cwd(), "src/store/actions/inventoryActions.ts")).href
);
const transferHistoryModule = await import(
  pathToFileURL(resolve(process.cwd(), "src/services/cloudSync/transferHistory.ts")).href
);

const AT = "2026-11-23T12:00:00.000Z";

function transferRow(id: string, operationId: string, status: string, extra: Record<string, any> = {}) {
  return {
    id, operationId, productId: "p-1", productName: "Arroz",
    fromBranchId: "wh-1", fromBranchName: "Centro",
    toBranchId: "wh-2", toBranchName: "Vedado",
    quantity: 5, date: AT, userId: "u-1", status, ...extra
  };
}

function inventoryRow(branchId: string, quantity: number, productId = "p-1") {
  return { id: `inv-${branchId}`, productId, branchId, variantLabel: undefined, quantity, minQuantity: 5 };
}

function resetMocks(): any {
  const mocks: any = { enqueued: [], calls: { receive: [], cancel: [] } };
  (globalThis as any).__transferMocks__ = mocks;
  return mocks;
}

function createHarness(transfers: any[], inventory: any[]) {
  let state: any = { transfers, inventory };
  const set = (partial: any) => {
    const patch = typeof partial === "function" ? partial(state) : partial;
    state = { ...state, ...patch };
  };
  const get = () => state;
  const actions = inventoryActionsModule.createInventoryActions(set as any, get as any);
  return { actions, getState: () => state };
}

function rowByIdentity(state: any, identity: string) {
  return state.transfers.find((t: any) => String(t.operationId || t.id) === identity);
}

// ---------------------------------------------------------------------------
// Bug de producción: posted de una sola fase ya aplicado en la nube
// ---------------------------------------------------------------------------

test("recibir un traslado 'posted' ya aplicado: pasa a Recibido sin doble crédito y no vuelve a 'en tránsito'", async () => {
  const mocks = resetMocks();
  mocks.callReceiveTransferRPC = async () => ({
    success: true,
    data: { status: "posted", already_existed: true }
  });
  const harness = createHarness(
    [transferRow("ti-1", "op-posted-1", "in_transit")],
    [inventoryRow("wh-2", 10)]
  );

  const result = await harness.actions.receiveTransfer(["op-posted-1"]);
  assert.equal(result.success, true);
  assert.ok(result.warning && /sola fase/.test(result.warning), "aviso explícito del caso de una sola fase");
  const row = rowByIdentity(harness.getState(), "op-posted-1");
  assert.equal(row.status, "completed", "el cambio visible ocurre SIEMPRE");
  assert.equal(harness.getState().inventory[0].quantity, 10, "sin doble crédito: el stock ya estaba aplicado en la nube");
  assert.equal(mocks.enqueued.length, 0, "no se encola nada: la nube lo dio por resuelto");

  // El override debe sobrevivir la reconciliación del historial: el servidor
  // sigue reportando la fila como posted (→ in_transit) hasta la migración.
  const overrides = (transferHistoryModule as any).getTransferStatusOverrides();
  assert.equal(overrides.get("op-posted-1"), "completed", "override registrado para la identidad");

  const syncTransferHistory = (inventoryActionsModule as any).syncTransferHistory;
  const remotePosted = [transferRow("ti-1", "op-posted-1", "in_transit")];
  // syncTransferHistory necesita el set del harness; se vuelve a invocar con él.
  let state = harness.getState();
  const set = (partial: any) => {
    const patch = typeof partial === "function" ? partial(state) : partial;
    state = { ...state, ...patch };
  };
  await syncTransferHistory(set, async () => ({ success: true, transfers: remotePosted }));
  assert.equal(state.transfers[0].status, "completed", "la reconciliación no deshace la recepción");
});

test("la reconciliación del historial solo aplica el override a identidades registradas", async () => {
  const syncTransferHistory = (inventoryActionsModule as any).syncTransferHistory;
  let state: any = {
    transfers: [transferRow("ti-x", "op-posted-2", "in_transit"), transferRow("ti-y", "op-other-2", "in_transit")]
  };
  const set = (partial: any) => {
    const patch = typeof partial === "function" ? partial(state) : partial;
    state = { ...state, ...patch };
  };
  (transferHistoryModule as any).registerTransferStatusOverrides(["op-posted-2"], "completed");
  await syncTransferHistory(set, async () => ({ success: true, transfers: [] }));
  assert.equal(state.transfers.find((t: any) => (t.operationId || t.id) === "op-posted-2").status, "completed");
  assert.equal(state.transfers.find((t: any) => (t.operationId || t.id) === "op-other-2").status, "in_transit", "sin override no se toca nada");
});

// ---------------------------------------------------------------------------
// Éxito online con fallo del pull: el cambio visible no depende del refresco
// ---------------------------------------------------------------------------

test("recibir online con pull de inventario/historial fallando: la fila queda Recibida y el stock acreditado localmente", async () => {
  const mocks = resetMocks();
  // RPC confirma recepción fresca; el refresco canónico falla (por defecto
  // pullBranchInventoryFromSupabase devuelve success:false y no hay cliente
  // real de Supabase para el historial).
  mocks.callReceiveTransferRPC = async () => ({
    success: true,
    data: { status: "received", already_existed: false }
  });
  const harness = createHarness(
    [transferRow("ti-1", "op-fresh-1", "in_transit", { quantity: 5 })],
    [inventoryRow("wh-2", 10)]
  );

  const result = await harness.actions.receiveTransfer(["op-fresh-1"]);
  assert.equal(result.success, true);
  assert.equal(result.pending, false);
  const row = rowByIdentity(harness.getState(), "op-fresh-1");
  assert.equal(row.status, "completed");
  assert.equal(harness.getState().inventory[0].quantity, 15, "crédito local aplicado de inmediato (el pull falló)");
  assert.equal(mocks.enqueued.length, 0);
});

// ---------------------------------------------------------------------------
// Error transitorio del RPC: error claro reintentable, fila intacta, encolado
// ---------------------------------------------------------------------------

test("error transitorio del RPC: error claro, la fila sigue en tránsito, el stock intacto y se encola el id", async () => {
  const mocks = resetMocks();
  mocks.callReceiveTransferRPC = async () => ({
    success: false,
    error: "La red falló al confirmar la recepción.",
    errorCode: undefined
  });
  const harness = createHarness(
    [transferRow("ti-1", "op-transient-1", "in_transit")],
    [inventoryRow("wh-2", 10)]
  );

  const result = await harness.actions.receiveTransfer(["op-transient-1"]);
  assert.equal(result.success, false);
  assert.equal(result.pending, true);
  assert.ok(/red falló/.test(result.error), "el error del RPC llega a la UI");
  const row = rowByIdentity(harness.getState(), "op-transient-1");
  assert.equal(row.status, "in_transit", "sin confirmación no se miente el estado");
  assert.equal(harness.getState().inventory[0].quantity, 10, "stock intacto");
  assert.equal(mocks.enqueued.length, 1);
  assert.equal(mocks.enqueued[0].type, "transfer_receive");
  assert.deepEqual(mocks.enqueued[0].payload.operationIds, ["op-transient-1"]);
});

// ---------------------------------------------------------------------------
// Guard in-flight: se limpia en finally
// ---------------------------------------------------------------------------

test("el guard in-flight no queda atascado tras un error: un segundo intento vuelve a invocar el RPC", async () => {
  const mocks = resetMocks();
  let failing = true;
  mocks.callReceiveTransferRPC = async () => {
    if (failing) throw new Error("red caída");
    return { success: true, data: { status: "received", already_existed: false } };
  };
  const harness = createHarness(
    [transferRow("ti-1", "op-guard-1", "in_transit")],
    [inventoryRow("wh-2", 10)]
  );

  await assert.rejects(() => harness.actions.receiveTransfer(["op-guard-1"]), /red caída/);
  assert.equal(mocks.calls.receive.length, 1);
  failing = false;
  const result = await harness.actions.receiveTransfer(["op-guard-1"]);
  assert.equal(result.success, true, "el segundo intento funciona: el guard se limpió en finally");
  assert.equal(mocks.calls.receive.length, 2, "el RPC se volvió a invocar");
  assert.equal(rowByIdentity(harness.getState(), "op-guard-1").status, "completed");
});

test("doble clic concurrente: una sola invocación al RPC y un solo crédito", async () => {
  const mocks = resetMocks();
  let release: any;
  mocks.callReceiveTransferRPC = () => new Promise(res => { release = res; });
  const harness = createHarness(
    [transferRow("ti-1", "op-double-1", "in_transit", { quantity: 5 })],
    [inventoryRow("wh-2", 10)]
  );

  const first = harness.actions.receiveTransfer(["op-double-1"]);
  const second = await harness.actions.receiveTransfer(["op-double-1"]);
  assert.deepEqual(second, { success: true, pending: false }, "el segundo clic se descarta mientras el primero está en vuelo");
  release({ success: true, data: { status: "received", already_existed: false } });
  const result = await first;
  assert.equal(result.success, true);
  assert.equal(mocks.calls.receive.length, 1, "una sola llamada al RPC");
  assert.equal(harness.getState().inventory[0].quantity, 15, "un solo crédito de stock");
});

// ---------------------------------------------------------------------------
// Cancelación
// ---------------------------------------------------------------------------

test("cancelar online con pull fallando: fila cancelada y stock devuelto al origen localmente", async () => {
  const mocks = resetMocks();
  mocks.callCancelTransferRPC = async () => ({
    success: true,
    data: { status: "cancelled", already_existed: false }
  });
  const harness = createHarness(
    [transferRow("ti-1", "op-cancel-1", "in_transit", { quantity: 5 })],
    [inventoryRow("wh-1", 3)]
  );

  const result = await harness.actions.cancelTransfer(["op-cancel-1"]);
  assert.equal(result.success, true);
  const row = rowByIdentity(harness.getState(), "op-cancel-1");
  assert.equal(row.status, "cancelled");
  assert.equal(harness.getState().inventory[0].quantity, 8, "stock devuelto al origen");
  assert.equal(mocks.enqueued.length, 0);
});

test("cancelar un posted de una sola fase: error claro no reintentable y sin encolado", async () => {
  const mocks = resetMocks();
  mocks.callCancelTransferRPC = async () => ({
    success: false,
    error: "transfer_not_in_transit",
    errorCode: "P0001"
  });
  const harness = createHarness(
    [transferRow("ti-1", "op-posted-cancel-1", "in_transit")],
    [inventoryRow("wh-1", 3)]
  );

  const result = await harness.actions.cancelTransfer(["op-posted-cancel-1"]);
  assert.equal(result.success, false);
  assert.equal(result.pending, false, "no reintentable: no queda pendiente");
  assert.ok(/sola fase/.test(result.error), "explica que la nube no admite la cancelación");
  assert.equal(rowByIdentity(harness.getState(), "op-posted-cancel-1").status, "in_transit", "no se miente el estado");
  assert.equal(harness.getState().inventory[0].quantity, 3, "stock intacto");
  assert.equal(mocks.enqueued.length, 0, "sin encolado infinito");
});

// ---------------------------------------------------------------------------
// Estados ya resueltos por la nube
// ---------------------------------------------------------------------------

test("recibir un traslado que la nube ya canceló: asienta cancelado local sin crédito", async () => {
  const mocks = resetMocks();
  mocks.callReceiveTransferRPC = async () => ({
    success: false,
    error: "transfer_cancelled",
    errorCode: "P0001"
  });
  const harness = createHarness(
    [transferRow("ti-1", "op-cloud-cancelled-1", "in_transit")],
    [inventoryRow("wh-2", 10)]
  );

  const result = await harness.actions.receiveTransfer(["op-cloud-cancelled-1"]);
  assert.equal(result.success, true, "la nube ya lo resolvió: no es un error del usuario");
  assert.ok(result.warning && /cancelado en la nube/.test(result.warning));
  assert.equal(rowByIdentity(harness.getState(), "op-cloud-cancelled-1").status, "cancelled");
  assert.equal(harness.getState().inventory[0].quantity, 10, "sin crédito: la nube ya devolvió el stock");
  assert.equal(mocks.enqueued.length, 0);
});

test("recibir un traslado que no existe en la nube: asienta recibido local sin crédito y sin reintentos", async () => {
  const mocks = resetMocks();
  mocks.callReceiveTransferRPC = async () => ({
    success: false,
    error: "transfer_not_found",
    errorCode: "P0001"
  });
  const harness = createHarness(
    [transferRow("ti-1", "op-missing-1", "in_transit")],
    [inventoryRow("wh-2", 10)]
  );

  const result = await harness.actions.receiveTransfer(["op-missing-1"]);
  assert.equal(result.success, true);
  assert.ok(result.warning && /no existe en la nube/.test(result.warning));
  assert.equal(rowByIdentity(harness.getState(), "op-missing-1").status, "completed", "cambio visible siempre");
  assert.equal(harness.getState().inventory[0].quantity, 10, "sin inventar stock");
  assert.equal(mocks.enqueued.length, 0, "transfer_not_found jamás prosperará: no se encola");
});

// ---------------------------------------------------------------------------
// Helpers puros compartidos con la cola offline
// ---------------------------------------------------------------------------

test("classifyTransferResolutionError: clasifica los errores terminales del RPC", () => {
  const classify = (transferHistoryModule as any).classifyTransferResolutionError;
  assert.equal(classify("transfer_not_found", "P0001"), "not_found");
  assert.equal(classify("transfer_cancelled", "P0001"), "cancelled");
  assert.equal(classify("transfer_not_in_transit", "P0001"), "not_in_transit");
  assert.equal(classify("sin stock disponible", "P0001"), "retriable");
  assert.equal(classify("id inválido", "INVALID_OPERATION_ID"), "not_found");
});

test("settleTransferRows: con creditStock:false cambia el estado sin tocar el stock", () => {
  const settleTransferRows = (transferHistoryModule as any).settleTransferRows;
  const settled = settleTransferRows(
    [transferRow("ti-1", "op-x", "in_transit", { quantity: 5 })],
    [inventoryRow("wh-2", 10)],
    ["op-x"],
    "completed",
    { creditStock: false, creditSide: "toBranchId" }
  );
  assert.equal(settled.changed, true);
  assert.equal(settled.transfers[0].status, "completed");
  assert.equal(settled.inventory[0].quantity, 10, "sin crédito");

  const twice = settleTransferRows(settled.transfers, settled.inventory, ["op-x"], "completed", { creditStock: false });
  assert.equal(twice.changed, false, "idempotente");
});

// ---------------------------------------------------------------------------
// Cableado: la cola offline también tolera los errores terminales
// ---------------------------------------------------------------------------

test("processQueueItem: la cola clasifica errores terminales y registra overrides para posted", () => {
  const sourceText = readFileSync(join(process.cwd(), "src/services/offline/processQueueItem.ts"), "utf8");
  assert.ok(sourceText.includes("classifyTransferResolutionError("), "la cola clasifica en lugar de reintentar a ciegas");
  assert.ok(sourceText.includes("registerTransferStatusOverrides(postedIds, 'completed')"), "la cola registra el override de posted recibidos");
  assert.ok(sourceText.includes("retryableIds.length"), "solo los transitorios reintentan");
});
