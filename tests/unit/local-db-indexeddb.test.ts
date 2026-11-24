import test from "node:test";
import assert from "node:assert/strict";

import { LocalDbError } from "../../src/services/localDb/contract";
import type { LocalRow } from "../../src/services/localDb/contract";
import { LOCAL_DB_TABLES } from "../../src/services/localDb/schema";
import { createIndexedDbDriver } from "../../src/services/localDb/indexedDbDriver";

/**
 * Fake IDBFactory mínimo pero fiel al subconjunto que usa el driver:
 * open con upgrade, createObjectStore/createIndex, transacciones con
 * get/put/delete/getAll y oncomplete/onerror. Los datos persisten por
 * nombre de base, así que reabrir con la misma factory conserva el journal.
 */

type FakeStore = {
  keyPath: string;
  indexes: string[];
  data: Map<unknown, unknown>;
};

type FakeDatabase = {
  name: string;
  version: number;
  stores: Map<string, FakeStore>;
};

const DELETED = Symbol("deleted");

function clone<T>(value: T): T {
  return value === undefined ? value : (structuredClone(value) as T);
}

class FakeRequest {
  result: any = undefined;
  error: any = null;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
}

class FakeOpenRequest extends FakeRequest {
  onupgradeneeded: ((event: { oldVersion: number; newVersion: number }) => void) | null = null;
  onblocked: (() => void) | null = null;
}

class FakeTransaction {
  oncomplete: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  error: any = null;

  private readonly queue: Array<() => void> = [];
  private readonly staged = new Map<string, Map<unknown, unknown>>();
  private finished = false;

  constructor(
    private readonly db: FakeDatabase,
    private readonly state: { failWrites: boolean },
    storeNames: string[]
  ) {
    for (const name of storeNames) {
      if (!db.stores.has(name)) throw new Error("NotFoundError: " + name);
    }
    queueMicrotask(() => this.drain());
  }

  objectStore(name: string) {
    const store = this.db.stores.get(name);
    if (!store) throw new Error("NotFoundError: " + name);

    const stagedFor = () => {
      let map = this.staged.get(name);
      if (!map) {
        map = new Map();
        this.staged.set(name, map);
      }
      return map;
    };

    const read = (key: unknown) => {
      const writes = this.staged.get(name);
      if (writes?.has(key)) {
        const value = writes.get(key);
        return value === DELETED ? undefined : clone(value);
      }
      return store.data.has(key) ? clone(store.data.get(key)) : undefined;
    };

    return {
      keyPath: store.keyPath,
      indexNames: { contains: (index: string) => store.indexes.includes(index) },
      get: (key: unknown) => this.request((req) => { req.result = read(key); }),
      getAll: () => this.request((req) => {
        const values = new Map(store.data);
        const writes = this.staged.get(name);
        if (writes) {
          for (const [key, value] of writes) {
            if (value === DELETED) values.delete(key);
            else values.set(key, value);
          }
        }
        req.result = Array.from(values.values()).map(clone);
      }),
      put: (value: any, key?: unknown) => this.request(() => {
        if (this.state.failWrites) throw new Error("QuotaExceededError");
        const target = store.keyPath ? value?.[store.keyPath] : key;
        if (target === undefined) throw new Error("DataError: clave ausente");
        stagedFor().set(target, clone(value));
      }),
      delete: (key: unknown) => this.request(() => {
        if (this.state.failWrites) throw new Error("QuotaExceededError");
        stagedFor().set(key, DELETED);
      })
    };
  }

  abort() {
    this.fail(new Error("AbortError"));
  }

  private request(apply: (req: FakeRequest) => void) {
    const req = new FakeRequest();
    this.queue.push(() => {
      apply(req);
      req.onsuccess?.();
    });
    return req;
  }

  private fail(error: unknown) {
    if (this.finished) return;
    this.finished = true;
    this.error = error;
    this.onerror?.();
    this.onabort?.();
  }

  private drain() {
    while (!this.finished && this.queue.length > 0) {
      const operation = this.queue.shift()!;
      try {
        operation();
      } catch (error) {
        // Sin commit: las escrituras preparadas se descartan.
        this.fail(error);
        return;
      }
    }
    if (this.finished) return;
    for (const [name, writes] of this.staged) {
      const store = this.db.stores.get(name)!;
      for (const [key, value] of writes) {
        if (value === DELETED) store.data.delete(key);
        else store.data.set(key, value);
      }
    }
    this.staged.clear();
    this.finished = true;
    this.oncomplete?.();
  }
}

class FakeDb {
  onversionchange: (() => void) | null = null;
  readonly objectStoreNames: { contains: (name: string) => boolean };
  private closed = false;

  constructor(
    private readonly db: FakeDatabase,
    private readonly state: { failWrites: boolean }
  ) {
    this.objectStoreNames = {
      contains: (name: string) => db.stores.has(name)
    };
  }

