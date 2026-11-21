import test from "node:test";
import assert from "node:assert/strict";

const data = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (key: string) => (data.has(key) ? data.get(key)! : null),
  setItem: (key: string, value: string) => { data.set(key, String(value)); },
  removeItem: (key: string) => { data.delete(key); },
  clear: () => data.clear(),
  key: (index: number) => Array.from(data.keys())[index] ?? null,
  get length() { return data.size; }
};

const { setPalmyraLocalScope } = await import("../../src/services/localScope");
const { cacheSaaSContext } = await import("../../src/services/offlineAuthContext");
const { isCloudBusinessSyncAllowed } = await import("../../src/services/localPlanMode");

const USER = "00000000-0000-4000-8000-000000000001";
const COMPANY = "11111111-1111-4111-8111-111111111111";

function cachePlan(planCode: string) {
  cacheSaaSContext({
    authUserId: USER,
    user: { id: USER, name: "Prueba", email: "test@example.com" } as any,
    companyId: COMPANY,
    company: { id: COMPANY, name: "Prueba", slug: "prueba", account_status: "active", default_currency_code: "CUP" },
    membershipStatus: "active",
    isOwner: true,
    deviceActive: true,
    roleKey: "admin",
    warehouseIds: ["w1"],
    subscription: {
      id: "s1", status: "active", planCode, planName: planCode,
      limits: {}, currentPeriodEnd: null
    }
  } as any);
}

test("Gratis keeps cloud sync enabled for business data", () => {
  setPalmyraLocalScope(USER, COMPANY);
  cachePlan("free");
  assert.equal(isCloudBusinessSyncAllowed(), true);
});

test("paid plans and sessions without a cached plan also keep cloud sync", () => {
  setPalmyraLocalScope(USER, COMPANY);
  cachePlan("growth");
  assert.equal(isCloudBusinessSyncAllowed(), true);

  setPalmyraLocalScope("00000000-0000-4000-8000-000000000099", COMPANY);
  assert.equal(isCloudBusinessSyncAllowed(), true);
});
