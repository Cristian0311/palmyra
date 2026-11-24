/**
 * Verificación pre-instalación blindada: tamaño y sha256 de la descarga contra
 * el manifiesto firmado, en las tres superficies (helpers compartidos, archivo
 * en disco para el escritorio y firma del manifiesto).
 *
 * Regla que se prueba: un desajuste NUNCA instala; se reintenta una sola vez y
 * el segundo desajuste deja la versión instalada intacta.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, generateKeyPairSync } from "node:crypto";
import {
  RETRY_MESSAGE,
  REJECTED_MESSAGE,
  downloadVerifiedArtifact,
  verifyArtifactSha256,
  verifyArtifactSize,
  verifyDownloadedArtifact
} from "../../src/services/updates/artifact";
import { verifyArtifactFileAgainstManifest } from "../../src/desktop/mainRuntime";
import { signUpdateManifest, verifyUpdateManifest } from "../../src/services/updates/verify";
import {
  UPDATE_MANIFEST_VERSION,
  type UpdateArtifact,
  type UpdateManifestV1
} from "../../src/services/updates/manifest";

const setupBytes = Buffer.from("PALMYRA-POS-Setup-fixture-de-integridad");
const expectedSha256 = createHash("sha256").update(setupBytes).digest("hex");
const expectedBytes = setupBytes.byteLength;

const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
  "sign",
  "verify"
]);
const publicJwk = await crypto.subtle.exportKey("jwk", keys.publicKey);

function artifact(overrides: Partial<UpdateArtifact> = {}): UpdateArtifact {
  return {
    platform: "windows",
    name: "PALMYRA-POS-Setup.exe",
    url: "https://example.test/releases/PALMYRA-POS-Setup.exe",
    sha256: expectedSha256,
    bytes: expectedBytes,
    ...overrides
  };
}

function withTempFile(bytes: Buffer, run: (filePath: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "palmyra-artifact-"));
  const filePath = path.join(dir, "PALMYRA-POS-Setup.exe");
  try {
    fs.writeFileSync(filePath, bytes);
    run(filePath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function baseManifest(overrides: Partial<UpdateManifestV1> = {}): UpdateManifestV1 {
  return {
    v: UPDATE_MANIFEST_VERSION,
    version: "1.4.0",
    channel: "stable",
    releasedAt: "2026-11-22T00:00:00.000Z",
    rollout: 100,
    artifacts: [artifact()],
    ...overrides
  };
}

// ─── Manifiesto con size/hash correctos pasa ────────────────────────────────

test("un artefacto con size y hash correctos pasa la verificación pre-instalación", () => {
  const check = verifyDownloadedArtifact({
    name: "PALMYRA-POS-Setup.exe",
    expectedBytes,
    expectedSha256,
    actualBytes: expectedBytes,
    actualSha256: expectedSha256
  });
  assert.equal(check.ok, true);
  assert.equal(check.reason, "ok");
  assert.equal(check.message, "");

  withTempFile(setupBytes, (filePath) => {
    const file = verifyArtifactFileAgainstManifest(filePath, artifact());
    assert.equal(file.ok, true);
    assert.equal(file.reason, "ok");
    assert.equal(file.actualBytes, expectedBytes);
    assert.equal(file.actualSha256, expectedSha256);
  });
});

test("un manifiesto firmado con size/hash correctos verifica con su clave", async () => {
  const signed = await signUpdateManifest(baseManifest(), keys.privateKey, "clave-fixture");
  const result = await verifyUpdateManifest(signed, { publicJwk, requireSignature: true });
  assert.equal(result.ok, true);
});

// ─── Hash corrupto falla ────────────────────────────────────────────────────

test("un hash corrupto se rechaza con valores esperados y recibidos", () => {
  const check = verifyDownloadedArtifact({
    name: "PALMYRA-POS-Setup.exe",
    expectedBytes,
    expectedSha256,
    actualBytes: expectedBytes,
    actualSha256: "f".repeat(64)
  });
  assert.equal(check.ok, false);
  assert.equal(check.reason, "hash-mismatch");
  assert.match(check.message, /sha256 esperado/);
  assert.match(check.message, new RegExp(expectedSha256));

  withTempFile(Buffer.from("x".repeat(expectedBytes)), (filePath) => {
    const tampered = artifact();
    const file = verifyArtifactFileAgainstManifest(filePath, tampered);
    assert.equal(file.ok, false);
    assert.equal(file.reason, "hash-mismatch");
    assert.match(file.message, /El instalador no coincide con el manifiesto firmado/);
  });
});

test("el hash corrupto también lo detecta el verificador de un solo campo", () => {
  const check = verifyArtifactSha256({
    name: "PALMYRA-POS-Setup.exe",
    expectedSha256,
    actualSha256: "0".repeat(64)
  });
  assert.equal(check.ok, false);
  assert.equal(check.reason, "hash-mismatch");
});

// ─── Size corrupto falla ────────────────────────────────────────────────────

test("un tamaño corrupto se rechaza antes de calcular el hash", () => {
  const check = verifyDownloadedArtifact({
    name: "PALMYRA-POS-Setup.exe",
    expectedBytes,
    expectedSha256,
    actualBytes: expectedBytes - 1,
    actualSha256: expectedSha256
  });
  assert.equal(check.ok, false);
  assert.equal(check.reason, "size-mismatch");
  assert.match(check.message, /tamaño esperado/);

  withTempFile(setupBytes.subarray(0, expectedBytes - 1), (filePath) => {
    const file = verifyArtifactFileAgainstManifest(filePath, artifact());
    assert.equal(file.ok, false);
    assert.equal(file.reason, "size-mismatch");
    assert.match(file.message, /tamaño del instalador no coincide/);
    assert.equal(file.actualBytes, expectedBytes - 1);
  });
});

test("el tamaño corrupto también lo detecta el verificador de un solo campo", () => {
  const check = verifyArtifactSize({
    name: "PALMYRA-POS-Setup.exe",
    expectedBytes,
    actualBytes: expectedBytes + 1
  });
  assert.equal(check.ok, false);
  assert.equal(check.reason, "size-mismatch");
});

// ─── Firma inválida falla ───────────────────────────────────────────────────

test("una firma inválida del manifiesto se rechaza antes de descargar", async () => {
  const signed = await signUpdateManifest(baseManifest(), keys.privateKey, "clave-fixture");
  const tampered = { ...signed, version: "9.9.9" };
  const result = await verifyUpdateManifest(tampered, { publicJwk, requireSignature: true });
  assert.equal(result.ok, false);
});

test("un artefacto ausente o ilegible nunca se aplica", () => {
  withTempFile(setupBytes, (filePath) => {
    const missing = verifyArtifactFileAgainstManifest(`${filePath}.no-existe`, artifact());
    assert.equal(missing.ok, false);
    assert.equal(missing.reason, "not-found");

    const emptyPath = path.join(path.dirname(filePath), "vacio.exe");
    fs.writeFileSync(emptyPath, Buffer.alloc(0));
    const empty = verifyArtifactFileAgainstManifest(emptyPath, artifact());
    assert.equal(empty.ok, false);
    assert.equal(empty.reason, "not-found");
    assert.match(empty.message, /vacío o no es un archivo/);
  });
});

// ─── Verificación pre-instalación rechaza y NO aplica ───────────────────────

test("la descarga con desajuste se reintenta una vez y la segunda correcta se aplica", async () => {
  const good = { data: setupBytes, attempts: [] as string[] };
  const downloads = [
    { data: Buffer.from("corrupto") },
    { data: setupBytes }
  ];
  const notices: string[] = [];
  const result = await downloadVerifiedArtifact({
    name: "PALMYRA-POS-Setup.exe",
    expectedBytes,
    expectedSha256,
    download: async () => {
      const next = downloads.shift();
      good.attempts.push("download");
      return next ? { data: new Uint8Array(next.data) } : { data: null, error: "sin más descargas" };
    },
    onRetry: (message) => notices.push(message)
  });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  assert.deepEqual(notices, [RETRY_MESSAGE]);
  assert.deepEqual(new Uint8Array(result.data as Uint8Array), new Uint8Array(setupBytes));
  assert.equal(good.attempts.length, 2);
});

test("el segundo desajuste no se aplica: se descarta el archivo y se avisa", async () => {
  let downloads = 0;
  const result = await downloadVerifiedArtifact({
    name: "PALMYRA-POS-Setup.exe",
    expectedBytes,
    expectedSha256,
    download: async () => {
      downloads += 1;
      return { data: new Uint8Array(Buffer.from(`intento-${downloads}-corrupto`)) };
    }
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "size-mismatch");
  assert.equal(result.attempts, 2);
  assert.equal(result.data, null, "un artefacto rechazado nunca se entrega para instalar");
  assert.equal(result.message, REJECTED_MESSAGE);
  assert.equal(downloads, 2);
});

test("un error de transporte no consume el reintento de integridad", async () => {
  const result = await downloadVerifiedArtifact({
    name: "PALMYRA-POS-Setup.exe",
    expectedBytes,
    expectedSha256,
    download: async () => ({ data: null, error: "sin red" })
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "not-available");
  assert.equal(result.attempts, 1);
  assert.equal(result.data, null);
});

// ─── Pipeline: el firmado no sobrevive a un artefacto que cambia ────────────

test("build-update-manifest falla si un artefacto cambió después de firmar", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "palmyra-builder-"));
  try {
    const setupPath = path.join(dir, "PALMYRA-POS-Setup.exe");
    const apkPath = path.join(dir, "PALMYRA-Android.apk");
    fs.writeFileSync(setupPath, Buffer.from("setup-fixture"));
    fs.writeFileSync(apkPath, Buffer.from("apk-fixture"));
    const { privateKey } = generateKeyPairSync("ec", {
      namedCurve: "P-256",
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" }
    });
    const keyPath = path.join(dir, "signing.pem");
    fs.writeFileSync(keyPath, privateKey, "utf8");

    const builder = await import("../../scripts/build-update-manifest.mjs");
    const parsed = builder.parseArgs([
      "--version",
      "1.4.0",
      "--windows",
      setupPath,
      "--android",
      apkPath,
      "--key",
      keyPath,
      "--key-id",
      "fixture",
      "--out",
      path.join(dir, "update-manifest.json")
    ]);
    const result = builder.inspect(parsed.options, {});
    assert.equal(result.signed, true);

    // El artefacto se regenera después de firmar: el hash del manifiesto ya no
    // cubre el archivo final y el pipeline debe fallar, nunca publicar.
    fs.appendFileSync(setupPath, Buffer.from("-regenerado"));

    assert.throws(
      () => builder.writeManifest(result),
      /cambió DESPUÉS de calcular su hash/,
      "un artefacto regenerado tras firmar debe tumbar la escritura del manifiesto"
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Pipeline: latest.yml sin size se rechaza con un comando accionable ─────

test("check-release-assets exige size en latest.yml con comando de parcheo", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "palmyra-check-size-"));
  try {
    fs.writeFileSync(path.join(dir, "PALMYRA-POS-Setup.exe"), Buffer.from("setup"));
    fs.writeFileSync(path.join(dir, "PALMYRA-Android.apk"), Buffer.from("apk"));
    const latest = [
      "version: 1.4.0",
      "files:",
      "  - url: PALMYRA-POS-Setup.exe",
      `    sha512: ${createHash("sha512").update("setup").digest("base64")}`,
      "path: PALMYRA-POS-Setup.exe",
      `sha512: ${createHash("sha512").update("setup").digest("base64")}`,
      "releaseDate: '2026-11-22T00:00:00.000Z'",
      ""
    ].join("\n");
    fs.writeFileSync(path.join(dir, "latest.yml"), latest, "utf8");

    const checker = await import("../../scripts/check-release-assets.mjs");
    const result = checker.checkReleaseAssets({
      dir,
      version: "1.4.0",
      packageVersion: "1.4.0"
    });
    assert.equal(result.ok, false);
    const sizeIssue = result.issues.find((issue: string) => /no declara size/.test(issue));
    assert.ok(sizeIssue, `debe existir un fallo explícito de size; issues=${result.issues.join(" | ")}`);
    assert.match(String(sizeIssue), /--patch-latest-size/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
