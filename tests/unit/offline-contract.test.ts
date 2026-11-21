import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  OFFLINE_ITEM_SCHEMA_VERSION,
  OFFLINE_WARNING_DAYS,
  OFFLINE_WINDOW_DAYS,
  assignMissingDeviceSequences,
  compareOfflineQueueItems,
  evaluateOfflineFreshness,
  normalizeOfflineQueueItem,
  summarizeOfflineQueue,
} from "../../src/services/offline/syncContract";
import type { OfflineActionType, OfflineQueueItem } from "../../src/services/offlineQueueTypes";
import {
  collectPendingInventoryKeys,
  mergeBranchOperationalData,
} from "../../src/store/utils/offlineProtection";
import { setPalmyraLocalScope } from "../../src/services/localScope";
import { getLastSyncMoment, readSyncLedger, recordSyncMoment } from "../../src/services/offline/syncLedger";
import { summarizeTransferBatch } from "../../src/services/offline/transferBatch";

function queued(
  type: OfflineActionType,
  data: any,
  overrides: Partial<OfflineQueueItem> = {}
): OfflineQueueItem {
  return {
    id: overrides.id || "q-" + type + "-" + Math.random().toString(36).slice(2),
    actionId: overrides.actionId || "action-" + type,
    type,
    data,
    timestamp: overrides.timestamp || "2026-11-17T10:00:00.000Z",
    retryCount: 0,
    ...overrides,
  };
}

test("normalizeOfflineQueueItem adds protocol fields without touching operation data", () => {
  const original = queued("transaction", { id: "sale-1", total: 100 }, {
    timestamp: "2026-11-17T09:00:00.000Z",
  });

  const normalized = normalizeOfflineQueueItem(original, {
    deviceId: "device-1",
    deviceSequence: 7,
  });

  assert.equal(normalized.schemaVersion, OFFLINE_ITEM_SCHEMA_VERSION);
  assert.equal(normalized.deviceId, "device-1");
  assert.equal(normalized.deviceSequence, 7);
  assert.equal(normalized.queuedAt, "2026-11-17T09:00:00.000Z");
  assert.deepEqual(normalized.data, { id: "sale-1", total: 100 });
});

test("queue ordering prefers the device sequence over clock timestamps", () => {
  const first = queued("transaction", { id: "a" }, {
    id: "a",
    deviceSequence: 1,
    timestamp: "2026-11-17T12:00:00.000Z",
  });
  const second = queued("transaction", { id: "b" }, {
    id: "b",
    deviceSequence: 2,
    timestamp: "2026-11-17T08:00:00.000Z",
  });

  assert.ok(compareOfflineQueueItems(first, second) < 0);
  assert.ok(compareOfflineQueueItems(second, first) > 0);
});

test("legacy items receive deterministic sequences and existing ones are preserved", () => {
  const legacyLate = queued("customer", { id: "late" }, {
    id: "late",
    timestamp: "2026-11-17T11:00:00.000Z",
  });
  const legacyEarly = queued("customer", { id: "early" }, {
    id: "early",
    timestamp: "2026-11-17T09:00:00.000Z",
  });
  const alreadySequenced = queued("customer", { id: "seq" }, {
    id: "seq",
    deviceSequence: 40,
    timestamp: "2026-11-17T07:00:00.000Z",
  });

  const result = assignMissingDeviceSequences([legacyLate, alreadySequenced, legacyEarly], 10);
  const byId = new Map(result.items.map(item => [item.id, item]));

  assert.equal(byId.get("early")?.deviceSequence, 11);
  assert.equal(byId.get("late")?.deviceSequence, 12);
  assert.equal(byId.get("seq")?.deviceSequence, 40);
  assert.equal(result.lastSequence, 40);
});

