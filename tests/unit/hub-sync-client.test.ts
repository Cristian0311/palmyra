import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { HUB_AUTH_HEADERS } from "../../src/services/lanHub/auth";
import {
  HubSyncError,
  pullHubChanges,
  type HubChange
} from "../../src/services/lanHub/syncClient";
import { createMemoryDriver } from "../../src/services/localDb/memoryDriver";
import type { LocalDbDriver, LocalRow } from "../../src/services/localDb/contract";
import type { CursorStore } from "../../src/services/cloudSync/contract";

const TOKEN = "token-sync-secreto_ABC123";
const DEVICE = "pc-secundario";
const COMPANY = "co-1";
const OTHER_COMPANY = "co-ajena";
const FIXED_MS = Date.parse("2026-05-01T12:00:00.000Z");
const EARLY = "2026-05-01T10:00:00.000Z";
const LATE = "2026-05-01T12:00:00.000Z";
const BASE_URL = "http://192.168.1.10:48900";
const CHANGES_PATH = "/lan/v1/changes";

interface FetchCall {
  url: string;
  init: RequestInit;
}

/** Fetch simulado: devuelve una página por llamada y repite la última. */
function makeFetch(pages: unknown[]) {
  const calls: FetchCall[] = [];
  let index = 0;
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: typeof input === "string" ? input : input.toString(), init: init ?? {} });
    const body = pages[Math.min(index, pages.length - 1)];
    index += 1;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;
  return { calls, impl };
}

function headersOf(call: FetchCall): Record<string, string> {
  return call.init.headers as Record<string, string>;
}

/** Implementación independiente de la firma, como la del hub. */
function expectedSignature(
  method: string,
  path: string,
  timestamp: number,
  nonce: string,
  body: string
): string {
  const key = createHash("sha256").update(TOKEN).digest("hex");
  const bodyHash = createHash("sha256").update(body, "utf8").digest("hex");
  const canonical = [method.toUpperCase(), path, String(timestamp), nonce, bodyHash].join("\n");
  return createHmac("sha256", key).update(canonical, "utf8").digest("hex");
}

function assertSigned(call: FetchCall): void {
  const headers = headersOf(call);
  assert.equal(call.init.method, "GET");
  assert.equal(headers[HUB_AUTH_HEADERS.device], DEVICE);
  assert.match(headers[HUB_AUTH_HEADERS.nonce], /^[0-9a-f]{32}$/);
  // La firma cubre la ruta sin query y el cuerpo vacío de un GET.
  assert.equal(
    headers[HUB_AUTH_HEADERS.signature],
    expectedSignature(
      "GET",
      CHANGES_PATH,
      Number(headers[HUB_AUTH_HEADERS.timestamp]),
      headers[HUB_AUTH_HEADERS.nonce],
      ""
    )
  );
  assert.equal(call.url.includes(TOKEN), false);
  assert.equal(call.url.includes(DEVICE), false);
}

function product(id: string, overrides: Partial<LocalRow> = {}): LocalRow {
  return {
    id,
    company_id: COMPANY,
    version: 1,
    updated_at: LATE,
    origin_device: "hub",
    deleted_at: null,
    name: `Producto ${id}`,
    ...overrides
  };
}

function upsert(seq: number, row: LocalRow): HubChange {
  return {
    seq,
    table: "products",
    row_id: row.id,
    op: "upsert",
    company_id: row.company_id,
    updated_at: row.updated_at,
    origin_device: row.origin_device,
    row
  };
}

function tombstone(seq: number, id: string, at = LATE, companyId = COMPANY): HubChange {
  return {
    seq,
    table: "products",
    row_id: id,
    op: "delete",
    company_id: companyId,
    updated_at: at,
    origin_device: "hub"
  };
}

function page(changes: HubChange[], cursor: number, hasMore?: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = { ok: true, changes, cursor };
  if (hasMore !== undefined) body.hasMore = hasMore;
  return body;
}

function memoryCursors(initial: Record<string, number> = {}) {
  const values = new Map<string, number>(Object.entries(initial));
  const saves: Array<{ companyId: string; seq: number }> = [];
  const store: CursorStore = {
    async load(companyId) {
      return values.get(companyId) ?? 0;
    },
    async save(companyId, seq) {
      values.set(companyId, seq);
      saves.push({ companyId, seq });
    }
  };
  return { store, saves, value: (companyId: string) => values.get(companyId) ?? 0 };
}

/**
 * Envoltorio que prohíbe escribir por la puerta de atrás: si `syncClient`
 * usara `driver.put`/`driver.remove` en vez de `tx.*`, la prueba fallaría.
 */
