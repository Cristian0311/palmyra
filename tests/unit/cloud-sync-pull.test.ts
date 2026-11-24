import test from "node:test";
import assert from "node:assert/strict";
import type { LocalDbDriver, LocalRow } from "../../src/services/localDb/contract";
import { createMemoryDriver } from "../../src/services/localDb/memoryDriver";
import {
  DEFAULT_PULL_MAX_ROWS,
  compareFreshness,
  planRemoteChanges,
  resolveRemoteChange,
  type RemotePullChange
} from "../../src/services/cloudSync/pull";

const COMPANY = "co-1";
const OTHER_COMPANY = "co-2";
const BASE_AT = "2026-06-01T08:00:00.000Z";

function at(minutes: number): string {
  return new Date(Date.parse(BASE_AT) + minutes * 60_000).toISOString();
}

function makeRow(id: string, fields: Partial<LocalRow> = {}): LocalRow {
  return {
    id,
    company_id: COMPANY,
    version: 1,
    updated_at: at(0),
    origin_device: "dev-1",
    deleted_at: null,
    name: `fila-${id}`,
    ...fields
  };
}

async function makeDriver(): Promise<LocalDbDriver> {
  const driver = createMemoryDriver({ now: () => at(120) });
  await driver.ready();
  return driver;
}

async function seed(driver: LocalDbDriver, table: RedirectTable, row: LocalRow): Promise<void> {
  await driver.put(table, [row]);
}

/** Las pruebas usan tablas reales del contrato; el alias evita repetir el tipo. */
type RedirectTable = "products" | "customers" | "outbox";

test("una fila remota más nueva gana y se escribe localmente", async () => {
  const driver = await makeDriver();
  await seed(driver, "products", makeRow("p1", { version: 1, updated_at: at(0), name: "viejo" }));

  const change: RemotePullChange = {
    table: "products",
    row: makeRow("p1", {
      version: 2,
      updated_at: at(10),
      name: "nuevo",
      origin_device: "dev-remoto"
    })
  };

  const report = await planRemoteChanges({
    localDriver: driver,
    changes: [change],
    companyId: COMPANY
  });

  assert.deepEqual(report, { applied: { products: 1 }, skipped: 0, conflicts: [], deferred: 0 });
  const stored = await driver.get<LocalRow>("products", "p1");
  assert.equal(stored?.name, "nuevo");
  assert.equal(stored?.version, 2);
  assert.equal(stored?.origin_device, "dev-remoto");
});

test("una fila local más nueva nunca se pisa y se reporta como conflicto", async () => {
  const driver = await makeDriver();
  const local = makeRow("p1", { version: 5, updated_at: at(30), name: "local-gana" });
  await seed(driver, "products", local);

  const report = await planRemoteChanges({
    localDriver: driver,
    changes: [
      {
        table: "products",
        row: makeRow("p1", { version: 2, updated_at: at(10), name: "remoto-pierde" })
      }
    ],
    companyId: COMPANY
  });

  assert.deepEqual(report.applied, {});
  assert.equal(report.skipped, 0);
  assert.equal(report.conflicts.length, 1);
  assert.deepEqual(report.conflicts[0], {
    table: "products",
    id: "p1",
    reason: "local_newer"
  });
  const stored = await driver.get<LocalRow>("products", "p1");
  assert.equal(stored?.name, "local-gana");
  assert.equal(stored?.version, 5);
});

test("misma version y updated_at se descarta como duplicado", async () => {
  const driver = await makeDriver();
  await seed(driver, "products", makeRow("p1", { version: 3, updated_at: at(15) }));

  const report = await planRemoteChanges({
    localDriver: driver,
    changes: [
      {
        table: "products",
        row: makeRow("p1", { version: 3, updated_at: at(15), name: "otro-nombre" })
      }
    ],
    companyId: COMPANY
  });

  assert.deepEqual(report.applied, {});
  assert.equal(report.skipped, 1);
  assert.equal(report.conflicts.length, 0);
  const stored = await driver.get<LocalRow>("products", "p1");
  assert.equal(stored?.name, "fila-p1");
});

test("un tombstone remoto contra una fila local más nueva es conflicto visible", async () => {
  const driver = await makeDriver();
  await seed(driver, "customers", makeRow("c1", { version: 4, updated_at: at(40), name: "vigente" }));

  const report = await planRemoteChanges({
    localDriver: driver,
    changes: [
      {
        table: "customers",
        row_id: "c1",
        tombstone: true,
        deleted_at: at(20),
        version: 3,
        origin_device: "dev-remoto"
      }
    ],
    companyId: COMPANY
  });

  assert.deepEqual(report.applied, {});
  assert.deepEqual(report.conflicts, [
    { table: "customers", id: "c1", reason: "tombstone_local_newer" }
  ]);
  const stored = await driver.get<LocalRow>("customers", "c1");
  assert.ok(stored);
  assert.equal(stored.deleted_at, null);
  assert.equal(stored.name, "vigente");
});

test("un tombstone más nuevo borra la fila local y queda en el journal", async () => {
  const driver = await makeDriver();
  await seed(driver, "customers", makeRow("c1", { version: 1, updated_at: at(0) }));
  const journalBefore = (await driver.changes(0, 100)).length;

  const report = await planRemoteChanges({
    localDriver: driver,
    changes: [
      {
        table: "customers",
        row_id: "c1",
        tombstone: true,
        deleted_at: at(50),
        version: 2,
        origin_device: "dev-remoto"
      }
    ],
    companyId: COMPANY
  });

  assert.deepEqual(report.applied, { customers: 1 });
  assert.equal(report.conflicts.length, 0);
  assert.equal(await driver.get("customers", "c1"), null);
  const journal = await driver.changes(0, 100);
  assert.equal(journal.length, journalBefore + 1);
  const last = journal[journal.length - 1];
  assert.equal(last.op, "delete");
  assert.equal(last.row_id, "c1");
  assert.equal(last.origin_device, "dev-remoto");
  assert.equal(last.updated_at, at(50));
});