test("health summary separates pending work from permanent conflicts", () => {
  const health = summarizeOfflineQueue([
    queued("transaction", { id: "s1" }, {
      status: "pending",
      timestamp: "2026-11-15T10:00:00.000Z",
    }),
    queued("customer", { id: "c1" }, {
      status: "failed",
      lastError: "network",
      timestamp: "2026-11-16T10:00:00.000Z",
    }),
    queued("product", { id: "p1" }, {
      status: "conflict",
      lastError: "permission denied",
      timestamp: "2026-11-17T10:00:00.000Z",
    }),
  ]);

  assert.equal(health.total, 3);
  assert.equal(health.pending, 2);
  assert.equal(health.failed, 1);
  assert.equal(health.conflicts, 1);
  assert.equal(health.oldestQueuedAt, "2026-11-15T10:00:00.000Z");
  assert.equal(health.lastError, "permission denied");
});

test("offline freshness warns before the offline window and turns stale after it", () => {
  const now = Date.parse("2026-11-17T00:00:00.000Z");
  const fresh = evaluateOfflineFreshness("2026-11-16T00:00:00.000Z", now);
  const warning = evaluateOfflineFreshness("2026-10-27T00:00:00.000Z", now);
  const stale = evaluateOfflineFreshness("2026-10-01T00:00:00.000Z", now);

  assert.equal(fresh.state, "fresh");
  assert.equal(warning.state, "warning");
  assert.ok((warning.daysSinceSync || 0) >= OFFLINE_WARNING_DAYS);
  assert.equal(stale.state, "stale");
  assert.ok((stale.daysSinceSync || 0) >= OFFLINE_WINDOW_DAYS);
  assert.equal(evaluateOfflineFreshness(null, now).state, "unknown");
});

test("pending sale keeps its optimistic stock while unrelated rows accept remote values", () => {
  const sale = queued("transaction", {
    id: "sale-1",
    branchId: "w1",
    items: [{ product: "p1", variantLabel: "" }],
  });

  const pendingKeys = collectPendingInventoryKeys([sale]);
  assert.ok(pendingKeys.has("p1_w1_"));

  const merged = mergeBranchOperationalData({
    remote: {
      inventory: [
        { id: "w1-p1-base", productId: "p1", branchId: "w1", quantity: 10 },
        { id: "w1-p2-base", productId: "p2", branchId: "w1", quantity: 4 },
      ],
    },
    local: {
      inventory: [
        { id: "w1-p1-base", productId: "p1", branchId: "w1", quantity: 8 },
        { id: "w1-p2-base", productId: "p2", branchId: "w1", quantity: 9 },
      ],
    },
    branchId: "w1",
    queue: [sale],
  });

  const byProduct = new Map(merged.inventory.map(item => [item.productId, item.quantity]));
  assert.equal(byProduct.get("p1"), 8, "pending sale must keep local stock");
  assert.equal(byProduct.get("p2"), 4, "unrelated remote stock must win");
});

test("pending cash close survives a stale remote open snapshot", () => {
  const close = queued("cash_session", { id: "session-1", __operation: "close" });

  const merged = mergeBranchOperationalData({
    remote: {
      cashSessions: [{ id: "session-1", status: "open", openedAt: "2026-11-17T08:00:00.000Z" }],
    },
    local: {
      cashSessions: [{
        id: "session-1",
        status: "closed",
        closedAt: "2026-11-17T18:00:00.000Z",
        closingBalances: [{ currencyCode: "CUP", method: "cash", amount: 500 }],
      }],
    },
    branchId: "w1",
    queue: [close],
  });

  assert.equal(merged.cashSessions.length, 1);
  assert.equal(merged.cashSessions[0].status, "closed");
  assert.equal(merged.cashSessions[0].closedAt, "2026-11-17T18:00:00.000Z");
});

