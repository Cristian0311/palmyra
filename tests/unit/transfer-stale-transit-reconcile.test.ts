import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

/**
 * Reconciliación de traslados "en tránsito" que la nube ya resolvió.
 *
 * Bug reportado por el cliente: la sección de transferencias muestra
 * traslados en tránsito que piden confirmar/cancelar, pero al pulsar la nube
 * responde que ya lo tenía registrado. La causa: la identidad local (p. ej.
 * `invrec:<uuid>` de las colas legacy) no coincide textualmente con la de la
 * nube (`<uuid>`), así que los merges nunca las enlazan y la fila local
 * reaparece accionable para siempre.
 *
 * Regresiones que cubre:
 *  1) Normalización de identidades: prefijos legacy → uuid canónico.
 *  2) filterLocalTransfers: una fila local en tránsito cuya identidad ya
 *     llegó de la nube se descarta, aunque el id textual difiera.
 *  3) settleTransferRows: asienta por identidad normalizada (ids con prefijo
 *     legacy alcanzan filas locales con uuid pelado y viceversa).
 *  4) Overrides de resolución: una fila legacy que reaparece en tránsito se
 *     fuerza al estado real en todos los merges.
 *  5) mergeTransferLists: la operación resuelta por la nube no convive con
 *     su copia local accionable.
 */

(globalThis as any).__VITE_ENV__ = {};
Object.defineProperty(globalThis, "navigator", {
  value: { onLine: true },
  configurable: true,
  writable: true
});

