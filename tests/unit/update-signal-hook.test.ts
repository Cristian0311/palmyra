/**
 * Regresiones del aviso de actualización por señal del servidor.
 *
 * El aviso debe salir UNA vez por build: ni en cada heartbeat de Realtime, ni
 * al remontar el hook, ni al reiniciar la app (la marca se persiste). Un build
 * nuevo que llega dentro del margen de 60 s se aplaza, no se pierde. El build
 * que ya corre en el equipo nunca avisa.
 *
 * Se prueba la función pura `applyUpdateSignal`; el hook solo la conecta.
 * `localStorage` se simula para no depender del navegador.
 */
import test from "node:test";
import assert from "node:assert/strict";

const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => (storage.has(key) ? (storage.get(key) as string) : null),
    setItem: (key: string, value: string) => { storage.set(key, String(value)); },
    removeItem: (key: string) => { storage.delete(key); }
  }
});

const {
  UPDATE_NOTIFIED_BUILD_STORAGE_KEY,
  UPDATE_SIGNAL_THROTTLE_MS,
  applyUpdateSignal
} = await import("../../src/hooks/useUpdateSignal.ts");

const T0 = Date.parse("2026-11-24T12:00:00.000Z");

test("el build que ya corre y los builds atrasados no avisan", () => {
  assert.equal(applyUpdateSignal({ version: "1.3.5", build_id: "build-abc" }, "build-abc", "1.3.5", T0), false);
  assert.equal(applyUpdateSignal({ version: "1.3.4", build_id: "build-old" }, "build-abc", "1.3.5", T0), false);
  assert.equal(applyUpdateSignal(null, "build-abc", "1.3.5", T0), false);
});

test("un mismo build avisa una sola vez y no consume el turno de otro build", () => {
  const seen: string[] = [];
  const signal = { version: "1.3.6", build_id: "build-sig-1" };
  assert.equal(applyUpdateSignal(signal, "build-abc", "1.3.5", T0), true);
  seen.push(signal.build_id);
  // Heartbeat del mismo INSERT mucho después: no vuelve a avisar.
  assert.equal(applyUpdateSignal(signal, "build-abc", "1.3.5", T0 + 10 * UPDATE_SIGNAL_THROTTLE_MS), false);
  assert.deepEqual(seen, ["build-sig-1"]);
  assert.equal(storage.get(UPDATE_NOTIFIED_BUILD_STORAGE_KEY), "build-sig-1", "el build avisado se persiste");
});

test("un build ya avisado antes de reiniciar la app no repite el aviso", () => {
  // Simula la marca que dejó una sesión anterior (sin estado en memoria).
  storage.set(UPDATE_NOTIFIED_BUILD_STORAGE_KEY, "build-sig-2");
  assert.equal(
    applyUpdateSignal({ version: "1.3.7", build_id: "build-sig-2" }, "build-abc", "1.3.5", T0 + 365 * 24 * 3600_000),
    false,
    "tras reiniciar, el mismo build sigue avisado"
  );
});

test("un build nuevo dentro del margen se aplaza en vez de perderse", () => {
  const T4 = T0 + 10 * 24 * 3600_000;
  assert.equal(applyUpdateSignal({ version: "1.3.8", build_id: "build-sig-4" }, "build-abc", "1.3.5", T4), true);
  // Un segundo build 1 s después cae dentro del margen: no avisa todavía,
  // pero queda pendiente (el mismo build avisa al agotarse el margen).
  assert.equal(
    applyUpdateSignal({ version: "1.3.9", build_id: "build-sig-5" }, "build-abc", "1.3.5", T4 + 1_000),
    false
  );
  assert.equal(
    applyUpdateSignal(
      { version: "1.3.9", build_id: "build-sig-5" },
      "build-abc",
      "1.3.5",
      T4 + UPDATE_SIGNAL_THROTTLE_MS + 2_000
    ),
    true
  );
});
