#!/usr/bin/env node
/**
 * Comprobación de campo del piloto de PALMYRA.
 *
 * Contrasta el JSON de estado legado (zustand/persist) con un volcado del
 * almacén normalizado y con el presupuesto de solicitudes a la nube. No escribe
 * archivos: solo lee JSON y emite un informe en texto.
 *
 * Uso:
 *   node scripts/field-check.mjs
 *   node scripts/field-check.mjs <estado-legado.json> [<volcado-almacen.json>]
 *   node scripts/field-check.mjs --legacy <ruta> --store <ruta>
 *
 * Sin ruta se usa EMBEDDED_FIXTURE, un estado pequeño que debe pasar.
 * Código de salida: 0 si todo cuadra; 1 si hay diferencias o un error de lectura.
 *
 * Este archivo es ESM puro y no puede importar TypeScript. Por eso replica las
 * reglas MÍNIMAS de lectura de src/services/localDb/importLegacy.ts (envoltorio
 * { state }, colecciones ignoradas, ids derivados del stock, última ocurrencia
 * gana) y los topes de src/services/cloudSync/contract.ts. Para que ambas
 * implementaciones no diverjan, tests/unit/field-check.test.ts ejecuta el
 * importador real y compara sus conteos con las funciones exportadas aquí; si
 * cambian las reglas del importador, ese test falla y obliga a actualizar este
 * script.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// --- Topes de sincronización (espejo de cloudSync/contract.ts) -------------
/** Una subida cada 15 minutos como mínimo. */
export const MIN_INTERVAL_MS = 15 * 60 * 1000;
/** Presupuesto diario: 96 subidas/día equivalen a una cada 15 minutos. */
export const MAX_REQUESTS_PER_DAY = 96;
export const MS_PER_DAY = 24 * 60 * 60 * 1000;

// --- Mapa legado → almacén (espejo de importLegacy.LEGACY_TABLE_MAP) --------
export const LEGACY_TABLE_MAP = Object.freeze({
  branches: "warehouses",
  products: "products",
  inventory: "stock_balances",
  transactions: "sales",
  cashSessions: "cash_sessions",
  customers: "customers",
  suppliers: "suppliers",
  supplierOrders: "purchases",
  inventoryAudits: "inventory_audits",
  quotes: "quotes",
  transfers: "transfers",
  returns: "returns",
  bankCards: "banks",
  bankTransactions: "bank_movements",
  fiscalConfigs: "ncf_sequences"
});

/** Tablas destino contempladas por el importador. */
export const MAPPED_TABLES = Object.freeze(new Set(Object.values(LEGACY_TABLE_MAP)));

/** Arreglos de UI o sesión efímera: nunca forman parte del negocio importable. */
const IGNORED_ARRAYS = new Set(["cart", "notifications"]);

/** Diferencia tolerada al cotejar importes y cantidades (redondeo de coma flotante). */
const EPSILON = 1e-6;

/** Estado de ejemplo: cubre duplicados, filas sin id, stock derivado y totales. */
export const EMBEDDED_FIXTURE = Object.freeze({
  state: {
    currentBranchId: "b1",
    branches: [
      { id: "b1", name: "Centro" },
      { id: "b2", name: "Vedado" }
    ],
    products: [
      { id: "p1", name: "Cemento gris", price: 150 },
      { name: "Producto sin id", price: 10 },
      { id: "p2", name: "Arena fina", price: 60 },
      { id: "p1", name: "Cemento gris (corregido)", price: 160 }
    ],
    inventory: [
      { productId: "p1", branchId: "b1", quantity: 12 },
      { productId: "p1", branchId: "b1", quantity: 20 },
      { productId: "p2", branchId: "b1", variantLabel: "M", quantity: 4 },
      { productId: "p2", branchId: "b2", quantity: 6 }
    ],
    transactions: [
      { id: "t1", branchId: "b1", total: 1500 },
      { id: "t2", branchId: "b2", total: 250.5 },
      { id: "t1", branchId: "b1", total: 1600 },
      { id: "t3", branchId: "b1", total_amount: 99.5 }
    ],
    cashSessions: [{ id: "s1", branchId: "b1", openingBalance: 0 }],
    cart: [{ id: "c1" }],
    notifications: [{ id: "n1" }],
    categories: [{ id: "cat1" }, { id: "cat2" }]
  },
  version: 0
});