const MOCKS: Record<string, string> = {
  "/src/services/tenant.ts": `
export async function getActiveTenant() {
  return { companyId: '11111111-1111-4111-8111-111111111111' };
}
`
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

const repositories = await import(
  pathToFileURL(resolve(process.cwd(), "src/services/localDb/repositories.ts")).href
);
const transferHistory = await import(
  pathToFileURL(resolve(process.cwd(), "src/services/cloudSync/transferHistory.ts")).href
);

const UUID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UUID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function row(id: string, operationId: string, status: string) {
  return {
    id, operationId, productId: "p-1", productName: "Arroz",
    fromBranchId: "wh-1", fromBranchName: "Centro",
    toBranchId: "wh-2", toBranchName: "Vedado",
    quantity: 5, date: "2026-11-23T12:00:00.000Z", userId: "u-1", status
  };
}

function inventory(branchId: string, quantity: number) {
  return { id: `inv-${branchId}`, productId: "p-1", branchId, variantLabel: undefined, quantity, minQuantity: 5 };
}

// ---------------------------------------------------------------------------
// 1) Normalización de identidades
// ---------------------------------------------------------------------------

test("normalizeTransferOperationId: prefijos legacy → uuid canónico", () => {
  const norm = (repositories as any).normalizeTransferOperationId;
  assert.equal(norm(`invrec:${UUID_A}`), UUID_A, "prefijo de recepción legacy");
  assert.equal(norm(`transfer:${UUID_A}`), UUID_A, "prefijo de traslado legacy");
  assert.equal(norm(`INVREC:${UUID_A}`), UUID_A, "mayúsculas no importan");
  assert.equal(norm(UUID_A), UUID_A, "uuid pelado queda igual");
  assert.equal(norm(`op-legacy-1`), "op-legacy-1", "identidad no-uuid se conserva");
  assert.equal(norm(""), "", "vacío queda vacío");
});

// ---------------------------------------------------------------------------
// 2) filterLocalTransfers enlaza por identidad normalizada
// ---------------------------------------------------------------------------

test("filterLocalTransfers: la fila local en tránsito desaparece si la nube ya trae la operación", () => {
  const filterLocalTransfers = (repositories as any).filterLocalTransfers;
  const local = [
    row("line-local-1", `invrec:${UUID_A}`, "in_transit"),
    row("line-local-2", UUID_B, "in_transit")
  ];
  const remote = [
    row("line-cloud-1", UUID_A, "completed")
  ];
  const kept = filterLocalTransfers(local, remote);
  assert.equal(kept.length, 1, "solo sobrevive la operación que la nube no trae");
  assert.equal(kept[0].operationId, UUID_B);
});

test("filterLocalTransfers: conserva lo que la nube no conoce aunque esté en tránsito", () => {
  const filterLocalTransfers = (repositories as any).filterLocalTransfers;
  const local = [row("line-local-1", UUID_A, "in_transit")];
  const kept = filterLocalTransfers(local, []);
  assert.equal(kept.length, 1, "un traslado despachado offline aún no está en la nube: sigue accionable");
});

// ---------------------------------------------------------------------------
// 3) settleTransferRows asienta por identidad normalizada
// ---------------------------------------------------------------------------

test("settleTransferRows: un id con prefijo legacy asienta la fila local con uuid pelado", () => {
  const settleTransferRows = (transferHistory as any).settleTransferRows;
  const settled = settleTransferRows(
    [row("line-local-1", UUID_A, "in_transit")],
    [inventory("wh-2", 10)],
    [`invrec:${UUID_A}`],
    "completed",
    { creditStock: false }
  );
  assert.equal(settled.changed, true);
  assert.equal(settled.transfers[0].status, "completed");
  assert.equal(settled.inventory[0].quantity, 10, "sin crédito: la nube ya resolvió el stock");
});

// ---------------------------------------------------------------------------
// 4) Overrides: una resolución confirmada nunca reaparece en tránsito
// ---------------------------------------------------------------------------

test("applyTransferStatusOverrides: fuerza el estado real a identidades resueltas", () => {
  const { applyTransferStatusOverrides, registerTransferStatusOverrides } = transferHistory as any;
  registerTransferStatusOverrides([`invrec:${UUID_A}`], "completed");
  const rows = [
    row("line-local-1", UUID_A, "in_transit"),
    row("line-local-2", UUID_B, "in_transit")
  ];
  const applied = applyTransferStatusOverrides(rows);
  assert.equal(applied.find((t: any) => t.id === "line-local-1").status, "completed");
  assert.equal(applied.find((t: any) => t.id === "line-local-2").status, "in_transit", "sin override no se toca");
  assert.notEqual(applied, rows, "devuelve una copia: no muta la entrada");
});

test("applyTransferStatusOverrides: respeta el estado terminal ya asentado", () => {
  const { applyTransferStatusOverrides, registerTransferStatusOverrides } = transferHistory as any;
  registerTransferStatusOverrides([UUID_A], "cancelled");
  const rows = [row("line-local-1", UUID_A, "completed")];
  const applied = applyTransferStatusOverrides(rows);
  assert.equal(applied[0].status, "completed", "una fila ya cerrada no se pisa por el override");
});

test("applyTransferStatusOverrides: sin overrides devuelve copia intacta", () => {
  const { applyTransferStatusOverrides } = transferHistory as any;
  const getMap = (transferHistory as any).getTransferStatusOverrides;
  const before = getMap().size;
  const rows = [row("line-local-2", UUID_B, "in_transit")];
  const applied = applyTransferStatusOverrides(rows);
  assert.equal(getMap().size, before, "no registra nada por aplicar");
  assert.equal(applied[0].status, "in_transit", "sin override para la identidad no se toca");
});

// ---------------------------------------------------------------------------
// 5) mergeTransferLists: no conviven la operación local y su copia remota
// ---------------------------------------------------------------------------

test("mergeTransferLists: la copia local accionable no sobrevive junto a la remota resuelta", () => {
  const mergeTransferLists = (repositories as any).mergeTransferLists;
  const local = [row("line-local-1", `invrec:${UUID_A}`, "in_transit")];
  const remote = [row("line-cloud-1", UUID_A, "completed")];
  const merged = mergeTransferLists(remote, local);
  assert.equal(merged.length, 1, "una sola fila para la operación");
  assert.equal(merged[0].status, "completed", "manda el estado de la nube");
});

test("dedupeTransferRows: solape de paginación por id de línea", () => {
  const dedupeTransferRows = (repositories as any).dedupeTransferRows;
  const rows = [row("line-cloud-1", UUID_A, "completed"), row("line-cloud-1", UUID_A, "completed")];
  assert.equal(dedupeTransferRows(rows).length, 1);
});
