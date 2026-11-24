/**
 * La anulación de venta es un documento nuevo en `sale_voids`, nunca un
 * `update` ni un `delete` de `sales`. Estas pruebas fijan el contrato:
 * `buildSaleVoidRow` con columnas exactas, idempotencia por `void:<saleId>`,
 * transacción única, estado efectivo, solo anexado y que la venta original
 * quede intacta.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type {
  LocalDbDriver,
  LocalDbTransaction,
  LocalRow,
  QuerySpec
} from "../../src/services/localDb/contract";
import { createMemoryDriver } from "../../src/services/localDb/memoryDriver";
import {
  APPEND_ONLY_TABLES,
  AppendOnlyError,
  assertAppendOnly,
  assertAppendOnlyInsert
} from "../../src/services/localDb/appendOnly";
import { recordSale, type RecordSaleInput } from "../../src/services/localDb/hotPaths";
import {
  SALE_VOID_REASONS,
  SALE_VOID_TABLE,
  assertSaleNotVoided,
  buildSaleVoidRow,
  effectiveSaleStatus,
  isSaleVoided,
  recordSaleVoid,
  type SaleVoidInput
} from "../../src/services/localDb/saleLifecycle";
import { validateOperation, type HubValidationResult } from "../../src/services/lanHub/validation";

const AT = "2026-05-01T12:00:00.000Z";
const COMPANY = "co-1";
const DEVICE = "dev-1";
const VOID_ID = "void:s1";

const VOID_COLUMNS = [
  "branch_id",
  "company_id",
  "created_by",
  "deleted_at",
  "id",
  "origin_device",
  "reason",
  "sale_id",
  "updated_at",
  "version",
  "voided_at"
];

function row(id: string, fields: Record<string, unknown> = {}): LocalRow {
  return {
    id,
    company_id: COMPANY,
    version: 1,
    updated_at: AT,
    origin_device: DEVICE,
    deleted_at: null,
    ...fields
  };
}

async function readyDriver(): Promise<LocalDbDriver> {
  const driver = createMemoryDriver({ now: () => AT });
  await driver.ready();
  return driver;
}

function saleInput(id: string): RecordSaleInput {
  return {
    driver: undefined as unknown as RecordSaleInput["driver"],
    companyId: COMPANY,
    deviceId: DEVICE,
    at: AT,
    sale: {
      id,
      warehouseId: "w1",
      sessionId: "turno-1",
      date: AT,
      subtotal: 100,
      tax: 0,
      total: 100,
      userId: "u-1",
      status: "completed"
    },
    items: [{ id: "l1", productId: "p1", productName: "Arroz", quantity: 1, unitPrice: 100, total: 100 }],
    payments: [{ id: "pay1", method: "cash", currencyCode: "CUP", amount: 100, exchangeRate: 1 }]
  };
}

function voidInput(overrides: Partial<SaleVoidInput> = {}): SaleVoidInput {
  return {
    driver: undefined as unknown as LocalDbDriver,
    companyId: COMPANY,
    deviceId: DEVICE,
    saleId: "s1",
    reason: SALE_VOID_REASONS.user_void,
    voidedAt: AT,
    ...overrides
  };
}

/** Driver que falla al escribir en `sale_voids` para probar el rollback. */
function driverWithFailingVoidWrite(base: LocalDbDriver): LocalDbDriver {
  return {
    ...base,
    transaction: <T>(fn: (tx: LocalDbTransaction) => Promise<T>): Promise<T> =>
      base.transaction((tx) =>
        fn({
          get: <R extends LocalRow>(table: Parameters<LocalDbTransaction["get"]>[0], id: string) =>
            tx.get<R>(table, id),
          query: <R extends LocalRow>(spec: QuerySpec) => tx.query<R>(spec),
          put: <R extends LocalRow>(table: Parameters<LocalDbTransaction["put"]>[0], rows: R[]) =>
            table === SALE_VOID_TABLE
              ? Promise.reject(new Error("fallo simulado al anexar"))
              : tx.put(table, rows),
          remove: (table, ids, meta) => tx.remove(table, ids, meta)
        })
      )
  };
}

function verdict(result: HubValidationResult): string | null {
  return result.ok ? null : result.code;
}

