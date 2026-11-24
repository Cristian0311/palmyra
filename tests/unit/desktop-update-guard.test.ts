import test from "node:test";
import assert from "node:assert/strict";
import { verifyUpdateManifestForBoot } from "../../src/desktop/mainRuntime";
import { UPDATE_MANIFEST_VERSION, type UpdateManifestV1 } from "../../src/services/updates/manifest";
import { signUpdateManifest } from "../../src/services/updates/verify";

const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
  "sign",
  "verify"
]);
const publicJwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
const otherKeys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
  "sign",
  "verify"
]);

const MANIFEST_URL = "https://example.test/releases/update-manifest.json";

function baseManifest(overrides: Partial<UpdateManifestV1> = {}): UpdateManifestV1 {
  return {
    v: UPDATE_MANIFEST_VERSION,
    version: "1.4.0",
    channel: "stable",
    releasedAt: "2026-11-22T00:00:00.000Z",
    rollout: 100,
    artifacts: [
      {
        platform: "windows",
        name: "PALMYRA-POS-Setup.exe",
        url: "https://example.test/releases/PALMYRA-POS-Setup.exe",
        sha256: "a".repeat(64),
        bytes: 1024
      }
    ],
    ...overrides
  };
}

function fetchJson(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json; charset=utf-8" }
    })) as unknown as typeof fetch;
}

function guardInput(overrides: Record<string, unknown> = {}) {
  return {
    manifestUrl: MANIFEST_URL,
    publicJwk,
    currentVersion: "1.3.5",
    shellVersion: "1.3.5",
    deviceId: "equipo-1",
    fetchImpl: fetchJson(baseManifest()),
    ...overrides
  };
}

test("sin clave pública no descarga ni bloquea: política de compatibilidad", async () => {
  let fetched = false;
  const result = await verifyUpdateManifestForBoot(
    guardInput({
      publicJwk: null,
      fetchImpl: async () => {
        fetched = true;
        return new Response("{}");
      }
    })
  );
  assert.deepEqual(result, { ok: true, reason: "unverified" });
  assert.equal(fetched, false);
});

test("acepta un manifiesto firmado con su clave y una versión nueva", async () => {
  const signed = await signUpdateManifest(baseManifest(), keys.privateKey, "clave-2026");
  const result = await verifyUpdateManifestForBoot(guardInput({ fetchImpl: fetchJson(signed) }));
  assert.deepEqual(result, {
    ok: true,
    reason: "manifesto-verificado",
    version: "1.4.0",
    artifacts: baseManifest().artifacts
  });
});

test("rechaza una firma de otra clave", async () => {
  const signed = await signUpdateManifest(baseManifest(), otherKeys.privateKey, "clave-2026");
  const result = await verifyUpdateManifestForBoot(guardInput({ fetchImpl: fetchJson(signed) }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, "firma-invalida");
});

test("rechaza un manifiesto alterado después de firmarse", async () => {
  const signed = await signUpdateManifest(baseManifest(), keys.privateKey, "clave-2026");
  const tampered = { ...signed, version: "9.9.9" };
  const result = await verifyUpdateManifestForBoot(guardInput({ fetchImpl: fetchJson(tampered) }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, "firma-invalida");
});

test("rechaza un manifiesto sin firma si hay clave configurada", async () => {
  const result = await verifyUpdateManifestForBoot(guardInput());
  assert.equal(result.ok, false);
  assert.equal(result.reason, "firma-invalida");
});

test("una clave pública truncada se rechaza aunque parezca EC", async () => {
  const signed = await signUpdateManifest(baseManifest(), keys.privateKey, "clave-2026");
  const result = await verifyUpdateManifestForBoot(
    guardInput({
      publicJwk: { ...publicJwk, x: (publicJwk.x as string).slice(0, 12) },
      fetchImpl: fetchJson(signed)
    })
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "firma-invalida");
});

test("una firma que no cumple ES256 (64 bytes r||s) se rechaza", async () => {
  const signed = await signUpdateManifest(baseManifest(), keys.privateKey, "clave-2026");
  const truncated = `${(signed.signature as string).slice(0, 60)}`;
  const result = await verifyUpdateManifestForBoot(guardInput({ fetchImpl: fetchJson({ ...signed, signature: truncated }) }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, "firma-invalida");
});

test("un manifiesto con notBefore futuro bloquea el arranque", async () => {
  const signed = await signUpdateManifest(
    baseManifest({ notBefore: "2030-01-01T00:00:00.000Z" }),
    keys.privateKey,
    "clave-2026"
  );
  const result = await verifyUpdateManifestForBoot(guardInput({ fetchImpl: fetchJson(signed) }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, "not-before");
});

test("no descarga si el manifiesto no aplica a este equipo", async () => {
  const signed = await signUpdateManifest(baseManifest({ version: "1.3.5" }), keys.privateKey, "clave-2026");
  const result = await verifyUpdateManifestForBoot(guardInput({ fetchImpl: fetchJson(signed) }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, "up-to-date");
});

test("un fallo de red o un JSON corrupto nunca lanza", async () => {
  const httpError = await verifyUpdateManifestForBoot(
    guardInput({ fetchImpl: fetchJson({}, 500) })
  );
  assert.deepEqual(httpError, { ok: false, reason: "descarga-fallida" });

  const corrupt = await verifyUpdateManifestForBoot(
    guardInput({
      fetchImpl: async () => new Response("<html>no</html>", { status: 200 })
    })
  );
  assert.deepEqual(corrupt, { ok: false, reason: "manifiesto-invalido" });

  const thrown = await verifyUpdateManifestForBoot(
    guardInput({
      fetchImpl: async () => {
        throw new Error("ENOTFOUND");
      }
    })
  );
  assert.deepEqual(thrown, { ok: false, reason: "error" });

  const garbage = await verifyUpdateManifestForBoot(null as never);
  assert.equal(garbage.ok, false);
});
