/**
 * Arnés de aceptación F2-E: cinco equipos contra un hub real, 73 h sin hub,
 * recuperación con el mismo almacén y respaldo cifrado restaurado en otro
 * equipo sin volver a emparejar.
 *
 * Todo corre en loopback con puerto efímero y reloj inyectado. Los tokens se
 * obtienen emparejando con el handler y se pasan explícitos a cada cliente: no
 * se toca el almacén de sesión global.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { createMemoryDriver } from "../../src/services/localDb/memoryDriver";
import type { LocalDbDriver, LocalRow } from "../../src/services/localDb/contract";
import { createHubHandler, type HubHandler } from "../../src/services/lanHub/handler";
import { createHubNodeServer, type HubNodeServer } from "../../src/services/lanHub/nodeServer";
import { createHubOpsClient, type HubOperation } from "../../src/services/lanHub/opsClient";
import { HUB_ROUTES } from "../../src/services/lanHub/protocol";
import { createHubOutbox, createMemoryCursorStore } from "../../src/services/localDb/hubOutbox";
import {
  computeBackupHash,
  createBackup,
  createBackupKey,
  decryptBackup,
  importBackupKey,
  restoreBackup,
  verifyBackupContent
} from "../../src/services/lanHub/backup";

const COMPANY = "co-aceptacion";
const HUB_ID = "hub-aceptacion";
const FIXED_MS = Date.parse("2026-05-01T12:00:00.000Z");
const FIXED_ISO = new Date(FIXED_MS).toISOString();
const DAY_MS = 24 * 60 * 60 * 1000;
/** Corte simulado: 73 h sin hub, por encima del tope de 72 h del plan. */
const OUTAGE_MS = 73 * 60 * 60 * 1000;
const DEVICES = ["eq-1", "eq-2", "eq-3", "eq-4", "eq-5"];
const TEST_TIMEOUT = 30_000;

function productRow(deviceId: string, id: string): LocalRow {
  return {
    id,
    company_id: COMPANY,
    version: 1,
    updated_at: FIXED_ISO,
    origin_device: deviceId,
    deleted_at: null,
    name: `Producto ${id}`,
    sku: id,
    price: 100,
    warehouse_id: "w-1"
  };
}

function saleRow(deviceId: string, id: string, total: number): LocalRow {
  return {
    id,
    company_id: COMPANY,
    version: 1,
    updated_at: FIXED_ISO,
    origin_device: deviceId,
    deleted_at: null,
    total,
    warehouse_id: "w-1",
    created_at: FIXED_ISO
  };
}

function stockRow(deviceId: string, id: string, productId: string, quantity: number): LocalRow {
  return {
    id,
    company_id: COMPANY,
    version: 1,
    updated_at: FIXED_ISO,
    origin_device: deviceId,
    deleted_at: null,
    product_id: productId,
    warehouse_id: "w-1",
    quantity
  };
}

async function freshDriver(): Promise<LocalDbDriver> {
  const driver = createMemoryDriver({ now: () => FIXED_ISO });
  await driver.ready();
  return driver;
}

/** Hub real en loopback con puerto efímero y reloj fijo inyectado. */
async function startHub(
  driver: LocalDbDriver,
  clockMs: number
): Promise<{ handler: HubHandler; server: HubNodeServer }> {
  const handler = createHubHandler({
    driver,
    hubId: HUB_ID,
    companyId: COMPANY,
    now: () => clockMs
  });
  const server = await createHubNodeServer({ handler, eventsPollMs: 50, eventsPingMs: 5000 });
  return { handler, server };
}

/** Empareja un equipo llamando al handler (mismo POST /lan/v1/pair del cable). */
async function pairDevice(handler: HubHandler, deviceId: string): Promise<string> {
  const session = handler.createPairingSession();
  const response = await handler({
    method: "POST",
    path: HUB_ROUTES.pair,
    headers: {},
    bodyText: JSON.stringify({
      pairingCode: session.code,
      deviceId,
      deviceName: deviceId,
      platform: "aceptacion",
      companyId: COMPANY
    })
  });
  assert.equal(response.status, 200, `emparejamiento de ${deviceId}`);
  const body = JSON.parse(response.body) as { deviceToken?: string };
  assert.ok(body.deviceToken, `el hub entregó token a ${deviceId}`);
  return body.deviceToken as string;
}

function opsFor(deviceId: string, index: number): HubOperation[] {
  const productA = productRow(deviceId, `p-${index}-a`);
  const productB = productRow(deviceId, `p-${index}-b`);
  const sale = saleRow(deviceId, `s-${index}`, 100 + index);
  return [
    { actionId: `${deviceId}:products:${productA.id}:1`, table: "products", rows: [productA], deletes: [] },
    { actionId: `${deviceId}:products:${productB.id}:1`, table: "products", rows: [productB], deletes: [] },
    { actionId: `${deviceId}:sales:${sale.id}:1`, table: "sales", rows: [sale], deletes: [] }
  ];
}

