/**
 * Pruebas del respaldo cifrado del hub (AES-256-GCM + rotación 7/4).
 *
 * Todo se ejecuta en memoria: driver del almacén, IO del disco y reloj. Las
 * claves son efímeras y aleatorias; ninguna se imprime ni se guarda en disco de
 * verdad.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  BACKUP_ALG,
  BACKUP_BUSINESS_TABLES,
  BACKUP_FORMAT,
  HubBackupError,
  canonicalJson,
  createBackup,
  createBackupKey,
  decryptBackup,
  importBackupKey,
  restoreBackup,
  verifyBackupContent,
  type BackupEnvelope
} from "../../src/services/lanHub/backup";
import {
  BACKUP_KEY_FILE,
  BACKUP_KEY_FILE_BYTES,
  loadOrCreateBackupKey,
  rotateBackups,
  writeBackupFile,
  type BackupStoreIo
} from "../../src/services/lanHub/backupStoreNode";
import { createMemoryDriver } from "../../src/services/localDb/memoryDriver";
import type { LocalDbDriver, LocalRow, LocalTable } from "../../src/services/localDb/contract";

const COMPANY = "co-respaldo";
const OTHER_COMPANY = "co-ajena";
const FIXED_MS = Date.parse("2026-05-01T12:00:00.000Z");
const FIXED_ISO = new Date(FIXED_MS).toISOString();
const FIXED_IV = new Uint8Array(12).fill(7);

function row(_table: string, id: string, extra: Record<string, unknown> = {}): LocalRow {
  return {
    id,
    company_id: COMPANY,
    version: 1,
    updated_at: FIXED_ISO,
    origin_device: "hub",
    deleted_at: null,
    ...extra
  };
}

async function seed(driver: LocalDbDriver): Promise<void> {
  await driver.put("products", [
    row("products", "p-2", { name: "Café", price: 250 }),
    row("products", "p-1", { name: "Arroz", price: 120 }),
    row("products", "p-3", { name: "Borrado", price: 10, deleted_at: FIXED_ISO })
  ]);
  await driver.put("sales", [
    row("sales", "s-1", { total: 500, warehouse_id: "w-1", created_at: FIXED_ISO }),
    row("sales", "s-2", { total: 750, warehouse_id: "w-1", created_at: FIXED_ISO })
  ]);
  await driver.put("stock_balances", [
    row("stock_balances", "b-1", { product_id: "p-1", warehouse_id: "w-1", quantity: 12 }),
    row("stock_balances", "b-2", { product_id: "p-2", warehouse_id: "w-1", quantity: 4 })
  ]);
}

async function freshDriver(): Promise<LocalDbDriver> {
  const driver = createMemoryDriver({ now: () => FIXED_ISO });
  await driver.ready();
  return driver;
}

async function ephemKey(): Promise<{ raw: string; key: CryptoKey }> {
  const raw = await createBackupKey();
  return { raw, key: await importBackupKey(raw) };
}

function isBackupError(code: string) {
  return (error: unknown): boolean => error instanceof HubBackupError && error.code === code;
}

/** IO de disco en memoria: mismos métodos que fs/promises, sin tocar el disco. */
interface MemoryIo extends BackupStoreIo {
  files: Map<string, string>;
  modes: Map<string, number>;
}

function enoent(): Error {
  const error = new Error("ENOENT") as NodeJS.ErrnoException;
  error.code = "ENOENT";
  return error;
}

function createMemoryIo(): MemoryIo {
  const files = new Map<string, string>();
  const modes = new Map<string, number>();
  const norm = (path: string): string => {
    const clean = path.replace(/\\/g, "/").replace(/\/+$/, "");
    return clean || "/";
  };
  const read = (path: string): string => {
    const data = files.get(norm(path));
    if (data === undefined) throw enoent();
    return data;
  };

  return {
    files,
    modes,
    async readdir(dir) {
      const base = norm(dir) === "/" ? "/" : norm(dir) + "/";
      const names: string[] = [];
      for (const key of files.keys()) {
        if (!key.startsWith(base)) continue;
        const rest = key.slice(base.length);
        if (!rest || rest.includes("/")) continue;
        names.push(rest);
      }
      return names.sort();
    },
    async stat(path) {
      const data = read(path);
      return { mtimeMs: 0, size: new TextEncoder().encode(data).length };
    },
    async unlink(path) {
      if (!files.delete(norm(path))) throw enoent();
    },
    async copyFile(from, to) {
      files.set(norm(to), read(from));
    },
    async mkdir() {
      // Sin jerarquía real: las rutas son claves planas.
    },
    async rename(from, to) {
      const data = read(from);
      files.delete(norm(from));
      files.set(norm(to), data);
    },
    async writeFile(path, data, options) {
      files.set(norm(path), data);
      if (options?.mode !== undefined) modes.set(norm(path), options.mode);
    },
    async chmod(path, mode) {
      read(path);
      modes.set(norm(path), mode);
    },
    async readFile(path) {
      return read(path);
    }
  };
}

