import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createDeviceKey } from "../../src/services/license/deviceKey";
import {
  createMemoryLicenseStore,
  saveDeviceKey,
  type LicenseKeyValueStore
} from "../../src/services/license/storage";
import { createLicenseRuntime } from "../../src/services/license/runtime";
import type { LicenseFetch, LicenseSnapshot } from "../../src/services/license/runtime";
import { setLicenseReadOnly } from "../../src/services/license/guard";
import {
  activationNeedsSignIn,
  unverifiedMessage
} from "../../src/components/LicenseReadOnlyBanner";

/**
 * Regresión reportada: «al entrar al sistema, online u offline, siempre sale un
 * cartel de licencia sin verificar, da igual si me carga el plan».
 *
 * El aviso ámbar solo es legítimo cuando hay algo que el usuario puede hacer.
 * Un equipo sin lease que todavía no pudo intentar la activación (sin red, sin
 * cliente, espera entre reintentos, servidor saturado) no es un fallo del
 * equipo: se reintenta solo y debe permanecer callado en el POS.
 */

const NOW = Date.parse("2026-11-26T12:00:00.000Z");
const COMPANY_ID = "11111111-1111-4111-8111-111111111111";

const serverKeys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
  "sign",
  "verify"
])) as CryptoKeyPair;
const serverPublicJwk = await crypto.subtle.exportKey("jwk", serverKeys.publicKey);
const deviceKey = await createDeviceKey();

const keyFetch: LicenseFetch = async () =>
  new Response(JSON.stringify({ keyId: "test-key", jwk: serverPublicJwk }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });

async function withNavigator<T>(value: { onLine?: boolean }, run: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  try {
    Object.defineProperty(globalThis, "navigator", { value, configurable: true });
    return await run();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "navigator", descriptor);
    else delete (globalThis as { navigator?: unknown }).navigator;
  }
}

function snapshotWith(overrides: Partial<LicenseSnapshot>): LicenseSnapshot {
  return {
    mode: "unmanaged",
    readOnly: false,
    reason: "lease-missing",
    clockWarning: false,
    lastCheckedAt: NOW,
    keyConfigured: true,
    leasePresent: false,
    offlineVerified: false,
    pendingActivation: true,
    activationSettled: true,
    ...overrides
  };
}

/* ------------------- runtime: el intento nunca ocurrió ------------------- */

test("offline: la activación pendiente se cierra con causa 'offline', no en blanco", async () => {
  setLicenseReadOnly(false);
  const store: LicenseKeyValueStore = createMemoryLicenseStore();
  await saveDeviceKey(store, deviceKey);

  const runtime = createLicenseRuntime({
    store,
    fetchImpl: keyFetch,
    now: () => NOW,
    getClient: () => null,
    storageKeyPrefix: "unverified-notice"
  });

  await withNavigator({ onLine: false }, async () => {
    const snapshot = await runtime.start({ companyId: COMPANY_ID });
    assert.equal(snapshot.mode, "unmanaged");
    assert.equal(snapshot.reason, "lease-missing");
    assert.equal(snapshot.pendingActivation, true, "sigue pendiente: se reintentará sola");
    assert.equal(snapshot.activationSettled, true);
    assert.equal(snapshot.readOnly, false, "nunca se bloquea por no haber intentado");
    assert.equal(snapshot.activationError, "offline", "se distingue de un rechazo real");
  });
  setLicenseReadOnly(false);
});

/* ------------------- aviso: qué causas se callan ------------------- */

test("offline/red/servidor: el cartel de «licencia sin verificar» no aparece", () => {
  for (const activationError of [
    "offline",
    "network",
    "no-client",
    "backoff",
    "no-lease-response",
    "server-rejected:429",
    "server-rejected:500:server_error"
  ]) {
    assert.equal(
      unverifiedMessage(snapshotWith({ activationError })),
      null,
      `${activationError} se reintenta solo y no debe asustar en el POS`
    );
  }
});

test("sin sesión (o sesión rechazada): el aviso existe y manda a iniciar sesión", () => {
  for (const activationError of ["no-session", "server-rejected:401:authentication_required"]) {
    const snapshot = snapshotWith({ activationError });
    const message = unverifiedMessage(snapshot);
    assert.ok(message, activationError);
    assert.match(message as string, /sesión de licencia activa/);
    assert.equal(activationNeedsSignIn(activationError), true, activationError);
  }
});

test("plan rechazado, firma inválida y causa desconocida sí se avisan", () => {
  assert.match(
    unverifiedMessage(snapshotWith({ activationError: "server-rejected:403:permission_denied" })) as string,
    /suscripción no pudo activarse/
  );
  assert.match(
    unverifiedMessage(snapshotWith({ activationError: "signature-invalid" })) as string,
    /no se pudo verificar/
  );
  assert.match(
    unverifiedMessage(snapshotWith({ activationError: "save-failed" })) as string,
    /Licencia sin verificar/
  );
  assert.match(
    unverifiedMessage(snapshotWith({})) as string,
    /Licencia sin verificar/,
    "una causa desconocida se muestra: el silencio tampoco es verdad"
  );
});

