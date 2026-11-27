/**
 * Avisos del sistema operativo (`src/lib/osAlert.ts`).
 *
 * Cada superficie tiene un canal distinto y ninguno puede prometer el de la otra:
 * el APK usa el puente nativo, la PWA el worker de push y el programa de PC la API
 * `Notification`. Estas pruebas fijan ese orden y, sobre todo, que nunca se lance
 * ni se pida un permiso desde aquí (eso lo hace el aviso de entrada).
 */
import assert from "node:assert/strict";
import test from "node:test";

import { osAlertSupported, publishOsAlert, publishTestAlert } from "../../src/lib/osAlert";

type FakeNotification = {
  permission: NotificationPermission;
  instances: Array<{ title: string; options: NotificationOptions }>;
};

function setWindow(window: Record<string, unknown>): void {
  (globalThis as unknown as { window: unknown }).window = window;
}

function setNavigator(navigator: Record<string, unknown>): void {
  Object.defineProperty(globalThis, "navigator", { value: navigator, configurable: true, writable: true });
}

function installNotification(permission: NotificationPermission): FakeNotification {
  const fake: FakeNotification = { permission, instances: [] };
  function Ctor(title: string, options: NotificationOptions) {
    fake.instances.push({ title, options });
  }
  Object.defineProperty(globalThis, "Notification", {
    value: Object.assign(Ctor, { permission, requestPermission: async () => permission }),
    configurable: true,
    writable: true,
  });
  return fake;
}

function clearEnvironment(): void {
  setWindow({});
  setNavigator({});
  delete (globalThis as unknown as { Notification?: unknown }).Notification;
}

test("sin ninguna API disponible degrada a 'unsupported' sin lanzar", async () => {
  clearEnvironment();
  assert.equal(osAlertSupported(), false);
  assert.equal(await publishOsAlert({ title: "Stock bajo", body: "3 productos" }), "unsupported");
});

test("el APK publica por el puente nativo y respeta su envelope", async () => {
  clearEnvironment();
  const calls: Array<{ title: string; body: string; tag: string }> = [];
  setWindow({
    PALMYRA_NATIVE: {
      showNotification: (title: string, body: string, tag: string) => {
        calls.push({ title, body, tag });
        return JSON.stringify({ ok: true });
      }
    }
  });
  assert.equal(osAlertSupported(), true);
  assert.equal(await publishOsAlert({ title: "Turno cerrado", body: "Caja 1", tag: "shift_closed" }), "sent");
  assert.deepEqual(calls, [{ title: "Turno cerrado", body: "Caja 1", tag: "shift_closed" }]);
});

test("un permiso denegado en el APK se reporta como denied, no como fallo", async () => {
  clearEnvironment();
  setWindow({ PALMYRA_NATIVE: { showNotification: () => JSON.stringify({ ok: false, code: "permission_denied" }) } });
  assert.equal(await publishOsAlert({ title: "Aviso", body: "cuerpo" }), "denied");
});

test("una respuesta ilegible del puente nunca rompe el aviso interno", async () => {
  clearEnvironment();
  setWindow({ PALMYRA_NATIVE: { showNotification: () => "<no json>" } });
  assert.equal(await publishOsAlert({ title: "Aviso", body: "cuerpo" }), "failed");
  setWindow({ PALMYRA_NATIVE: { showNotification: () => { throw new Error("puente caído"); } } });
  assert.equal(await publishOsAlert({ title: "Aviso", body: "cuerpo" }), "failed");
});

test("sin permiso concedido no se pide: queda en denied", async () => {
  clearEnvironment();
  installNotification("default");
  setNavigator({});
  assert.equal(await publishOsAlert({ title: "Aviso", body: "cuerpo" }), "denied");
});

test("el programa de PC usa la API Notification con la tag del aviso", async () => {
  clearEnvironment();
  const fake = installNotification("granted");
  setNavigator({});
  assert.equal(await publishOsAlert({ title: "Actualización lista", body: "1.3.19", tag: "update_available" }), "sent");
  assert.equal(fake.instances.length, 1);
  assert.equal(fake.instances[0].title, "Actualización lista");
  assert.equal(fake.instances[0].options.tag, "update_available");
  assert.equal(fake.instances[0].options.icon, "/pwa-192.png");
});

test("la PWA prefiere el worker de push para que el clic abra la ruta", async () => {
  clearEnvironment();
  const fake = installNotification("granted");
  const shown: Array<{ title: string; options: NotificationOptions & { data?: { url?: string } } }> = [];
  const registration = { showNotification: (title: string, options: NotificationOptions) => { shown.push({ title, options }); } };
  setNavigator({ serviceWorker: { getRegistration: async () => registration } });
  assert.equal(await publishOsAlert({ title: "Tasa movida", body: "USD 2,5", tag: "rate", url: "/rates" }), "sent");
  assert.equal(shown.length, 1);
  assert.equal(shown[0].options.data?.url, "/rates");
  assert.equal(fake.instances.length, 0);
});

test("el worker roto cae a la API directa en vez de perder el aviso", async () => {
  clearEnvironment();
  const fake = installNotification("granted");
  setNavigator({ serviceWorker: { getRegistration: async () => { throw new Error("worker sin control"); } } });
  assert.equal(await publishOsAlert({ title: "Aviso", body: "cuerpo", tag: "x" }), "sent");
  assert.equal(fake.instances.length, 1);
});

test("el aviso de prueba usa una tag propia y título reconocible", async () => {
  clearEnvironment();
  const fake = installNotification("granted");
  setNavigator({});
  assert.equal(await publishTestAlert(), "sent");
  assert.match(fake.instances[0].title, /PALMYRA/);
  assert.equal(fake.instances[0].options.tag, "palmyra-test");
});

test("los textos largos se recortan y una tag vacía cae al grupo por defecto", async () => {
  clearEnvironment();
  const calls: Array<{ title: string; body: string; tag: string }> = [];
  setWindow({
    PALMYRA_NATIVE: {
      showNotification: (title: string, body: string, tag: string) => {
        calls.push({ title, body, tag });
        return JSON.stringify({ ok: true });
      }
    }
  });
  await publishOsAlert({ title: "x".repeat(500), body: "y".repeat(5000), tag: " ".repeat(80) });
  assert.equal(calls[0].title.length, 90);
  assert.equal(calls[0].body.length, 400);
  assert.equal(calls[0].tag, "palmyra-notice");
  // Un título vacío nunca viaja: el sistema lo mostraría como un aviso sin nombre.
  await publishOsAlert({ title: "   ", body: "" });
  assert.equal(calls[1].title, "PALMYRA");
});