test("round-trip: cifra, descifra y el sobre solo crece por base64 y etiqueta", async () => {
  const driver = await freshDriver();
  await seed(driver);
  const { raw, key } = await ephemKey();
  assert.match(raw, /^[A-Za-z0-9_-]{43}$/, "la clave es base64url de 32 bytes sin relleno");

  const envelope = await createBackup(driver, { companyId: COMPANY, key, now: () => FIXED_ISO });
  assert.equal(envelope.format, BACKUP_FORMAT);
  assert.equal(envelope.alg, BACKUP_ALG);
  assert.equal(envelope.createdAt, FIXED_ISO);
  assert.equal(envelope.companyId, COMPANY);
  assert.equal(envelope.iv.length, 16, "IV de 12 bytes en base64");
  assert.equal(envelope.tables.length, BACKUP_BUSINESS_TABLES.length);
  assert.equal(envelope.counts.products, 3, "incluye la fila borrada");
  assert.equal(envelope.counts.sales, 2);
  assert.equal(envelope.counts.hub_devices, undefined, "las tablas internas quedan fuera");

  const content = await decryptBackup(envelope, key);
  assert.equal(content.createdAt, FIXED_ISO);
  assert.equal(content.companyId, COMPANY);
  assert.deepEqual(content.counts, envelope.counts);
  const products = await driver.query<LocalRow>({
    table: "products",
    includeDeleted: true,
    orderBy: { field: "id", direction: "asc" }
  });
  assert.deepEqual(content.rows.products, products);

  // El sobre solo añade el relleno base64 y la etiqueta GCM (16 bytes).
  const plaintext = new TextEncoder().encode(
    canonicalJson({
      format: BACKUP_FORMAT,
      createdAt: envelope.createdAt,
      companyId: COMPANY,
      tables: envelope.tables,
      counts: envelope.counts,
      rows: content.rows
    })
  );
  const expectedChars = 4 * Math.ceil((plaintext.length + 16) / 3);
  assert.equal(envelope.data.length, expectedChars);
  assert.ok(!JSON.stringify(envelope).includes(raw), "el sobre nunca contiene la clave");
});

test("clave errónea y sobre manipulado se rechazan sin escribir", async () => {
  const driver = await freshDriver();
  await seed(driver);
  const { key } = await ephemKey();
  const envelope = await createBackup(driver, { companyId: COMPANY, key, now: () => FIXED_ISO });

  const wrong = await ephemKey();
  await assert.rejects(decryptBackup(envelope, wrong.key), isBackupError("integrity_failed"));

  const middle = Math.floor(envelope.data.length / 2);
  const changed = envelope.data[middle] === "A" ? "B" : "A";
  const tampered: BackupEnvelope = {
    ...envelope,
    data: envelope.data.slice(0, middle) + changed + envelope.data.slice(middle + 1)
  };
  await assert.rejects(decryptBackup(tampered, key), isBackupError("integrity_failed"));

  await assert.rejects(
    decryptBackup({ ...envelope, companyId: OTHER_COMPANY }, key),
    isBackupError("integrity_failed")
  );
  await assert.rejects(
    decryptBackup({ ...envelope, alg: "AES-128-CBC" }, key),
    isBackupError("invalid_format")
  );
  await assert.rejects(
    decryptBackup({ ...envelope, iv: envelope.iv.slice(0, 8) }, key),
    isBackupError("invalid_format")
  );

  const target = await freshDriver();
  await assert.rejects(
    restoreBackup(target, tampered, key, { companyId: COMPANY }),
    isBackupError("integrity_failed")
  );
  assert.equal((await target.query({ table: "products", includeDeleted: true })).length, 0);
});