const USAGE = `PALMYRA · comprobación de campo

Uso:
  node scripts/field-check.mjs
  node scripts/field-check.mjs <estado-legado.json> [<volcado-almacen.json>]
  node scripts/field-check.mjs --legacy <ruta> --store <ruta>

  --legacy <ruta>   JSON de estado legado (si falta, se usa un fixture embebido)
  --store <ruta>    volcado del almacén normalizado con forma { tabla: filas[] }
  -h, --help        muestra esta ayuda

No escribe archivos. Sale con 0 si todo cuadra y con 1 si hay diferencias.`;

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

/** El JSON de zustand/persist envuelve el estado en { state, version }. */
export function unwrapLegacyState(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const wrapper = input;
  const inner = wrapper.state;
  if (inner && typeof inner === "object" && !Array.isArray(inner)) return inner;
  return wrapper;
}

/**
 * Clave de fila con las mismas reglas que importLegacy.normalizeRow: id
 * explícito cuando existe; para el inventario se deriva producto/almacén/variante.
 */
function legacyRowId(table, raw) {
  const rawId = raw.id;
  const id =
    typeof rawId === "string"
      ? rawId.trim()
      : typeof rawId === "number" && Number.isFinite(rawId)
        ? String(rawId)
        : "";
  if (id) return id;
  if (table !== "stock_balances") return null;
  const productId = firstString(raw.productId, raw.product_id);
  if (!productId) return null;
  const warehouseId =
    firstString(raw.warehouseId, raw.warehouse_id, raw.branchId, raw.branch_id) ?? "default";
  const variant = firstString(raw.variantLabel, raw.variant_label) ?? "base";
  return `stock:${productId}:${warehouseId}:${variant}`;
}

