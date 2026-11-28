import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

/**
 * Regresiones de concurrencia en la sincronización (auditoría post-1.3.20).
 *
 * 1) El log de sincronización reescribía 200 filas en localStorage por cada
 *    elemento de la cola: un vaciado bloqueaba el hilo y el `crypto.randomUUID`
 *    del WebView antiguo podía tumbar el encolado. Ahora hay caché + escritura
 *    agrupada, y el archivo nunca mezcla empresas.
 * 2) `revoke-lease` exige JWT: sin cabecera la pasarela respondía 401 y cada
 *    refresco repetía la misma petición muerta (un fallo además se cacheaba 5 min).
 * 3) Dos refrescos canónicos de inventario sobre el mismo almacén podían escribir
 *    la instantánea vieja después de la nueva.
 * 4) Cambiar de empresa mientras el runtime de licencia tenía una pasada en vuelo
 *    le dejaba a la empresa nueva el veredicto de la anterior.
 */

// ---------------------------------------------------------------------------
// Entorno de navegador mínimo (el log agrupa writes usando `window`)
// ---------------------------------------------------------------------------

(globalThis as any).__VITE_ENV__ = {};

type Listener = (event?: any) => void;

function createBrowserStub() {
  const store = new Map<string, string>();
  const windowListeners = new Map<string, Listener[]>();
  const documentListeners = new Map<string, Listener[]>();
  let writes = 0;

  const scope = (type: string) => store.get("palmyra_local_scope_v1") || "";

  const localStorageStub = {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => {
      writes += 1;
      store.set(key, String(value));
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => store.clear(),
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    }
  };

  const windowStub = {
    setTimeout: (...args: any[]) => (setTimeout as any)(...args),
    clearTimeout: (...args: any[]) => (clearTimeout as any)(...args),
    addEventListener: (type: string, fn: Listener) => {
      const list = windowListeners.get(type) || [];
      list.push(fn);
      windowListeners.set(type, list);
    },
    removeEventListener: (type: string, fn: Listener) => {
      const list = windowListeners.get(type) || [];
      const at = list.indexOf(fn);
      if (at >= 0) list.splice(at, 1);
    },
    dispatchEvent: (event: any) => {
      const list = windowListeners.get(event?.type) || [];
      for (const fn of [...list]) fn(event);
      return true;
    },
    fetch: undefined,
    __scopeProbe: scope
  };

  const documentStub = {
    visibilityState: "visible",
    addEventListener: (type: string, fn: Listener) => {
      const list = documentListeners.get(type) || [];
      list.push(fn);
      documentListeners.set(type, list);
    },
    removeEventListener: () => {}
  };

  Object.defineProperty(globalThis, "localStorage", {
    value: localStorageStub,
    configurable: true,
    writable: true
  });
  Object.defineProperty(globalThis, "window", {
    value: windowStub,
    configurable: true,
    writable: true
  });
  Object.defineProperty(globalThis, "document", {
    value: documentStub,
    configurable: true,
    writable: true
  });

  return {
    store,
    writes: () => writes,
    setScope(userId: string, companyId: string) {
      store.set("palmyra_local_scope_v1", JSON.stringify({ userId, companyId }));
    },
    raw(key: string) {
      const value = store.get(key);
      return value ? JSON.parse(value) : null;
    },
    fireWindow(type: string) {
      for (const fn of [...(windowListeners.get(type) || [])]) fn({ type });
    },
    hidePage() {
      documentStub.visibilityState = "hidden";
      for (const fn of [...(documentListeners.get("visibilitychange") || [])]) fn({ type: "visibilitychange" });
      documentStub.visibilityState = "visible";
    }
  };
}

const browser = createBrowserStub();
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
const LOG_KEY = (userId: string, companyId: string) => `palmyra_sync_logs_v2__${userId}__${companyId}`;

// ---------------------------------------------------------------------------
// Cargador de mocks para el refresco canónico de almacenes
// ---------------------------------------------------------------------------

const SUPABASE_SYNC_MOCK = `
const M = () => (globalThis.__syncMocks__ || {});
export async function pullBranchInventoryFromSupabase(branchId) {
  const m = M();
  if (!m.pullCalls) m.pullCalls = [];
  m.pullCalls.push(branchId);
  if (m.pullBranchInventoryFromSupabase) return m.pullBranchInventoryFromSupabase(branchId, m.pullCalls.length);
  return { success: true, inventory: [] };
}
`;

