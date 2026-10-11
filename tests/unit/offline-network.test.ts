import test from "node:test";
import assert from "node:assert/strict";
import { isTransientNetworkError } from "../../src/services/offlineNetwork";

test("recognizes browser transport failures even when navigator.onLine is stale", () => {
  assert.equal(isTransientNetworkError(new TypeError("Failed to fetch")), true);
  assert.equal(isTransientNetworkError({ name: "AbortError", message: "signal is aborted without reason" }), true);
  assert.equal(isTransientNetworkError({ message: "ERR_INTERNET_DISCONNECTED" }), true);
  assert.equal(isTransientNetworkError({ message: "request timed out" }), true);
});

test("does not mistake ordinary application and authorization errors for network failures", () => {
  assert.equal(isTransientNetworkError(new Error("Debes iniciar sesión para acceder a la empresa.")), false);
  assert.equal(isTransientNetworkError({ code: "42501", message: "permission denied for table sales" }), false);
  assert.equal(isTransientNetworkError(null), false);
});
