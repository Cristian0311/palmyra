import test from "node:test";
import assert from "node:assert/strict";
import {
  dedupeOfflineQueueItems,
  describeOfflineQueueType,
  listPendingOfflineOperations,
  summarizeOfflineQueue
} from "../../src/services/offline/syncContract";
import type { OfflineActionType, OfflineQueueItem } from "../../src/services/offlineQueueTypes";

function queued(overrides: Partial<OfflineQueueItem> = {}): OfflineQueueItem {
  return {
    id: overrides.id || "q-1",
    actionId: overrides.actionId || "action-1",
    type: (overrides.type || "transaction") as OfflineActionType,
    data: overrides.data || { id: overrides.actionId || "action-1" },
    timestamp: overrides.timestamp || "2026-11-17T10:00:00.000Z",
    retryCount: 0,
    status: "pending",
    ...overrides
  };
}

test("dedupe collapses rows that share the idempotent type+actionId key", () => {
  const duplicate = dedupeOfflineQueueItems([
    queued({ id: "row-a", actionId: "sale-1", timestamp: "2026-11-17T10:00:00.000Z" }),
    queued({ id: "row-b", actionId: "sale-1", timestamp: "2026-11-17T10:05:00.000Z" }),
  ]);

  assert.equal(duplicate.length, 1);
  assert.equal(duplicate[0].id, "row-b");
});

test("dedupe keeps distinct actionIds and prefers the conflict copy", () => {
  const result = dedupeOfflineQueueItems([
    queued({ id: "pending-1", actionId: "sale-1", status: "pending" }),
    queued({ id: "conflict-1", actionId: "sale-1", status: "conflict", lastError: "rechazada" }),
    queued({ id: "pending-2", actionId: "sale-2", status: "pending" }),
  ]);

  assert.equal(result.length, 2);
  assert.equal(result.find(item => item.actionId === "sale-1")?.status, "conflict");
  assert.ok(result.some(item => item.actionId === "sale-2"));
});

test("health summary counts operations, not duplicated IndexedDB rows", () => {
  const health = summarizeOfflineQueue([
    queued({ id: "row-a", actionId: "sale-1", status: "pending" }),
    queued({ id: "row-b", actionId: "sale-1", status: "pending" }),
  ]);

  assert.equal(health.total, 1);
  assert.equal(health.pending, 1);
  assert.equal(health.conflicts, 0);
});

test("queue types get a human-readable Spanish label", () => {
  assert.equal(describeOfflineQueueType("cash_movement"), "Movimiento de caja");
  assert.equal(describeOfflineQueueType("inventory_adjustment"), "Ajuste de inventario");
  assert.equal(describeOfflineQueueType("unknown_type"), "Unknown type");
  assert.equal(describeOfflineQueueType(""), "Operación");
});

test("pending operation list excludes conflicts, orders oldest first and caps the limit", () => {
  const pending = listPendingOfflineOperations([
    queued({ id: "c-1", actionId: "conflict", type: "customer", status: "conflict" }),
    queued({ id: "p-new", actionId: "sale-2", type: "transaction", timestamp: "2026-11-17T12:00:00.000Z" }),
    queued({ id: "p-old", actionId: "move-1", type: "cash_movement", status: "failed", lastError: "network", timestamp: "2026-11-17T08:00:00.000Z" }),
    queued({ id: "p-mid", actionId: "adj-1", type: "inventory_adjustment", timestamp: "2026-11-17T10:00:00.000Z" }),
  ], 2);

  assert.deepEqual(pending.map(op => op.id), ["p-old", "p-mid"]);
  assert.equal(pending[0].label, "Movimiento de caja");
  assert.equal(pending[0].status, "failed");
  assert.equal(pending[0].lastError, "network");
  assert.equal(pending[0].queuedAt, "2026-11-17T08:00:00.000Z");
});
