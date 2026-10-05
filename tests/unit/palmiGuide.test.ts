import assert from "node:assert/strict";
import test from "node:test";
import { PALMI_TOUR_STEPS, getAccessiblePalmiTourSteps } from "../../src/components/help/palmiGuideSteps";

test("Palmi guide contains a complete ordered product journey", () => {
  const ids = PALMI_TOUR_STEPS.map(step => step.id);
  assert.equal(ids[0], "welcome");
  assert.equal(ids.at(-1), "finish");
  assert.ok(ids.includes("pos"));
  assert.ok(ids.includes("inventory"));
  assert.ok(ids.includes("team"));
  assert.ok(ids.includes("settings"));
  assert.ok(ids.includes("offline"));
});

test("module steps wait for a real user action before explaining", () => {
  const dashboard = PALMI_TOUR_STEPS.find(step => step.id === "dashboard");
  const team = PALMI_TOUR_STEPS.find(step => step.id === "team");
  assert.equal(dashboard?.requiresAction, true);
  assert.equal(team?.requiresAction, true);
  assert.equal(dashboard?.navSelector, '[data-palmi-nav="/"]');
  assert.match(dashboard?.actionMessage || "", /busca|presiona/i);
});

test("Palmi guide respects user permissions", () => {
  const employee = { role: "employee", permissions: ["pos.access", "employees.manage"] };
  const ids = getAccessiblePalmiTourSteps(employee).map(step => step.id);
  assert.ok(ids.includes("pos"));
  assert.ok(ids.includes("team"));
  assert.ok(!ids.includes("inventory"));
  assert.ok(!ids.includes("settings"));
});

test("administrators receive all guide modules", () => {
  const ids = getAccessiblePalmiTourSteps({ role: "admin", permissions: [] }).map(step => step.id);
  assert.ok(ids.includes("inventory"));
  assert.ok(ids.includes("settings"));
  assert.ok(ids.includes("subscription"));
});