test("JSON canónico: mismo contenido y IV fijo producen el mismo cifrado", async () => {
  const first = await freshDriver();
  await seed(first);
  const second = await freshDriver();
  // Mismo contenido insertado al revés: el orden de escritura no altera la foto.
  await second.put("stock_balances", [
    row("stock_balances", "b-2", { product_id: "p-2", warehouse_id: "w-1", quantity: 4 }),
    row("stock_balances", "b-1", { product_id: "p-1", warehouse_id: "w-1", quantity: 12 })
  ]);
  await second.put("sales", [
    row("sales", "s-2", { total: 750, warehouse_id: "w-1", created_at: FIXED_ISO }),
    row("sales", "s-1", { total: 500, warehouse_id: "w-1", created_at: FIXED_ISO })
  ]);
  await second.put("products", [
    row("products", "p-3", { name: "Borrado", price: 10, deleted_at: FIXED_ISO }),
    row("products", "p-1", { name: "Arroz", price: 120 }),
    row("products", "p-2", { name: "Café", price: 250 })
  ]);

  const { key } = await ephemKey();
  const a = await createBackup(first, { companyId: COMPANY, key, now: () => FIXED_ISO, iv: FIXED_IV });
  const b = await createBackup(second, { companyId: COMPANY, key, now: () => FIXED_ISO, iv: FIXED_IV });
  assert.equal(a.data, b.data);
  assert.deepEqual(a.counts, b.counts);

  const other = await createBackup(first, {
    companyId: COMPANY,
    key,
    now: () => FIXED_ISO,
    iv: new Uint8Array(12).fill(9)
  });
  assert.notEqual(other.data, a.data, "un IV distinto cambia el cifrado");
});

test("restaura en un equipo vacío, es idempotente y conserva el emparejamiento", async () => {
  const source = await freshDriver();
  await seed(source);
  // Tablas internas de origen: no deben viajar en el respaldo.
  await source.put("hub_devices", [
    row("hub_devices", "pc-origen", { device_id: "pc-origen", token_hash: "hash", paired_at: FIXED_ISO })
  ]);
  await source.put("outbox", [row("outbox", "ob-1", { status: "pending" })]);

  const { key } = await ephemKey();
  const envelope = await createBackup(source, { companyId: COMPANY, key, now: () => FIXED_ISO });
  const content = await decryptBackup(envelope, key);

  const target = await freshDriver();
  // Equipo destino ya emparejado con el hub: restaurar no debe tocarlo.
  await target.put("hub_devices", [
    row("hub_devices", "pc-destino", { device_id: "pc-destino", token_hash: "hash-destino", paired_at: FIXED_ISO })
  ]);

  const first = await restoreBackup(target, envelope, key, { companyId: COMPANY });
  assert.equal(first.restored, 7, "3 productos + 2 ventas + 2 saldos");
  assert.deepEqual(first.counts, envelope.counts);

  for (const table of ["products", "sales", "stock_balances"] as LocalTable[]) {
    const expected = await source.query<LocalRow>({
      table,
      where: [{ field: "company_id", op: "eq", value: COMPANY }],
      includeDeleted: true,
      orderBy: { field: "id", direction: "asc" }
    });
    const actual = await target.query<LocalRow>({
      table,
      where: [{ field: "company_id", op: "eq", value: COMPANY }],
      includeDeleted: true,
      orderBy: { field: "id", direction: "asc" }
    });
    assert.deepEqual(actual, expected, `filas idénticas en ${table}`);
  }

  const report = await verifyBackupContent(target, content, { companyId: COMPANY });
  assert.equal(report.ok, true, report.mismatches.join("; "));

  const second = await restoreBackup(target, envelope, key, { companyId: COMPANY });
  assert.deepEqual(second, first, "restaurar dos veces deja el mismo resultado");
  const again = await target.query<LocalRow>({
    table: "products",
    includeDeleted: true,
    orderBy: { field: "id", direction: "asc" }
  });
  assert.equal(again.length, 3, "sin duplicados");

  const device = await target.get<LocalRow>("hub_devices", "pc-destino");
  assert.ok(device, "el emparejamiento del destino sigue intacto");
  assert.equal(await target.get<LocalRow>("hub_devices", "pc-origen"), null);
  assert.equal((await target.query({ table: "outbox" })).length, 0, "la bandeja no se restaura");
});

test("rechaza tablas internas y mezclas de empresa", async () => {
  const driver = await freshDriver();
  await seed(driver);
  const { key } = await ephemKey();

  await assert.rejects(
    createBackup(driver, { companyId: COMPANY, key, tables: ["hub_devices"] }),
    isBackupError("internal_table")
  );
  await assert.rejects(
    createBackup(driver, { companyId: COMPANY, key, tables: ["hub_receipts", "products"] }),
    isBackupError("internal_table")
  );
  await assert.rejects(
    createBackup(driver, { companyId: COMPANY, key, tables: ["outbox"] }),
    isBackupError("internal_table")
  );

  const envelope = await createBackup(driver, { companyId: COMPANY, key, now: () => FIXED_ISO });
  const target = await freshDriver();
  await assert.rejects(
    restoreBackup(target, envelope, key, { companyId: OTHER_COMPANY }),
    isBackupError("company_mismatch")
  );
  assert.equal((await target.query({ table: "products", includeDeleted: true })).length, 0);
});