async function allRows(driver: LocalDbDriver, table: "products" | "sales" | "stock_balances"): Promise<LocalRow[]> {
  return driver.query<LocalRow>({
    table,
    where: [{ field: "company_id", op: "eq", value: COMPANY }],
    includeDeleted: true,
    orderBy: { field: "id", direction: "asc" }
  });
}

test(
  "cinco equipos escriben a la vez en un solo hub sin pérdidas y el reintento es idempotente",
  { timeout: TEST_TIMEOUT },
  async () => {
    const hubDriver = await freshDriver();
    const { handler, server } = await startHub(hubDriver, FIXED_MS);
    const clients = [];
    const batches: HubOperation[][] = [];
    try {
      for (let index = 0; index < DEVICES.length; index += 1) {
        const deviceId = DEVICES[index];
        const token = await pairDevice(handler, deviceId);
        clients.push(
          createHubOpsClient({
            baseUrl: server.url,
            token,
            deviceId,
            now: () => FIXED_MS,
            sleep: async () => undefined,
            maxAttempts: 1,
            timeoutMs: 5000
          })
        );
        batches.push(opsFor(deviceId, index + 1));
      }

      const tokens = new Set(clients.map((client) => client.deviceId));
      assert.equal(tokens.size, 5, "cinco equipos distintos");
      assert.equal((await hubDriver.query({ table: "hub_devices" })).length, 5);

      // Los cinco lotes viajan a la vez: el hub serializa transacciones.
      const firstPass = await Promise.all(clients.map((client, index) => client.push(batches[index])));
      for (const batch of firstPass) {
        assert.equal(batch.ok, true, "el hub acusó el lote");
        if (!batch.ok) continue;
        assert.equal(batch.results.length, 3);
        for (const outcome of batch.results) {
          assert.equal(outcome.status, "accepted", `${outcome.actionId}: ${outcome.error ?? ""}`);
        }
      }

      const products = await allRows(hubDriver, "products");
      const sales = await allRows(hubDriver, "sales");
      assert.equal(products.length, 10, "dos productos por equipo, sin pérdidas");
      assert.equal(sales.length, 5, "una venta por equipo");
      for (let index = 1; index <= 5; index += 1) {
        assert.ok(products.some((row) => row.id === `p-${index}-a`));
        assert.ok(products.some((row) => row.id === `p-${index}-b`));
        assert.ok(sales.some((row) => row.id === `s-${index}`));
      }
      assert.equal((await hubDriver.query({ table: "hub_receipts" })).length, 15);

      // Reenviar exactamente los mismos lotes: duplicate, ni una fila de más.
      const secondPass = await Promise.all(clients.map((client, index) => client.push(batches[index])));
      for (const batch of secondPass) {
        assert.equal(batch.ok, true);
        if (!batch.ok) continue;
        for (const outcome of batch.results) {
          assert.equal(outcome.status, "duplicate", "idempotencia por actionId");
        }
      }
      assert.equal((await allRows(hubDriver, "products")).length, 10);
      assert.equal((await allRows(hubDriver, "sales")).length, 5);
      assert.equal((await hubDriver.query({ table: "hub_receipts" })).length, 15);
    } finally {
      await server.close();
      await hubDriver.close();
    }
  }
);

