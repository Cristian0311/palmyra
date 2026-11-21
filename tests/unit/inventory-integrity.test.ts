import test from "node:test";
import assert from "node:assert/strict";
import { mergeInventoryAudits } from "../../src/store/utils/mergeInventoryAudits";
import { getLowStockThreshold, isLowStockQuantity } from "../../src/modules/inventory/utils/lowStock";
import type { InventoryAudit } from "../../src/types";

function audit(overrides: Partial<InventoryAudit>): InventoryAudit {
  return {
    id: "audit-1",
    date: "2026-11-20T10:00:00.000Z",
    branchId: "b1",
    userId: "u1",
    status: "pending",
    reviewStatus: "counting",
    items: [],
    ...overrides
  };
}

test("merge conserva conteos por variante que el servidor no guarda", () => {
  const local = audit({
    reviewStatus: "pending_approval",
    items: [
      { productId: "p1", productName: "Camisa", variantLabel: "M", expected: 3, counted: 5, difference: 2 }
    ]
  });
  const remote = audit({
    reviewStatus: "pending_approval",
    items: [{ productId: "p1", productName: "Camisa", expected: 3, counted: 5, difference: 2 }]
  });

  const [merged] = mergeInventoryAudits([local], [remote]);
  assert.equal(merged.items[0].variantLabel, "M");
  assert.equal(merged.reviewStatus, "pending_approval");
});

test("merge protege una aprobación offline que la nube aún no confirma", () => {
  const local = audit({ status: "completed", reviewStatus: "approved", adjustmentPostedAt: "2026-11-20T11:00:00.000Z" });
  const remote = audit({ status: "pending", reviewStatus: "pending_approval" });

  const [merged] = mergeInventoryAudits([local], [remote]);
  assert.equal(merged.reviewStatus, "approved");
  assert.equal(merged.status, "completed");
  assert.equal(merged.adjustmentPostedAt, "2026-11-20T11:00:00.000Z");
});

test("merge acepta el estado remoto cuando el servidor avanzó a recuento", () => {
  const local = audit({ reviewStatus: "pending_approval" });
  const remote = audit({ reviewStatus: "recount_requested", recountCount: 1 });

  const [merged] = mergeInventoryAudits([local], [remote]);
  assert.equal(merged.reviewStatus, "recount_requested");
  assert.equal(merged.recountCount, 1);
});

test("merge conserva auditorías locales todavía no publicadas", () => {
  const local = audit({ id: "audit-offline", reviewStatus: "counting" });
  const merged = mergeInventoryAudits([local], []);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, "audit-offline");
});

test("umbral de bajo stock: producto, nivel y valor por defecto", () => {
  assert.equal(getLowStockThreshold({ minStockAlert: 12 }, 3), 12);
  assert.equal(getLowStockThreshold({ minStockAlert: 0 }, 7), 7);
  assert.equal(getLowStockThreshold({}, 0), 5);
  assert.equal(isLowStockQuantity(5, {}), true);
  assert.equal(isLowStockQuantity(6, {}), false);
  assert.equal(isLowStockQuantity(null, { minStockAlert: 2 }), true);
});