const MOCKS: Record<string, string> = {
  "/src/services/supabaseSync.ts": SUPABASE_SYNC_MOCK
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
  "  return nextLoad(url, context);",
  "}"
].join("\n");
register("data:text/javascript;charset=utf-8," + encodeURIComponent(LOADER));

const syncLoggerModule = await import(
  pathToFileURL(resolve(process.cwd(), "src/utils/syncLogger.ts")).href
);
const revocationModule = await import(
  pathToFileURL(resolve(process.cwd(), "src/services/license/revocation.ts")).href
);
const branchRefreshModule = await import(
  pathToFileURL(resolve(process.cwd(), "src/store/utils/refreshBranchInventory.ts")).href
);

const { addSyncLog, getSyncLogs, clearSyncLogs } = syncLoggerModule as any;
const { checkLeaseRevocation, resetLeaseRevocationCache } = revocationModule as any;
const { refreshInventoryBranchesFromSupabase } = branchRefreshModule as any;

// ---------------------------------------------------------------------------
// 1) syncLogger: escritura agrupada y aislamiento por empresa
// ---------------------------------------------------------------------------

test("una ráfaga de la cola produce UNA sola escritura en localStorage", async () => {
  browser.setScope("u1", "c1");
  clearSyncLogs();

  const before = browser.writes();
  for (let i = 0; i < 25; i += 1) {
    addSyncLog({ level: "info", source: "offline_queue", title: `item ${i}` });
  }
  assert.equal(browser.writes(), before, "dentro del mismo tick no se serializa nada");
  assert.equal(getSyncLogs().length, 25, "la caché responde sin tocar la red de disco");
  assert.equal(browser.writes(), before, "leer la lista tampoco escribe");

  await wait(520);
  assert.equal(browser.writes(), before + 1, "la ráfaga completa se serializa una sola vez");
  const stored = browser.raw(LOG_KEY("u1", "c1"));
  assert.equal(stored.length, 25);
  assert.equal(stored[0].title, "item 24", "lo más nuevo primero");
});

test("el techo de 200 registros se mantiene sin escribir en cada alta", async () => {
  browser.setScope("u1", "c1");
  clearSyncLogs();

  const before = browser.writes();
  for (let i = 0; i < 250; i += 1) {
    addSyncLog({ level: "warning", source: "network", title: `e${i}` });
  }
  assert.equal(getSyncLogs().length, 200);
  assert.equal(browser.writes(), before, "250 altas no son 250 escrituras");

  await wait(520);
  assert.equal(browser.writes(), before + 1);
  assert.equal(browser.raw(LOG_KEY("u1", "c1")).length, 200);
  assert.equal(browser.raw(LOG_KEY("u1", "c1"))[0].title, "e249");
});

test("cambiar de empresa persiste lo pendiente del alcance anterior y no mezcla registros", async () => {
  browser.setScope("u1", "c1");
  clearSyncLogs();
  for (let i = 0; i < 3; i += 1) addSyncLog({ level: "error", source: "supabase_rpc", title: `c1-${i}` });

  browser.setScope("u1", "c2");
  assert.equal(getSyncLogs().length, 0, "la empresa nueva no hereda los registros de la anterior");
  assert.equal(browser.raw(LOG_KEY("u1", "c1")).length, 3, "lo pendiente quedó escrito antes de cambiar de clave");
  assert.equal(browser.store.has(LOG_KEY("u1", "c2")), false);

  addSyncLog({ level: "info", source: "realtime", title: "c2-unico" });
  await wait(520);
  assert.equal(browser.raw(LOG_KEY("u1", "c2")).length, 1);
  assert.equal(browser.raw(LOG_KEY("u1", "c1")).length, 3, "el alcance viejo no se pisa");
});

test("cerrar la pestaña no deja registros pendientes en memoria", async () => {
  browser.setScope("u1", "c1");
  clearSyncLogs();
  const before = browser.writes();
  addSyncLog({ level: "success", source: "background_sync", title: "pendiente-1" });
  addSyncLog({ level: "success", source: "background_sync", title: "pendiente-2" });
  assert.equal(browser.writes(), before);

  browser.fireWindow("pagehide");
  assert.equal(browser.writes(), before + 1, "pagehide fuerza el vaciado");
  assert.equal(browser.raw(LOG_KEY("u1", "c1")).length, 2);

  const afterFlush = browser.writes();
  await wait(520);
  assert.equal(browser.writes(), afterFlush, "el timer pendiente se canceló: no hay escritura duplicada");
});

