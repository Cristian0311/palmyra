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

test("explicit canonical or legacy allowlists are authoritative", () => {
  assert.deepEqual(
    getAuthorizedWarehouseIds({
      warehouseId: "w1",
      allowedWarehouseIds: ["w2"],
      allowedBranches: ["w3"],
    }),
    ["w2"]
  );
  assert.deepEqual(
    getAuthorizedWarehouseIds({
      warehouseId: "w1",
      allowedBranches: ["w3", "w4"],
    }),
    ["w3", "w4"]
  );
});

test("warehouse access remains compatible with legacy single assignment", () => {
  assert.equal(hasWarehouseAccess({ branchId: "b1" }, "b1"), true);
  assert.equal(hasWarehouseAccess({ branchId: "b1" }, "b2"), false);
});

test("an explicit empty canonical allowlist does not fall back to legacy scope", () => {
  assert.deepEqual(
    getAuthorizedWarehouseIds({
      warehouseId: "w1",
      allowedWarehouseIds: [],
      allowedBranches: ["b1"],
    }),
    []
  );
});