function isPlainRow(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Deduplica una colección legada. Ante un id repetido gana la última
 * ocurrencia del arreglo, igual que el importador.
 */
function collectLegacyRows(table, source, warnings) {
  const byId = new Map();
  let withoutId = 0;
  let invalid = 0;
  let derived = 0;
  let duplicates = 0;

  for (const candidate of source) {
    if (!isPlainRow(candidate)) {
      invalid += 1;
      continue;
    }
    const hadId =
      (typeof candidate.id === "string" && candidate.id.trim() !== "") ||
      (typeof candidate.id === "number" && Number.isFinite(candidate.id));
    const id = legacyRowId(table, candidate);
    if (!id) {
      withoutId += 1;
      continue;
    }
    if (!hadId) derived += 1;
    if (byId.has(id)) duplicates += 1;
    byId.set(id, candidate);
  }

  if (derived > 0) warnings.push(`${table}: ${derived} filas sin id con id derivado`);
  if (withoutId > 0) warnings.push(`${table}: ${withoutId} filas sin id (descartadas)`);
  if (invalid > 0) warnings.push(`${table}: ${invalid} filas con formato inválido`);
  if (duplicates > 0) warnings.push(`${table}: ${duplicates} ids duplicados (se conserva la última)`);
  return Array.from(byId.values());
}

function sumFiniteNumbers(rows) {
  let sum = 0;
  for (const row of rows) {
    // El importador pasa totalAmount a total_amount; se aceptan ambas formas
    // para que el cálculo sobre filas crudas y normalizadas coincida.
    const value = row.total ?? row.total_amount ?? row.totalAmount;
    if (typeof value === "number" && Number.isFinite(value)) sum += value;
  }
  return sum;
}

/** Agrupa cantidades por producto; acepta claves legadas y normalizadas. */
function stockByProduct(rows) {
  const result = {};
  for (const row of rows) {
    const productId = firstString(row.product_id, row.productId);
    if (!productId) continue;
    const quantity = row.quantity;
    if (typeof quantity !== "number" || !Number.isFinite(quantity)) continue;
    result[productId] = (result[productId] ?? 0) + quantity;
  }
  return result;
}

/** Conteos y sumas calculados sobre el JSON legado. */
export function computeLegacyMetrics(input) {
  const source = unwrapLegacyState(input);
  const tables = {};
  const tableCounts = {};
  const warnings = [];
  const unmappedKeys = [];

  for (const key of Object.keys(source)) {
    const value = source[key];
    const table = LEGACY_TABLE_MAP[key];
    if (!Array.isArray(value)) {
      if (table) warnings.push(`${table}: el valor legado "${key}" no es un arreglo (omitido)`);
      continue;
    }
    if (IGNORED_ARRAYS.has(key)) continue;
    if (!table) {
      unmappedKeys.push(`${key}: ${value.length}`);
      continue;
    }
    const rows = collectLegacyRows(table, value, warnings);
    if (rows.length === 0) continue;
    // El importador asigna (no fusiona) por tabla: la última colección gana.
    tables[table] = rows;
    tableCounts[table] = rows.length;
  }

  const sales = tables.sales ?? [];
  const totals = {
    products: tables.products?.length ?? 0,
    sales: sales.length,
    salesTotal: sumFiniteNumbers(sales),
    cashSessions: tables.cash_sessions?.length ?? 0
  };

  return {
    tables,
    tableCounts,
    totals,
    stockByProduct: stockByProduct(tables.stock_balances ?? []),
    warnings,
    unmappedKeys
  };
}

/** Conteos y sumas calculados sobre el volcado { tabla: filas[] }. */
export function computeStoreMetrics(dump) {
  if (!dump || typeof dump !== "object" || Array.isArray(dump)) {
    throw new TypeError("El volcado del almacén debe ser un objeto { tabla: filas[] }");
  }
  const tableCounts = {};
  for (const [table, rows] of Object.entries(dump)) {
    if (!Array.isArray(rows)) {
      throw new TypeError(`El volcado de "${table}" debe ser un arreglo de filas`);
    }
    tableCounts[table] = rows.length;
  }

  const sales = dump.sales ?? [];
  const totals = {
    products: tableCounts.products ?? 0,
    sales: sales.length,
    salesTotal: sumFiniteNumbers(sales),
    cashSessions: tableCounts.cash_sessions ?? 0
  };

  return {
    tableCounts,
    totals,
    stockByProduct: stockByProduct(dump.stock_balances ?? [])
  };
}

function sameAmount(a, b) {
  return Math.abs(a - b) <= EPSILON * Math.max(1, Math.abs(a), Math.abs(b));
}

function formatNumber(value) {
  if (!Number.isFinite(value)) return String(value);
  return String(Math.round(value * 10000) / 10000);
}

/** Coteja los conteos calculados contra el volcado del almacén. */
export function compareMetrics(expected, actual) {
  const issues = [];
  const push = (label, expectedValue, actualValue) => {
    if (expectedValue !== actualValue) {
      issues.push(`${label}: legado ${expectedValue}, almacén ${actualValue}`);
    }
  };

  push("productos", expected.totals.products, actual.totals.products);
  push("ventas", expected.totals.sales, actual.totals.sales);
  push("sesiones de caja", expected.totals.cashSessions, actual.totals.cashSessions);
  if (!sameAmount(expected.totals.salesTotal, actual.totals.salesTotal)) {
    issues.push(
      `suma de ventas: legado ${expected.totals.salesTotal.toFixed(2)}, almacén ${actual.totals.salesTotal.toFixed(2)}`
    );
  }

  const products = new Set([
    ...Object.keys(expected.stockByProduct),
    ...Object.keys(actual.stockByProduct)
  ]);
  for (const productId of [...products].sort()) {
    const left = expected.stockByProduct[productId] ?? 0;
    const right = actual.stockByProduct[productId] ?? 0;
    if (!sameAmount(left, right)) {
      issues.push(`stock de "${productId}": legado ${formatNumber(left)}, almacén ${formatNumber(right)}`);
    }
  }

  for (const table of [...MAPPED_TABLES].sort()) {
    const left = expected.tableCounts[table] ?? 0;
    const right = actual.tableCounts[table] ?? 0;
    if (left !== right && table !== "products" && table !== "sales" && table !== "cash_sessions") {
      issues.push(
        `tabla "${table}": legado ${left}, almacén ${right} (¿volcado incompleto o importación parcial?)`
      );
    }
  }

  return issues;
}

/**
 * Revisa la coherencia del presupuesto de solicitudes: el tope diario y el
 * intervalo mínimo deben describir la misma cadencia (96/día == cada 15 min).
 */
export function evaluateBudget({ maxRequestsPerDay = MAX_REQUESTS_PER_DAY, minIntervalMs = MIN_INTERVAL_MS } = {}) {
  const issues = [];
  if (!Number.isInteger(maxRequestsPerDay) || maxRequestsPerDay <= 0) {
    issues.push(
      `presupuesto inválido: el máximo diario debe ser un entero positivo (recibido ${maxRequestsPerDay})`
    );
  }
  if (!(minIntervalMs > 0) || !Number.isFinite(minIntervalMs)) {
    issues.push(`presupuesto inválido: el intervalo mínimo debe ser positivo (recibido ${minIntervalMs} ms)`);
  }

  const impliedIntervalMs = maxRequestsPerDay > 0 ? MS_PER_DAY / maxRequestsPerDay : Number.NaN;
  const uploadsPerDayAtMinInterval = minIntervalMs > 0 ? MS_PER_DAY / minIntervalMs : Number.NaN;

  if (issues.length === 0 && impliedIntervalMs !== minIntervalMs) {
    issues.push(
      `el diseño se contradice: 24 h / ${maxRequestsPerDay} = ${formatNumber(impliedIntervalMs)} ms por subida, ` +
        `pero el intervalo mínimo es ${minIntervalMs} ms (${formatNumber(minIntervalMs / 60000)} min)`
    );
  }
  if (issues.length === 0 && maxRequestsPerDay * minIntervalMs !== MS_PER_DAY) {
    issues.push(
      `el diseño no cubre el día: ${maxRequestsPerDay} × ${minIntervalMs} ms ≠ ${MS_PER_DAY} ms`
    );
  }

  return {
    ok: issues.length === 0,
    issues,
    maxRequestsPerDay,
    minIntervalMs,
    impliedIntervalMs,
    uploadsPerDayAtMinInterval
  };
}

/* ------------------------------------------------------------------ */
/* Estado de los módulos de la ola (inspección estática, sin red)     */
/* ------------------------------------------------------------------ */

/** Raíz del repo (scripts/ -> repo). */
const MODULE_ROOT = fileURLToPath(new URL("../", import.meta.url));

/**
 * Cada módulo se certifica por la presencia de sus archivos y de las marcas
 * que definen su contrato (rutas del hub, cifrado del respaldo, ES256,
 * revocación, caché de tasas). No ejecuta nada ni toca la red.
 */
const MODULE_SPECS = Object.freeze([
  {
    area: "hub",
    label: "Hub LAN",
    files: [
      "src/services/lanHub/protocol.ts",
      "src/services/lanHub/auth.ts",
      "src/services/lanHub/handler.ts",
      "src/services/lanHub/nodeServer.ts",
      "src/services/lanHub/opsClient.ts"
    ],
    markers: {
      "src/services/lanHub/protocol.ts": ["/lan/v1/pair", "/lan/v1/ops", "/lan/v1/changes"],
      "src/services/lanHub/auth.ts": ["HMAC", "nonce"],
      "src/services/lanHub/handler.ts": ["hub_receipts", "validateOperation"],
      "src/services/lanHub/nodeServer.ts": ["127.0.0.1"],
      "src/services/lanHub/opsClient.ts": ["createHubOpsClient"]
    }
  },
  {
    area: "respaldo",
    label: "Respaldo cifrado",
    files: [
      "src/services/localDb/backup/format.ts",
      "src/services/localDb/backup/backup.ts",
      "src/services/localDb/backup/snapshot.ts"
    ],
    markers: {
      "src/services/localDb/backup/format.ts": ["AES-256-GCM", "PBKDF2-SHA256", "310_000"],
      "src/services/localDb/backup/backup.ts": ["createBackupResult", "restoreBackup"],
      "src/services/localDb/backup/snapshot.ts": ["readBackupSnapshot", "applyBackupSnapshot"]
    }
  },
  {
    area: "licencia",
    label: "Licencia ES256",
    files: [
      "src/services/license/contract.ts",
      "src/services/license/verify.ts",
      "src/services/license/runtime.ts",
      "src/services/license/revocation.ts",
      "src/services/license/telemetry.ts"
    ],
    markers: {
      "src/services/license/contract.ts": ["ES256", "leaseSigningInput"],
      "src/services/license/verify.ts": ["verifyLeaseForDevice"],
      "src/services/license/runtime.ts": ["lease-revoked", "drainClockTelemetry"],
      "src/services/license/revocation.ts": ["revoke-lease"],
      "src/services/license/telemetry.ts": ["clock_tamper_reports"]
    }
  },
  {
    area: "tasas",
    label: "Tasas del hub",
    files: ["src/services/lanHub/rates.ts", "src/services/exchangeRatesHub.ts"],
    markers: {
      "src/services/lanHub/rates.ts": ["createHubRatesProvider", "/api/exchange-rates", "ttlMs"],
      "src/services/exchangeRatesHub.ts": ["resolveExchangeRates"]
    }
  }
]);

export const MODULE_AREAS = Object.freeze(MODULE_SPECS.map((spec) => spec.area));

function inspectModule(spec, root) {
  const missingFiles = [];
  const missingMarkers = [];
  let checks = 0;

  for (const file of spec.files) {
    checks += 1;
    let text = null;
    try {
      text = fs.readFileSync(path.join(root, file), "utf8");
    } catch {
      missingFiles.push(file);
      continue;
    }
    for (const marker of spec.markers[file] ?? []) {
      checks += 1;
      if (!text.includes(marker)) missingMarkers.push(`${file}: ${marker}`);
    }
  }

  const issues = [
    ...missingFiles.map((file) => `${spec.label}: falta ${file}`),
    ...missingMarkers.map((marker) => `${spec.label}: marca ausente ${marker}`)
  ];
  return {
    area: spec.area,
    label: spec.label,
    ok: issues.length === 0,
    files: spec.files.length,
    checks,
    detail:
      issues.length === 0
        ? `${spec.files.length} archivos y ${checks - spec.files.length} marcas verificadas`
        : `${issues.length} incidencia(s)`,
    issues
  };
}

/**
 * Estado de hub, respaldo, licencia y tasas sin red. Cada área lista sus
 * archivos y marcas de contrato; cualquier falta convierte el informe en FALLA.
 */
export function checkModules({ root = MODULE_ROOT } = {}) {
  const areas = MODULE_SPECS.map((spec) => inspectModule(spec, root));
  const issues = areas.flatMap((area) => area.issues);
  return { ok: issues.length === 0, areas, issues };
}

/**
 * Comprobación completa: métricas del legado, presupuesto y cotejo opcional con
 * el volcado del almacén.
 */
export function checkField({ legacy = EMBEDDED_FIXTURE, store = null, moduleRoot = MODULE_ROOT } = {}) {
  const legacyMetrics = computeLegacyMetrics(legacy);
  const budget = evaluateBudget();
  const modules = checkModules({ root: moduleRoot });
  const issues = [...budget.issues, ...modules.issues];
  let storeMetrics = null;

  if (store !== null && store !== undefined) {
    storeMetrics = computeStoreMetrics(store);
    issues.push(...compareMetrics(legacyMetrics, storeMetrics));
  }

  return {
    ok: issues.length === 0,
    issues,
    budget,
    legacy: legacyMetrics,
    store: storeMetrics,
    modules
  };
}

/** Informe legible en texto (sin Markdown). */
export function formatReport(result, { legacyLabel = "fixture embebido", storeLabel = null } = {}) {
  const lines = [];
  const budget = result.budget;

  lines.push("PALMYRA · comprobación de campo del piloto");
  lines.push(`Estado legado: ${legacyLabel}`);
  lines.push(`Volcado del almacén: ${storeLabel ?? "(no proporcionado)"}`);
  lines.push("");
  lines.push("Conteos calculados con las reglas del importador:");
  lines.push(`  productos: ${result.legacy.totals.products}`);
  lines.push(`  ventas: ${result.legacy.totals.sales}`);
  lines.push(`  suma de ventas: ${result.legacy.totals.salesTotal.toFixed(2)}`);
  lines.push(`  sesiones de caja: ${result.legacy.totals.cashSessions}`);
  const stockIds = Object.keys(result.legacy.stockByProduct).sort();
  if (stockIds.length === 0) {
    lines.push("  stock por producto: (sin inventario legado)");
  } else {
    lines.push("  stock por producto:");
    for (const productId of stockIds) {
      lines.push(`    ${productId}: ${formatNumber(result.legacy.stockByProduct[productId])}`);
    }
  }

  if (result.store) {
    lines.push("");
    lines.push("Volcado del almacén normalizado:");
    lines.push(`  productos: ${result.store.totals.products}`);
    lines.push(`  ventas: ${result.store.totals.sales}`);
    lines.push(`  suma de ventas: ${result.store.totals.salesTotal.toFixed(2)}`);
    lines.push(`  sesiones de caja: ${result.store.totals.cashSessions}`);
    lines.push(`  productos con stock: ${Object.keys(result.store.stockByProduct).length}`);
  }

  lines.push("");
  lines.push("Presupuesto de solicitudes a la nube:");
  lines.push(`  máximo por día: ${budget.maxRequestsPerDay}`);
  lines.push(
    `  intervalo mínimo: ${budget.minIntervalMs} ms (${formatNumber(budget.minIntervalMs / 60000)} min)`
  );
  lines.push(
    `  24 h / ${budget.maxRequestsPerDay} = ${formatNumber(budget.impliedIntervalMs)} ms por subida`
  );
  lines.push(
    `  subidas posibles al intervalo mínimo: ${formatNumber(budget.uploadsPerDayAtMinInterval)}/día`
  );
  lines.push(`  diseño: ${budget.ok ? "coherente" : "incoherente"}`);

  if (result.modules) {
    lines.push("");
    lines.push(`Estado de los módulos (${result.modules.ok ? "OK" : "FALLA"}, inspección sin red):`);
    for (const area of result.modules.areas) {
      lines.push(`  ${area.label}: ${area.ok ? "OK" : "FALLA"} — ${area.detail}`);
    }
  }

  if (result.legacy.warnings.length > 0) {
    lines.push("");
    lines.push(`Avisos de lectura (${result.legacy.warnings.length}):`);
    for (const warning of result.legacy.warnings.slice(0, 20)) lines.push(`  - ${warning}`);
    if (result.legacy.warnings.length > 20) {
      lines.push(`  - … y ${result.legacy.warnings.length - 20} avisos más`);
    }
  }
  if (result.legacy.unmappedKeys.length > 0) {
    lines.push("");
    lines.push(`Colecciones sin tabla destino: ${result.legacy.unmappedKeys.join(", ")}`);
  }

  lines.push("");
  if (result.issues.length === 0) {
    lines.push("Resultado: OK — el piloto cuadra (sin diferencias).");
  } else {
    lines.push(`Diferencias (${result.issues.length}):`);
    for (const issue of result.issues) lines.push(`  - ${issue}`);
    lines.push("");
    lines.push("Resultado: FALLA — revisa la importación o el volcado antes de certificar.");
  }
  return lines.join("\n");
}

/** Lee un JSON con un mensaje de error legible (nunca escribe). */
export function readJsonFile(filePath, label) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    throw new Error(`no se pudo leer ${label} "${filePath}": ${error.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label} "${filePath}" no es JSON válido: ${error.message}`);
  }
}