test("ocultar la pestaña también vacía el búfer", async () => {
  browser.setScope("u1", "c1");
  clearSyncLogs();
  const before = browser.writes();
  addSyncLog({ level: "info", source: "network", title: "alt-tab" });
  browser.hidePage();
  assert.equal(browser.writes(), before + 1);
  assert.equal(browser.raw(LOG_KEY("u1", "c1")).length, 1);
});

test("un registro corrupto en localStorage no invalida el archivo completo", async () => {
  browser.setScope("u1", "c1");
  clearSyncLogs();
  const dirtyKey = LOG_KEY("u1", "c1-corrupt");
  browser.store.set(
    dirtyKey,
    JSON.stringify([{ level: "info" }, { level: "error", source: "network", title: "real" }, "basura", null])
  );
  // La caché apunta a c1: al cambiar de alcance se relee el archivo nuevo.
  browser.setScope("u1", "c1-corrupt");
  const logs = getSyncLogs();
  assert.equal(logs.length, 1, "sobrevive la fila válida y se descartan las inválidas");
  assert.equal(logs[0].title, "real");

  browser.setScope("u1", "c1");
  clearSyncLogs();
  const brokenKey = LOG_KEY("u1", "c1-nojson");
  browser.store.set(brokenKey, "{no es json");
  browser.setScope("u1", "c1-nojson");
  assert.deepEqual(getSyncLogs(), [], "un archivo ilegible empieza vacío, nunca revienta");
});

test("el identificador no depende de crypto.randomUUID", async () => {
  browser.setScope("u1", "c1");
  clearSyncLogs();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  try {
    Object.defineProperty(globalThis, "crypto", {
      value: {},
      configurable: true,
      writable: true
    });
    const entry = addSyncLog({ level: "info", source: "offline_queue", title: "sin randomUUID" });
    assert.equal(typeof entry.id, "string");
    assert.ok(entry.id.length > 0, "el log se crea igual: un fallo de diagnóstico no puede tumbar el negocio");
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "crypto", descriptor);
  }
});

// ---------------------------------------------------------------------------
// 2) revoke-lease: un GET por ráfaga, con JWT, y los fallos no se cachean
// ---------------------------------------------------------------------------

const REVOCATION_NOW = Date.parse("2026-11-27T12:00:00.000Z");

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

test("varias comprobaciones simultáneas del mismo lease comparten un único GET", async () => {
  resetLeaseRevocationCache();
  let calls = 0;
  let release: (() => void) | null = null;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  const fetchImpl = async () => {
    calls += 1;
    await gate;
    return response({ revoked: false });
  };

  const lease = { leaseId: "lease-shared" } as any;
  const pending = [
    checkLeaseRevocation(lease, { baseUrl: "https://proj/functions/v1", fetchImpl, now: () => REVOCATION_NOW }),
    checkLeaseRevocation(lease, { baseUrl: "https://proj/functions/v1", fetchImpl, now: () => REVOCATION_NOW }),
    checkLeaseRevocation(lease, { baseUrl: "https://proj/functions/v1", fetchImpl, now: () => REVOCATION_NOW })
  ];
  assert.equal(calls, 1, "las tres llamadas entran en el mismo tick");
  release!();
  const results = await Promise.all(pending);
  assert.equal(calls, 1);
  assert.deepEqual(results, [{ revoked: false }, { revoked: false }, { revoked: false }]);

  const again = await checkLeaseRevocation(lease, {
    baseUrl: "https://proj/functions/v1",
    fetchImpl,
    now: () => REVOCATION_NOW
  });
  assert.equal(calls, 1, "ya concluida, la respuesta buena se sirve de caché");
  assert.deepEqual(again, { revoked: false });
});