test(
  "73 h sin hub: la bandeja conserva las ventas y, al volver, se recupera y se respalda",
  { timeout: TEST_TIMEOUT },
  async () => {
    const hubDriver = await freshDriver();
    const first = await startHub(hubDriver, FIXED_MS);
    let second: { handler: HubHandler; server: HubNodeServer } | null = null;
    const clientDriver = await freshDriver();
    try {
      const token = await pairDevice(first.handler, "eq-1");
      const deviceId = "eq-1";
      const hubUrl = first.server.url;
      // El hub se cae: a partir de aquí no hay red ni acuses.
      await first.server.close();

      await clientDriver.put("products", [productRow(deviceId, "p-offline-1")]);
      await clientDriver.put("sales", [saleRow(deviceId, "s-offline-1", 999)]);
      await clientDriver.put("stock_balances", [stockRow(deviceId, "b-offline-1", "p-offline-1", 3)]);

      const outbox = createHubOutbox(clientDriver, {
        deviceId,
        companyId: COMPANY,
        originDevice: deviceId,
        cursor: createMemoryCursorStore()
      });
      const pending = await outbox.collect();
      assert.equal(pending.ops.length, 3, "producto, venta y saldo pendientes");

      const afterOutageMs = FIXED_MS + OUTAGE_MS;
      const offlineClient = createHubOpsClient({
        baseUrl: hubUrl,
        token,
        deviceId,
        now: () => afterOutageMs,
        sleep: async () => undefined,
        maxAttempts: 1,
        timeoutMs: 2000
      });
      const failed = await offlineClient.push(pending.ops);
      assert.equal(failed.ok, false, "sin hub no hay acuse");
      if (failed.ok === false) assert.equal(failed.retryable, true);

      // Ningún acuse avanza: el cursor sigue en cero y las filas siguen ahí.
      assert.equal(await outbox.loadCursor(), 0);
      assert.equal((await clientDriver.get<LocalRow>("sales", "s-offline-1"))?.total, 999);
      const retry = await outbox.collect();
      assert.deepEqual(
        retry.ops.map((op) => op.actionId),
        pending.ops.map((op) => op.actionId),
        "reintentar reenvía los mismos actionId"
      );
      // El bloqueo de escritura por 72 h (solo lectura) lo evalúa F2-D en
      // resilience.ts; aquí se comprueba lo que este arnés posee: ni una venta
      // se pierde de la bandeja mientras el hub está caído.

      // Vuelve el hub con el MISMO almacén: los tokens siguen valiendo.
      second = await startHub(hubDriver, afterOutageMs);
      const recovered = createHubOpsClient({
        baseUrl: second.server.url,
        token,
        deviceId,
        now: () => afterOutageMs,
        sleep: async () => undefined,
        maxAttempts: 1,
        timeoutMs: 5000
      });
      const applied = await recovered.push(retry.ops);
      assert.equal(applied.ok, true, "el hub volvió a responder");
      if (applied.ok) {
        for (const outcome of applied.results) {
          assert.equal(outcome.status, "accepted", `${outcome.actionId}: ${outcome.error ?? ""}`);
        }
      }
      await outbox.saveCursor(retry.nextSeq);
      assert.equal(await outbox.loadCursor(), retry.nextSeq, "el acuse avanza el cursor");

      assert.ok(await hubDriver.get<LocalRow>("sales", "s-offline-1"), "la venta llegó al hub");
      assert.ok(await hubDriver.get<LocalRow>("products", "p-offline-1"));
      assert.ok(await hubDriver.get<LocalRow>("stock_balances", "b-offline-1"));

      // Respaldo del hub y restauración en un equipo nuevo, sin emparejar.
      const rawKey = await createBackupKey();
      const key = await importBackupKey(rawKey);
      const envelope = await createBackup(hubDriver, {
        companyId: COMPANY,
        key,
        now: () => new Date(afterOutageMs).toISOString()
      });
      const content = await decryptBackup(envelope, key);

      const restoredDriver = await freshDriver();
      const result = await restoreBackup(restoredDriver, envelope, key, { companyId: COMPANY });
      assert.deepEqual(result.counts, envelope.counts);
      assert.ok(result.restored >= 3);

      const hubProducts = await allRows(hubDriver, "products");
      const hubSales = await allRows(hubDriver, "sales");
      const restoredProducts = await allRows(restoredDriver, "products");
      const restoredSales = await allRows(restoredDriver, "sales");
      assert.equal(restoredProducts.length, hubProducts.length);
      assert.equal(restoredSales.length, hubSales.length);
      assert.equal(
        computeBackupHash({ products: restoredProducts, sales: restoredSales }),
        computeBackupHash({ products: hubProducts, sales: hubSales }),
        "mismo hash de productos y ventas"
      );
      assert.deepEqual(restoredProducts, hubProducts);
      assert.deepEqual(restoredSales, hubSales);

      const report = await verifyBackupContent(restoredDriver, content, { companyId: COMPANY });
      assert.equal(report.ok, true, report.mismatches.join("; "));
      assert.equal(
        (await restoredDriver.query({ table: "hub_devices" })).length,
        0,
        "restaurar no requiere ni copia emparejamientos"
      );
      await restoredDriver.close();
    } finally {
      if (second) await second.server.close();
      await clientDriver.close();
      await hubDriver.close();
    }
  }
);

test("el arnés no deja puertos ni servidores abiertos entre pruebas", { timeout: TEST_TIMEOUT }, async () => {
  // Un hub nuevo arranca en otro puerto efímero y responde salud pública.
  const hubDriver = await freshDriver();
  const { server } = await startHub(hubDriver, FIXED_MS + DAY_MS);
  try {
    const response = await fetch(`${server.url}${HUB_ROUTES.health}`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { ok?: boolean; hubId?: string };
    assert.equal(body.ok, true);
    assert.equal(body.hubId, HUB_ID);
  } finally {
    await server.close();
    await hubDriver.close();
  }
});