test("buildSaleVoidRow arma exactamente las columnas del libro con sus valores por defecto", () => {
  const built = buildSaleVoidRow(voidInput({ branchId: "b-1", createdBy: "u-9" }));

  assert.deepEqual(Object.keys(built).sort(), VOID_COLUMNS);
  assert.equal(built.id, VOID_ID);
  assert.equal(built.company_id, COMPANY);
  assert.equal(built.sale_id, "s1");
  assert.equal(built.branch_id, "b-1");
  assert.equal(built.reason, SALE_VOID_REASONS.user_void);
  assert.equal(built.voided_at, AT);
  assert.equal(built.created_by, "u-9");
  assert.equal(built.version, 1);
  assert.equal(built.updated_at, AT);
  assert.equal(built.origin_device, DEVICE);
  assert.equal(built.deleted_at, null);

  // Motivo y autor son opcionales: el documento sigue siendo válido.
  const defaults = buildSaleVoidRow(voidInput({ reason: undefined, branchId: undefined }));
  assert.equal(defaults.reason, SALE_VOID_REASONS.user_void);
  assert.equal(defaults.branch_id, null);
  assert.equal(defaults.created_by, null);
  // El id es determinista: la misma venta produce siempre la misma fila.
  assert.equal(defaults.id, built.id);
});

test("recordSaleVoid anexa una fila determinista y no toca la venta", async () => {
  const driver = await readyDriver();
  await recordSale({ ...saleInput("s1"), driver });
  const seqBefore = await driver.latestSeq();

  const result = await recordSaleVoid({
    ...voidInput({ createdBy: "u-9" }),
    driver
  });

  assert.equal(result.voidId, VOID_ID);
  assert.equal(result.saleId, "s1");
  assert.equal(result.actionId, `${DEVICE}:sale_voids:${VOID_ID}:1`);
  assert.equal(result.created, true);
  assert.equal(result.skipped, null);
  assert.equal(result.row?.sale_id, "s1");

  const stored = await driver.get<LocalRow>(SALE_VOID_TABLE, VOID_ID);
  assert.ok(stored, "la anulación queda anexada");
  assert.equal(stored?.company_id, COMPANY);
  assert.equal(stored?.sale_id, "s1");
  // La sucursal se hereda de la venta almacenada si no se envía.
  assert.equal(stored?.branch_id, "w1");
  assert.equal(stored?.reason, SALE_VOID_REASONS.user_void);
  assert.equal(stored?.voided_at, AT);
  assert.equal(stored?.created_by, "u-9");
  assert.equal(stored?.version, 1);
  assert.equal(stored?.origin_device, DEVICE);
  assert.equal(stored?.deleted_at, null);

  // La venta, sus líneas y sus pagos siguen exactamente iguales.
  const sale = await driver.get<LocalRow>("sales", "s1");
  assert.equal(sale?.version, 1);
  assert.equal(sale?.total, 100);
  assert.equal(sale?.deleted_at, null);
  assert.ok(await driver.get("sale_items", "s1:item:l1"));
  assert.ok(await driver.get("sale_payments", "s1:pay:pay1"));
  assert.equal((await driver.query<LocalRow>({ table: "sales" })).length, 1);

  // Solo se anexó: un upsert en el libro de anulaciones y ningún borrado.
  const journal = await driver.changes(seqBefore, 50);
  assert.equal(journal.length, 1);
  assert.equal(journal[0].table, SALE_VOID_TABLE);
  assert.equal(journal[0].op, "upsert");
  assert.equal(
    (await driver.changes(0, 500)).filter((change) => change.op === "delete").length,
    0,
    "anular nunca registra un borrado"
  );
});

test("repetir la anulación es idempotente: devuelve la existente sin duplicar", async () => {
  const driver = await readyDriver();
  await recordSale({ ...saleInput("s1"), driver });

  const first = await recordSaleVoid({ ...voidInput(), driver });
  assert.equal(first.created, true);
  const seqAfterFirst = await driver.latestSeq();

  const second = await recordSaleVoid({
    ...voidInput({
      reason: SALE_VOID_REASONS.legacy_removed,
      voidedAt: "2026-05-02T00:00:00.000Z"
    }),
    driver
  });

  assert.equal(second.created, false);
  assert.equal(second.skipped, "already_voided");
  assert.equal(second.voidId, first.voidId);
  assert.equal(second.actionId, first.actionId);
  assert.equal(second.row?.reason, SALE_VOID_REASONS.user_void, "devuelve la anulación existente");
  assert.equal(await driver.latestSeq(), seqAfterFirst, "el reintento no escribe");
  const voids = await driver.query<LocalRow>({ table: SALE_VOID_TABLE, includeDeleted: true });
  assert.equal(voids.length, 1);
});

