import assert from "node:assert/strict";
import test from "node:test";
import { NUMA_TOUR_STEPS, getAccessibleNumaTourSteps } from "../../src/components/help/palmiGuideSteps";

test("Palmi guide contains a complete ordered product journey", () => {
  const ids = NUMA_TOUR_STEPS.map(step => step.id);
  assert.equal(ids[0], "welcome");
  assert.ok(ids.includes("open-menu"));
  assert.equal(ids.at(-1), "finish");
  assert.ok(ids.includes("pos"));
  assert.ok(ids.includes("inventory"));
  assert.ok(ids.includes("team"));
  assert.ok(ids.includes("settings"));
  assert.ok(ids.includes("offline"));
});

test("module steps wait for a real user action before explaining", () => {
  const dashboard = NUMA_TOUR_STEPS.find(step => step.id === "dashboard");
  const team = NUMA_TOUR_STEPS.find(step => step.id === "team");
  assert.equal(dashboard?.requiresAction, true);
  assert.equal(team?.requiresAction, true);
  assert.equal(dashboard?.navSelector, '[data-palmi-nav="/"]');
  assert.match(dashboard?.actionMessage || "", /busca|presiona/i);
});

test("Palmi guide respects user permissions", () => {
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
  assert.ok(ids.includes("subscription"));
});


test("mobile navigation step is filtered on desktop", () => {
  const desktopIds = getAccessibleNumaTourSteps({ role: "admin", permissions: [] }, false).map(step => step.id);
  const mobileIds = getAccessibleNumaTourSteps({ role: "admin", permissions: [] }, true).map(step => step.id);
  assert.ok(!desktopIds.includes("open-menu"));
  assert.ok(mobileIds.includes("open-menu"));
});

test("Numa commands expose exact UI anchors", () => {
  const dashboard = NUMA_TOUR_STEPS.find(step => step.id === "dashboard");
  const offline = NUMA_TOUR_STEPS.find(step => step.id === "offline");
  assert.equal(dashboard?.navSelector, '[data-palmi-nav="/"]');
  assert.equal(dashboard?.selector, '[data-palmi-content="dashboard"]');
  assert.match(offline?.selector || "", /offline-status-mobile/);
});