  createObjectStore(name: string, options?: { keyPath?: string }) {
    if (this.db.stores.has(name)) throw new Error("ConstraintError: " + name);
    const store: FakeStore = { keyPath: options?.keyPath ?? "", indexes: [], data: new Map() };
    this.db.stores.set(name, store);
    return {
      keyPath: store.keyPath,
      indexNames: { contains: (index: string) => store.indexes.includes(index) },
      createIndex: (index: string, _keyPath: string | string[]) => {
        if (!store.indexes.includes(index)) store.indexes.push(index);
        return null;
      }
    };
  }

  transaction(names: string | string[], _mode?: string) {
    if (this.closed) throw new Error("InvalidStateError: base cerrada");
    const list = Array.isArray(names) ? names : [names];
    return new FakeTransaction(this.db, this.state, list);
  }

  close() {
    this.closed = true;
  }
}

function createFakeIndexedDb() {
  const databases = new Map<string, FakeDatabase>();
  const state = { failWrites: false, failOpens: false };

  const factory = {
    open(name: string, version?: number) {
      const request = new FakeOpenRequest();
      queueMicrotask(() => {
        if (state.failOpens) {
          request.error = new Error("open failed");
          request.onerror?.();
          return;
        }
        let db = databases.get(name);
        if (!db) {
          db = { name, version: 0, stores: new Map() };
          databases.set(name, db);
        }
        const oldVersion = db.version;
        const newVersion = version ?? 1;
        request.result = new FakeDb(db, state);
        if (oldVersion < newVersion) {
          db.version = newVersion;
          request.onupgradeneeded?.({ oldVersion, newVersion });
        }
        request.onsuccess?.();
      });
      return request;
    }
  };

  return { factory, databases, state };
}

const COMPANY = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY = "22222222-2222-4222-8222-222222222222";

function row(id: string, overrides: Partial<LocalRow> = {}): LocalRow {
  return {
    id,
    company_id: COMPANY,
    version: 1,
    updated_at: "2026-01-01T00:00:00.000Z",
    origin_device: "device-a",
    deleted_at: null,
    ...overrides
  };
}

function setup(dbName: string) {
  const fake = createFakeIndexedDb();
  const driver = createIndexedDbDriver({
    factory: fake.factory as unknown as IDBFactory,
    dbName
  });
  return { ...fake, driver };
}

test("el upgrade crea un store por tabla, sus índices y los stores internos", async () => {
  const { driver, databases } = setup("db-upgrade");
  await driver.ready();
  const db = databases.get("db-upgrade");
  assert.ok(db);

  for (const schema of Object.values(LOCAL_DB_TABLES)) {
    assert.ok(db.stores.has(schema.name), "falta el store " + schema.name);
    assert.equal(db.stores.get(schema.name)!.keyPath, "id");
  }

  const products = db.stores.get("products")!;
  for (const index of ["idx_company_id", "idx_company_id_updated_at", "idx_company_id_name"]) {
    assert.ok(products.indexes.includes(index), "falta el índice " + index);
  }

  assert.equal(db.stores.get("_changes")!.keyPath, "seq");
  assert.equal(db.stores.get("_meta")!.keyPath, "key");
});

test("sin factory disponible, ready() falla con driver_unavailable", async () => {
  const globals = globalThis as { indexedDB?: IDBFactory };
  const original = globals.indexedDB;
  delete globals.indexedDB;
  try {
    const driver = createIndexedDbDriver();
    await assert.rejects(
      () => driver.ready(),
      (error: unknown) =>
        error instanceof LocalDbError && error.code === "driver_unavailable"
    );
  } finally {
    if (original !== undefined) globals.indexedDB = original;
  }
});

test("put, get y query aplican el spec en memoria", async () => {
  const { driver } = setup("db-crud");
  const written = await driver.put("products", [
    row("p1", { name: "Café" }),
    row("p2", { name: "Azúcar" }),
    row("p3", { name: "Arroz", company_id: OTHER_COMPANY })
  ]);
  assert.equal(written, 3);

  const single = await driver.get<LocalRow>("products", "p2");
  assert.equal(single?.name, "Azúcar");
  assert.equal(await driver.get("products", "no-existe"), null);

  const ordered = await driver.query<LocalRow>({
    table: "products",
    where: [{ field: "company_id", op: "eq", value: COMPANY }],
    orderBy: { field: "name", direction: "asc" }
  });
  assert.deepEqual(ordered.map((item) => item.id), ["p2", "p1"]);

  const page = await driver.query<LocalRow>({
    table: "products",
    orderBy: { field: "name", direction: "asc" },
    offset: 1,
    limit: 1
  });
  assert.deepEqual(page.map((item) => item.id), ["p2"]);
});