test("una venta inexistente no produce anulación y lo informa", async () => {
  const driver = await readyDriver();

  const result = await recordSaleVoid({ ...voidInput({ saleId: "fantasma" }), driver });

  assert.equal(result.created, false);
  assert.equal(result.skipped, "missing_sale");
  assert.equal(result.voidId, "void:fantasma");
  assert.equal(result.actionId, `${DEVICE}:sale_voids:void:fantasma:1`);
  assert.equal(result.row, null);
  assert.equal(await driver.latestSeq(), 0, "no se escribe nada");
  assert.deepEqual(await driver.query<LocalRow>({ table: SALE_VOID_TABLE, includeDeleted: true }), []);
});

test("la anulación de otra empresa se rechaza sin escribir", async () => {
  const driver = await readyDriver();
  await driver.put("sales", [row("s1", { total: 100, warehouse_id: "w1" })]);

  await assert.rejects(
    () => recordSaleVoid({ ...voidInput({ companyId: "co-otra" }), driver }),
    (error: unknown) =>
      error instanceof Error && (error as { code?: string }).code === "company_mismatch"
  );
  assert.equal((await driver.get<LocalRow>("sales", "s1"))?.total, 100);
  assert.deepEqual(await driver.query<LocalRow>({ table: SALE_VOID_TABLE, includeDeleted: true }), []);
});

test("la anulación es atómica: si la escritura falla no queda rastro", async () => {
  const base = await readyDriver();
  await recordSale({ ...saleInput("s1"), driver: base });
  const seqBefore = await base.latestSeq();

  const failing = driverWithFailingVoidWrite(base);
  await assert.rejects(() => recordSaleVoid({ ...voidInput(), driver: failing }), /fallo simulado al anexar/);

  assert.deepEqual(await base.query<LocalRow>({ table: SALE_VOID_TABLE, includeDeleted: true }), []);
  assert.equal(await base.latestSeq(), seqBefore, "la transacción revirtió el journal");
  assert.equal((await base.get<LocalRow>("sales", "s1"))?.version, 1);
});

test("acepta la fila de venta heredada como referencia (sombra legada)", async () => {
  const driver = await readyDriver();
  const stored = row("s1", { total: 100, warehouse_id: "w9", user_id: "u-7" });
  await driver.put("sales", [stored]);

  const result = await recordSaleVoid({
    driver,
    companyId: COMPANY,
    deviceId: DEVICE,
    sale: stored,
    reason: SALE_VOID_REASONS.legacy_removed,
    voidedAt: AT
  });

  assert.equal(result.created, true);
  assert.equal(result.row?.sale_id, "s1");
  assert.equal(result.row?.branch_id, "w9");
  assert.equal(result.row?.created_by, "u-7");
  assert.equal((await driver.get<LocalRow>("sales", "s1"))?.deleted_at, null);
});

test("isSaleVoided y effectiveSaleStatus: la anulación manda y lo demás se conserva", () => {
  const voids: LocalRow[] = [
    row(VOID_ID, { sale_id: "s1", reason: SALE_VOID_REASONS.user_void, voided_at: AT }),
    row("void:borrada", { sale_id: "s3", deleted_at: AT })
  ];

  assert.equal(isSaleVoided(voids, "s1"), true);
  assert.equal(isSaleVoided(voids, "s2"), false);
  // Una fila borrada no anula nada.
  assert.equal(isSaleVoided(voids, "s3"), false);
  assert.equal(isSaleVoided([], "s1"), false);
  assert.equal(isSaleVoided(undefined, "s1"), false);

  assert.equal(effectiveSaleStatus("completed", true), "voided");
  assert.equal(effectiveSaleStatus("refunded", true), "voided");
  assert.equal(effectiveSaleStatus("completed", false), "completed");
  assert.equal(effectiveSaleStatus("refunded", false), "refunded");
  assert.equal(effectiveSaleStatus("partial_refund", false), "partial_refund");
  assert.equal(effectiveSaleStatus(undefined, false), "completed");

  // También acepta el listado de anulaciones y la referencia de venta.
  assert.equal(effectiveSaleStatus({ id: "s1", status: "completed" }, voids), "voided");
  assert.equal(effectiveSaleStatus({ id: "s2", status: "refunded" }, voids), "refunded");
});

