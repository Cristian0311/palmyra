import assert from "node:assert/strict";
import test from "node:test";
import { PALMYRA_PLANS, type PlanCode } from "../../src/config/saas";

test("PALMYRA publishes exactly the three purchasable plans", () => {
  assert.deepEqual(
    PALMYRA_PLANS.map((plan) => plan.code),
    ["starter", "growth", "pro"]
  );
});

test("plan limits match the SaaS entitlement catalog", () => {
  const expected: Record<PlanCode, { warehouses: number; employees: number; products: number }> = {
    starter: { warehouses: 1, employees: 2, products: 50 },
    growth: { warehouses: 3, employees: 4, products: 150 },
    pro: { warehouses: 7, employees: 10, products: 300 }
  };

  for (const plan of PALMYRA_PLANS) {
    assert.deepEqual(
      {
        warehouses: plan.warehouses,
        employees: plan.employees,
        products: plan.products
      },
      expected[plan.code]
    );
  }
});

test("premium plan features do not leak into lower plans", () => {
  const starter = PALMYRA_PLANS.find((plan) => plan.code === "starter")!;
  const growth = PALMYRA_PLANS.find((plan) => plan.code === "growth")!;
  const pro = PALMYRA_PLANS.find((plan) => plan.code === "pro")!;

  assert.equal(starter.features.some((x) => /compras|transferencias|analítica|soporte prioritario/i.test(x)), false);
  assert.equal(growth.features.some((x) => /analítica avanzada|soporte prioritario/i.test(x)), false);
  assert.equal(growth.features.includes("Compras y recepción"), true);
  assert.equal(growth.features.includes("Transferencias entre almacenes"), true);
  assert.equal(pro.features.includes("Analítica avanzada"), true);
  assert.equal(pro.features.includes("Soporte prioritario"), true);
});