test("un tombstone de una fila inexistente se omite sin escribir", async () => {
  const driver = await makeDriver();

  const report = await planRemoteChanges({
    localDriver: driver,
    changes: [
      { table: "customers", row_id: "fantasma", tombstone: true, deleted_at: at(10), version: 1 }
    ],
    companyId: COMPANY
  });

  assert.deepEqual(report.applied, {});
  assert.equal(report.skipped, 1);
  assert.equal(report.conflicts.length, 0);
  assert.equal(await driver.latestSeq(), 0);
});

test("las filas de otra empresa se rechazan (aislamiento multiempresa)", async () => {
  const driver = await makeDriver();
  await seed(driver, "products", makeRow("p1", { version: 1, updated_at: at(0), name: "local" }));

  const report = await planRemoteChanges({
    localDriver: driver,
    changes: [
      {
        table: "products",
        row: makeRow("p1", {
          company_id: OTHER_COMPANY,
          version: 9,
          updated_at: at(90),
          name: "intruso"
        })
      },
      {
        table: "products",
        row: makeRow("p2", {
          company_id: OTHER_COMPANY,
          version: 9,
          updated_at: at(90),
          name: "intruso-nuevo"
        })
      }
    ],
    companyId: COMPANY
  });

  assert.deepEqual(report.applied, {});
  assert.equal(report.conflicts.length, 2);
  assert.ok(report.conflicts.every((entry) => entry.reason === "foreign_company"));
  const kept = await driver.get<LocalRow>("products", "p1");
  assert.equal(kept?.name, "local");
  assert.equal(await driver.get("products", "p2"), null);
});

test("un lote vacío no abre escrituras ni altera el journal", async () => {
  const driver = await makeDriver();

  const report = await planRemoteChanges({
    localDriver: driver,
    changes: [],
    companyId: COMPANY
  });

  assert.deepEqual(report, { applied: {}, skipped: 0, conflicts: [], deferred: 0 });
  assert.equal(await driver.latestSeq(), 0);
});

test("maxRows limita el lote y el resto queda como deferred", async () => {
  const driver = await makeDriver();
  const changes: RemotePullChange[] = ["p1", "p2", "p3"].map((id) => ({
    table: "products",
    row: makeRow(id, { version: 1, updated_at: at(0) })
  }));

  const first = await planRemoteChanges({
    localDriver: driver,
    changes,
    companyId: COMPANY,
    maxRows: 1
  });

  assert.deepEqual(first.applied, { products: 1 });
  assert.equal(first.deferred, 2);
  assert.equal(await driver.latestSeq(), 1);
  assert.ok(await driver.get("products", "p1"));
  assert.equal(await driver.get("products", "p2"), null);

  const second = await planRemoteChanges({
    localDriver: driver,
    changes: changes.slice(1),
    companyId: COMPANY,
    maxRows: 2
  });
  assert.deepEqual(second.applied, { products: 2 });
  assert.equal(second.deferred, 0);
  assert.ok(await driver.get("products", "p3"));
});

test("las tablas propias del dispositivo no se replican desde el remoto", async () => {
  const driver = await makeDriver();

  const report = await planRemoteChanges({
    localDriver: driver,
    changes: [
      {
        table: "outbox",
        row: makeRow("o1", { version: 1, updated_at: at(0) })
      }
    ],
    companyId: COMPANY
  });

  assert.deepEqual(report.applied, {});
  assert.equal(report.skipped, 1);
  assert.equal(await driver.latestSeq(), 0);
});

test("los cambios del mismo lote se resuelven en orden con la fila ya escrita", async () => {
  const driver = await makeDriver();

  const report = await planRemoteChanges({
    localDriver: driver,
    changes: [
      {
        table: "products",
        row: makeRow("p1", { version: 2, updated_at: at(10), name: "v2" })
      },
      {
        table: "products",
        row: makeRow("p1", { version: 5, updated_at: at(50), name: "v5" })
      }
    ],
    companyId: COMPANY
  });

  assert.equal(report.applied.products, 2);
  const stored = await driver.get<LocalRow>("products", "p1");
  assert.equal(stored?.name, "v5");
  assert.equal(stored?.version, 5);
});

test("resolveRemoteChange y compareFreshness son puros y no tocan el driver", () => {
  const local = makeRow("p1", { version: 3, updated_at: at(30) });
  assert.equal(compareFreshness(local, { version: 4 }), 1);
  assert.equal(compareFreshness(local, { version: 2 }), -1);
  assert.equal(compareFreshness(local, { updated_at: at(30) }), 0);
  assert.equal(compareFreshness(local, { updated_at: at(31) }), 1);

  const decision = resolveRemoteChange(
    {
      table: "products",
      row: makeRow("p1", { company_id: OTHER_COMPANY, version: 9, updated_at: at(90) })
    },
    COMPANY,
    local
  );
  assert.deepEqual(decision, {
    action: "conflict",
    table: "products",
    id: "p1",
    reason: "foreign_company"
  });

  const skip = resolveRemoteChange(
    { table: "outbox", row: makeRow("o1") },
    COMPANY,
    null
  );
  assert.equal(skip.action, "skip");
});

test("el límite por defecto es conservador", () => {
  assert.ok(DEFAULT_PULL_MAX_ROWS > 0);
  assert.ok(DEFAULT_PULL_MAX_ROWS <= 1000);
});