function refuseDirectWrites(base: LocalDbDriver): LocalDbDriver {
  const fail = (): never => {
    throw new Error("applyHubChanges debe escribir solo con tx.put/tx.remove");
  };
  return { ...base, put: fail, remove: fail } as LocalDbDriver;
}

function pullInput(
  driver: LocalDbDriver,
  cursors: CursorStore,
  impl: typeof fetch,
  extra: { limit?: number; maxPages?: number } = {}
) {
  return {
    baseUrl: BASE_URL,
    token: TOKEN,
    deviceId: DEVICE,
    companyId: COMPANY,
    driver,
    cursors,
    fetchImpl: impl,
    now: () => FIXED_MS,
    ...extra
  };
}

test("una página vacía no escribe nada ni mueve el cursor", async () => {
  const driver = createMemoryDriver();
  await driver.ready();
  const cursors = memoryCursors({ [COMPANY]: 8 });
  const { calls, impl } = makeFetch([{ ok: true, changes: [], cursor: 3 }]);

  const result = await pullHubChanges(pullInput(driver, cursors.store, impl, { limit: 50 }));

  assert.equal(result.pages, 1);
  assert.equal(result.applied, 0);
  assert.equal(result.cursor, 8);
  assert.equal(cursors.value(COMPANY), 8);
  assert.deepEqual(cursors.saves, []);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/lan\/v1\/changes\?since=8&limit=50$/);
  assert.deepEqual(await driver.query({ table: "products" }), []);
  await driver.close();
});

test("recorre dos páginas, firma cada petición y confirma el cursor", async () => {
  const base = createMemoryDriver();
  await base.ready();
  // El cliente debe escribir únicamente a través de la transacción.
  const driver = refuseDirectWrites(base);
  const cursors = memoryCursors();
  const { calls, impl } = makeFetch([
    page([upsert(1, product("p1")), upsert(2, product("p2", { version: 2 }))], 2, true),
    page([upsert(3, product("p3", { version: 3 }))], 3, false)
  ]);

  const result = await pullHubChanges(pullInput(driver, cursors.store, impl, { limit: 2, maxPages: 5 }));

  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/lan\/v1\/changes\?since=0&limit=2$/);
  assert.match(calls[1].url, /\/lan\/v1\/changes\?since=2&limit=2$/);
  assertSigned(calls[0]);
  assertSigned(calls[1]);

  assert.equal(result.pages, 2);
  assert.equal(result.applied, 3);
  assert.equal(result.cursor, 3);
  assert.equal(cursors.value(COMPANY), 3);
  for (const id of ["p1", "p2", "p3"]) {
    assert.ok(await base.get("products", id), `${id} debería existir`);
  }
  await base.close();
});

test("un cursor del hub menor que el local no hace retroceder el cursor", async () => {
  const driver = createMemoryDriver();
  await driver.ready();
  const cursors = memoryCursors({ [COMPANY]: 10 });
  const { impl } = makeFetch([page([upsert(11, product("p1"))], 2, false)]);

  const result = await pullHubChanges(pullInput(driver, cursors.store, impl));

  // El cursor avanza solo hasta el último `seq` realmente aplicado.
  assert.equal(result.cursor, 11);
  assert.equal(cursors.value(COMPANY), 11);
  assert.deepEqual(cursors.saves, [{ companyId: COMPANY, seq: 11 }]);
  await driver.close();
});

test("aplica tombstones sobre filas existentes y descarta los de filas ausentes", async () => {
  const driver = createMemoryDriver();
  await driver.ready();
  await driver.put("products", [product("p1", { version: 1, updated_at: EARLY })]);
  const cursors = memoryCursors();
  const { impl } = makeFetch([page([tombstone(5, "p1"), tombstone(6, "p9")], 6, false)]);

  const result = await pullHubChanges(pullInput(driver, cursors.store, impl));

  assert.equal(result.deleted, 1);
  assert.equal(result.skipped, 1);
  assert.equal(await driver.get("products", "p1"), null);
  assert.equal(await driver.get("products", "p9"), null);
  assert.equal(result.cursor, 6);
  await driver.close();
});

test("ignora los cambios de otra empresa aunque compartan la página", async () => {
  const driver = createMemoryDriver();
  await driver.ready();
  const cursors = memoryCursors();
  const ajeno = product("ajeno", { company_id: OTHER_COMPANY, origin_device: "otro" });
  const { impl } = makeFetch([page([upsert(1, ajeno), upsert(2, product("propio"))], 2, false)]);

  const result = await pullHubChanges(pullInput(driver, cursors.store, impl));

  assert.equal(result.applied, 1);
  assert.equal(result.skipped, 1);
  assert.equal(await driver.get("products", "ajeno"), null);
  assert.ok(await driver.get("products", "propio"));
  assert.equal(result.cursor, 2);
  await driver.close();
});

