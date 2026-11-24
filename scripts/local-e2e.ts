/**
 * Arnés end-to-end LOCAL de PALMYRA (sin red externa, sin archivos).
 *
 * Demuestra que la cadena completa funciona junta:
 *   sombra legado → almacén local → hub LAN real en loopback → emparejamiento,
 *   lote validado e idempotente, cambios incrementales → respaldo cifrado →
 *   licencia ES256 con revocación y telemetría → tasas con caché local →
 *   anulación append-only en `sale_voids` → canal SSE continuo → tasas del hub
 *   con fetch inyectable → respaldo binario SQLite →
 *   importación verificada (conteos/sumas/hash) → escritura inmediata del POS →
 *   push real al hub con outbox y filtro por origen → pull de un segundo equipo
 *   sin eco → paridad legado ↔ almacén.
 *
 * Reglas del arnés:
 * - Solo loopback (127.0.0.1) y puertos efímeros.
 * - Ningún artefacto se escribe en el repositorio (todo vive en memoria).
 * - Nunca se imprimen tokens ni material de clave.
 * - Cada paso se evalúa por separado; la salida final es PASS/FAIL por paso y
 *   el proceso termina con código 1 si algo falla.
 */
import {
  createHash,
  createPrivateKey,
  sign as signWithKey,
  type JsonWebKey as NodeJsonWebKey
} from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Transaction } from "../src/types";
import type { LocalDbDriver, LocalRow, LocalTable } from "../src/services/localDb/contract";
import { createMemoryDriver } from "../src/services/localDb/memoryDriver";
import { createLegacyShadowWriter } from "../src/services/localDb/legacyShadow";
import { createMemoryShadowIndexStore } from "../src/services/localDb/shadowIndex";
import {
  BackupError,
  BACKUP_MIN_ITERATIONS,
  createBackupResult,
  restoreBackup
} from "../src/services/localDb/backup/index";
import {
  isSqliteFile,
  readBinaryBackup,
  snapshotToBackupBytes,
  validateBinaryRestore
} from "../src/services/localDb/backup/binary";
import {
  assertSaleNotVoided,
  buildSaleVoidRow,
  effectiveSaleStatus,
  isSaleVoided,
  recordSaleVoid,
  SALE_VOID_REASONS
} from "../src/services/localDb/saleLifecycle";
import { applyVerifiedImport } from "../src/services/localDb/importVerify";
import { compareLocalDbWithLegacy } from "../src/services/localDb/parity";
import { mirrorCashMovement, mirrorCompletedSale, mirrorSaleVoid } from "../src/services/localDb/posWriteThrough";
import { createHubHandler, type HubHandler } from "../src/services/lanHub/handler";
import { createHubNodeServer, type HubNodeServer } from "../src/services/lanHub/nodeServer";
import { joinHub } from "../src/services/lanHub/pairing";
import {
  advanceCursor,
  clearHubSession,
  configureHubSessionStorage,
  createMemoryHubSessionStore,
  getHubSession,
  loadHubOutboxCursor
} from "../src/services/lanHub/session";
import { createHubClient } from "../src/services/lanHub/client";
import { startHubClientLoop } from "../src/services/lanHub/clientLoop";
import { applyHubChanges, type HubChange } from "../src/services/lanHub/syncClient";
import {
  createHubOpsClient,
  type HubOperation,
  type HubOpOutcome,
  type HubOpOutcomeStatus,
  type HubOpsClient
} from "../src/services/lanHub/opsClient";
import { createHubRatesProvider } from "../src/services/lanHub/rates";
import { readChangeFeed } from "../src/services/lanHub/changesFeed";
import { openHubEvents, type HubEventPage } from "../src/services/lanHub/events";
import { createMemoryLicenseStore, saveDeviceKey, saveLease } from "../src/services/license/storage";
import { createDeviceKey } from "../src/services/license/deviceKey";
import { createLicenseRuntime, type LicenseRuntimeClient } from "../src/services/license/runtime";
import {
  drainClockTelemetry,
  queueClockTamperEvent,
  type ClockTamperTelemetryClient
} from "../src/services/license/telemetry";
import {
  leaseSigningInput,
  toBase64Url,
  type SignedLease
} from "../src/services/license/contract";
import { importVerifyKey, verifyLeaseForDevice } from "../src/services/license/verify";

/* ------------------------------------------------------------------ */
/* Piezas puras (probadas en tests/unit/local-e2e.test.ts)            */
/* ------------------------------------------------------------------ */

export interface StepResult {
  n: number;
  name: string;
  ok: boolean;
  detail: string;
}

export const STEP_NAMES: readonly string[] = Object.freeze([
  "Estado legado → escritura en sombra",
  "Hub LAN real en 127.0.0.1 (puerto efímero)",
  "Emparejamiento y token de dispositivo",
  "Lote propuesto: válido + rechazos del hub",
  "Idempotencia: reenvío sin duplicar filas",
  "Cambios incrementales y cursor monótono",
  "Respaldo cifrado: alterar, restaurar, comparar",
  "Licencia ES256, revocación y telemetría",
  "Tasas del hub con caché local",
  "Anulación de venta: anexo append-only en sale_voids",
  "Canal SSE continuo: dos páginas sin reconectar",
  "Tasas del hub con fetch inyectable y respaldo",
  "Respaldo binario SQLite: envolver, leer y rechazar",
  "Importación verificada: conteos, sumas y huella",
  "Escritura inmediata del POS: venta, anulación y caja",
  "Push real al hub: outbox, cursor y filtro por origen",
  "Pull al segundo equipo sin reenviar su journal",
  "Paridad legado ↔ almacén y alteración detectada",
  "Resumen legible y código de salida"
]);

export function summarizeSteps(results: StepResult[]): {
  text: string;
  exitCode: number;
  passed: number;
  failed: number;
} {
  const ordered = [...results].sort((a, b) => a.n - b.n);
  let passed = 0;
  let failed = 0;
  const lines: string[] = [];
  for (const result of ordered) {
    if (result.ok) passed += 1;
    else failed += 1;
    const mark = result.ok ? "PASS" : "FAIL";
    lines.push(`${mark}  ${String(result.n).padStart(2, "0")}. ${result.name}`);
    if (result.detail) lines.push(`      ${result.detail}`);
  }
  lines.push("");
  lines.push(`Resumen: ${passed}/${ordered.length} pasos correctos${failed ? `, ${failed} con fallo` : ""}`);
  return { text: lines.join("\n"), exitCode: failed === 0 ? 0 : 1, passed, failed };
}

/** Diferencias entre dos mapas de conteos; lista vacía si coinciden. */
export function compareRowCounts(
  expected: Record<string, number>,
  actual: Record<string, number>
): string[] {
  const tables = new Set([...Object.keys(expected ?? {}), ...Object.keys(actual ?? {})]);
  const issues: string[] = [];
  for (const table of [...tables].sort()) {
    const want = Number(expected?.[table] ?? 0);
    const got = Number(actual?.[table] ?? 0);
    if (want !== got) issues.push(`${table}: esperado ${want}, real ${got}`);
  }
  return issues;
}

/** Compara acuses por operación (estado y, si aplica, código de error). */
export function checkOutcomes(
  actual: HubOpOutcome[],
  expected: Array<{ actionId: string; status: HubOpOutcomeStatus; error?: string }>
): string[] {
  const issues: string[] = [];
  for (const want of expected) {
    const got = actual.find((item) => item.actionId === want.actionId);
    if (!got) {
      issues.push(`sin acuse para ${want.actionId}`);
      continue;
    }
    if (got.status !== want.status) {
      issues.push(
        `${want.actionId}: esperado ${want.status}, recibido ${got.status}${got.error ? ` (${got.error})` : ""}`
      );
      continue;
    }
    if (want.error && got.error !== want.error) {
      issues.push(`${want.actionId}: error esperado ${want.error}, recibido ${got.error ?? "(ninguno)"}`);
    }
  }
  return issues;
}

