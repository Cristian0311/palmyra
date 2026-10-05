import assert from "node:assert/strict";
import test from "node:test";
import { mergeById, mergeUnique } from "../../src/store/utils/syncMerges";

test("mergeById keeps protected offline records even when the remote snapshot is stale", () => {
  const merged = mergeById(
    [{ id: "p1", name: "Remote" }],
    [{ id: "p1", name: "Offline" }, { id: "p2", name: "Local only" }],
    new Set(["p1"])
  );

  assert.deepEqual(
    merged.sort((a, b) => a.id.localeCompare(b.id)),
    [
      { id: "p1", name: "Offline" },
      { id: "p2", name: "Local only" },
    ]
  );
});

test("mergeUnique preserves a locally closed cash session against stale open cloud state", () => {
  const local = [{
    id: "s1",
    status: "closed",
    closedAt: "2026-10-05T12:00:00.000Z",
    closingDate: "2026-10-05T12:00:00.000Z",
    closingBalances: [{ currencyCode: "CUP", method: "cash", amount: 200 }],
  }];

  const remote = [{
    id: "s1",
    status: "open",
    openedAt: "2026-10-05T10:00:00.000Z",
  }];

  const merged = mergeUnique(remote, local);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].status, "closed");
  assert.equal(merged[0].closedAt, "2026-10-05T12:00:00.000Z");
  assert.deepEqual(merged[0].closingBalances, [{ currencyCode: "CUP", method: "cash", amount: 200 }]);
});

test("mergeUnique lets remote win same-id records while keeping local-only records", () => {
  const merged = mergeUnique(
    [{ id: "p1", name: "Cloud" }],
    [{ id: "p1", name: "Old local" }, { id: "p2", name: "Offline new" }]
  );

  assert.deepEqual(
    merged.sort((a, b) => a.id.localeCompare(b.id)),
    [
      { id: "p1", name: "Cloud" },
      { id: "p2", name: "Offline new" },
    ]
  );
});
