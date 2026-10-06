import assert from "node:assert/strict";
import test from "node:test";

import { getAccessibleNumaTourSteps } from "../../src/components/help/palmiGuideSteps";

test("Numa guide hides restricted modules for employees but keeps support and security", () => {
  const employee = {
    id: "u1",
    name: "Ana",
    email: "ana@example.com",
    role: "employee",
    baseSalary: 0,
    permissions: ["pos.access"]
  } as any;

  const ids = getAccessibleNumaTourSteps(employee).map(step => step.id);
  assert.ok(ids.includes("pos"));
  assert.ok(ids.includes("security"));
  assert.ok(ids.includes("offline"));
  assert.ok(!ids.includes("inventory"));
  assert.ok(!ids.includes("team"));
});

test("Numa guide exposes administrative modules to admins", () => {
  const admin = {
    id: "u1",
    name: "Admin",
    email: "admin@example.com",
    role: "admin",
    baseSalary: 0,
    permissions: []
  } as any;

  const ids = getAccessibleNumaTourSteps(admin).map(step => step.id);
  assert.ok(ids.includes("dashboard"));
  assert.ok(ids.includes("inventory"));
  assert.ok(ids.includes("team"));
  assert.ok(ids.includes("settings"));
});