test("el aviso respeta el orden: nada mientras la evaluación no termina", () => {
  assert.equal(unverifiedMessage(snapshotWith({ activationError: "no-session", activationSettled: false })), null);
  assert.equal(unverifiedMessage(snapshotWith({ activationError: "no-session", pendingActivation: false })), null);
  assert.equal(
    unverifiedMessage(snapshotWith({ activationError: "no-session", offlineVerified: true })),
    null,
    "lease verificado en disco: la licencia está verificada aunque no haya red"
  );
  assert.equal(
    unverifiedMessage(snapshotWith({ activationError: "no-session", keyConfigured: false })),
    null,
    "sin clave de licencia no hay nada que reclamarle al equipo"
  );
});

/* ------------------- la clave pública debe ser alcanzable ------------------- */

test("el origen sirve la clave pública aunque falte la variable de entorno", () => {
  const server = readFileSync(resolve(import.meta.dirname, "../../server.ts"), "utf8");
  // Causa raíz de producción: la ruta respondía 404 `not_configured` si Render no
  // tenía LEASE_PUBLIC_JWK, así que ningún equipo podía anclar la clave ni emitir
  // un lease. El archivo público del build es el respaldo.
  assert.match(
    server,
    /app\.get\('\/license-public-key\.json'[\s\S]{0,900}license-public-key\.json/,
    "la ruta debe leer el archivo público del build"
  );
});

test("la clave pública publicada tiene la forma que verifica el runtime", () => {
  const raw = readFileSync(resolve(import.meta.dirname, "../../public/license-public-key.json"), "utf8");
  const doc = JSON.parse(raw) as { keyId?: string; jwk?: JsonWebKey };
  assert.ok(doc.keyId, "el runtime guarda el keyId anclado");
  assert.equal(doc.jwk?.kty, "EC");
  assert.equal(doc.jwk?.crv, "P-256");
  assert.ok(doc.jwk?.x && doc.jwk?.y, "coordenadas públicas presentes");
});

/* ------------------- ciclo de vida: el runtime debe arrancar solo ------------------- */

test("el cambio de alcance local se anuncia: el runtime puede arrancar tras el login", async () => {
  const seen: string[] = [];
  const storage = new Map<string, string>();
  const descriptors = {
    window: Object.getOwnPropertyDescriptor(globalThis, "window"),
    localStorage: Object.getOwnPropertyDescriptor(globalThis, "localStorage")
  };
  const dispatchSpy = (event: { type?: string }) => {
    if (event?.type) seen.push(event.type);
  };
  try {
    Object.defineProperty(globalThis, "window", {
      value: { dispatchEvent: dispatchSpy },
      configurable: true
    });
    Object.defineProperty(globalThis, "localStorage", {
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => void storage.set(key, value),
        removeItem: (key: string) => void storage.delete(key)
      },
      configurable: true
    });
    const { setPalmyraLocalScope, clearPalmyraLocalScope, PALMYRA_LOCAL_SCOPE_EVENT } =
      await import("../../src/services/localScope");

    setPalmyraLocalScope("usuario-1", COMPANY_ID);
    assert.deepEqual(seen, [PALMYRA_LOCAL_SCOPE_EVENT], "guardar la empresa avisa");

    clearPalmyraLocalScope();
    assert.equal(seen.length, 2, "cerrar sesión también avisa");
  } finally {
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});

test("el hook reacciona a la sesión nueva y al cambio de alcance local", () => {
  const hook = readFileSync(
    resolve(import.meta.dirname, "../../src/hooks/useLicenseRuntime.ts"),
    "utf8"
  );
  // Sesión Supabase recién creada: fuerza la activación pendiente (antes había
  // que reiniciar la app o esperar el refresco de 12 h).
  assert.match(hook, /onAuthStateChange/, "el runtime debe enterarse del login");
  assert.match(
    hook,
    /onAuthStateChange[\s\S]{0,240}runThrottled\(false, 0, true\)/,
    "el login nuevo debe reintentar la activación de inmediato"
  );
  assert.match(
    hook,
    /forceRenew \? renewLicenseRuntime\(target\) : startLicenseRuntime\(target\)/,
    "el tercer argumento de runThrottled es el forzado de renovación"
  );
  // La empresa se escribe durante el login: el arranque no puede depender del
  // instante en que se montó la interfaz.
  assert.match(hook, /PALMYRA_LOCAL_SCOPE_EVENT/);
  assert.match(hook, /scheduleStartupProbe/, "sin alcance aún se reintenta un rato");
});
