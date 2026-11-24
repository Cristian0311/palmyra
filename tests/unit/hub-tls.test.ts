import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHubNodeServer } from "../../src/services/lanHub/nodeServer";
import type { HubHandler } from "../../src/services/lanHub/handler";
import type { HubRequest, HubResponse } from "../../src/services/lanHub/protocol";
import { createPinnedFetch, ensureHubTls, normalizeFingerprint } from "../../src/services/lanHub/tls";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "palmyra-hub-tls-"));
}

/** Handler mínimo: no toca SQLite, solo devuelve lo que recibió. */
function fakeHandler(): HubHandler {
  const handler = async (request: HubRequest): Promise<HubResponse> => {
    const pathname = new URL(request.path, "http://hub.local").pathname;
    return {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        ok: true,
        path: pathname,
        method: request.method,
        body: request.bodyText,
        accept: request.headers.accept ?? ""
      })
    };
  };
  return Object.assign(handler, {
    createPairingSession: () => ({ code: "00000000", expiresAt: "" }),
    currentPairingSession: () => null
  }) as HubHandler;
}

/** GET con la verificación de CA por defecto: un autofirmado debe fallar. */
function strictGet(url: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const request = https.get(url, { rejectUnauthorized: true }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on("error", reject);
  });
}

test("ensureHubTls genera un certificado reutilizable con huella estable", () => {
  const dir = tempDir();
  try {
    const first = ensureHubTls(dir);
    assert.match(first.certPem, /^-----BEGIN CERTIFICATE-----/);
    assert.match(first.keyPem, /^-----BEGIN PRIVATE KEY-----/);
    assert.match(first.fingerprint, /^[0-9a-f]{64}$/);

    const second = ensureHubTls(dir);
    assert.equal(second.fingerprint, first.fingerprint);
    assert.equal(second.certPem, first.certPem);

    // El material persistido está en la carpeta propia y la huella es la del DER.
    const stored = fs.readFileSync(path.join(dir, "hub-tls", "hub-tls.json"), "utf8");
    assert.match(stored, /"fingerprint": "[0-9a-f]{64}"/);
    assert.match(stored, /"keyPem": "-----BEGIN PRIVATE KEY-----/);
    const raw = new crypto.X509Certificate(first.certPem).raw;
    assert.equal(crypto.createHash("sha256").update(raw).digest("hex"), first.fingerprint);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureHubTls regenera cuando al certificado le quedan menos de 7 días", () => {
  const dir = tempDir();
  try {
    const first = ensureHubTls(dir);
    const almostExpired = Date.now() + 820 * 24 * 60 * 60 * 1000;
    const renewed = ensureHubTls(dir, { now: almostExpired });
    assert.match(renewed.fingerprint, /^[0-9a-f]{64}$/);
    assert.notEqual(renewed.fingerprint, first.fingerprint);
    const cert = new crypto.X509Certificate(renewed.certPem);
    assert.ok(new Date(cert.validToDate).getTime() > almostExpired);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureHubTls regenera si el archivo guardado está corrupto o no le corresponde la clave", () => {
  const dir = tempDir();
  try {
    const first = ensureHubTls(dir);
    const file = path.join(dir, "hub-tls", "hub-tls.json");
    fs.writeFileSync(file, "{ no es json");

    const second = ensureHubTls(dir);
    assert.match(second.fingerprint, /^[0-9a-f]{64}$/);
    assert.notEqual(second.fingerprint, first.fingerprint);

    // Certificado válido con una clave de otro par: debe regenerarse.
    const stored = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, string>;
    const other = crypto.generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" }
    });
    stored.keyPem = other.privateKey;
    fs.writeFileSync(file, JSON.stringify(stored));
    const third = ensureHubTls(dir);
    assert.notEqual(third.fingerprint, second.fingerprint);
    const cert = new crypto.X509Certificate(third.certPem);
    assert.ok(cert.checkHost("localhost", { subject: "default" }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("el certificado cubre localhost, 127.0.0.1, ::1 y el CN del hub", () => {
  const dir = tempDir();
  try {
    const { certPem } = ensureHubTls(dir);
    const cert = new crypto.X509Certificate(certPem);
    assert.equal(cert.subject, cert.issuer);
    assert.match(cert.subject, /CN=palmyra-hub\.local/);
    assert.ok(cert.checkIP("127.0.0.1"));
    assert.ok(cert.checkIP("::1"));
    assert.ok(cert.checkHost("localhost", { subject: "default" }));
    assert.ok(cert.checkHost("palmyra-hub.local", { subject: "default" }));

    const dailyMs = 24 * 60 * 60 * 1000;
    const days = (new Date(cert.validToDate).getTime() - new Date(cert.validFromDate).getTime()) / dailyMs;
    assert.ok(days > 800 && days < 850, `vigencia inesperada: ${days} días`);
    assert.match(cert.publicKey.asymmetricKeyType ?? "", /ec/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("normalizeFingerprint acepta formato humano y rechaza longitudes erróneas", () => {
  const compact = "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899";
  const colon = compact.toUpperCase().replace(/(..)(?=.)/g, "$1:");
  assert.equal(colon.length, 95);
  assert.equal(normalizeFingerprint(colon), compact);
  assert.equal(normalizeFingerprint(`${compact.slice(0, 32)} ${compact.slice(32)}`), compact);
  assert.equal(normalizeFingerprint(compact), compact);
  assert.equal(normalizeFingerprint(compact.slice(0, 62)), "");
  assert.equal(normalizeFingerprint(`${compact}00`), "");
  assert.equal(normalizeFingerprint("z".repeat(64)), "");
  assert.equal(normalizeFingerprint(undefined), "");
  assert.equal(normalizeFingerprint(12345), "");
});

test("servidor HTTPS real: el pin correcto funciona y el pin erróneo falla", async () => {
  const dir = tempDir();
  const material = ensureHubTls(dir);
  const server = await createHubNodeServer({
    handler: fakeHandler(),
    port: 0,
    tls: material
  });
  try {
    assert.match(server.url, /^https:\/\//);
    assert.equal(server.fingerprint, material.fingerprint);

    const pinned = createPinnedFetch(material.fingerprint);
    const response = await pinned(`${server.url}/lan/v1/health`, {
      method: "GET",
      headers: { accept: "application/json" }
    });
    assert.equal(response.status, 200);
    const payload = (await response.json()) as Record<string, unknown>;
    assert.equal(payload.ok, true);
    assert.equal(payload.path, "/lan/v1/health");
    assert.equal(payload.accept, "application/json");

    const posted = await pinned(`${server.url}/lan/v1/ops`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ping: true })
    });
    assert.equal(posted.status, 200);
    const postedPayload = (await posted.json()) as Record<string, unknown>;
    assert.equal(postedPayload.method, "POST");
    assert.equal(postedPayload.body, JSON.stringify({ ping: true }));

    // Pin de otra longitud pero válido: el certificado del par no coincide.
    const wrongPin = createPinnedFetch("0".repeat(64));
    await assert.rejects(
      () => wrongPin(`${server.url}/lan/v1/health`),
      /huella TLS del hub LAN no coincide/i
    );

    // Un fetch normal (CA del sistema) rechaza el certificado autofirmado.
    await assert.rejects(() => strictGet(`${server.url}/lan/v1/health`), /self.signed|certificate|unable to verify/i);

    // La huella se puede pegar con separadores.
    const humanPin = material.fingerprint.toUpperCase().replace(/(..)(?=.)/g, "$1:");
    assert.equal(normalizeFingerprint(humanPin), material.fingerprint);
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("createPinnedFetch rechaza http y huellas inválidas", () => {
  assert.throws(() => createPinnedFetch("no-es-hex"), /Huella TLS/i);
  const pinned = createPinnedFetch("a".repeat(64));
  return assert.rejects(() => pinned("http://127.0.0.1:1/health"), /exige https/i);
});