test("la consulta manda el JWT de sesión en Authorization", async () => {
  resetLeaseRevocationCache();
  let headers: Record<string, string> | null = null;
  const fetchImpl = async (_url: string, init?: RequestInit) => {
    headers = (init?.headers || {}) as Record<string, string>;
    return response({ revoked: false });
  };
  await checkLeaseRevocation({ leaseId: "lease-hdr" } as any, {
    baseUrl: "https://proj/functions/v1",
    fetchImpl,
    accessToken: "  jwt-de-sesion  ",
    now: () => REVOCATION_NOW
  });
  assert.ok(headers, "hubo petición");
  assert.equal(headers!.Authorization, "Bearer jwt-de-sesion", "la pasarela exige el JWT (verify_jwt=true)");
  assert.equal(headers!.Accept, "application/json");
});

test("sin token no se envía Authorization y el fallo no se cachea", async () => {
  resetLeaseRevocationCache();
  let calls = 0;
  let sawAuth = false;
  const fetchImpl = async (_url: string, init?: RequestInit) => {
    calls += 1;
    const headers = (init?.headers || {}) as Record<string, string>;
    if (headers.Authorization) sawAuth = true;
    return response({ error: "unauthorized" }, 401);
  };
  const options = { baseUrl: "https://proj/functions/v1", fetchImpl, now: () => REVOCATION_NOW };

  const first = await checkLeaseRevocation({ leaseId: "lease-401" } as any, options);
  assert.deepEqual(first, { revoked: false }, "un 401 jamás revoca: falla abierto");
  const second = await checkLeaseRevocation({ leaseId: "lease-401" } as any, options);
  assert.equal(calls, 2, "un fallo no puede quedar cacheado 5 min: ocultaría una revocación real");
  assert.deepEqual(second, { revoked: false });
  assert.equal(sawAuth, false);
});

test("una revocación explícita se aplica y se cachea", async () => {
  resetLeaseRevocationCache();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return response({ revoked: true, revokedAt: "2026-11-27T10:00:00Z", reason: "plan cancelado" });
  };
  const options = { baseUrl: "https://proj/functions/v1", fetchImpl, now: () => REVOCATION_NOW };
  const result = await checkLeaseRevocation({ leaseId: "lease-rev" } as any, options);
  assert.equal(result.revoked, true);
  assert.equal(result.reason, "plan cancelado");
  assert.equal(result.revokedAt, "2026-11-27T10:00:00.000Z");
  const cached = await checkLeaseRevocation({ leaseId: "lease-rev" } as any, options);
  assert.equal(calls, 1);
  assert.equal(cached.revoked, true);
});

test("un fallo de red o un cuerpo inválido nunca revocan", async () => {
  resetLeaseRevocationCache();
  const throwing = await checkLeaseRevocation({ leaseId: "lease-net" } as any, {
    baseUrl: "https://proj/functions/v1",
    fetchImpl: async () => {
      throw new Error("offline");
    },
    now: () => REVOCATION_NOW
  });
  assert.deepEqual(throwing, { revoked: false });

  resetLeaseRevocationCache();
  const garbage = await checkLeaseRevocation({ leaseId: "lease-bad" } as any, {
    baseUrl: "https://proj/functions/v1",
    fetchImpl: async () => new Response("<html>502</html>", { status: 200 }),
    now: () => REVOCATION_NOW
  });
  assert.deepEqual(garbage, { revoked: false });

  resetLeaseRevocationCache();
  const noBase = await checkLeaseRevocation({ leaseId: "lease-nb" } as any, {
    baseUrl: null,
    fetchImpl: async () => {
      throw new Error("no debe llamar a la red");
    },
    now: () => REVOCATION_NOW
  });
  assert.deepEqual(noBase, { revoked: false }, "sin base de funciones no se sale a la red");
});

// ---------------------------------------------------------------------------
// 3) Refresco canónico de inventario: una lectura y un `set` por ráfaga
// ---------------------------------------------------------------------------

function inventoryRow(branchId: string, quantity: number, productId = "p-1", variantLabel?: string) {
  return { id: `inv-${branchId}-${productId}`, productId, branchId, variantLabel, quantity, minQuantity: 5 };
}

function resetSyncMocks(): any {
  const mocks: any = { pullCalls: [] };
  (globalThis as any).__syncMocks__ = mocks;
  return mocks;
}

function createStoreHarness(inventory: any[]) {
  let state: any = { inventory };
  let sets = 0;
  const set = (partial: any) => {
    sets += 1;
    const patch = typeof partial === "function" ? partial(state) : partial;
    state = { ...state, ...patch };
  };
  return {
    set,
    get: () => state,
    sets: () => sets,
    rows: () => state.inventory
  };
}

