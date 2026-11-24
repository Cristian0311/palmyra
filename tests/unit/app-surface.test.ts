import assert from "node:assert/strict";
import test from "node:test";
import {
  canRunPos,
  currentAppSurface,
  describeAppSurface,
  detectAppSurface,
  entryPathForSurface,
  type AppSurface,
} from "../../src/lib/appSurface";

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const ELECTRON_UA = `${CHROME_UA} Electron/33.4.11 PALMYRA/1.3.5`;
const PALMYRA_APP_UA =
  "Mozilla/5.0 (Linux; Android 13; SM-A045M) AppleWebKit/537.36 (KHTML, like Gecko) PALMYRAApp/1.3.5 Mobile Safari/537.36";

test("El shell de escritorio (Electron) se detecta como desktop", () => {
  assert.equal(
    detectAppSurface({ userAgent: ELECTRON_UA, hostname: "palmyracrm.onrender.com" }),
    "desktop"
  );
});

test("Las apps instaladas cargan desde 127.0.0.1 y no se confunden con dev", () => {
  for (const hostname of ["127.0.0.1", "localhost"]) {
    assert.equal(detectAppSurface({ userAgent: ELECTRON_UA, hostname }), "desktop", hostname);
    assert.equal(
      detectAppSurface({ userAgent: CHROME_UA, hostname, isNativeBridge: true }),
      "android-app",
      hostname
    );
    assert.equal(detectAppSurface({ userAgent: PALMYRA_APP_UA, hostname }), "android-app", hostname);
  }
});

test("El desarrollo local entra directo al sistema; solo la web va a descarga", () => {
  assert.equal(entryPathForSurface("dev"), "/");
  assert.equal(entryPathForSurface("desktop"), "/");
  assert.equal(entryPathForSurface("android-app"), "/");
  assert.equal(entryPathForSurface("web-tab"), "/download");
});

test("127.0.0.1 en un navegador es dev y nunca bloquea", () => {
  for (const hostname of ["127.0.0.1", "localhost", "[::1]", "::1", " 127.0.0.1 "]) {
    const surface = detectAppSurface({ userAgent: CHROME_UA, hostname });
    assert.equal(surface, "dev", hostname);
    assert.equal(canRunPos(surface), true, hostname);
  }
});

test("El dominio público de PALMYRA se clasifica como pestaña web", () => {
  for (const hostname of ["palmyracrm.onrender.com", "palmyra.cu", "www.palmyra.app"]) {
    assert.equal(
      detectAppSurface({ userAgent: CHROME_UA, hostname, standalone: false }),
      "web-tab",
      hostname
    );
  }
});

test("display-mode standalone se trata como PWA instalada", () => {
  const surface = detectAppSurface({
    userAgent: CHROME_UA,
    hostname: "palmyracrm.onrender.com",
    standalone: true,
  });
  assert.equal(surface, "pwa");
  assert.equal(canRunPos(surface), true);
});

test("Electron tiene prioridad sobre standalone", () => {
  assert.equal(
    detectAppSurface({
      userAgent: ELECTRON_UA,
      hostname: "palmyracrm.onrender.com",
      standalone: true,
    }),
    "desktop"
  );
});

test("Un usuario normal sin standalone queda en la pestaña web", () => {
  assert.equal(
    detectAppSurface({ userAgent: CHROME_UA, hostname: "palmyracrm.onrender.com" }),
    "web-tab"
  );
});

test("El puente nativo de Android (o su UA) se detecta como android-app", () => {
  assert.equal(
    detectAppSurface({
      userAgent: CHROME_UA,
      hostname: "palmyracrm.onrender.com",
      isNativeBridge: true,
    }),
    "android-app"
  );
  assert.equal(
    detectAppSurface({ userAgent: PALMYRA_APP_UA, hostname: "palmyracrm.onrender.com" }),
    "android-app"
  );
});

test("canRunPos solo bloquea la pestaña del navegador", () => {
  const expected: Record<AppSurface, boolean> = {
    dev: true,
    desktop: true,
    "android-app": true,
    pwa: true,
    "web-tab": false,
  };
  for (const [surface, allowed] of Object.entries(expected) as Array<[AppSurface, boolean]>) {
    assert.equal(canRunPos(surface), allowed, surface);
  }
});

test("El modo dev tiene prioridad sobre cualquier otra señal", () => {
  assert.equal(
    detectAppSurface({
      userAgent: ELECTRON_UA,
      hostname: "palmyracrm.onrender.com",
      standalone: true,
      isNativeBridge: true,
      dev: true,
    }),
    "dev"
  );
});

test("describeAppSurface devuelve etiquetas en español para todas las superficies", () => {
  const surfaces: AppSurface[] = ["dev", "desktop", "android-app", "pwa", "web-tab"];
  for (const surface of surfaces) {
    const label = describeAppSurface(surface);
    assert.equal(typeof label, "string", surface);
    assert.ok(label.trim().length > 0, surface);
  }
  assert.match(describeAppSurface("web-tab"), /navegador/i);
  assert.match(describeAppSurface("desktop"), /escritorio/i);
});

test("currentAppSurface es segura sin window y no bloquea fuera del navegador", () => {
  // En Node no hay window: el helper devuelve "dev" y el POS sigue permitido.
  assert.equal(currentAppSurface(), "dev");
  assert.equal(canRunPos(currentAppSurface()), true);
});
