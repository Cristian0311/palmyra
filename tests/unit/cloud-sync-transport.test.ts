import test from "node:test";
import assert from "node:assert/strict";
import type { LocalRow } from "../../src/services/localDb/contract";
import {
  createLocalStorageBudgetStore,
  createLocalStorageCursorStore,
  createMemoryBudgetStore,
  createMemoryCursorStore,
  createSupabaseCloudTransport,
  serializeChange,
  type CloudChangeBatch,
  type CloudRpcClient,
  type CloudRpcResult,
  type CloudStorage
} from "../../src/services/cloudSync";

const COMPANY = "11111111-1111-1111-1111-111111111111";
const DELETED_AT = "2026-05-01T09:00:00.000Z";
const DEVICE = "dev-local";

function makeRow(id: string, fields: Record<string, unknown> = {}): LocalRow {
  return {
    id,
    company_id: COMPANY,
    version: 1,
    updated_at: "2026-05-01T08:00:00.000Z",
    origin_device: "dev-1",
    deleted_at: null,
    ...fields
  };
}

interface RpcCall {
  name: string;
  args: Record<string, unknown>;
}

interface FakeClient extends CloudRpcClient {
  calls: RpcCall[];
}

function makeClient(result: CloudRpcResult | (() => CloudRpcResult)): FakeClient {
  const calls: RpcCall[] = [];
  return {
    calls,
    rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      const value = typeof result === "function" ? result() : result;
      return Promise.resolve(value);
    }
  };
}

function makeBatch(changes: CloudChangeBatch["changes"], cursor = 5): CloudChangeBatch {
  return { companyId: COMPANY, cursor, changes };
}

test("envía el lote con los nombres exactos del journal local", async () => {
  const row = makeRow("p1", { name: "Arroz" });
  const client = makeClient({ data: { acceptedThrough: 5 }, error: null });
  const transport = createSupabaseCloudTransport({ client, deviceId: DEVICE });

  const batch = makeBatch([
    { seq: 4, table: "products", rowId: "p1", op: "upsert", row },
    { seq: 5, table: "products", rowId: "p2", op: "delete", deletedAt: DELETED_AT }
  ]);
  const result = await transport.push(batch);

  assert.deepEqual(result, { acceptedThrough: 5 });
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].name, "ingest_local_changes");
  assert.deepEqual(client.calls[0].args, {
    p_company_id: COMPANY,
    p_cursor: 5,
    p_changes: [
      {
        seq: 4,
        table: "products",
        row_id: "p1",
        op: "upsert",
        row,
        deleted_at: null,
        origin_device: DEVICE
      },
      {
        seq: 5,
        table: "products",
        row_id: "p2",
        op: "delete",
        row: null,
        deleted_at: DELETED_AT,
        origin_device: DEVICE
      }
    ]
  });
  // Ningún campo viaja en camelCase.
  const serialized = client.calls[0].args.p_changes as Array<Record<string, unknown>>;
  assert.equal("rowId" in serialized[0], false);
  assert.equal("deletedAt" in serialized[0], false);
  assert.equal("originDevice" in serialized[0], false);
});

test("origin_device identifica al equipo que numera el seq, no al autor de la fila", async () => {
  // La fila pudo llegar de otro equipo vía pull: si se reenviara su autor, el
  // `seq` local chocaría con el de ese otro equipo en la bandeja remota.
  const row = makeRow("p1", { origin_device: "dev-remoto" });
  const client = makeClient({ data: { acceptedThrough: 1 }, error: null });
  const transport = createSupabaseCloudTransport({ client, deviceId: DEVICE });

  await transport.push(makeBatch([{ seq: 1, table: "products", rowId: "p1", op: "upsert", row }], 1));

  const serialized = client.calls[0].args.p_changes as Array<Record<string, unknown>>;
  assert.equal(serialized[0].origin_device, DEVICE);
});

