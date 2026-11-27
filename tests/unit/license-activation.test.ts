import test from "node:test";
import assert from "node:assert/strict";
import { createPublicKey, createPrivateKey, sign, verify } from "node:crypto";
import {
  LICENSE_PUBLIC_KEY_PATH,
  createLicensePublicKeyResolver,
  isPublicLeaseJwk,
  resetLicensePublicKeyCache,
  resolveLicensePublicKey
} from "../../src/services/license/activation";
import {
  generateKeyPairJwks,
  publicKeyFingerprint
} from "../../scripts/license-keygen.mjs";

/**
 * Resolución de la clave pública del lease: precedencia build vs red, caché,
 * saneado de parámetros privados y fallos que nunca lanzan.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

const pair = generateKeyPairJwks();

test("keygen: par ES256 P-256 válido, pública sin parámetros privados y huella estable", () => {
  assert.equal(pair.privateJwk.kty, "EC");
  assert.equal(pair.privateJwk.crv, "P-256");
  assert.equal(typeof pair.privateJwk.d, "string");
  assert.ok(pair.privateJwk.d.length > 0);

  assert.equal(pair.publicJwk.kty, "EC");
  assert.equal(pair.publicJwk.crv, "P-256");
  for (const field of ["d", "dp", "dq", "qi"]) {
    assert.equal(field in pair.publicJwk, false);
  }
  assert.equal(isPublicLeaseJwk(pair.publicJwk), true);

  // El par sirve de verdad: firma con la privada y verifica con la pública.
  const privateKey = createPrivateKey({ key: pair.privateJwk, format: "jwk" });
  const publicKey = createPublicKey({ key: pair.publicJwk, format: "jwk" });
  const payload = Buffer.from("palmyra-lease", "utf8");
  const signature = sign("sha256", payload, privateKey);
  assert.equal(verify("sha256", payload, publicKey, signature), true);

  assert.match(pair.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(publicKeyFingerprint(pair.publicJwk), pair.fingerprint);
});

test("precedencia: la clave del build manda sobre la red", async () => {
  const envJwk = JSON.stringify({ ...pair.publicJwk, kid: "env-kid" });
  let fetchCalls = 0;
  const resolver = createLicensePublicKeyResolver({
    envRaw: envJwk,
    fetchImpl: async () => {
      fetchCalls += 1;
      return jsonResponse({ keyId: "remote-kid", jwk: pair.publicJwk });
    }
  });

  const result = await resolver.resolve();

  assert.equal(result.status, "found");
  if (result.status !== "found") return;
  assert.equal(result.key.source, "env");
  assert.equal(result.key.keyId, "env-kid");
  assert.equal(fetchCalls, 0);
});

test("fallback remoto: lee { keyId, jwk } o un JWK directo y cachea", async () => {
  let fetchCalls = 0;
  const resolver = createLicensePublicKeyResolver({
    envRaw: null,
    fetchImpl: async (input) => {
      assert.equal(input, LICENSE_PUBLIC_KEY_PATH);
      fetchCalls += 1;
      return jsonResponse({ keyId: "remote-kid", jwk: pair.publicJwk });
    }
  });

  const first = await resolver.resolve();
  const second = await resolver.resolve();

  assert.equal(first.status, "found");
  assert.equal(second.status, "found");
  if (first.status === "found") {
    assert.equal(first.key.source, "remote");
    assert.equal(first.key.keyId, "remote-kid");
  }
  assert.equal(fetchCalls, 1);

  const direct = createLicensePublicKeyResolver({
    envRaw: null,
    fetchImpl: async () => jsonResponse(pair.publicJwk)
  });
  const directResult = await direct.resolve();
  assert.equal(directResult.status, "found");
  if (directResult.status === "found") {
    assert.equal(directResult.key.keyId, "");
    assert.equal(directResult.key.source, "remote");
  }
});

test("nunca lanza: red caída es error, 404 o JSON roto es missing", async () => {
  const offline = createLicensePublicKeyResolver({
    envRaw: null,
    bundled: null,
    fetchImpl: async () => {
      throw new TypeError("network down");
    }
  });
  assert.deepEqual(await offline.resolve(), { status: "error" });

  const notFound = createLicensePublicKeyResolver({
    envRaw: null,
    bundled: null,
    fetchImpl: async () => jsonResponse({ error: "not_configured" }, 404)
  });
  assert.deepEqual(await notFound.resolve(), { status: "missing" });

  const broken = createLicensePublicKeyResolver({
    envRaw: null,
    bundled: null,
    fetchImpl: async () => new Response("no-es-json", { status: 200 })
  });
  assert.deepEqual(await broken.resolve(), { status: "missing" });

  const wrongShape = createLicensePublicKeyResolver({
    envRaw: null,
    bundled: null,
    fetchImpl: async () => jsonResponse({ jwk: { kty: "RSA", n: "x", e: "AQAB" } })
  });
  assert.deepEqual(await wrongShape.resolve(), { status: "missing" });

  const badEnv = createLicensePublicKeyResolver({
    envRaw: "{no-json",
    fetchImpl: async () => jsonResponse({ keyId: "remote", jwk: pair.publicJwk })
  });
  const fallback = await badEnv.resolve();
  assert.equal(fallback.status, "found");
  if (fallback.status === "found") assert.equal(fallback.key.source, "remote");
});

test("saneado: un JSON con parámetros privados se reduce a la parte pública", async () => {
  const resolver = createLicensePublicKeyResolver({
    envRaw: null,
    fetchImpl: async () =>
      jsonResponse({ keyId: "remote", jwk: pair.privateJwk })
  });

  const result = await resolver.resolve();
  assert.equal(result.status, "found");
  if (result.status !== "found") return;
  const jwk = result.key.jwk as JsonWebKey & { d?: unknown };
  assert.equal(jwk.d, undefined);
  assert.equal(jwk.x, pair.publicJwk.x);
  assert.equal(jwk.y, pair.publicJwk.y);
});

test("resolveLicensePublicKey con fetch aislado no comparte caché entre llamadas", async () => {
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls += 1;
    return jsonResponse({ keyId: "remote", jwk: pair.publicJwk });
  };

  const first = await resolveLicensePublicKey({ fetchImpl });
  const second = await resolveLicensePublicKey({ fetchImpl });

  assert.equal(first.status, "found");
  assert.equal(second.status, "found");
  assert.equal(fetchCalls, 2);
  // La limpieza de la caché de módulo es segura aunque no se haya usado.
  resetLicensePublicKeyCache();
});
