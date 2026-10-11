import test from "node:test";
import assert from "node:assert/strict";
import type { SaaSContext } from "../../src/services/saas";
import { cacheSaaSContext, getCachedSaaSContext } from "../../src/services/offlineAuthContext";
import { getPalmyraLocalScope } from "../../src/services/localScope";
import { rememberOfflineSaaSCredential, verifyOfflineSaaSCredential } from "../../src/services/offlineSaaSAuth";

class MemoryStorage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  key(index: number) { return Array.from(this.values.keys())[index] ?? null; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, String(value)); }
  removeItem(key: string) { this.values.delete(key); }
  clear() { this.values.clear(); }
}

test("offline SaaS login needs the previously verified password and a cached active company", async () => {
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });

  try {
    const context = {
      authUserId: "offline-test-user",
      user: {
        id: "offline-test-user",
        name: "Offline Test",
        email: "offline@example.test",
        role: "admin",
        baseSalary: 0,
        compensationType: "fixed_product",
        salesPercentage: 0,
        permissions: ["pos.access", "cash.open", "cash.close"],
        isActive: true,
        warehouseId: "offline-test-warehouse",
        allowedWarehouseIds: ["offline-test-warehouse"],
        branchId: "offline-test-warehouse",
        allowedBranches: ["offline-test-warehouse"]
      },
      companyId: "offline-test-company",
      company: {
        id: "offline-test-company",
        name: "Offline Test Co.",
        slug: "offline-test-co",
        account_status: "active",
        default_currency_code: "CUP"
      },
      membershipStatus: "active",
      isOwner: true,
      deviceActive: true,
      roleKey: "admin",
      warehouseIds: ["offline-test-warehouse"],
      subscription: null
    } as unknown as SaaSContext;

    cacheSaaSContext(context);
    await rememberOfflineSaaSCredential(context, "Test-Passphrase-938!");
    const storedValues = Array.from({ length: storage.length }, (_, i) => storage.getItem(storage.key(i)!) || "");
    assert.equal(storedValues.some(value => value.includes("Test-Passphrase-938!")), false);

    const wrongPassword = await verifyOfflineSaaSCredential("offline@example.test", "wrong-password");
    assert.equal(wrongPassword, null);

    const restored = await verifyOfflineSaaSCredential("OFFLINE@example.test", "Test-Passphrase-938!");
    assert.equal(restored?.companyId, "offline-test-company");
    assert.equal(restored?.authUserId, "offline-test-user");
    assert.equal(getCachedSaaSContext("offline-test-user")?.companyId, "offline-test-company");
    assert.deepEqual(getPalmyraLocalScope(), {
      userId: "offline-test-user",
      companyId: "offline-test-company",
      offlineSession: true
    });

    // The offline password must not authorize a cached role/company that was
    // altered after the last cloud-verified login.
    const cacheKey = "palmyra_offline_auth_context_v1__offline-test-user";
    const cachedRaw = storage.getItem(cacheKey);
    assert.ok(cachedRaw);
    const tamperedContext = JSON.parse(cachedRaw!);
    tamperedContext.companyId = "attacker-selected-company";
    storage.setItem(cacheKey, JSON.stringify(tamperedContext));
    assert.equal(await verifyOfflineSaaSCredential("offline@example.test", "Test-Passphrase-938!"), null);
  } finally {
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else delete (globalThis as any).localStorage;
  }
});

test("offline SaaS login refuses a cached context for a suspended company", async () => {
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
  try {
    const context = {
      authUserId: "offline-suspended-user",
      user: { id: "offline-suspended-user", name: "Suspended", email: "suspended@example.test" },
      companyId: "offline-suspended-company",
      company: { id: "offline-suspended-company", name: "Suspended Co.", slug: "suspended-co", account_status: "suspended", default_currency_code: "CUP" },
      membershipStatus: "active", isOwner: true, deviceActive: true, roleKey: "admin",
      warehouseIds: ["warehouse-1"], subscription: null
    } as unknown as SaaSContext;
    cacheSaaSContext(context);
    await rememberOfflineSaaSCredential(context, "Another-Test-Passphrase-421!");
    assert.equal(await verifyOfflineSaaSCredential("suspended@example.test", "Another-Test-Passphrase-421!"), null);
  } finally {
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else delete (globalThis as any).localStorage;
  }
});