test("sin deviceId inyectado el cambio viaja con un origin_device no vacío", () => {
  const sinFila = serializeChange({ seq: 3, table: "sales", rowId: "s1", op: "delete", deletedAt: DELETED_AT });
  assert.equal(typeof sinFila.origin_device, "string");
  assert.ok(sinFila.origin_device.length > 0);
});

test("serializeChange conserva la fila y la marca de borrado", () => {
  const row = makeRow("p1", { name: "Frijol" });
  assert.deepEqual(serializeChange({ seq: 1, table: "products", rowId: "p1", op: "upsert", row }, DEVICE), {
    seq: 1,
    table: "products",
    row_id: "p1",
    op: "upsert",
    row,
    deleted_at: null,
    origin_device: DEVICE
  });
  assert.deepEqual(
    serializeChange({ seq: 2, table: "sales", rowId: "s1", op: "delete", deletedAt: DELETED_AT }, DEVICE),
    {
      seq: 2,
      table: "sales",
      row_id: "s1",
      op: "delete",
      row: null,
      deleted_at: DELETED_AT,
      origin_device: DEVICE
    }
  );
});

test("acepta un acuse numérico y también un acuse parcial", async () => {
  const numeric = makeClient({ data: 4, error: null });
  const transport = createSupabaseCloudTransport({ client: numeric });
  assert.deepEqual(await transport.push(makeBatch([], 5)), { acceptedThrough: 4 });

  const partial = makeClient({ data: { acceptedThrough: 3 }, error: null });
  const partialTransport = createSupabaseCloudTransport({ client: partial });
  assert.deepEqual(await partialTransport.push(makeBatch([], 5)), { acceptedThrough: 3 });
});

test("rechaza acuses mayores que el cursor enviado", async () => {
  const client = makeClient({ data: { acceptedThrough: 6 }, error: null });
  const transport = createSupabaseCloudTransport({ client });

  await assert.rejects(
    () => transport.push(makeBatch([], 5)),
    /confirmó más cambios de los que se enviaron/
  );
});

test("rechaza acuses inválidos con mensaje en español", async () => {
  const invalid: unknown[] = [{}, null, "5", -1, 1.5, Number.NaN, { acceptedThrough: null }];
  for (const data of invalid) {
    const client = makeClient({ data, error: null });
    const transport = createSupabaseCloudTransport({ client });
    await assert.rejects(() => transport.push(makeBatch([], 5)), /acuse inválido/);
  }
});

test("sin cliente lanza que Supabase no está configurado", async () => {
  const transport = createSupabaseCloudTransport({ client: null });
  await assert.rejects(() => transport.push(makeBatch([], 1)), /Supabase no está configurado/);
});

test("propaga el error de la RPC sin filtrar detalles", async () => {
  const client = makeClient({ data: null, error: { message: "permission denied" } });
  const transport = createSupabaseCloudTransport({ client });
  await assert.rejects(
    () => transport.push(makeBatch([], 1)),
    /No se pudo sincronizar con la nube: permission denied/
  );
});

test("respeta un nombre de RPC alternativo y valida el cursor del lote", async () => {
  const client = makeClient({ data: { acceptedThrough: 0 }, error: null });
  const transport = createSupabaseCloudTransport({ client, rpcName: "custom_ingest" });
  await transport.push(makeBatch([], 0));
  assert.equal(client.calls[0].name, "custom_ingest");

  await assert.rejects(
    () => transport.push({ companyId: COMPANY, cursor: -1, changes: [] }),
    /cursor válido/
  );
  await assert.rejects(
    () => transport.push({ companyId: COMPANY, cursor: 1e13, changes: [] }),
    /límite permitido/
  );
});

interface FakeStorage extends CloudStorage {
  dump(): Record<string, string>;
}

function makeStorage(initial: Record<string, string> = {}): FakeStorage {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => (data.has(key) ? data.get(key)! : null),
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
    key: (index: number) => Array.from(data.keys())[index] ?? null,
    get length(): number {
      return data.size;
    },
    dump: () => Object.fromEntries(data)
  };
}