test("el libro de anulaciones también es de solo anexado", async () => {
  const isAppendOnlyError = (error: unknown) =>
    error instanceof AppendOnlyError && error.code === "append_only";

  assert.ok((APPEND_ONLY_TABLES as readonly string[]).includes("sale_voids"));
  assert.throws(() => assertAppendOnly(SALE_VOID_TABLE, "update"), isAppendOnlyError);
  assert.throws(() => assertAppendOnly(SALE_VOID_TABLE, "delete"), isAppendOnlyError);

  const driver = await readyDriver();
  const existing = row(VOID_ID, {
    sale_id: "s1",
    branch_id: "w1",
    reason: SALE_VOID_REASONS.user_void,
    voided_at: AT,
    created_by: null
  });
  await driver.put(SALE_VOID_TABLE, [existing]);
  const seqBefore = await driver.latestSeq();

  await assert.rejects(
    () =>
      driver.transaction(async (tx) => {
        await assertAppendOnlyInsert(tx, SALE_VOID_TABLE, [{ ...existing, reason: "duplicado" }]);
      }),
    isAppendOnlyError
  );
  assert.equal((await driver.get<LocalRow>(SALE_VOID_TABLE, VOID_ID))?.reason, SALE_VOID_REASONS.user_void);
  assert.equal(await driver.latestSeq(), seqBefore);
});

test("recordSale rechaza una venta anulada sin lanzar ni reescribir nada", async () => {
  const driver = await readyDriver();
  await recordSale({ ...saleInput("s1"), driver });
  const voidResult = await recordSaleVoid({ ...voidInput(), driver });
  const seqBefore = await driver.latestSeq();

  assert.equal(await assertSaleNotVoided(driver, "s1"), false);
  assert.equal(await assertSaleNotVoided(driver, "s-otra"), true);

  const retry = await recordSale({ ...saleInput("s1"), driver });
  assert.equal(retry.created, false);
  assert.equal(retry.voided, true);
  assert.equal(retry.saleId, "s1");
  assert.equal(retry.actionId, `${DEVICE}:sales:s1:1`);
  assert.equal(await driver.latestSeq(), seqBefore, "el rechazo no escribe");
  assert.equal((await driver.get<LocalRow>("sales", "s1"))?.version, 1);
  assert.equal((await driver.get<LocalRow>(SALE_VOID_TABLE, voidResult.voidId))?.sale_id, "s1");
});

test("el hub acepta el anexo de la anulación y rechaza update/delete de la venta", async () => {
  const driver = await readyDriver();
  await driver.put("sales", [row("s1", { total: 100, warehouse_id: "w1", status: "completed" })]);

  const voidRow = row(VOID_ID, {
    sale_id: "s1",
    branch_id: "w1",
    reason: SALE_VOID_REASONS.refund_full,
    voided_at: AT,
    created_by: "u-1"
  });
  assert.equal(
    verdict(await validateOperation({ table: SALE_VOID_TABLE, rows: [voidRow], driver, companyId: COMPANY })),
    null,
    "un insert legítimo en sale_voids se acepta"
  );

  const storedSale = await driver.get<LocalRow>("sales", "s1");
  assert.equal(
    verdict(
      await validateOperation({
        table: "sales",
        rows: [{ ...(storedSale as LocalRow), version: 2, total: 999 }],
        driver,
        companyId: COMPANY
      })
    ),
    "append_only",
    "reescribir la venta sigue prohibido"
  );
  assert.equal(
    verdict(await validateOperation({ table: "sales", deletes: ["s1"], driver, companyId: COMPANY })),
    "append_only",
    "borrar la venta sigue prohibido"
  );
});