test("dos refrescos del mismo almacén comparten una lectura y un solo set", async () => {
  const mocks = resetSyncMocks();
  let release: (() => void) | null = null;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  mocks.pullBranchInventoryFromSupabase = async (branchId: string) => {
    await gate;
    return { success: true, inventory: [inventoryRow(branchId, 7)] };
  };

  const store = createStoreHarness([inventoryRow("wh-2", 1)]);
  try {
    const first = refreshInventoryBranchesFromSupabase(store.set, store.get, ["wh-2"]);
    const second = refreshInventoryBranchesFromSupabase(store.set, store.get, ["wh-2"]);
    // El orden inverso también es el mismo conjunto: la clave se normaliza.
    const third = refreshInventoryBranchesFromSupabase(store.set, store.get, ["wh-2"]);
    assert.equal(mocks.pullCalls.length, 1, "la segunda llamada entra en la tarea que ya está en vuelo");
    release!();

    assert.deepEqual(await Promise.all([first, second, third]), [true, true, true]);
    assert.equal(mocks.pullCalls.length, 1, "una sola lectura canónica por ráfaga");
    assert.equal(store.sets(), 1, "un solo set: no se escribe la instantánea vieja después de la nueva");
    assert.equal(store.rows().length, 1);
    assert.equal(store.rows()[0].quantity, 7);
  } finally {
    release?.();
  }
});

test("la tarea en vuelo se libera al resolver: el siguiente refresco vuelve a leer", async () => {
  const mocks = resetSyncMocks();
  mocks.pullBranchInventoryFromSupabase = async (branchId: string) => ({
    success: true,
    inventory: [inventoryRow(branchId, 4)]
  });
  const store = createStoreHarness([inventoryRow("wh-7", 1)]);
  await refreshInventoryBranchesFromSupabase(store.set, store.get, ["wh-7"]);
  await refreshInventoryBranchesFromSupabase(store.set, store.get, ["wh-7"]);
  assert.equal(mocks.pullCalls.length, 2, "la deduplicación solo cubre lo que sigue en vuelo");
  assert.equal(store.sets(), 2);
});

test("conjuntos distintos de almacenes se refrescan por separado", async () => {
  const mocks = resetSyncMocks();
  mocks.pullBranchInventoryFromSupabase = async (branchId: string) => ({
    success: true,
    inventory: [inventoryRow(branchId, branchId === "wh-1" ? 11 : 22)]
  });
  const store = createStoreHarness([inventoryRow("wh-1", 1), inventoryRow("wh-2", 1), inventoryRow("wh-3", 1)]);

  const ok = await refreshInventoryBranchesFromSupabase(store.set, store.get, ["wh-1", "wh-2"]);
  assert.equal(ok, true);
  assert.equal(mocks.pullCalls.length, 2);

  const ok2 = await refreshInventoryBranchesFromSupabase(store.set, store.get, ["wh-3"]);
  assert.equal(ok2, true);
  assert.equal(mocks.pullCalls.length, 3, "el conjunto nuevo no se lo come la deduplicación");
  assert.equal(store.sets(), 2);

  const byBranch: Record<string, number> = {};
  store.rows().forEach((row: any) => {
    byBranch[row.branchId] = row.quantity;
  });
  assert.deepEqual(byBranch, { "wh-1": 11, "wh-2": 22, "wh-3": 22 });
});

test("un pull fallido no reescribe el inventario local", async () => {
  const mocks = resetSyncMocks();
  mocks.pullBranchInventoryFromSupabase = async (branchId: string) =>
    branchId === "wh-2" ? { success: false, inventory: [] } : { success: true, inventory: [inventoryRow(branchId, 9)] };
  const store = createStoreHarness([inventoryRow("wh-1", 3), inventoryRow("wh-2", 4)]);

  const ok = await refreshInventoryBranchesFromSupabase(store.set, store.get, ["wh-1", "wh-2"]);
  assert.equal(ok, false, "el llamador necesita saber que la conciliación quedó incompleta");
  assert.equal(store.sets(), 0, "sin datos completos no se toca el estado");
  assert.deepEqual(
    store.rows().map((row: any) => row.quantity),
    [3, 4]
  );
});