test("el cursor se guarda como {seq} bajo cursor:<companyId>", async () => {
  const storage = makeStorage();
  const store = createLocalStorageCursorStore(undefined, storage);

  await store.save("co-1", 7);
  assert.equal(storage.getItem("palmyra:cloudsync:cursor:co-1"), JSON.stringify({ seq: 7 }));
  assert.equal(await store.load("co-1"), 7);
  assert.equal(await store.load("co-2"), 0);
});

test("el cursor inválido se normaliza a 0 y nunca lanza", async () => {
  const storage = makeStorage({ "palmyra:cloudsync:cursor:co-1": '{"seq":-3}' });
  const store = createLocalStorageCursorStore(undefined, storage);

  assert.equal(await store.load("co-1"), 0);
  await store.save("co-1", -9);
  assert.equal(await store.load("co-1"), 0);

  storage.setItem("palmyra:cloudsync:cursor:co-1", "no-json");
  assert.equal(await store.load("co-1"), 0);
});

test("si el almacenamiento falla, el cursor degrada a memoria", async () => {
  const blocked: CloudStorage = {
    getItem() {
      throw new Error("bloqueado");
    },
    setItem() {
      throw new Error("cuota");
    }
  };
  const store = createLocalStorageCursorStore(undefined, blocked);

  await store.save("co-1", 12);
  assert.equal(await store.load("co-1"), 12);
});

test("el presupuesto usa budget:<YYYY-MM-DD> y retiene 7 días", async () => {
  const storage = makeStorage();
  const store = createLocalStorageBudgetStore("palmyra:cloudsync", storage);

  await store.save("2026-05-01", { requests: 2, lastRequestAt: 1000 });
  assert.equal(
    storage.getItem("palmyra:cloudsync:budget:2026-05-01"),
    JSON.stringify({ requests: 2, lastRequestAt: 1000 })
  );

  for (const day of ["2026-05-02", "2026-05-03", "2026-05-04", "2026-05-05", "2026-05-06", "2026-05-07", "2026-05-08"]) {
    await store.save(day, { requests: 1, lastRequestAt: 2000 });
  }

  assert.equal(storage.getItem("palmyra:cloudsync:budget:2026-05-01"), null);
  for (const day of ["2026-05-02", "2026-05-08"]) {
    assert.ok(storage.getItem(`palmyra:cloudsync:budget:${day}`), `conserva ${day}`);
  }
  assert.deepEqual(await store.load("2026-05-08"), { requests: 1, lastRequestAt: 2000 });
});

test("el presupuesto normaliza valores y no lanza con almacenamiento bloqueado", async () => {
  const storage = makeStorage({
    "palmyra:cloudsync:budget:2026-05-01": '{"requests":-4,"lastRequestAt":"x"}'
  });
  const store = createLocalStorageBudgetStore("palmyra:cloudsync", storage);
  assert.deepEqual(await store.load("2026-05-01"), { requests: 0, lastRequestAt: 0 });

  const blocked: CloudStorage = {
    getItem() {
      throw new Error("bloqueado");
    },
    setItem() {
      throw new Error("cuota");
    }
  };
  const memoryBacked = createLocalStorageBudgetStore("palmyra:cloudsync", blocked);
  await memoryBacked.save("2026-05-02", { requests: 3, lastRequestAt: 5000 });
  assert.deepEqual(await memoryBacked.load("2026-05-02"), { requests: 3, lastRequestAt: 5000 });
});

test("las versiones en memoria guardan y devuelven copias", async () => {
  const cursors = createMemoryCursorStore();
  await cursors.save("co-1", 3);
  assert.equal(await cursors.load("co-1"), 3);

  const budget = createMemoryBudgetStore();
  await budget.save("2026-05-01", { requests: 2, lastRequestAt: 10 });
  const snapshot = await budget.load("2026-05-01");
  snapshot.requests = 99;
  assert.deepEqual(await budget.load("2026-05-01"), { requests: 2, lastRequestAt: 10 });
});