test("una fila local más nueva gana y se reporta como conflicto", async () => {
  const driver = createMemoryDriver();
  await driver.ready();
  await driver.put("products", [product("p1", { version: 5, updated_at: LATE, name: "local" })]);
  const cursors = memoryCursors();
  const entrante = product("p1", { version: 3, updated_at: EARLY, name: "hub" });
  const { impl } = makeFetch([page([upsert(7, entrante)], 7, false)]);

  const result = await pullHubChanges(pullInput(driver, cursors.store, impl));

  const stored = await driver.get<LocalRow>("products", "p1");
  assert.equal(stored?.name, "local");
  assert.equal(result.applied, 0);
  assert.equal(result.conflicts, 1);
  assert.equal(result.cursor, 7);
  await driver.close();
});

test("un tombstone no borra una fila local más nueva", async () => {
  const driver = createMemoryDriver();
  await driver.ready();
  await driver.put("products", [product("p1", { version: 4, updated_at: LATE })]);
  const cursors = memoryCursors();
  const { impl } = makeFetch([page([tombstone(9, "p1", EARLY)], 9, false)]);

  const result = await pullHubChanges(pullInput(driver, cursors.store, impl));

  assert.ok(await driver.get("products", "p1"));
  assert.equal(result.deleted, 0);
  assert.equal(result.conflicts, 1);
  await driver.close();
});

test("una respuesta inválida produce un error claro y no escribe", async () => {
  const driver = createMemoryDriver();
  await driver.ready();
  const cursors = memoryCursors({ [COMPANY]: 4 });

  // Sin la lista de cambios no se puede aplicar nada.
  const sinCambios = makeFetch([{ ok: true, cursor: 9 }]);
  await assert.rejects(
    pullHubChanges(pullInput(driver, cursors.store, sinCambios.impl)),
    (error: unknown) => {
      assert.ok(error instanceof HubSyncError);
      assert.equal(error.code, "invalid_response");
      assert.match(error.message, /lista de cambios/);
      return true;
    }
  );
  assert.equal(cursors.value(COMPANY), 4);
  assert.deepEqual(cursors.saves, []);

  // Un upsert sin fila tampoco se escribe a medias.
  const cambioRoto = makeFetch([
    {
      ok: true,
      cursor: 5,
      changes: [
        {
          seq: 5,
          table: "products",
          row_id: "p1",
          op: "upsert",
          company_id: COMPANY,
          updated_at: LATE,
          origin_device: "hub"
        }
      ]
    }
  ]);
  await assert.rejects(
    pullHubChanges(pullInput(driver, cursors.store, cambioRoto.impl)),
    (error: unknown) => {
      assert.ok(error instanceof HubSyncError);
      assert.equal(error.code, "invalid_change");
      assert.match(error.message, /sin fila/);
      return true;
    }
  );
  assert.deepEqual(await driver.query({ table: "products" }), []);
  assert.equal(cursors.value(COMPANY), 4);
  await driver.close();
});

test("un sobre con ok=false se rechaza con el código del hub", async () => {
  const driver = createMemoryDriver();
  await driver.ready();
  const cursors = memoryCursors();
  const { impl } = makeFetch([{ ok: false, error: "company_mismatch" }]);

  await assert.rejects(
    pullHubChanges(pullInput(driver, cursors.store, impl)),
    (error: unknown) => {
      assert.ok(error instanceof HubSyncError);
      assert.equal(error.code, "invalid_response");
      assert.match(error.message, /company_mismatch/);
      return true;
    }
  );
  assert.equal(cursors.value(COMPANY), 0);
  await driver.close();
});

test("el tope de páginas corta la llamada y deja hasMore para la próxima", async () => {
  const driver = createMemoryDriver();
  await driver.ready();
  const cursors = memoryCursors();
  const { calls, impl } = makeFetch([
    page([upsert(1, product("p1"))], 1, true),
    page([upsert(2, product("p2"))], 2, true),
    page([upsert(3, product("p3"))], 3, false)
  ]);

  const result = await pullHubChanges(pullInput(driver, cursors.store, impl, { limit: 1, maxPages: 2 }));

  assert.equal(calls.length, 2);
  assert.equal(result.pages, 2);
  assert.equal(result.applied, 2);
  assert.equal(result.cursor, 2);
  assert.equal(result.hasMore, true);
  await driver.close();
});