test("la nube manda sobre la fila local del almacén pedido: no hay protección de filas locales", async () => {
  const mocks = resetSyncMocks();
  mocks.pullBranchInventoryFromSupabase = async () => ({
    success: true,
    inventory: [inventoryRow("wh-2", 7), inventoryRow("wh-2", 2, "p-2")]
  });
  // Movimiento concurrente de otro equipo que el cambio local refleja todavía.
  const store = createStoreHarness([inventoryRow("wh-2", 50), inventoryRow("wh-9", 111)]);

  const ok = await refreshInventoryBranchesFromSupabase(store.set, store.get, ["wh-2"]);
  assert.equal(ok, true);
  const byRow: Record<string, number> = {};
  store.rows().forEach((row: any) => {
    byRow[`${row.branchId}:${row.productId}`] = row.quantity;
  });
  assert.deepEqual(Object.keys(byRow).sort(), ["wh-2:p-1", "wh-2:p-2", "wh-9:p-1"]);
  assert.equal(byRow["wh-2:p-1"], 7, "los RPC de traslado asientan stock_balances en su transacción: la nube ya trae el movimiento");
  assert.equal(byRow["wh-2:p-2"], 2);
  assert.equal(byRow["wh-9:p-1"], 111, "los demás almacenes se conservan");
});

test("sin almacenes pedidos no se sale a la red", async () => {
  const mocks = resetSyncMocks();
  const store = createStoreHarness([inventoryRow("wh-1", 1)]);
  assert.equal(await refreshInventoryBranchesFromSupabase(store.set, store.get, []), true);
  assert.equal(await refreshInventoryBranchesFromSupabase(store.set, store.get, ["", null as any]), true);
  assert.equal(mocks.pullCalls.length, 0);
  assert.equal(store.sets(), 0);
});

// ---------------------------------------------------------------------------
// 4) Contrato de fuente: los disparadores que mantienen viva la sincronización
// ---------------------------------------------------------------------------

const source = (relative: string) => readFileSync(resolve(process.cwd(), relative), "utf8");

test("useCloudSync reacciona al cambio de alcance local", () => {
  const text = source("src/hooks/useCloudSync.ts");
  assert.match(text, /PALMYRA_LOCAL_SCOPE_EVENT/, "sin el evento, el runner queda inerte toda la sesión");
  assert.match(text, /addEventListener\(\s*PALMYRA_LOCAL_SCOPE_EVENT/, "debe escucharlo, no solo importarlo");
});

test("el runtime de licencia no reasigna la empresa a una pasada en vuelo", () => {
  const text = source("src/services/license/runtime.ts");
  const block = text.match(/if \(inFlight\) \{[\s\S]*?\n {2}\}/);
  assert.ok(block, "existe la rama de tarea en vuelo");
  assert.doesNotMatch(block![0], /companyId\s*=\s*(?!=)/, "reasignar companyId dejaría el veredicto de la empresa anterior");
  assert.match(block![0], /pendingCompanyId\s*=/, "la empresa nueva se pospone a una pasada limpia");
  assert.match(text, /if \(pending && pending !== companyId[\s\S]*?void refresh\(\{ companyId: pending \}\)/);
});

test("el refresco canónico de inventario vive en un único módulo", () => {
  const files = [
    "src/store/actions/inventoryActions.ts",
    "src/store/actions/posActions.ts",
    "src/store/useStore.ts"
  ];
  for (const file of files) {
    const text = source(file);
    assert.doesNotMatch(text, /function refreshInventoryBranchesFromSupabase/, `${file} duplicaba el refresco`);
  }
  assert.match(source("src/store/actions/inventoryActions.ts"), /from '\.\.\/utils\/refreshBranchInventory'/);
  assert.match(source("src/store/actions/posActions.ts"), /from '\.\.\/utils\/refreshBranchInventory'/);
  const shared = source("src/store/utils/refreshBranchInventory.ts");
  assert.match(shared, /from '\.\.\/\.\.\/services\/supabaseSync'/, "importa la barrera para seguir siendo mockeable");
  assert.match(shared, /inFlight/);
});

test("el merge del pull respeta el trabajo offline sin cursor congelado", () => {
  const merges = source("src/store/utils/syncMerges.ts");
  assert.match(merges, /offlineIds/, "las filas encoladas no las pisa el snapshot remoto");
  const build = source("src/store/utils/buildSupabaseSyncState.ts");
  assert.doesNotMatch(build, /i\.data\.id/, "los identificadores remotos se leen con guarda opcional");
});
