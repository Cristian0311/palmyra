import assert from "node:assert/strict";
import test from "node:test";
import { isSameConfig, resolveConfigSync, shouldAdoptStoreConfig } from "../../src/lib/formSync";
import type { StoreConfig } from "../../src/types";

const base: StoreConfig = {
  storeName: 'PALMYRA',
  address: 'Calle Principal 123',
  phone: '+53 51234567',
  receiptNotes: '¡Gracias por su compra!',
  darkMode: false,
  manualOfflineSync: false,
};

const clone = (value: StoreConfig): StoreConfig => ({ ...value });

test("isSameConfig treats two fresh references with equal content as equal", () => {
  assert.equal(isSameConfig(base, clone(base)), true);
  assert.equal(isSameConfig(base, { ...base, phone: '+53 59999999' }), false);
});

test("initial hydration adopts the store config even when it equals local defaults", () => {
  assert.equal(shouldAdoptStoreConfig(base, clone(base), null), true);
});

test("company change is adopted while the form has no unsaved edits", () => {
  const other: StoreConfig = { ...base, storeName: 'La Caravana', address: 'Otura 40' };
  assert.equal(shouldAdoptStoreConfig(base, other, clone(base)), true);
});

test("a new store reference with identical content never resets the form", () => {
  const emitted = clone(base);
  assert.equal(shouldAdoptStoreConfig(base, emitted, clone(base)), false);
});

test("an external change is adopted only once and then stops resetting", () => {
  const remote: StoreConfig = { ...base, autoRateThreshold: 7 };
  const first = resolveConfigSync({ synced: clone(base), dirtyBaseline: null }, base, clone(remote));
  assert.equal(first.adopt, true);
  const second = resolveConfigSync(first.snapshot, first.snapshot.synced, clone(remote));
  assert.equal(second.adopt, false);
});

test("unsaved edits survive a pull or realtime event that re-emits the store config", () => {
  const snapshot = { synced: clone(base), dirtyBaseline: null as StoreConfig | null };
  const draft: StoreConfig = { ...base, address: 'Dirección nueva que se está escribiendo' };

  // El usuario ya escribió: local ya no coincide con lo sincronizado.
  const reEmitted = resolveConfigSync(snapshot, draft, clone(base));
  assert.equal(reEmitted.adopt, false, 'no debe pisar la edición sucia');
  assert.deepEqual(reEmitted.snapshot, snapshot);

  // Y tampoco un pull que traiga otro valor del store.
  const pulled = resolveConfigSync(snapshot, draft, { ...clone(base), phone: '+53 50000000' });
  assert.equal(pulled.adopt, false);
});

test("the store returning to the value already shown needs no adoption", () => {
  const snapshot = { synced: clone(base), dirtyBaseline: clone(base) };
  const reverted: StoreConfig = { ...base, phone: '' };
  const decision = resolveConfigSync(snapshot, reverted, clone(base));
  assert.equal(decision.adopt, false, 'el formulario ya muestra exactamente ese valor');
  assert.equal(isSameConfig(reverted, snapshot.synced), false);
});

test("adopting leaves the form clean with no pending edit", () => {
  const remote: StoreConfig = { ...base, storeName: 'Otra empresa' };
  const adopted = resolveConfigSync({ synced: clone(base), dirtyBaseline: null }, base, clone(remote));
  assert.equal(adopted.snapshot.dirtyBaseline, null);
});

test("saving marks the form clean again so later external changes are adopted", () => {
  const snapshot = { synced: clone(base), dirtyBaseline: clone(base) };
  const draft: StoreConfig = { ...base, address: 'Dirección guardada' };
  // El usuario guarda: el store pasa a valer exactamente lo que mostraba el formulario.
  const afterSave = resolveConfigSync(snapshot, draft, clone(draft));
  assert.equal(afterSave.adopt, true);
  assert.equal(afterSave.snapshot.dirtyBaseline, null);

  const remote: StoreConfig = { ...draft, phone: '+53 51111111' };
  const next = resolveConfigSync(afterSave.snapshot, draft, clone(remote));
  assert.equal(next.adopt, true);
});
