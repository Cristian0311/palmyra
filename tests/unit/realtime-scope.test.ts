import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PLAN_APPROVAL_NOTIFICATION_TABLE,
  __realtimeInternals,
  initMultiDeviceRealtimeSync,
  realtimeTableSubscriptions
} from "../../src/services/realtimeSync";

/**
 * F6: el realtime de negocio vive en el hub LAN. La nube solo puede escuchar
 * la aprobación de planes, y no debe quedar ningún sondeo de 120 s.
 */

const source = () => readFileSync(join(process.cwd(), "src/services/realtimeSync.ts"), "utf8");

const BUSINESS_TABLES = [
  "stock_balances",
  "variant_stock_balances",
  "stock_movements",
  "sales",
  "payments",
  "cash_registers",
  "cash_sessions",
  "cash_movements",
  "transfers",
  "sales_returns",
  "warranties",
  "purchase_orders",
  "quotes",
  "inventory_audits",
  "bank_accounts",
  "bank_transactions",
  "employee_time_shifts",
  "payroll_runs",
  "payroll_items",
  "warehouses",
  "categories",
  "products",
  "product_variants",
  "product_barcodes",
  "product_kit_components",
  "employees",
  "employee_warehouse_access",
  "currencies",
  "exchange_rates"
];

test("realtimeTableSubscriptions returns only the plan approval allowlist", () => {
  const tables = realtimeTableSubscriptions();
  assert.deepEqual(tables, ["notifications", "plan_requests"]);
  assert.equal(tables.includes("sales"), false);
  for (const table of BUSINESS_TABLES) {
    assert.equal(tables.includes(table), false, `${table} must never run on cloud Realtime`);
  }
});

test("PLAN_APPROVAL_NOTIFICATION_TABLE is exported for the owner plan approval", () => {
  assert.equal(PLAN_APPROVAL_NOTIFICATION_TABLE, "notifications");
  assert.equal(realtimeTableSubscriptions().includes(PLAN_APPROVAL_NOTIFICATION_TABLE), true);
});

test("mutating the returned allowlist never leaks into the module", () => {
  const tables = realtimeTableSubscriptions();
  tables.push("sales");
  assert.deepEqual(realtimeTableSubscriptions(), ["notifications", "plan_requests"]);
});

test("realtimeSync no longer subscribes to business tables nor polls every 120 s", () => {
  const code = source();
  assert.doesNotMatch(code, /palmyra-tenant-/);
  assert.doesNotMatch(code, /120_000|120000/);
  assert.doesNotMatch(code, /setInterval/);
  assert.doesNotMatch(code, /GLOBAL_TABLES|OP_TABLES|scheduleDebouncedSync\s*=\s*\(delay/);
  for (const table of BUSINESS_TABLES) {
    assert.equal(
      new RegExp(`table:\\s*['"]${table}['"]`).test(code),
      false,
      `${table} must not be subscribed as a cloud table`
    );
  }
  // Solo el canal de aprobación puede usar postgres_changes, con la lista blanca.
  const registrations = code.match(/postgres_changes/g) ?? [];
  assert.equal(registrations.length, 1, "exactly one cloud realtime registration point");
  assert.match(code, /for \(const table of realtimeTableSubscriptions\(\)\)/);
});

test("boot calls the minimal cloud bootstrap once per tenant", () => {
  const code = source();
  assert.match(code, /import\('\.\.\/store\/actions\/syncActions'\)/, "bootstrap must be a dynamic import");
  assert.match(code, /bootstrapCloudData/);
  assert.match(code, /bootstrappedTenantKey/);
  assert.match(code, /export async function refreshRealtimeNow/);
});

test("initMultiDeviceRealtimeSync is idempotent and stops cleanly", () => {
  type Listener = () => void;
  const listeners = new Map<string, Set<Listener>>();
  const fakeWindow = {
    addEventListener(name: string, fn: Listener) {
      const set = listeners.get(name) ?? new Set<Listener>();
      set.add(fn);
      listeners.set(name, set);
    },
    removeEventListener(name: string, fn: Listener) {
      listeners.get(name)?.delete(fn);
    }
  };
  const count = (name: string) => listeners.get(name)?.size ?? 0;

  const globalAny = globalThis as unknown as Record<string, unknown>;
  const originalWindow = globalAny.window;
  const originalWarn = console.warn;
  const originalInfo = console.info;
  globalAny.window = fakeWindow;
  console.warn = () => {};
  console.info = () => {};

  try {
    const stopFirst = initMultiDeviceRealtimeSync();
    const stopSecond = initMultiDeviceRealtimeSync();

    assert.equal(__realtimeInternals.getInitRefCount(), 2);
    assert.equal(count("online"), 1, "only one online listener regardless of subscribers");
    assert.equal(count("offline"), 1);

    stopFirst();
    stopFirst(); // doble liberación no debe contar dos veces
    assert.equal(__realtimeInternals.getInitRefCount(), 1);
    assert.equal(count("online"), 1);

    stopSecond();
    assert.equal(__realtimeInternals.getInitRefCount(), 0);
    assert.equal(count("online"), 0);
    assert.equal(count("offline"), 0);
  } finally {
    globalAny.window = originalWindow;
    console.warn = originalWarn;
    console.info = originalInfo;
  }
});
