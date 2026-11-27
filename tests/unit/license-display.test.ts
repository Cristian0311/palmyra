import test from "node:test";
import assert from "node:assert/strict";
import { deriveLicenseDisplay, licenseVerifiedLabel } from "../../src/services/license/licenseDisplay";
import type { LicenseSnapshot } from "../../src/services/license/runtime";

/**
 * Presentación compartida por la burbuja y Configuración › Sistema: una sola
 * derivación para que las dos superficies no puedan contradecirse.
 */

const NOW = Date.parse("2026-11-26T14:32:00.000Z");

function snapshot(overrides: Partial<LicenseSnapshot> = {}): LicenseSnapshot {
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

test("activación concluida sin lease y sin sello: se nombra «Sin licencia»", () => {
  const display = deriveLicenseDisplay(snapshot(), NOW);
  assert.equal(display.label, "Sin licencia");
  assert.equal(display.tone, "warn");
  assert.equal(display.remembered, false);
  assert.equal(display.verifiedLabel, null);
});

test("sello persistido: la verificación con fecha y hora no se pierde", () => {
  const display = deriveLicenseDisplay(
    snapshot({
      lastVerifiedAt: "2026-11-24T09:15:00.000Z",
      lastVerifiedPlan: "growth",
      lastVerifiedPaidThrough: "2026-12-24T00:00:00.000Z"
    }),
    NOW
  );
  assert.equal(display.remembered, true);
  assert.equal(display.label, "Verificada antes");
  assert.equal(display.verifying, false);
  assert.match(display.verifiedLabel ?? "", /Verificada el/);
  assert.match(display.verifiedLabel ?? "", /Caravana/);
});

test("verificación en vuelo: estado neutro, nunca aviso", () => {
  const display = deriveLicenseDisplay(
    snapshot({ pendingActivation: true, activationSettled: false }),
    NOW
  );
  assert.equal(display.verifying, true);
  assert.equal(display.label, "Verificando…");
  assert.equal(display.tone, "idle");
});

test("lease válido: activa y con etiqueta de última verificación", () => {
  const display = deriveLicenseDisplay(
    snapshot({
      mode: "active",
      planCode: "growth",
      leasePresent: true,
      offlineVerified: true,
      pendingActivation: false,
      paidThrough: "2026-12-24T00:00:00.000Z",
      offlineUntil: "2026-12-10T00:00:00.000Z",
      lastVerifiedAt: "2026-11-26T14:30:00.000Z",
      lastVerifiedPlan: "growth"
    }),
    NOW
  );
  assert.equal(display.label, "Activa");
  assert.equal(display.tone, "ok");
  assert.match(display.verifiedLabel ?? "", /Caravana/);
});

test("el sello nombra el plan con el nombre comercial de la nube", () => {
  const pro = licenseVerifiedLabel(
    snapshot({ lastVerifiedAt: "2026-11-26T14:30:00.000Z", lastVerifiedPlan: "pro" })
  );
  assert.match(pro ?? "", /· Ciudadela$/);
  const free = licenseVerifiedLabel(
    snapshot({ lastVerifiedAt: "2026-11-26T14:30:00.000Z", lastVerifiedPlan: "free" })
  );
  assert.match(free ?? "", /· Gratis$/);
});

test("solo lectura manda sobre cualquier otro estado", () => {
  const display = deriveLicenseDisplay(
    snapshot({
      mode: "expired",
      readOnly: true,
      pendingActivation: false,
      lastVerifiedAt: "2026-10-01T10:00:00.000Z"
    }),
    NOW
  );
  assert.equal(display.label, "Vencida");
  assert.equal(display.tone, "bad");
});

test("la etiqueta del sello no inventa plan cuando el lease no lo trajo", () => {
  const label = licenseVerifiedLabel(
    snapshot({ lastVerifiedAt: "2026-11-24T09:15:00.000Z" })
  );
  assert.ok(label?.startsWith("Verificada el "));
  assert.ok(label && !label.includes(" · "));
  assert.equal(licenseVerifiedLabel(snapshot()), null);
});