test("query excluye borrados salvo includeDeleted", async () => {
  const { driver } = setup("db-deleted");
  await driver.put("products", [
    row("vivo", { name: "a" }),
    row("borrado", { name: "b", deleted_at: "2026-01-02T00:00:00.000Z" })
  ]);

  const visible = await driver.query<LocalRow>({ table: "products" });
  assert.deepEqual(visible.map((item) => item.id), ["vivo"]);

  const all = await driver.query<LocalRow>({ table: "products", includeDeleted: true });
  assert.deepEqual(all.map((item) => item.id).sort(), ["borrado", "vivo"]);
});

test("el journal conserva el seq tras cerrar y reabrir", async () => {
  const { driver, factory } = setup("db-journal");
  await driver.put("products", [row("a"), row("b")]);
  assert.equal(await driver.latestSeq(), 2);
  assert.deepEqual((await driver.changes()).map((record) => record.seq), [1, 2]);
  await driver.close();

  const reopened = createIndexedDbDriver({
    factory: factory as unknown as IDBFactory,
    dbName: "db-journal"
  });
  await reopened.ready();
  assert.equal(await reopened.latestSeq(), 2);

  await reopened.put("products", [row("c")]);
  const incremental = await reopened.changes(2);
  assert.deepEqual(incremental.map((record) => [record.seq, record.row_id]), [[3, "c"]]);
  assert.equal((await reopened.changes(0, 2)).length, 2);
  assert.equal((await reopened.changes(0, 0)).length, 1, "limit mínimo 1");
  await reopened.close();
});

test("remove borra la fila y anota un cambio delete con la meta indicada", async () => {
  const { driver } = setup("db-delete");
  await driver.put("products", [row("p1"), row("p2")]);

  const at = "2026-02-01T10:00:00.000Z";
  await driver.remove("products", ["p1"], {
    company_id: COMPANY,
    origin_device: "device-b",
    at
  });

  assert.equal(await driver.get("products", "p1"), null);
  assert.equal(await driver.get("products", "p2") !== null, true);

  const journal = await driver.changes(2);
  assert.equal(journal.length, 1);
  const record = journal[0];
  assert.equal(record.op, "delete");
  assert.equal(record.seq, 3);
  assert.equal(record.row_id, "p1");
  assert.equal(record.table, "products");
  assert.equal(record.company_id, COMPANY);
  assert.equal(record.origin_device, "device-b");
  assert.equal(record.updated_at, at);
  assert.notEqual(record.recorded_at, at);
  assert.equal(record.recorded_at.length, "2026-02-01T10:00:00.000Z".length);
});

test("un lote inválido se rechaza completo y no escribe nada", async () => {
  const { driver } = setup("db-invalid");
  await assert.rejects(
    () =>
      driver.put("products", [
        row("valida"),
        { id: "sin-campos" } as unknown as LocalRow
      ]),
    (error: unknown) => error instanceof LocalDbError && error.code === "invalid_row"
  );

  assert.equal(await driver.latestSeq(), 0);
  assert.deepEqual(await driver.changes(), []);
  assert.equal(await driver.get("products", "valida"), null);
  assert.equal((await driver.query<LocalRow>({ table: "products", includeDeleted: true })).length, 0);
});

test("una escritura abortada no avanza el seq ni deja filas", async () => {
  const { driver, state } = setup("db-abort");
  state.failWrites = true;
  await assert.rejects(
    () => driver.put("products", [row("p1")]),
    (error: unknown) => error instanceof LocalDbError && error.code === "transaction_failed"
  );
  state.failWrites = false;

  assert.equal(await driver.latestSeq(), 0);
  assert.equal(await driver.get("products", "p1"), null);

  await driver.put("products", [row("p1")]);
  assert.equal(await driver.latestSeq(), 1);
});

test("close cierra la conexión y la siguiente operación reabre", async () => {
  const { driver } = setup("db-reopen");
  await driver.put("products", [row("p1")]);
  await driver.close();

  const afterReopen = await driver.get<LocalRow>("products", "p1");
  assert.equal(afterReopen?.id, "p1");

  await driver.put("products", [row("p2")]);
  assert.equal(await driver.latestSeq(), 2);
});

test("dos transacciones concurrentes se serializan", async () => {
  const { driver } = setup("db-serial");
  const order: string[] = [];

  const first = driver.transaction(async (tx) => {
    order.push("a:inicio");
    await new Promise((resolve) => setTimeout(resolve, 10));
    await tx.put("products", [row("p-a")]);
    order.push("a:fin");
  });
  const second = driver.transaction(async (tx) => {
    order.push("b:inicio");
    await tx.put("products", [row("p-b")]);
    const inside = await tx.query<LocalRow>({ table: "products" });
    assert.equal(inside.length, 2, "la transacción ve las escrituras previas");
    order.push("b:fin");
  });

  await Promise.all([first, second]);

  assert.deepEqual(order, ["a:inicio", "a:fin", "b:inicio", "b:fin"]);
  assert.equal(await driver.latestSeq(), 2);
  assert.deepEqual(
    (await driver.changes()).map((record) => record.row_id),
    ["p-a", "p-b"]
  );
});
