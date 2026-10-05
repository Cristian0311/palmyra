import assert from "node:assert/strict";
import test from "node:test";
import {
  getAuthorizedWarehouseIds,
  getWarehouseId,
  hasWarehouseAccess,
} from "../../src/modules/warehouse/warehouseScope";

test("warehouse scope prefers canonical warehouseId and supports legacy branchId", () => {
  assert.equal(getWarehouseId({ warehouseId: "w1", branchId: "b1" }), "w1");
  assert.equal(getWarehouseId({ branchId: "b2" }), "b2");
});

test("authorized warehouse ids merge canonical and legacy assignments without duplicates", () => {
  assert.deepEqual(
    getAuthorizedWarehouseIds({
      warehouseId: "w1",
      allowedWarehouseIds: ["w1", "w2"],
      allowedBranches: ["w2", "w3"],
    }),
    ["w1", "w2", "w3"]
  );
});

test("warehouse access remains compatible with legacy branch assignments", () => {
  assert.equal(hasWarehouseAccess({ branchId: "b1" }, "b1"), true);
  assert.equal(hasWarehouseAccess({ branchId: "b1" }, "b2"), false);
});