/** Estado legado mínimo (formato zustand/persist) para la escritura en sombra. */
export function buildLegacyFixture(): unknown {
  return {
    state: {
      currentBranchId: "wh-e2e",
      branches: [{ id: "wh-e2e", name: "Centro E2E" }],
      products: [
        { id: "p1", name: "Cemento gris", price: 150 },
        { id: "p2", name: "Arena fina", price: 60 }
      ],
      inventory: [
        { productId: "p1", branchId: "wh-e2e", quantity: 20 },
        { productId: "p2", branchId: "wh-e2e", quantity: 10 }
      ],
      transactions: [{ id: "legacy-t1", branchId: "wh-e2e", total: 120 }],
      cashSessions: [{ id: "legacy-s1", branchId: "wh-e2e", openingBalance: 0 }]
    },
    version: 0
  };
}

export function makeSaleRow(
  companyId: string,
  deviceId: string,
  at: string,
  overrides: Record<string, unknown> = {}
): LocalRow {
  return {
    id: "sale-e2e-1",
    company_id: companyId,
    version: 1,
    updated_at: at,
    origin_device: deviceId,
    deleted_at: null,
    warehouse_id: "wh-e2e",
    total: 250,
    status: "completed",
    ...overrides
  };
}

export function makeNegativeStockRow(companyId: string, deviceId: string, at: string): LocalRow {
  return {
    id: "stock-neg-e2e",
    company_id: companyId,
    version: 1,
    updated_at: at,
    origin_device: deviceId,
    deleted_at: null,
    product_id: "prod-stock-e2e",
    warehouse_id: "wh-e2e",
    quantity: -5
  };
}

/**
 * Estado legado de F1: productos, inventario en dos presentaciones, dos ventas
 * con líneas y pagos, y un turno con dos movimientos. Es la base compartida de
 * la importación verificada y de la paridad (pasos 14 y 18).
 */
export function buildF1LegacyFixture(): unknown {
  return {
    state: {
      branches: [{ id: "wh-e2e", name: "Centro E2E" }],
      products: [
        { id: "p1", name: "Cemento gris", price: 150, costPrice: 100, sku: "CEM-1" },
        { id: "p2", name: "Arena fina", price: 60, costPrice: 40, sku: "ARE-1" }
      ],
      inventory: [
        { productId: "p1", branchId: "wh-e2e", quantity: 10, minQuantity: 2 },
        { productId: "p2", branchId: "wh-e2e", quantity: 5, minQuantity: 1 }
      ],
      transactions: [
        {
          id: "sale-fixture-1",
          branchId: "wh-e2e",
          date: "2026-06-14T10:00:00.000Z",
          total: 1500,
          status: "completed",
          items: [
            {
              id: "line-1",
              product: { id: "p1", name: "Cemento gris" },
              quantity: 10,
              price: 150,
              total: 1500
            }
          ],
          payments: [{ id: "pay-cup", currencyCode: "CUP", amount: 1500, exchangeRate: 1, method: "cash" }]
        },
        {
          id: "sale-fixture-2",
          branchId: "wh-e2e",
          date: "2026-06-15T09:00:00.000Z",
          total: 250.5,
          status: "completed",
          items: [
            { id: "line-2", productId: "p2", quantity: 4, price: 60, total: 240 },
            { id: "line-3", productId: "p1", quantity: 0.07, price: 150, total: 10.5 }
          ],
          payments: [
            { id: "pay-usd", currencyCode: "USD", amount: 1, exchangeRate: 250.5, method: "transfer" },
            { id: "pay-cup-2", currencyCode: "CUP", amount: 0, exchangeRate: 1, method: "cash" }
          ]
        }
      ],
      cashSessions: [
        {
          id: "shift-e2e",
          branchId: "wh-e2e",
          openingBalance: 100,
          status: "closed",
          movements: [
            { id: "mov-1", type: "income", amount: 50, currencyCode: "CUP" },
            { id: "mov-2", type: "expense", amount: 20, currencyCode: "CUP" }
          ]
        }
      ]
    },
    version: 0
  };
}

/**
 * Venta cerrada del POS con dos líneas y dos pagos, con la misma forma que usa
 * `mirrorCompletedSale` en producción (tipos de `src/types`).
 */
export function buildF1SaleTransaction(overrides: Record<string, unknown> = {}): Transaction {
  return {
    id: "sale-f1-pos",
    warehouseId: "wh-e2e",
    branchId: "wh-e2e",
    userId: "cajero-e2e",
    cashierName: "Cajero E2E",
    date: "2026-06-15T12:00:00.000Z",
    subtotal: 480,
    tax: 0,
    discount: 0,
    total: 480,
    status: "completed",
    sessionId: "shift-e2e",
    payments: [
      { currencyCode: "CUP", amount: 300, exchangeRate: 1, method: "cash" },
      { currencyCode: "CUP", amount: 180, exchangeRate: 1, method: "cash" }
    ],
    items: [
      {
        id: "line-1",
        product: {
          id: "p1",
          name: "Cemento gris",
          sku: "CEM-1",
          costPrice: 100,
          price: 150,
          margin: 50,
          categoryId: "cat-1",
          color: "bg-white",
          commissionValue: 0
        },
        quantity: 2,
        price: 150,
        total: 300
      },
      {
        id: "line-2",
        product: {
          id: "p2",
          name: "Arena fina",
          sku: "ARE-1",
          costPrice: 40,
          price: 90,
          margin: 50,
          categoryId: "cat-1",
          color: "bg-white",
          commissionValue: 0
        },
        quantity: 2,
        price: 90,
        total: 180
      }
    ],
    ...overrides
  } as unknown as Transaction;
}

/** Fila mínima de producto con el origen que exige el filtro del outbox. */
export function makeProductRow(id: string, companyId: string, originDevice: string, at: string): LocalRow {
  return {
    id,
    company_id: companyId,
    version: 1,
    updated_at: at,
    origin_device: originDevice,
    deleted_at: null,
    name: `Producto ${id}`,
    price: 25
  };
}

/* ------------------------------------------------------------------ */
/* Utilidades del arnés                                               */
/* ------------------------------------------------------------------ */

const HUB_PAIRING_CODE = "48291573";
const COMPANY_ID = "co-e2e";
const ORIGIN_DEVICE = "dev-legacy";
const BASE_MS = Date.parse("2026-06-15T12:00:00.000Z");

function createClock(): { ms: () => number; iso: () => string; advance: (ms: number) => void } {
  let current = BASE_MS;
  return {
    ms: () => current,
    iso: () => new Date(current).toISOString(),
    advance: (ms: number) => {
      current += ms;
    }
  };
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Espera activa con tope: el arnés nunca se queda colgado por un bucle. */
async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error("tiempo de espera agotado en el arnés");
    await delay(10);
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

/**
 * Deja mudo el canal de entrada (SSE 404 y páginas vacías) para medir el push
 * sin el eco del pull. Cuenta las llamadas a `/lan/v1/ops` y reenvía el resto
 * de peticiones, que son las que sí deben llegar al hub real.
 */
function createQuietPushFetch(at: string): { impl: typeof fetch; opsCalls: () => number } {
  let ops = 0;
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/lan/v1/events")) return jsonResponse({ error: "not_found" }, 404);
    if (url.includes("/lan/v1/changes")) {
      return jsonResponse({ changes: [], latestSeq: 0, serverTime: at, hasMore: false });
    }
    if (url.includes("/lan/v1/ops")) ops += 1;
    return fetch(input, init);
  }) as typeof fetch;
  return { impl, opsCalls: () => ops };
}

async function countRows(driver: LocalDbDriver, companyId: string, table: LocalTable): Promise<number> {
  const rows = await driver.query({
    table,
    where: [{ field: "company_id", op: "eq", value: companyId }]
  });
  return rows.length;
}

async function rowCounts(
  driver: LocalDbDriver,
  companyId: string,
  tables: readonly LocalTable[]
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of tables) counts[table] = await countRows(driver, companyId, table);
  return counts;
}

function listen(server: HttpServer, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.removeListener("error", onError);
      const address = server.address() as AddressInfo | null;
      resolve(address ? address.port : 0);
    });
  });
}

function closeHttpServer(server: HttpServer): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

/* ------------------------------------------------------------------ */
/* Escenario                                                          */
/* ------------------------------------------------------------------ */

