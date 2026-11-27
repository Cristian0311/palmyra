import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Guarda de deriva: la clave pública embebida en el bundle
 * (`src/services/license/lease-public-key.json`) debe ser exactamente la que se
 * publica en `public/license-public-key.json`. Si se rota la clave del servidor
 * y solo se actualiza una de las dos, el resolver preferiría la remota al haber
 * red, pero un equipo offline quedaría con una clave obsoleta: esta prueba lo
 * detecta en los gates.
 */

function readJson(relative: string): unknown {
  return JSON.parse(readFileSync(new URL(relative, import.meta.url), "utf8"));
}

test("la clave embebida es idéntica a la publicada en public/", () => {
  const bundled = readJson("../../src/services/license/lease-public-key.json") as {
    keyId?: string;
    jwk?: Record<string, unknown>;
  };
  const published = readJson("../../public/license-public-key.json") as {
    keyId?: string;
    jwk?: Record<string, unknown>;
  };

  assert.equal(bundled.keyId, published.keyId);
  assert.deepEqual(bundled.jwk, published.jwk);
  assert.equal(bundled.jwk?.kty, "EC");
  assert.equal(bundled.jwk?.crv, "P-256");
  // Nunca debe filtrarse la mitad privada (d) en un archivo del cliente.
  assert.equal(bundled.jwk?.d, undefined);
  assert.equal(published.jwk?.d, undefined);
});

test("el resolver usa la clave embebida cuando no hay env, pin ni red", async () => {
  const { createLicensePublicKeyResolver } = await import("../../src/services/license/activation");
  const resolver = createLicensePublicKeyResolver({
    envRaw: null,
    fetchImpl: async () => new Response("{}", { status: 404 })
  });
  const result = await resolver.resolve();
  assert.equal(result.status, "found");
  if (result.status === "found") {
    assert.equal(result.key.source, "bundled");
    assert.equal(result.key.keyId, "palmyra-lease-2026-11");
  }
});