test("clave en disco: 44 bytes, modo 0600 y nunca se regenera", async () => {
  const io = createMemoryIo();
  const dir = "/datos/hub";
  const created = await loadOrCreateBackupKey(dir, { io });
  assert.equal(created.created, true);
  const keyPath = `${dir}/${BACKUP_KEY_FILE}`;
  const stored = io.files.get(keyPath);
  assert.ok(stored, "el archivo de clave existe");
  assert.equal(new TextEncoder().encode(stored as string).length, BACKUP_KEY_FILE_BYTES);
  assert.match((stored as string).trim(), /^[A-Za-z0-9_-]{43}$/);
  assert.equal(io.modes.get(keyPath), 0o600);
  assert.ok(!created.path.includes((stored as string).trim()), "la ruta no contiene la clave");

  const loaded = await loadOrCreateBackupKey(dir, { io });
  assert.equal(loaded.created, false);
  assert.equal(io.files.get(keyPath), stored, "la clave existente no se reescribe");

  // Un archivo corrupto no se sobrescribe: los respaldos previos quedarían ilegibles.
  io.files.set(keyPath, "no-es-una-clave\n");
  await assert.rejects(loadOrCreateBackupKey(dir, { io }), isBackupError("invalid_key"));
  assert.equal(io.files.get(keyPath), "no-es-una-clave\n");
});

test("rotación: 7 diarios, 4 semanales y nombres ISO correctos", async () => {
  const driver = await freshDriver();
  await seed(driver);
  const { raw, key } = await ephemKey();
  const envelope = await createBackup(driver, { companyId: COMPANY, key, now: () => FIXED_ISO });

  // Diez días seguidos: 2026-01-05 (lunes) … 2026-01-14.
  const io = createMemoryIo();
  const dir = "/respaldos/hub";
  let last = { dailyKept: 0, weeklyKept: 0, removed: 0 };
  let removedTotal = 0;
  const days: string[] = [];
  for (let index = 0; index < 10; index += 1) {
    const day = new Date(Date.UTC(2026, 0, 5 + index)).toISOString().slice(0, 10);
    days.push(day);
    const now = () => `${day}T09:00:00.000Z`;
    await writeBackupFile(dir, envelope, { io, now });
    // Mismo día dos veces: el archivo se sobrescribe, no se duplica.
    if (index === 0) await writeBackupFile(dir, envelope, { io, now });
    last = await rotateBackups(dir, { io, now });
    removedTotal += last.removed;
  }

  assert.equal(last.dailyKept, 7);
  assert.equal(last.weeklyKept, 2, "las diez fechas caen en las semanas ISO 2 y 3");
  assert.equal(removedTotal, 3, "se purgan los tres diarios más viejos");

  const names = await io.readdir(`${dir}/backups`);
  const daily = names.filter((name) => name.startsWith("palmyra-"));
  assert.deepEqual(daily, days.slice(3).map((day) => `palmyra-${day}.pbak`));
  assert.deepEqual(names.filter((name) => name.startsWith("weekly-")).sort(), [
    "weekly-2026-W02.pbak",
    "weekly-2026-W03.pbak"
  ]);

  // Seis semanas: los semanales se recortan a los cuatro más recientes.
  const weeklyIo = createMemoryIo();
  const weeklyDir = "/respaldos/semanal";
  let weeklyLast = { dailyKept: 0, weeklyKept: 0, removed: 0 };
  for (let week = 0; week < 6; week += 1) {
    const day = new Date(Date.UTC(2026, 0, 5 + week * 7)).toISOString().slice(0, 10);
    const now = () => `${day}T09:00:00.000Z`;
    await writeBackupFile(weeklyDir, envelope, { io: weeklyIo, now });
    weeklyLast = await rotateBackups(weeklyDir, { io: weeklyIo, now });
  }
  assert.equal(weeklyLast.weeklyKept, 4);
  assert.equal(weeklyLast.dailyKept, 6, "aún no hay más de siete diarios");
  const weeklyNames = (await weeklyIo.readdir(`${weeklyDir}/backups`))
    .filter((name) => name.startsWith("weekly-"))
    .sort();
  assert.deepEqual(weeklyNames, [
    "weekly-2026-W04.pbak",
    "weekly-2026-W05.pbak",
    "weekly-2026-W06.pbak",
    "weekly-2026-W07.pbak"
  ]);

  // Ningún archivo ni nombre de archivo contiene la clave en claro.
  for (const [path, data] of [...io.files, ...weeklyIo.files]) {
    assert.ok(!path.includes(raw), "el nombre del archivo no filtra la clave");
    assert.ok(!data.includes(raw), "el contenido no filtra la clave");
  }
});