async function main(): Promise<number> {
  const clock = createClock();
  const driver = createMemoryDriver({ now: clock.iso });
  const results: StepResult[] = [];

  let hubHandler: HubHandler | null = null;
  let hubServer: HubNodeServer | null = null;
  let deviceId = "";
  let token = "";
  let baselineSeq = 0;
  let operations: HubOperation[] = [];
  let opsClient: HubOpsClient | null = null;
  let countsAfterApply: Record<string, number> = {};
  /** Piezas compartidas por los pasos F1 (14 importación, 16-18 push/pull). */
  let importDriver: LocalDbDriver | null = null;
  let f1Fixture: unknown = null;
  let f1HubHandler: HubHandler | null = null;
  let f1Hub: HubNodeServer | null = null;
  let f1HubDriver: LocalDbDriver | null = null;
  let deviceA = "";

  const step = async (
    n: number,
    fn: () => Promise<string>,
    explicitName?: string
  ): Promise<void> => {
    const name = explicitName ?? STEP_NAMES[n - 1] ?? `Paso ${n}`;
    try {
      const detail = await fn();
      results.push({ n, name, ok: true, detail });
    } catch (error) {
      results.push({ n, name, ok: false, detail: describeError(error) });
    }
  };

  try {
    await driver.ready();
    configureHubSessionStorage(createMemoryHubSessionStore());

    // 1. Estado legado → escritura en sombra -------------------------------
    await step(1, async () => {
      const writer = createLegacyShadowWriter({
        driver,
        companyId: COMPANY_ID,
        originDevice: ORIGIN_DEVICE,
        index: createMemoryShadowIndexStore(),
        now: clock.iso
      });
      const raw = JSON.stringify(buildLegacyFixture());
      const first = await writer.sync(raw);
      if (!first || !first.rawChanged) throw new Error("la primera pasada no importó el estado legado");
      const second = await writer.sync(raw);
      if (!second || second.rawChanged) throw new Error("la segunda pasada volvió a importar el mismo JSON");

      const counts = await rowCounts(driver, COMPANY_ID, [
        "companies",
        "products",
        "sales",
        "stock_balances"
      ]);
      const want = { companies: 1, products: 2, sales: 1, stock_balances: 2 };
      const issues = compareRowCounts(want, counts);
      if (issues.length) throw new Error(`conteos inesperados (${issues.join("; ")})`);
      return `products=2, sales=1, stock_balances=2; segunda pasada sin reimportar`;
    });

    // 2. Hub LAN real en loopback -----------------------------------------
    await step(2, async () => {
      hubHandler = createHubHandler({
        driver,
        hubId: "hub-e2e",
        companyId: COMPANY_ID,
        now: clock.ms,
        pairingCode: () => HUB_PAIRING_CODE
      });
      hubServer = await createHubNodeServer({ handler: hubHandler, port: 0, host: "127.0.0.1" });
      if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(hubServer.url)) {
        throw new Error(`el hub no escuchó en loopback: ${hubServer.url}`);
      }
      const response = await fetch(`${hubServer.url}/lan/v1/health`);
      const body = (await response.json()) as { ok?: boolean; protocol?: number };
      if (!response.ok || body.ok !== true || body.protocol !== 1) {
        throw new Error(`salud del hub inesperada (HTTP ${response.status})`);
      }
      return `escucha en ${hubServer.url} (protocolo 1, salud OK)`;
    });

    // 3. Emparejamiento ----------------------------------------------------
    await step(3, async () => {
      if (!hubHandler || !hubServer) throw new Error("el hub no está disponible (paso 2)");
      const pairing = hubHandler.createPairingSession();
      const joined = await joinHub({
        baseUrl: hubServer.url,
        code: pairing.code,
        deviceName: "Caja E2E",
        companyId: COMPANY_ID,
        platform: "windows",
        now: clock.ms,
        timeoutMs: 5000
      });
      deviceId = joined.session.deviceId;
      token = joined.session.token;
      if (!deviceId || !token) throw new Error("el hub no entregó dispositivo y token");
      const session = await getHubSession();
      if (!session || session.cursor !== 0) throw new Error("la sesión no quedó guardada con cursor 0");
      return `dispositivo emparejado (token recibido y no mostrado), cursor inicial 0`;
    });

    // 4. Lote validado por el hub -----------------------------------------
    await step(4, async () => {
      if (!hubServer) throw new Error("el hub no está disponible (paso 2)");
      const at = clock.iso();

      // Producto ya sincronizado en versión 5: la propuesta con versión 1 es vieja.
      await driver.put("products", [
        {
          id: "prod-stale-e2e",
          company_id: COMPANY_ID,
          version: 5,
          updated_at: at,
          origin_device: deviceId,
          deleted_at: null,
          name: "Producto estable",
          price: 10
        }
      ]);

      const sale = makeSaleRow(COMPANY_ID, deviceId, at);
      operations = [
        { actionId: "e2e:sale:insert", table: "sales", rows: [sale], deletes: [] },
        {
          actionId: "e2e:sale:update",
          table: "sales",
          rows: [{ ...sale, version: 2, total: 999 }],
          deletes: []
        },
        {
          actionId: "e2e:stock:negative",
          table: "stock_balances",
          rows: [makeNegativeStockRow(COMPANY_ID, deviceId, at)],
          deletes: []
        },
        {
          actionId: "e2e:product:stale",
          table: "products",
          rows: [
            {
              id: "prod-stale-e2e",
              company_id: COMPANY_ID,
              version: 1,
              updated_at: at,
              origin_device: deviceId,
              deleted_at: null,
              name: "Nombre viejo",
              price: 5
            }
          ],
          deletes: []
        }
      ];

      baselineSeq = await driver.latestSeq();
      opsClient = createHubOpsClient({
        baseUrl: hubServer.url,
        token,
        deviceId,
        now: clock.ms,
        sleep: async () => undefined,
        maxAttempts: 2,
        timeoutMs: 5000
      });
      const batch = await opsClient.push(operations);
      if (batch.ok !== true) throw new Error(`el hub rechazó el lote completo (${batch.error})`);

      const issues = checkOutcomes(batch.results, [
        { actionId: "e2e:sale:insert", status: "accepted" },
        { actionId: "e2e:sale:update", status: "rejected", error: "append_only" },
        { actionId: "e2e:stock:negative", status: "rejected", error: "negative_stock" },
        { actionId: "e2e:product:stale", status: "rejected", error: "stale_version" }
      ]);
      if (issues.length) throw new Error(`acuses inesperados (${issues.join("; ")})`);

      const storedSale = await driver.get("sales", "sale-e2e-1");
      const storedProduct = await driver.get("products", "prod-stale-e2e");
      const negative = await driver.get("stock_balances", "stock-neg-e2e");
      if (!storedSale || storedSale.total !== 250) throw new Error("la venta aceptada no quedó escrita");
      if (!storedProduct || storedProduct.version !== 5 || storedProduct.name !== "Producto estable") {
        throw new Error("la versión vieja sobrescribió el producto");
      }
      if (negative) throw new Error("el saldo negativo llegó al almacén");

      countsAfterApply = await rowCounts(driver, COMPANY_ID, ["sales", "stock_balances", "products"]);
      return "acuses: accepted + append_only + negative_stock + stale_version";
    });

    // 5. Idempotencia ------------------------------------------------------
    await step(5, async () => {
      if (!opsClient) throw new Error("el cliente del hub no está disponible (paso 4)");
      const saleRowsBefore = await countRows(driver, COMPANY_ID, "sales");
      const stockRowsBefore = await countRows(driver, COMPANY_ID, "stock_balances");

      const resend = await opsClient.push(operations);
      if (resend.ok !== true) throw new Error(`el reenvío falló (${resend.error})`);
      const issues = checkOutcomes(resend.results, [
        { actionId: "e2e:sale:insert", status: "duplicate" },
        { actionId: "e2e:sale:update", status: "rejected", error: "append_only" },
        { actionId: "e2e:stock:negative", status: "rejected", error: "negative_stock" },
        { actionId: "e2e:product:stale", status: "rejected", error: "stale_version" }
      ]);
      if (issues.length) throw new Error(`acuses del reenvío inesperados (${issues.join("; ")})`);

      const saleRowsAfter = await countRows(driver, COMPANY_ID, "sales");
      const stockRowsAfter = await countRows(driver, COMPANY_ID, "stock_balances");
      if (saleRowsAfter !== saleRowsBefore) throw new Error("el reenvío duplicó ventas");
      if (stockRowsAfter !== stockRowsBefore) throw new Error("el reenvío duplicó saldos");
      return "venta acusada como duplicate; filas sin duplicar";
    });

    // 6. Cambios incrementales y cursor -----------------------------------
    await step(6, async () => {
      if (!hubServer) throw new Error("el hub no está disponible (paso 2)");
      const client = createHubClient({
        baseUrl: hubServer.url,
        deviceId,
        token,
        now: clock.ms,
        timeoutMs: 5000
      });
      const changes = await client.changes({ since: baselineSeq, limit: 100 });
      if (!Array.isArray(changes.changes) || changes.changes.length === 0) {
        throw new Error("el hub no devolvió cambios desde el cursor");
      }
      if (changes.changes.some((change) => change.seq <= baselineSeq)) {
        throw new Error("el journal devolvió cambios anteriores al cursor");
      }
      const saleChange = changes.changes.find(
        (change) => change.table === "sales" && change.row_id === "sale-e2e-1"
      ) as (typeof changes.changes)[number] & { row?: LocalRow };
      if (!saleChange || saleChange.op !== "upsert" || !saleChange.row || saleChange.row.total !== 250) {
        throw new Error("el cambio de la venta no llegó con su fila vigente");
      }

      const firstCursor = await advanceCursor(changes.latestSeq);
      if (firstCursor < changes.latestSeq) throw new Error("el cursor no alcanzó el último seq");
      const secondCursor = await advanceCursor(baselineSeq);
      if (secondCursor !== firstCursor) throw new Error("el cursor retrocedió");
      const session = await getHubSession();
      if (!session || session.cursor !== firstCursor) throw new Error("la sesión no conservó el cursor");
      return `${changes.changes.length} cambios con fila; cursor ${baselineSeq}→${firstCursor} sin retroceso`;
    });

    // 7. Respaldo cifrado --------------------------------------------------
    await step(7, async () => {
      const passphrase = "palmyra-e2e-2026";
      const backup = await createBackupResult({
        driver,
        passphrase,
        iterations: BACKUP_MIN_ITERATIONS,
        meta: { companyId: COMPANY_ID, originDevice: deviceId, purpose: "e2e" },
        now: clock.iso
      });
      if (!backup.bytes || backup.bytes.length === 0) throw new Error("el respaldo salió vacío");

      const before = backup.summary.counts;
      const beforeTotal = backup.summary.totalRows;

      await driver.remove("products", ["p1"], {
        company_id: COMPANY_ID,
        origin_device: deviceId,
        at: clock.iso()
      });
      await driver.put("products", [
        {
          id: "prod-alterado-e2e",
          company_id: COMPANY_ID,
          version: 1,
          updated_at: clock.iso(),
          origin_device: deviceId,
          deleted_at: null,
          name: "Producto alterado",
          price: 1
        }
      ]);

      const restored = await restoreBackup({
        bytes: backup.bytes,
        passphrase,
        driver,
        mutation: { company_id: COMPANY_ID, origin_device: deviceId, at: clock.iso() },
        now: clock.iso
      });
      const issues = compareRowCounts(before, restored.counts);
      if (issues.length) throw new Error(`conteos restaurados distintos (${issues.join("; ")})`);
      if (restored.totalRows !== beforeTotal) throw new Error("el total de filas restaurado no coincide");
      if (restored.hash !== backup.summary.hash) throw new Error("el hash restaurado no coincide");
      const p1 = await driver.get("products", "p1");
      const altered = await driver.get("products", "prod-alterado-e2e");
      if (!p1) throw new Error("la restauración no recuperó la fila borrada");
      if (altered) throw new Error("la restauración no eliminó la fila añadida después");

      let wrongCode = "";
      try {
        await restoreBackup({
          bytes: backup.bytes,
          passphrase: "clave-equivocada-e2e",
          driver,
          now: clock.iso
        });
      } catch (error) {
        wrongCode = error instanceof BackupError ? error.code : "otro";
      }
      if (wrongCode !== "decrypt_failed") {
        throw new Error(`la frase incorrecta no fue rechazada (${wrongCode || "sin error"})`);
      }
      return `${beforeTotal} filas, hash ${backup.summary.hash.slice(0, 12)}…; frase incorrecta rechazada`;
    });

    // 8. Licencia ES256 + revocación + telemetría --------------------------
    await step(8, async () => {
      const keygen = (await import("./license-keygen.mjs")) as unknown as {
        generateKeyPairJwks: () => {
          privateJwk: NodeJsonWebKey;
          publicJwk: NodeJsonWebKey;
          fingerprint: string;
        };
      };
      const pair = keygen.generateKeyPairJwks();
      const privateKey = createPrivateKey({ key: pair.privateJwk, format: "jwk" });

      const store = createMemoryLicenseStore();
      const device = await createDeviceKey();
      await saveDeviceKey(store, device);

      const issuedAt = new Date(clock.ms() - 60 * 60 * 1000).toISOString();
      const expiresAt = new Date(clock.ms() + 30 * 24 * 60 * 60 * 1000).toISOString();
      const lease: SignedLease = {
        v: 1,
        leaseId: "lease-e2e-1",
        companyId: COMPANY_ID,
        deviceId: "device-license-e2e",
        devicePubKeyFp: device.fingerprint,
        planCode: "pro",
        billingMonths: 1,
        limits: { maxDevices: 5 },
        featureKeys: ["pos", "reports"],
        storageMode: "hybrid",
        paidThrough: expiresAt,
        issuedAt,
        notBefore: issuedAt,
        expiresAt,
        offlineUntil: new Date(clock.ms() + 15 * 24 * 60 * 60 * 1000).toISOString(),
        graceDays: 7,
        maxOfflineDays: 15,
        serverTimeAnchor: new Date(clock.ms()).toISOString(),
        seq: 1,
        keyId: "e2e-key",
        signature: "",
        signatureAlg: "ES256"
      };
      lease.signature = toBase64Url(
        new Uint8Array(
          signWithKey("sha256", Buffer.from(leaseSigningInput(lease), "utf8"), {
            key: privateKey,
            dsaEncoding: "ieee-p1363"
          })
        )
      );
      await saveLease(store, lease, COMPANY_ID);

      const verification = await verifyLeaseForDevice(lease, {
        verifyKey: await importVerifyKey(pair.publicJwk)
      });
      if (!verification.ok) throw new Error("la firma ES256 no verificó");

      let revoked = false;
      const revocationCalls: string[] = [];
      const telemetryRows: unknown[] = [];
      const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        if (url.includes("/license-telemetry")) {
          const body = JSON.parse(String(init?.body ?? "{}")) as { reports?: unknown[] };
          const reports = Array.isArray(body.reports) ? body.reports : [];
          telemetryRows.push(...reports);
          return new Response(JSON.stringify({ accepted: reports.length, inserted: reports.length, duplicates: 0 }), {
            status: 202,
            headers: { "content-type": "application/json" }
          });
        }
        if (url.includes("/license-public-key.json")) {
          return new Response(JSON.stringify({ keyId: "e2e-key", jwk: pair.publicJwk }), {
            status: 200,
            headers: { "content-type": "application/json" }
          });
        }
        if (url.includes("/revoke-lease")) {
          revocationCalls.push(url);
          const payload = revoked
            ? { revoked: true, revokedAt: clock.iso(), reason: "pago revertido" }
            : { revoked: false };
          return new Response(JSON.stringify(payload), {
            status: 200,
            headers: { "content-type": "application/json" }
          });
        }
        return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
      };

      // Cliente mínimo: la telemetría va por fetch a la Edge Function, nunca por tabla.
      const licenseClient: LicenseRuntimeClient = {
        auth: { getSession: async () => ({ data: { session: { access_token: "e2e-token" } } }) },
        functions: { invoke: async () => ({ data: null, error: null }) },
        supabaseUrl: "http://127.0.0.1:9"
      };
      let client: LicenseRuntimeClient | null = null;

      const runtime = createLicenseRuntime({
        store,
        fetchImpl,
        now: clock.ms,
        getClient: () => client,
        revokeBaseUrl: "http://127.0.0.1:9/functions/v1",
        revocationTtlMs: 0
      });

      const active = await runtime.start({ companyId: COMPANY_ID });
      if (active.mode !== "active" || active.readOnly) {
        throw new Error(`la licencia no quedó activa (${active.mode}/${active.reason})`);
      }

      revoked = true;
      client = licenseClient;
      await queueClockTamperEvent(store, {
        kind: "wall-rollback",
        source: "watermark",
        skewMs: 15 * 60 * 1000,
        detectedAtMs: clock.ms()
      });
      const after = await runtime.refresh({ companyId: COMPANY_ID });
      if (after.mode !== "revoked" || after.readOnly !== true || after.reason !== "lease-revoked") {
        throw new Error(`la revocación no aplicó (${after.mode}/${after.reason})`);
      }
      if (!revocationCalls.some((url) => url.includes("lease-e2e-1"))) {
        throw new Error("no se consultó la revocación del lease");
      }
      // El refresco intenta vaciar con el fetch global (falla sin red en el
      // arnés); el envío verificable es el vaciado con fetch inyectable.
      const drained = await drainClockTelemetry({
        store,
        client: licenseClient as unknown as ClockTamperTelemetryClient,
        companyId: COMPANY_ID,
        fetchImpl
      });
      if (telemetryRows.length === 0) throw new Error("la telemetría de reloj no se envió");
      if (drained.pending !== 0) throw new Error("quedó telemetría pendiente tras el envío");

      return "firma verificada; activo → revocado (lease-revoked); telemetría enviada";
    });

    // 9. Tasas con caché local --------------------------------------------
    await step(9, async () => {
      let requests = 0;
      const ratesServer = createServer((_request, response) => {
        requests += 1;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            source: "elTOQUE API",
            capturedAt: clock.iso(),
            data: { USD: 320.5, EUR: 350.1, MLC: 250 }
          })
        );
      });
      try {
        const port = await listen(ratesServer, 0, "127.0.0.1");
        const provider = createHubRatesProvider({
          localBaseUrl: `http://127.0.0.1:${port}`,
          ttlMs: 60 * 1000,
          now: clock.ms,
          timeoutMs: 3000
        });
        const first = await provider();
        if (first.length < 1) throw new Error("el proveedor no devolvió tasas");
        const afterFirst = requests;
        const second = await provider();
        if (second.length !== first.length) throw new Error("la caché devolvió otras tasas");
        if (requests !== afterFirst) throw new Error("la segunda consulta golpeó el servidor local");
        if (afterFirst !== 1) throw new Error(`se esperaba 1 consulta, hubo ${afterFirst}`);
        return `${first.length} tasas; 1 consulta y la segunda servida de caché`;
      } finally {
        await closeHttpServer(ratesServer);
      }
    });

    // 10. Anulación de venta: append en el hub -----------------------------
    await step(10, async () => {
      if (!opsClient) throw new Error("el cliente del hub no está disponible (paso 4)");
      const saleId = "sale-void-e2e";
      const sale = makeSaleRow(COMPANY_ID, deviceId, clock.iso(), { id: saleId, total: 180 });

      const inserted = await opsClient.pushOne({
        actionId: "e2e:void:sale:insert",
        table: "sales",
        rows: [sale],
        deletes: []
      });
      if (inserted.status !== "accepted") {
        throw new Error(
          `el hub no aceptó la venta a anular (${inserted.status}/${inserted.error ?? "sin error"})`
        );
      }

      // La anulación es una fila nueva: la venta y sus líneas no se tocan.
      const voidRow = buildSaleVoidRow({
        driver,
        companyId: COMPANY_ID,
        deviceId,
        saleId,
        reason: SALE_VOID_REASONS.user_void,
        branchId: "wh-e2e",
        createdBy: "cajero-e2e",
        voidedAt: clock.iso()
      });

      const batch = await opsClient.push([
        { actionId: "e2e:void:append", table: "sale_voids", rows: [voidRow], deletes: [] },
        {
          actionId: "e2e:void:sale:update",
          table: "sales",
          rows: [{ ...sale, version: 2, total: 1 }],
          deletes: []
        },
        { actionId: "e2e:void:sale:delete", table: "sales", rows: [], deletes: [saleId] }
      ]);
      if (batch.ok !== true) throw new Error(`el lote de anulación falló (${batch.error})`);
      const issues = checkOutcomes(batch.results, [
        { actionId: "e2e:void:append", status: "accepted" },
        { actionId: "e2e:void:sale:update", status: "rejected", error: "append_only" },
        { actionId: "e2e:void:sale:delete", status: "rejected", error: "append_only" }
      ]);
      if (issues.length) throw new Error(`acuses de anulación inesperados (${issues.join("; ")})`);

      const resend = await opsClient.pushOne({
        actionId: "e2e:void:append",
        table: "sale_voids",
        rows: [voidRow],
        deletes: []
      });
      if (resend.status !== "duplicate") {
        throw new Error(`reenviar la anulación no fue duplicate (${resend.status})`);
      }

      const voids = await driver.query<LocalRow>({
        table: "sale_voids",
        where: [{ field: "company_id", op: "eq", value: COMPANY_ID }]
      });
      if (voids.length !== 1) throw new Error(`el libro de anulaciones tiene ${voids.length} filas`);
      if (!isSaleVoided(voids, saleId)) throw new Error("isSaleVoided no reconoce la anulación");

      const original = await driver.get<LocalRow>("sales", saleId);
      if (!original) throw new Error("la venta anulada desapareció del almacén");
      if (original.total !== 180 || original.version !== 1 || original.status !== "completed") {
        throw new Error("la venta original cambió al anular");
      }
      if (effectiveSaleStatus(original, voids) !== "voided") {
        throw new Error("effectiveSaleStatus no devolvió 'voided'");
      }
      if (await assertSaleNotVoided(driver, saleId)) {
        throw new Error("la guarda permite volver a escribir en una venta anulada");
      }
      const repeat = await recordSaleVoid({
        driver,
        companyId: COMPANY_ID,
        deviceId,
        saleId,
        reason: SALE_VOID_REASONS.user_void
      });
      if (repeat.created || repeat.skipped !== "already_voided") {
        throw new Error("recordSaleVoid volvió a anexar una anulación existente");
      }
      return "anulación aceptada; update/delete con append_only; venta intacta y estado voided";
    });

    // 11. Canal SSE continuo ----------------------------------------------
    await step(11, async () => {
      if (!hubHandler) throw new Error("el handler del hub no está disponible (paso 2)");
      const eventsServer = await createHubNodeServer({
        handler: hubHandler,
        port: 0,
        host: "127.0.0.1",
        eventsPollMs: 20,
        eventsPingMs: 60_000,
        changes: ({ since, limit }) =>
          readChangeFeed(driver, { companyId: COMPANY_ID, since, limit, now: clock.ms })
      });
      const controller = new AbortController();
      try {
        // El canal firma contra la sesión guardada, así que se vincula a este hub.
        const paired = await joinHub({
          baseUrl: eventsServer.url,
          code: hubHandler.createPairingSession().code,
          deviceName: "Caja SSE",
          companyId: COMPANY_ID,
          platform: "windows",
          now: clock.ms,
          timeoutMs: 5000
        });
        deviceId = paired.session.deviceId;

        const since = await driver.latestSeq();
        const pages: HubEventPage[] = [];
        let connections = 0;
        let streamFailure: unknown = null;
        const streamDone = openHubEvents({
          since,
          signal: controller.signal,
          // La firma del canal usa el mismo reloj fijo que el hub del arnés.
          now: clock.ms,
          fetchImpl: (input, init) => {
            connections += 1;
            return fetch(input, init);
          },
          onChanges: (page) => {
            pages.push(page);
          }
        }).then(
          () => ({ ok: true as const }),
          (error: unknown) => {
            streamFailure = error;
            return { ok: false as const, error };
          }
        );

        const waitForPages = async (count: number, timeoutMs = 8000): Promise<void> => {
          const deadline = Date.now() + timeoutMs;
          while (pages.length < count) {
            if (streamFailure) {
              throw new Error(
                `el canal SSE falló antes de la página ${count}: ${describeError(streamFailure)}`
              );
            }
            if (Date.now() > deadline) {
              throw new Error(`solo llegaron ${pages.length} de ${count} páginas SSE`);
            }
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
        };
        const putProduct = (id: string, name: string) =>
          driver.put("products", [
            {
              id,
              company_id: COMPANY_ID,
              version: 1,
              updated_at: clock.iso(),
              origin_device: deviceId,
              deleted_at: null,
              name,
              price: 1
            }
          ]);

        await putProduct("prod-sse-1", "Alta SSE 1");
        await waitForPages(1);
        clock.advance(1000);
        await putProduct("prod-sse-2", "Alta SSE 2");
        await waitForPages(2);

        controller.abort();
        const finished = await streamDone;
        if (!finished.ok) throw finished.error;

        if (connections !== 1) throw new Error(`el canal SSE se abrió ${connections} veces`);
        if (pages.length !== 2) throw new Error(`llegaron ${pages.length} páginas en vez de 2`);
        const hasChange = (page: HubEventPage, id: string) =>
          page.changes.some((change) => change.table === "products" && change.row_id === id);
        if (!hasChange(pages[0], "prod-sse-1")) throw new Error("la primera alta no llegó en la primera página");
        if (hasChange(pages[0], "prod-sse-2")) throw new Error("las dos altas llegaron en la misma página");
        if (!hasChange(pages[1], "prod-sse-2")) throw new Error("la segunda alta no llegó en la segunda página");
        if (pages[1].cursor <= pages[0].cursor) throw new Error("el cursor SSE no avanzó entre páginas");
        return `2 páginas (cursor ${pages[0].cursor}→${pages[1].cursor}) con una sola conexión`;
      } finally {
        controller.abort();
        await eventsServer.close().catch(() => undefined);
      }
    });

    // 12. Tasas del hub con fetch inyectable ------------------------------
    await step(12, async () => {
      let calls = 0;
      let failing = false;
      const fetchRates = async (input: RequestInfo | URL): Promise<Response> => {
        calls += 1;
        if (failing) throw new Error("hub local inalcanzable");
        if (!String(input).endsWith("/api/exchange-rates")) {
          throw new Error(`ruta de tasas inesperada: ${String(input)}`);
        }
        return new Response(
          JSON.stringify({
            source: "elTOQUE API",
            capturedAt: clock.iso(),
            data: { USD: 320.5, EUR: 350.1, MLC: 250 }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      };
      const provider = createHubRatesProvider({
        fetchImpl: fetchRates as unknown as typeof fetch,
        localBaseUrl: "http://127.0.0.1:9",
        ttlMs: 60 * 1000,
        now: clock.ms,
        timeoutMs: 1000
      });

      const first = await provider();
      const second = await provider();
      if (first.length !== 3) throw new Error(`se esperaban 3 tasas, llegaron ${first.length}`);
      if (calls !== 1) throw new Error(`la caché no evitó la segunda consulta (${calls} consultas)`);
      if (second.some((rate) => rate.stale)) throw new Error("la lectura en caché se marcó como stale");
      if (second.map((rate) => rate.code).join(",") !== first.map((rate) => rate.code).join(",")) {
        throw new Error("la caché devolvió otras divisas");
      }

      clock.advance(60 * 1000 + 1);
      failing = true;
      const fallback = await provider();
      if (calls !== 2) throw new Error(`el TTL no forzó una segunda consulta (${calls})`);
      if (fallback.length !== 3) throw new Error("el respaldo no conservó las 3 tasas");
      if (!fallback.every((rate) => rate.stale)) throw new Error("el respaldo no se marcó como stale");

      const cold = createHubRatesProvider({
        fetchImpl: fetchRates as unknown as typeof fetch,
        localBaseUrl: "http://127.0.0.1:9",
        now: clock.ms,
        timeoutMs: 1000
      });
      const coldError = await cold().then(
        () => "",
        (error: unknown) => describeError(error)
      );
      if (!coldError) throw new Error("un proveedor sin copia previa devolvió tasas inventadas");
      return "3 tasas; 1 consulta para 2 lecturas; respaldo stale y sin copia previa falla";
    });

    // 13. Respaldo binario SQLite -----------------------------------------
    await step(13, async () => {
      const passphrase = "palmyra-binario-e2e";
      const image = new Uint8Array(1024);
      image.set(Buffer.from("SQLite format 3\u0000", "latin1"), 0);
      if (!isSqliteFile(image)) throw new Error("la imagen mínima no fue reconocida como SQLite");
      const sha256 = createHash("sha256").update(image).digest("hex");

      const wrapped = await snapshotToBackupBytes({
        snapshot: {
          ok: true,
          bytesBase64: Buffer.from(image).toString("base64"),
          size: image.length,
          sha256,
          latestSeq: 7
        },
        passphrase,
        iterations: BACKUP_MIN_ITERATIONS,
        now: clock.iso,
        meta: { appVersion: "e2e", schemaVersion: 33 }
      });
      if (!wrapped.bytes.length) throw new Error("el sobre binario salió vacío");
      if (wrapped.summary.sha256 !== sha256 || wrapped.summary.latestSeq !== 7) {
        throw new Error("el resumen binario no coincide con la imagen");
      }

      const read = await readBinaryBackup({ bytes: wrapped.bytes, passphrase });
      if (read.summary.sha256 !== sha256) throw new Error("el respaldo leído no conservó el hash");
      if (Buffer.compare(Buffer.from(read.image), Buffer.from(image)) !== 0) {
        throw new Error("la imagen descifrada difiere de la original");
      }

      const corrupt = new Uint8Array(image);
      corrupt[0] = 0x58; // "X": ya no es "SQLite format 3\0"
      if (isSqliteFile(corrupt)) throw new Error("la cabecera inválida pasó como SQLite");
      const rejection = validateBinaryRestore(corrupt);
      if (rejection.ok || !/SQLite/.test(rejection.error ?? "")) {
        throw new Error("validateBinaryRestore no rechazó la cabecera inválida");
      }

      let wrapCode = "";
      try {
        await snapshotToBackupBytes({
          snapshot: {
            ok: true,
            bytesBase64: Buffer.from(corrupt).toString("base64"),
            size: corrupt.length,
            sha256: createHash("sha256").update(corrupt).digest("hex"),
            latestSeq: 0
          },
          passphrase,
          iterations: BACKUP_MIN_ITERATIONS,
          now: clock.iso
        });
      } catch (error) {
        wrapCode = error instanceof BackupError ? error.code : "otro";
      }
      if (wrapCode !== "invalid_format") {
        throw new Error(`la cabecera inválida no fue rechazada (${wrapCode || "sin error"})`);
      }

      let readCode = "";
      try {
        await readBinaryBackup({ bytes: wrapped.bytes, passphrase: "clave-equivocada-e2e" });
      } catch (error) {
        readCode = error instanceof BackupError ? error.code : "otro";
      }
      if (readCode !== "decrypt_failed") {
        throw new Error(`la frase incorrecta no fue rechazada (${readCode || "sin error"})`);
      }
      return `imagen de 1 KiB ida y vuelta (sha ${sha256.slice(0, 12)}…); cabecera inválida y frase errónea rechazadas`;
    });

    // 14. Importación verificada ------------------------------------------
    await step(14, async () => {
      const state = buildF1LegacyFixture();
      const meta = { companyId: COMPANY_ID, originDevice: "dev-import-f1", now: clock.iso() };
      const imported = createMemoryDriver({ now: clock.iso });
      await imported.ready();
      importDriver = imported;
      f1Fixture = state;

      const first = await applyVerifiedImport(imported, state, meta);
      if (!first.report.ok) {
        throw new Error(`la importación no verificó (${first.report.mismatches.join("; ")})`);
      }
      const want: Record<string, number> = {
        warehouses: 1,
        products: 2,
        stock_balances: 2,
        sales: 2,
        sale_items: 3,
        sale_payments: 3,
        cash_sessions: 1
      };
      const tableIssues: string[] = [];
      for (const [table, count] of Object.entries(want)) {
        const status = first.report.tables[table];
        if (!status) {
          tableIssues.push(`${table}: sin estado`);
          continue;
        }
        if (status.expected !== count || status.actual !== count) {
          tableIssues.push(`${table}: real ${status.actual}, declarado ${status.expected}, esperado ${count}`);
        }
      }
      if (tableIssues.length) throw new Error(`conteos verificados inesperados (${tableIssues.join("; ")})`);
      if (first.report.hash.expected !== first.report.hash.actual) {
        throw new Error("la huella esperada y la real difieren");
      }
      if (!/^[0-9a-f]{16}$/.test(first.report.hash.expected)) {
        throw new Error("la huella no es FNV-1a de 64 bits");
      }
      if (first.report.totals.actualSalesTotal !== 1750.5 || first.report.totals.actualStock !== 15) {
        throw new Error(
          `sumas verificadas inesperadas (ventas ${first.report.totals.actualSalesTotal}, stock ${first.report.totals.actualStock})`
        );
      }

      // Repetir la misma importación escribe los mismos upserts: no duplica.
      const second = await applyVerifiedImport(imported, state, meta);
      if (!second.report.ok) {
        throw new Error(`la reimportación no verificó (${second.report.mismatches.join("; ")})`);
      }
      if (second.report.hash.actual !== first.report.hash.actual) {
        throw new Error("la reimportación cambió la huella");
      }
      const counts = await rowCounts(imported, COMPANY_ID, [
        "products",
        "sales",
        "sale_items",
        "sale_payments",
        "cash_sessions"
      ]);
      const issues = compareRowCounts(
        { products: 2, sales: 2, sale_items: 3, sale_payments: 3, cash_sessions: 1 },
        counts
      );
      if (issues.length) throw new Error(`la reimportación duplicó filas (${issues.join("; ")})`);
      return `7 tablas, ventas 1750.5 y stock 15; huella ${first.report.hash.expected.slice(0, 8)}…; repetir no duplica`;
    });

    // 15. Escritura inmediata del POS --------------------------------------
    await step(15, async () => {
      const posDriver = createMemoryDriver({ now: clock.iso });
      await posDriver.ready();
      const sale = buildF1SaleTransaction();
      const options = {
        driver: posDriver,
        companyId: COMPANY_ID,
        deviceId: "dev-pos-f1",
        now: clock.iso(),
        enabled: true
      };

      const mirrored = await mirrorCompletedSale(sale, options);
      if (!mirrored.written) throw new Error("la venta cerrada no se escribió en el almacén");
      const counts = await rowCounts(posDriver, COMPANY_ID, ["sales", "sale_items", "sale_payments"]);
      const issues = compareRowCounts({ sales: 1, sale_items: 2, sale_payments: 2 }, counts);
      if (issues.length) throw new Error(`filas del espejo inesperadas (${issues.join("; ")})`);
      const stored = await posDriver.get<LocalRow>("sales", sale.id);
      if (!stored || stored.total !== 480 || stored.origin_device !== "dev-pos-f1") {
        throw new Error("la fila de venta no coincide con el ticket");
      }
      const line = await posDriver.get("sale_items", `${sale.id}:item:line-1`);
      const payment = await posDriver.get("sale_payments", `${sale.id}:pay:0`);
      if (!line || !payment) throw new Error("faltan la línea o el pago normalizados");

      // Idempotente por id: repetir no reescribe ni ensucia el journal.
      const seqBefore = await posDriver.latestSeq();
      const repeated = await mirrorCompletedSale(sale, options);
      if (repeated.written) throw new Error("repetir la venta volvió a escribir");
      if ((await posDriver.latestSeq()) !== seqBefore) throw new Error("repetir la venta ensució el journal");

      const voidedTx = buildF1SaleTransaction({ deletedAt: clock.iso(), deletedBy: "cajero-e2e" });
      const voided = await mirrorSaleVoid(voidedTx, options);
      if (!voided.written) throw new Error("la anulación no se anexó al libro");
      const voids = await posDriver.query<LocalRow>({
        table: "sale_voids" as LocalTable,
        where: [{ field: "company_id", op: "eq", value: COMPANY_ID }]
      });
      if (voids.length !== 1) throw new Error(`el libro de anulaciones tiene ${voids.length} filas`);
      if (!isSaleVoided(voids, sale.id)) throw new Error("isSaleVoided no reconoce la anulación del POS");
      if (await assertSaleNotVoided(posDriver, sale.id)) {
        throw new Error("la guarda permite escribir en una venta anulada");
      }
      if ((await posDriver.get<LocalRow>("sales", sale.id))?.total !== 480) {
        throw new Error("la anulación tocó la venta original");
      }
      const repeatedVoid = await mirrorSaleVoid(voidedTx, options);
      if (repeatedVoid.written) throw new Error("repetir la anulación anexó otra fila");

      // El movimiento de caja abre el turno y anexa la fila, sin duplicarse.
      const session = {
        id: "shift-e2e",
        warehouseId: "wh-e2e",
        branchId: "wh-e2e",
        openedAt: clock.iso(),
        openingBalance: 100,
        status: "open",
        userId: "cajero-e2e",
        workerName: "Cajero E2E",
        movements: []
      };
      const movement = {
        id: "mov-1",
        type: "income",
        amount: 50,
        currencyCode: "CUP",
        description: "Fondo adicional",
        date: clock.iso(),
        sessionId: "shift-e2e",
        branchId: "wh-e2e"
      };
      const cash = await mirrorCashMovement(session, movement, options);
      if (!cash.written) throw new Error("el movimiento de caja no se anexó");
      const cashCounts = await rowCounts(posDriver, COMPANY_ID, ["cash_sessions", "cash_movements"]);
      const cashIssues = compareRowCounts({ cash_sessions: 1, cash_movements: 1 }, cashCounts);
      if (cashIssues.length) throw new Error(`caja inesperada (${cashIssues.join("; ")})`);
      const storedMovement = await posDriver.get<LocalRow>("cash_movements", "shift-e2e:mov:mov-1");
      if (!storedMovement || storedMovement.amount !== 50 || storedMovement.session_id !== "shift-e2e") {
        throw new Error("la fila del movimiento de caja no coincide");
      }
      const repeatedCash = await mirrorCashMovement(session, movement, options);
      if (repeatedCash.written) throw new Error("repetir el movimiento de caja lo duplicó");
      return "sales=1, sale_items=2, sale_payments=2, caja=1/1; repetir no escribe; venta anulada en sale_voids";
    });

    // 16. Push real al hub --------------------------------------------------
    await step(16, async () => {
      await clearHubSession();
      const hubDriver = createMemoryDriver({ now: clock.iso });
      await hubDriver.ready();
      const handler = createHubHandler({
        driver: hubDriver,
        hubId: "hub-f1",
        companyId: COMPANY_ID,
        now: clock.ms,
        pairingCode: () => HUB_PAIRING_CODE
      });
      const server = await createHubNodeServer({ handler, port: 0, host: "127.0.0.1" });
      f1HubHandler = handler;
      f1Hub = server;
      f1HubDriver = hubDriver;

      const joined = await joinHub({
        baseUrl: server.url,
        code: handler.createPairingSession().code,
        deviceName: "Caja F1",
        companyId: COMPANY_ID,
        platform: "windows",
        now: clock.ms,
        timeoutMs: 5000
      });
      deviceA = joined.session.deviceId;
      if (!deviceA) throw new Error("el hub no asignó equipo al push");

      const clientDriver = createMemoryDriver({ now: clock.iso });
      await clientDriver.ready();
      const at = clock.iso();
      await clientDriver.put("products", [makeProductRow("prod-f1-push", COMPANY_ID, deviceA, at)]);
      // Fila recibida por pull de otro equipo: su origen no coincide y no viaja.
      await clientDriver.put("products", [makeProductRow("prod-f1-ajena", COMPANY_ID, "otro-equipo", at)]);
      await clientDriver.put("sales", [
        { ...makeSaleRow(COMPANY_ID, deviceA, at), id: "sale-f1-push", total: 99 }
      ]);

      const script = createQuietPushFetch(at);
      const loop = startHubClientLoop({
        companyId: COMPANY_ID,
        driver: clientDriver,
        fetchImpl: script.impl,
        // Este arnés sella sus filas con el id de sesión: es su identidad local.
        localDeviceId: deviceA,
        now: clock.ms,
        pollMs: 30_000,
        pushMs: 20,
        pushLimit: 50,
        pushBackoffMs: 40,
        eventsBaseDelayMs: 5
      });
      try {
        await waitFor(async () => (await hubDriver.get("products", "prod-f1-push")) !== null, 8000);
        await waitFor(async () => (await hubDriver.get("sales", "sale-f1-push")) !== null, 8000);
        // Tres cambios locales (dos altas y la venta) confirman el cursor.
        await waitFor(async () => (await loadHubOutboxCursor()) >= 3, 8000);
      } finally {
        loop.stop();
      }
      if (loop.isRunning()) throw new Error("el bucle de salida no se detuvo");
      if ((await hubDriver.get("products", "prod-f1-ajena")) !== null) {
        throw new Error("una fila de otro equipo llegó al hub");
      }
      if (script.opsCalls() === 0) throw new Error("no se propuso ningún lote al hub");
      const pushed = await hubDriver.get<LocalRow>("products", "prod-f1-push");
      if (pushed?.origin_device !== deviceA) throw new Error("el hub perdió el origen de la fila");
      return `producto y venta en el hub; fila ajena filtrada; cursor de salida ${await loadHubOutboxCursor()}`;
    });

    // 17. Pull al segundo equipo -------------------------------------------
    await step(17, async () => {
      const server = f1Hub;
      const handler = f1HubHandler;
      const hubDriver = f1HubDriver;
      if (!server || !handler || !hubDriver || !deviceA) {
        throw new Error("el hub F1 no está disponible (paso 16)");
      }

      // Un equipo distinto tiene su propia sesión, su propio cursor y su almacén.
      await clearHubSession();
      const joined = await joinHub({
        baseUrl: server.url,
        code: handler.createPairingSession().code,
        deviceName: "Caja F1-B",
        companyId: COMPANY_ID,
        platform: "windows",
        now: clock.ms,
        timeoutMs: 5000
      });
      const deviceB = joined.session.deviceId;
      if (!deviceB || deviceB === deviceA) throw new Error("el segundo equipo no tiene identidad propia");

      const secondDriver = createMemoryDriver({ now: clock.iso });
      await secondDriver.ready();

      // Pull inicial por la ruta firmada, descartando las tablas internas.
      const client = createHubClient({
        baseUrl: server.url,
        deviceId: deviceB,
        token: joined.session.token,
        now: clock.ms,
        timeoutMs: 5000
      });
      const page = await client.changes({ since: 0, limit: 200 });
      const external = page.changes.filter(
        (change) => change.table !== "hub_devices" && change.table !== "hub_receipts"
      );
      const outcome = await applyHubChanges({
        driver: secondDriver,
        companyId: COMPANY_ID,
        changes: external as unknown as HubChange[]
      });
      if (outcome.applied < 2) throw new Error(`el pull solo aplicó ${outcome.applied} filas`);
      const product = await secondDriver.get<LocalRow>("products", "prod-f1-push");
      const sale = await secondDriver.get<LocalRow>("sales", "sale-f1-push");
      if (!product || product.name !== "Producto prod-f1-push") {
        throw new Error("el producto no convergió en el segundo equipo");
      }
      if (!sale || sale.total !== 99) throw new Error("la venta no convergió en el segundo equipo");
      if (product.origin_device !== deviceA) throw new Error("el pull no conservó el origen de la fila");

      // Su journal local no debe volver al hub: el filtro por origen lo corta.
      const localSeq = await secondDriver.latestSeq();
      const script = createQuietPushFetch(clock.iso());
      const loop = startHubClientLoop({
        companyId: COMPANY_ID,
        driver: secondDriver,
        fetchImpl: script.impl,
        now: clock.ms,
        pollMs: 25,
        pushMs: 20,
        pushLimit: 50,
        pushBackoffMs: 40,
        eventsBaseDelayMs: 5
      });
      try {
        await waitFor(async () => (await loadHubOutboxCursor()) >= localSeq, 8000);
        // Margen para que un tick en vuelo se complete antes de contar.
        await delay(120);
      } finally {
        loop.stop();
      }
      if (script.opsCalls() !== 0) {
        throw new Error(`el segundo equipo reenvió ${script.opsCalls()} lote(s) al hub`);
      }
      const hubProducts = await countRows(hubDriver, COMPANY_ID, "products");
      const hubSales = await countRows(hubDriver, COMPANY_ID, "sales");
      if (hubProducts !== 1 || hubSales !== 1) {
        throw new Error(`el hub duplicó filas (productos ${hubProducts}, ventas ${hubSales})`);
      }
      return `${localSeq} filas convergentes, cursor de salida ${await loadHubOutboxCursor()} y 0 envíos; hub sin duplicados`;
    });

    // 18. Paridad legado ↔ almacén ------------------------------------------
    await step(18, async () => {
      const imported = importDriver;
      const state = f1Fixture;
      if (!imported || !state) throw new Error("la importación no está disponible (paso 14)");
      const options = {
        driver: imported,
        state,
        companyId: COMPANY_ID,
        originDevice: "dev-parity-f1",
        now: clock.iso()
      };

      const parity = await compareLocalDbWithLegacy(options);
      if (!parity.ok) throw new Error(`la paridad no cuadró (${parity.mismatches.join("; ")})`);
      if (parity.totals.actualSalesTotal !== 1750.5) {
        throw new Error(`la paridad sumó ${parity.totals.actualSalesTotal} en ventas`);
      }
      if (parity.totals.actualStockQuantity !== 15) {
        throw new Error(`la paridad sumó ${parity.totals.actualStockQuantity} en inventario`);
      }
      if (parity.totals.actualCashAmount !== 70) {
        throw new Error(`la paridad sumó ${parity.totals.actualCashAmount} en caja`);
      }

      // Alterar una venta rompe la paridad, pero nunca lanza: queda en ok=false.
      const sale = await imported.get<LocalRow>("sales", "sale-fixture-1");
      if (!sale) throw new Error("falta la venta del fixture para alterarla");
      await imported.put("sales", [
        { ...sale, version: Number(sale.version) + 1, updated_at: clock.iso(), total: 1 }
      ]);
      const broken = await compareLocalDbWithLegacy(options);
      if (broken.ok) throw new Error("la alteración no rompió la paridad");
      if (!broken.mismatches.some((entry) => entry.includes("ventas.total"))) {
        throw new Error(`la paridad no señaló la venta alterada (${broken.mismatches.join("; ")})`);
      }
      return "paridad ok (ventas 1750.5, stock 15, caja 70); una venta alterada da ok=false sin lanzar";
    });
  } finally {
    if (f1Hub) await f1Hub.close().catch(() => undefined);
    if (hubServer) await hubServer.close().catch(() => undefined);
    await driver.close().catch(() => undefined);
  }

  // 19. Resumen y código de salida ---------------------------------------
  const failedBefore = results.filter((result) => !result.ok).length;
  results.push({
    n: 19,
    name: STEP_NAMES[18],
    ok: failedBefore === 0,
    detail:
      failedBefore === 0
        ? "todos los pasos correctos; salida 0"
        : `${failedBefore} paso(s) con fallo; salida 1`
  });

  const summary = summarizeSteps(results);
  console.log("");
  console.log("PALMYRA · arnés end-to-end local");
  console.log("=".repeat(72));
  console.log(summary.text);
  console.log("=".repeat(72));
  console.log(summary.exitCode === 0 ? "Resultado: TODO OK" : "Resultado: FALLA");
  return summary.exitCode;
}

const rawArgvPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const isDirectRun = rawArgvPath !== "" && rawArgvPath === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`FALLA inesperada del arnés: ${describeError(error)}`);
      process.exitCode = 1;
    });
}
