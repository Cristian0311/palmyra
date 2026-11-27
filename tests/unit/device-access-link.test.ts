import test from "node:test";
import assert from "node:assert/strict";
import { buildDeviceAccessDeepLink, buildDeviceAccessLink } from "../../src/services/deviceAccess";

const PUBLIC_ORIGIN = "https://palmyracrm.onrender.com";

/** La app instalada sirve su interfaz desde loopback/LAN: hay que simular ese origen. */
function withOrigin(origin: string | undefined, run: () => void): void {
  const previous = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window =
    origin === undefined ? undefined : { location: { origin } };
  try {
    run();
  } finally {
    (globalThis as { window?: unknown }).window = previous;
  }
}

test("el enlace de acceso nunca apunta a loopback: lo comparte otro equipo", () => {
  // Electron sirve en 127.0.0.1:<puerto> y el hub LAN en una IP privada. Si el
  // enlace se arma con ese origen, el empleado ve «127.0.0.1 rechazó la conexión».
  for (const origin of [
    "http://127.0.0.1:10000",
    "http://localhost:5173",
    "http://192.168.10.5:48900",
    "http://10.0.0.9",
    "http://[::1]:10000",
    "capacitor://localhost"
  ]) {
    withOrigin(origin, () => {
      const link = buildDeviceAccessLink("tok 123");
      assert.ok(link.startsWith(`${PUBLIC_ORIGIN}/device-access?token=tok%20123`), origin);
    });
  }
});

test("sin window (arranque fuera del navegador) el enlace sigue siendo público", () => {
  withOrigin(undefined, () => {
    assert.equal(
      buildDeviceAccessLink("abc"),
      `${PUBLIC_ORIGIN}/device-access?token=abc`
    );
  });
});

test("un origen público real se conserva para no romper otros dominios", () => {
  withOrigin("https://pos.marcapropia.com", () => {
    assert.equal(
      buildDeviceAccessLink("abc"),
      "https://pos.marcapropia.com/device-access?token=abc"
    );
  });
});

test("el deep link de la app instalada no depende del origen de la ventana", () => {
  withOrigin("http://127.0.0.1:10000", () => {
    assert.equal(buildDeviceAccessDeepLink("ab c"), "palmyra://device-access?token=ab%20c");
  });
});