export function parseArgs(argv = []) {
  const options = { legacyPath: null, storePath: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") {
      options.help = true;
    } else if (arg === "--legacy") {
      options.legacyPath = argv[++index] ?? null;
      if (!options.legacyPath) throw new Error("--legacy requiere una ruta");
    } else if (arg.startsWith("--legacy=")) {
      options.legacyPath = arg.slice("--legacy=".length) || null;
      if (!options.legacyPath) throw new Error("--legacy requiere una ruta");
    } else if (arg === "--store") {
      options.storePath = argv[++index] ?? null;
      if (!options.storePath) throw new Error("--store requiere una ruta");
    } else if (arg.startsWith("--store=")) {
      options.storePath = arg.slice("--store=".length) || null;
      if (!options.storePath) throw new Error("--store requiere una ruta");
    } else if (arg.startsWith("-")) {
      throw new Error(`opción desconocida: ${arg}`);
    } else if (!options.legacyPath) {
      options.legacyPath = arg;
    } else if (!options.storePath) {
      options.storePath = arg;
    } else {
      throw new Error(`argumento de más: ${arg}`);
    }
  }
  return options;
}

/**
 * Punto de entrada sin efectos globales: devuelve el código de salida para que
 * las pruebas puedan ejecutarlo sin lanzar procesos.
 */
export function runCli(argv = [], io = { out: (line) => console.log(line), err: (line) => console.error(line) }) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    io.err(`field-check: ${error.message}`);
    io.err(USAGE);
    return 1;
  }
  if (options.help) {
    io.out(USAGE);
    return 0;
  }

  let legacy;
  let store = null;
  try {
    legacy = options.legacyPath
      ? readJsonFile(options.legacyPath, "estado legado")
      : EMBEDDED_FIXTURE;
    if (options.storePath) store = readJsonFile(options.storePath, "volcado del almacén");
  } catch (error) {
    io.err(`field-check: ${error.message}`);
    return 1;
  }

  const result = checkField({ legacy, store });
  io.out(
    formatReport(result, {
      legacyLabel: options.legacyPath ?? "fixture embebido",
      storeLabel: options.storePath
    })
  );
  return result.ok ? 0 : 1;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath && invokedPath === path.resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = runCli(process.argv.slice(2));
}
