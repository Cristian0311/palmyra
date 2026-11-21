import test from "node:test";
import assert from "node:assert/strict";

type Store = Map<string, any>;

function createLocalStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => (data.has(key) ? data.get(key)! : null),
    setItem: (key: string, value: string) => { data.set(key, String(value)); },
    removeItem: (key: string) => { data.delete(key); },
    clear: () => data.clear(),
    key: (index: number) => Array.from(data.keys())[index] ?? null,
    get length() { return data.size; }
  };
}

/**
 * Minimal in-memory IndexedDB used only to prove scope isolation and the
 * recovery-over-stale-record precedence. It models the subset the storage
 * adapter uses.
 */
function createFakeIndexedDb() {
  const databases = new Map<string, Store>();
  const state = { failWrites: false, failOpens: false };

  class FakeTransaction {
    oncomplete: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    error: any = null;
    constructor(private data: Store, private mode: string) {}
    objectStore(_name: string) {
      return {
        get: (key: string) => {
          const value = this.data.has(key) ? this.data.get(key) : undefined;
          const req: any = { result: undefined };
          queueMicrotask(() => {
            req.result = value;
            req.onsuccess?.();
          });
          return req;
        },
        put: (value: any, key: string) => {
          if (state.failWrites) {
            queueMicrotask(() => {
              this.error = new Error("QuotaExceededError");
              this.onerror?.();
            });
            return;
          }
          this.data.set(key, value);
          queueMicrotask(() => this.oncomplete?.());
        },
        delete: (key: string) => {
          this.data.delete(key);
          queueMicrotask(() => this.oncomplete?.());
        }
      };
    }
  }

  class FakeDb {
    objectStoreNames: { contains: (name: string) => boolean };
    onversionchange: (() => void) | null = null;
    constructor(public name: string, private storeName: string) {
      this.objectStoreNames = { contains: () => true };
    }
    close() {}
    transaction(_store: string, mode: string) {
      const data = databases.get(this.name) || new Map();
      databases.set(this.name, data);
      return new FakeTransaction(data, mode);
    }
  }

  const indexedDB = {
    open(name: string) {
      const req: any = { result: null, error: null };
      req.onupgradeneeded = null;
      req.onsuccess = null;
      req.onerror = null;
      req.onblocked = null;
      queueMicrotask(() => {
        if (state.failOpens) {
          req.error = new Error("Open failed");
          req.onerror?.();
          return;
        }
        req.result = new FakeDb(name, "state");
        req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    }
  };

  return { indexedDB, state, databases };
}

function installGlobals(local: ReturnType<typeof createLocalStorage>, idb: any) {
  (globalThis as any).localStorage = local;
  (globalThis as any).window = {
    dispatchEvent: (event: any) => { (globalThis as any).lastDispatchedEvent = event; }
  };
  (globalThis as any).CustomEvent = class CustomEvent {
    type: string;
    detail: any;
    constructor(type: string, init?: { detail?: any }) { this.type = type; this.detail = init?.detail; }
  };
  (globalThis as any).indexedDB = idb;
}

const local = createLocalStorage();
const fakeIdb = createFakeIndexedDb();
installGlobals(local, fakeIdb.indexedDB);

const { setPalmyraLocalScope, getPalmyraLocalScopeKey } = await import("../../src/services/localScope");
const { localStateStorage, flushLocalStateStorage, clearLocalStateStorage } = await import("../../src/services/localStateStorage");

const USER_A = "00000000-0000-4000-8000-00000000000a";
const USER_B = "00000000-0000-4000-8000-00000000000b";
const COMPANY = "11111111-1111-4111-8111-111111111111";

test("writes are pinned to the account captured at call time", async () => {
  setPalmyraLocalScope(USER_A, COMPANY);
  const scopeA = getPalmyraLocalScopeKey();
  const pendingA = localStateStorage.setItem("zustand", "state-A");

  // Session switches before the previous write resolves.
  setPalmyraLocalScope(USER_B, COMPANY);
  const pendingB = localStateStorage.setItem("zustand", "state-B");

  await Promise.all([pendingA, pendingB]);

  assert.equal(await localStateStorage.getItem("zustand"), "state-B");
  setPalmyraLocalScope(USER_A, COMPANY);
  assert.equal(await localStateStorage.getItem("zustand"), "state-A");
  assert.equal(scopeA, USER_A + "__" + COMPANY);
});

test("a failed IndexedDB write keeps a recovery snapshot that wins over the stale record", async () => {
  setPalmyraLocalScope(USER_A, COMPANY);
  await localStateStorage.setItem("zustand", "committed-A");

  fakeIdb.state.failWrites = true;
  await localStateStorage.setItem("zustand", "newer-A");
  fakeIdb.state.failWrites = false;

  // The in-memory DB still holds "committed-A"; the recovery record must win.
  assert.equal(await localStateStorage.getItem("zustand"), "newer-A");
  assert.equal(
    local.getItem("palmyra-local-state-recovery__" + USER_A + "__" + COMPANY),
    "newer-A"
  );

  // A later successful write clears the recovery record.
  await localStateStorage.setItem("zustand", "final-A");
  assert.equal(local.getItem("palmyra-local-state-recovery__" + USER_A + "__" + COMPANY), null);
  assert.equal(await localStateStorage.getItem("zustand"), "final-A");
});

test("total storage failure surfaces an actionable error instead of silently losing the sale", async () => {
  setPalmyraLocalScope(USER_A, COMPANY);
  fakeIdb.state.failWrites = true;
  const originalSetItem = local.setItem;
  local.setItem = () => { throw new Error("QuotaExceededError"); };

  try {
    await assert.rejects(
      () => localStateStorage.setItem("zustand", "cannot-save"),
      /No se pudo guardar en este dispositivo/
    );
    await assert.rejects(() => flushLocalStateStorage(), /No se pudo guardar en este dispositivo/);
    assert.equal((globalThis as any).lastDispatchedEvent?.type, "palmyra:storage-warning");
  } finally {
    local.setItem = originalSetItem;
    fakeIdb.state.failWrites = false;
  }

  // Recovering afterwards clears the pending error state.
  await localStateStorage.setItem("zustand", "saved-again");
  await flushLocalStateStorage();
});

test("clearing one account never removes another account's local state", async () => {
  setPalmyraLocalScope(USER_A, COMPANY);
  await localStateStorage.setItem("zustand", "keep-A");
  setPalmyraLocalScope(USER_B, COMPANY);
  await localStateStorage.setItem("zustand", "keep-B");

  await clearLocalStateStorage();
  assert.equal(await localStateStorage.getItem("zustand"), null);

  setPalmyraLocalScope(USER_A, COMPANY);
  assert.equal(await localStateStorage.getItem("zustand"), "keep-A");
});
