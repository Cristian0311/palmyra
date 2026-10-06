import assert from "node:assert/strict";
import test from "node:test";
import { NUMA_TOUR_STEPS, getAccessibleNumaTourSteps } from "../../src/components/help/palmiGuideSteps";

test("Numa guide contains a complete ordered product journey", () => {
  const ids = NUMA_TOUR_STEPS.map(step => step.id);
  assert.equal(ids[0], "welcome");
  assert.equal(ids.at(-1), "finish");
  assert.ok(ids.includes("pos"));
  assert.ok(ids.includes("inventory"));
  assert.ok(ids.includes("team"));
  assert.ok(ids.includes("settings"));
  assert.ok(ids.includes("offline"));
});

test("navigation steps define separate menu and content targets", () => {
  const dashboard = NUMA_TOUR_STEPS.find(step => step.id === "dashboard");
  const team = NUMA_TOUR_STEPS.find(step => step.id === "team");
  assert.equal(dashboard?.navTarget, true);
  assert.equal(team?.navTarget, true);
  assert.ok(dashboard?.target?.includes('[data-palmy-nav="/"]'));
  assert.ok(dashboard?.contentTarget?.includes('[data-palmi-content="dashboard"]'));
});

test("Numa guide respects user permissions", () => {
  const employee = { role: "employee", permissions: ["pos.access", "employees.manage"] };
  const ids = getAccessibleNumaTourSteps(employee).map(step => step.id);
  assert.ok(ids.includes("pos"));
  assert.ok(ids.includes("team"));
  assert.ok(!ids.includes("inventory"));
  assert.ok(!ids.includes("settings"));
});

test("administrators receive all guide modules", () => {
  const ids = getAccessibleNumaTourSteps({ role: "admin", permissions: [] }).map(step => step.id);
  assert.ok(ids.includes("inventory"));
  assert.ok(ids.includes("settings"));
});

test("Numa steps expose real UI anchors", () => {
  const dashboard = NUMA_TOUR_STEPS.find(step => step.id === "dashboard");
  const offline = NUMA_TOUR_STEPS.find(step => step.id === "offline");
  assert.equal(dashboard?.target?.[0], '[data-palmy-nav="/"]');
  assert.ok(dashboard?.contentTarget?.includes('[data-palmi-content="dashboard"]'));
  assert.ok(offline?.target?.some(selector => selector.includes("offline-status")));
});