test("pending transfer and void keep their local records until confirmation", () => {  const transfer = queued("transfer_bulk", {
    id: "bulk-1",
    items: [{ operationId: "transfer-1", productId: "p1", variants: [] }],
  });
  const voidSale = queued("void_transaction", { id: "sale-9" });

  const merged = mergeBranchOperationalData({
    remote: {
      transfers: [
        { id: "transfer-1", status: "pending" },
        { id: "transfer-2", status: "received" },
      ],
      transactions: [
        { id: "sale-9", status: "completed", total: 100 },
        { id: "sale-10", status: "completed", total: 50 },
      ],
    },
    local: {
      transfers: [
        { id: "transfer-1", status: "received" },
        { id: "transfer-2", status: "pending" },
      ],
      transactions: [
        { id: "sale-9", status: "voided", total: 100 },
        { id: "sale-10", status: "completed", total: 40 },
      ],
    },
    branchId: "w1",
    queue: [transfer, voidSale],
  });

  assert.equal(merged.transfers.find((item: any) => item.id === "transfer-1")?.status, "received");
  assert.equal(merged.transfers.find((item: any) => item.id === "transfer-2")?.status, "received");
  assert.equal(merged.transactions.find((item: any) => item.id === "sale-9")?.status, "voided");
  assert.equal(merged.transactions.find((item: any) => item.id === "sale-10")?.total, 50);
});

test("transfer batches report partial success without hiding applied items", () => {
  const applied = summarizeTransferBatch(3, ["op-1", "op-2"], []);
  assert.equal(applied.success, true);
  assert.equal(applied.partial, false);
  assert.deepEqual(applied.appliedOperationIds, ["op-1", "op-2"]);

  const partial = summarizeTransferBatch(3, ["op-1", "op-2"], [
    { operationId: "op-3", productId: "p3", error: "variant_stock_record_missing", errorCode: "23503" }
  ]);
  assert.equal(partial.success, false);
  assert.equal(partial.partial, true);
  assert.deepEqual(partial.appliedOperationIds, ["op-1", "op-2"]);
  assert.equal(partial.failedItems.length, 1);
  assert.equal(partial.errorCode, "23503");
  assert.match(partial.error || "", /2 de 3/);
  assert.match(partial.error || "", /variant_stock_record_missing/);

  const rejected = summarizeTransferBatch(2, [], [
    { operationId: "op-9", productId: "p9", error: "permiso denegado", errorCode: "42501" }
  ]);
  assert.equal(rejected.partial, false);
  assert.equal(rejected.error, "permiso denegado");
  assert.equal(rejected.appliedOperationIds.length, 0);
});

test("sync ledger survives restarts and is isolated per user and company", () => {
  const memory = new Map<string, string>();
  const previous = (globalThis as any).localStorage;
  (globalThis as any).localStorage = {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => { memory.set(key, String(value)); },
    removeItem: (key: string) => { memory.delete(key); },
  };

  try {
    setPalmyraLocalScope("user-1", "company-1");
    recordSyncMoment("pull", "2026-10-20T10:00:00.000Z");
    recordSyncMoment("push", "2026-10-25T10:00:00.000Z");

    assert.equal(getLastSyncMoment(), "2026-10-25T10:00:00.000Z");
    assert.equal(readSyncLedger().lastPullAt, "2026-10-20T10:00:00.000Z");
    assert.equal(readSyncLedger().lastPushAt, "2026-10-25T10:00:00.000Z");

    setPalmyraLocalScope("user-2", "company-1");
    assert.equal(readSyncLedger().lastPullAt, null);
    assert.equal(getLastSyncMoment(), null);
  } finally {
    if (previous === undefined) delete (globalThis as any).localStorage;
    else (globalThis as any).localStorage = previous;
  }
});

test("every queued action type has a replay handler in the sync engine", () => {
  // Un tipo encolado sin handler bloquearía la cola para siempre: la operación
  // nunca se aplicaría en Supabase y el usuario perdería datos silenciosamente.
  const typesSource = readFileSync(new URL("../../src/services/offlineQueueTypes.ts", import.meta.url), "utf8");
  const declaredUnion = typesSource.split("export interface")[0];
  const declared = new Set([...declaredUnion.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]));

  const handlerSource = readFileSync(new URL("../../src/services/offline/processQueueItem.ts", import.meta.url), "utf8");
  const handled = new Set([...handlerSource.matchAll(/case '([a-z_]+)'/g)].map((match) => match[1]));

  const missing = [...declared].filter((type) => !handled.has(type));
  assert.deepEqual(missing, [], `Tipos sin handler de sincronización: ${missing.join(", ")}`);
});
