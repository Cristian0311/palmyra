import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  compareVersions,
  isNewerVersion,
  parseUpdateManifest,
  rolloutBucket,
  UPDATE_MANIFEST_ERROR_CODES,
  UPDATE_MANIFEST_VERSION,
  UpdateManifestError
} from "../../src/services/updates/manifest";
import type {
  ParseUpdateManifestOptions,
  UpdateArtifact,
  UpdateManifestErrorCode,
  UpdateManifestV1
} from "../../src/services/updates/manifest";
import {
  checkUpdatePublicJwk,
  evaluateUpdate,
  manifestSigningInput,
  signUpdateManifest,
  UPDATE_KEY_CURVE,
  UPDATE_SIGNATURE_ALG,
  verifyUpdateManifest
} from "../../src/services/updates/verify";
import { toBase64Url } from "../../src/services/license/contract";

/** Par real ES256 (ECDSA P-256) generado por WebCrypto, como en producción. */
const signingKeys = await crypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" },
  true,
  ["sign", "verify"]
);
const publicJwk = await crypto.subtle.exportKey("jwk", signingKeys.publicKey);
const otherKeys = await crypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" },
  true,
  ["sign", "verify"]
);
const otherPublicJwk = await crypto.subtle.exportKey("jwk", otherKeys.publicKey);
/** Clave real de otra curva: nunca debe aceptarse. */
const p384Keys = await crypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-384" },
  true,
  ["sign", "verify"]
);
const p384PublicJwk = await crypto.subtle.exportKey("jwk", p384Keys.publicKey);

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
        url: "https://github.com/Cristian0311/palmyra/releases/download/v1.4.0/PALMYRA-POS-Setup.exe",
        sha256: "b".repeat(64),
        bytes: 98765432
      }
    ],
    ...overrides
  };
}

function withArtifact(overrides: Partial<UpdateArtifact>): UpdateManifestV1 {
  const manifest = baseManifest();
  manifest.artifacts = [{ ...manifest.artifacts[0], ...overrides }];
  return manifest;
}

function expectedBucket(seed: string): number {
  return createHash("sha256").update(seed).digest().readUInt32BE(0) % 100;
}

/** Comprueba mensaje en español + código estable de un manifiesto rechazado. */
function expectManifestError(
  label: string,
  input: unknown,
  pattern: RegExp,
  code: UpdateManifestErrorCode,
  options?: ParseUpdateManifestOptions
): void {
  assert.throws(
    () => parseUpdateManifest(input, options),
    (error: unknown) =>
      error instanceof UpdateManifestError &&
      error.code === code &&
      pattern.test((error as Error).message),
    `${label} (esperaba ${code})`
  );
}

test("parsea un manifiesto válido y descarta campos desconocidos", () => {
  const parsed = parseUpdateManifest({
    ...baseManifest({
      notes: "Correcciones",
      notBefore: "2026-11-22T06:00:00.000Z",
      minShellVersion: "1.3.0",
      keyId: "clave-1",
      rollout: 15
    }),
    extra: "ignorado"
  });

  assert.equal(parsed.v, 1);
  assert.equal(parsed.version, "1.4.0");
  assert.equal(parsed.channel, "stable");
  assert.equal(parsed.rollout, 15);
  assert.equal(parsed.notBefore, "2026-11-22T06:00:00.000Z");
  assert.equal(parsed.notes, "Correcciones");
  assert.equal(parsed.minShellVersion, "1.3.0");
  assert.equal(parsed.keyId, "clave-1");
  assert.equal(parsed.artifacts.length, 1);
  assert.equal(parsed.artifacts[0].platform, "windows");
  assert.equal(
    (parsed as unknown as Record<string, unknown>).extra,
    undefined,
    "los campos no previstos no se copian"
  );
});

test("rechaza manifiestos inválidos con mensajes en español y códigos estables", () => {
  const cases: Array<
    [string, unknown, RegExp, UpdateManifestErrorCode, ParseUpdateManifestOptions?]
  > = [
    ["no es objeto", null, /objeto JSON/, "manifest-not-object"],
    ["es un array", [], /objeto JSON/, "manifest-not-object"],
    ["versión de contrato", { ...baseManifest(), v: 2 }, /no soportada/, "manifest-version"],
    ["semver incompleto", baseManifest({ version: "1.4" }), /semver/, "version-invalid"],
    ["semver con ceros", baseManifest({ version: "01.4.0" }), /semver/, "version-invalid"],
    ["semver rc", baseManifest({ version: "1.4.0-rc.1" }), /semver/, "version-invalid"],
    ["canal", baseManifest({ channel: "nightly" as unknown as "stable" }), /Canal inválido/, "channel-invalid"],
    ["fecha", baseManifest({ releasedAt: "ayer" }), /fecha ISO/, "released-at-invalid"],
    ["fecha sin hora", baseManifest({ releasedAt: "2026-11-22" }), /fecha ISO/, "released-at-invalid"],
    [
      "notBefore ilegible",
      baseManifest({ notBefore: "2026-11-23" }),
      /fecha ISO/,
      "not-before-invalid"
    ],
    [
      "notBefore anterior al release",
      baseManifest({ notBefore: "2026-11-21T00:00:00.000Z" }),
      /anterior a releasedAt/,
      "not-before-invalid"
    ],
    [
      "notBefore futuro",
      baseManifest({ notBefore: "2027-01-01T00:00:00.000Z" }),
      /futuro/,
      "not-before-future",
      { now: Date.parse("2026-11-23T00:00:00.000Z") }
    ],
    ["sin artefactos", baseManifest({ artifacts: [] }), /al menos un artefacto/, "artifacts-missing"],
    ["rollout negativo", baseManifest({ rollout: -1 }), /rollout/, "rollout-range"],
    ["rollout excesivo", baseManifest({ rollout: 101 }), /rollout/, "rollout-range"],
    ["rollout decimal", baseManifest({ rollout: 12.5 }), /rollout/, "rollout-range"],
    ["min-shell inválido", baseManifest({ minShellVersion: "1.4" }), /semver/, "min-shell-invalid"],
    [
      "min-shell posterior a la versión",
      baseManifest({ minShellVersion: "1.5.0" }),
      /posterior/,
      "version-not-monotonic"
    ],
    [
      "min-web posterior a la versión",
      baseManifest({ minWebVersion: "2.0.0" }),
      /posterior/,
      "version-not-monotonic"
    ],
    [
      "artefacto no es objeto",
      baseManifest({ artifacts: ["archivo" as unknown as UpdateArtifact] }),
      /objeto/,
      "artifact-shape"
    ],
    [
      "plataforma",
      withArtifact({ platform: "ios" as unknown as "web" }),
      /plataforma inválida/,
      "artifact-platform"
    ],
    [
      "plataforma repetida",
      {
        ...baseManifest(),
        artifacts: [
          { ...baseManifest().artifacts[0] },
          { ...baseManifest().artifacts[0], name: "PALMYRA-POS-Setup-2.exe" }
        ]
      },
      /repite la plataforma/,
      "artifact-duplicate-platform"
    ],
    [
      "nombre con ruta",
      withArtifact({ name: "../PALMYRA-POS-Setup.exe" }),
      /sin rutas/,
      "artifact-name"
    ],
    ["nombre con espacios", withArtifact({ name: "PALMYRA POS.exe" }), /sin rutas/, "artifact-name"],
    ["sha256 corto", withArtifact({ sha256: "abc" }), /sha256/, "artifact-sha256"],
    ["sha256 no hex", withArtifact({ sha256: "z".repeat(64) }), /sha256/, "artifact-sha256"],
    [
      "url http",
      withArtifact({ url: "http://example.com/setup.exe" }),
      /https/,
      "artifact-url-insecure"
    ],
    [
      "url ftp",
      withArtifact({ url: "ftp://example.com/setup.exe" }),
      /https/,
      "artifact-url-insecure"
    ],
    [
      "url con credenciales",
      withArtifact({ url: "https://usuario:clave@example.com/setup.exe" }),
      /credenciales/,
      "artifact-url-insecure"
    ],
    ["url relativa", withArtifact({ url: "/descargas/setup.exe" }), /no es válida/, "artifact-url"],
    [
      "web también exige https",
      withArtifact({ platform: "web", name: "palmyra-web.zip", url: "http://example.com/web.zip" }),
      /https/,
      "artifact-url-insecure"
    ],
    ["bytes cero", withArtifact({ bytes: 0 }), /bytes/, "artifact-bytes"],
    ["bytes negativos", withArtifact({ bytes: -5 }), /bytes/, "artifact-bytes"],
    ["bytes decimales", withArtifact({ bytes: 10.5 }), /bytes/, "artifact-bytes"],
    ["bytes inseguros", withArtifact({ bytes: 2 ** 53 }), /bytes/, "artifact-bytes"],
    ["notas enormes", baseManifest({ notes: "x".repeat(20_001) }), /notes/, "notes-invalid"],
    ["keyId con espacio", baseManifest({ keyId: "clave 2026" }), /keyId/, "key-id-invalid"],
    [
      "firma enorme",
      baseManifest({ signature: "a".repeat(513) }),
      /signature/,
      "signature-invalid"
    ]
  ];

  for (const [label, input, pattern, code, options] of cases) {
    expectManifestError(label, input, pattern, code, options);
  }
});

test("un objeto con getters que lanzan se rechaza como ilegible, nunca propaga", () => {
  const hostile = {};
  Object.defineProperty(hostile, "v", {
    enumerable: true,
    get() {
      throw new Error("boom");
    }
  });
  expectManifestError("getter hostil", hostile, /no se pudo interpretar/, "manifest-unreadable");
});

test("todos los códigos de error son únicos y pertenecen a la lista estable", () => {
  assert.equal(
    new Set(UPDATE_MANIFEST_ERROR_CODES).size,
    UPDATE_MANIFEST_ERROR_CODES.length,
    "no debe haber códigos duplicados"
  );
  for (const code of UPDATE_MANIFEST_ERROR_CODES) {
    assert.match(code, /^[a-z][a-z0-9-]+$/, `código raro: ${code}`);
  }
});

test("notBefore y la versión instalada se validan solo cuando se aporta contexto", () => {
  const future = baseManifest({ notBefore: "2027-01-01T00:00:00.000Z" });
  assert.equal(parseUpdateManifest(future).notBefore, "2027-01-01T00:00:00.000Z", "sin reloj no se juzga");

  assert.throws(
    () => parseUpdateManifest(future, { now: Date.parse("2026-11-23T00:00:00.000Z") }),
    (error: unknown) => error instanceof UpdateManifestError && error.code === "not-before-future"
  );
  assert.doesNotThrow(() =>
    parseUpdateManifest(future, { now: Date.parse("2027-02-01T00:00:00.000Z") })
  );

  assert.throws(
    () => parseUpdateManifest(baseManifest(), { currentVersion: "1.5.0" }),
    (error: unknown) => error instanceof UpdateManifestError && error.code === "version-downgrade"
  );
  assert.doesNotThrow(() => parseUpdateManifest(baseManifest(), { currentVersion: "1.4.0" }));
  assert.doesNotThrow(() => parseUpdateManifest(baseManifest(), { currentVersion: "1.3.9" }));
});

test("normaliza el sha256 a minúsculas", () => {
  const parsed = parseUpdateManifest(withArtifact({ sha256: "AB".repeat(32) }));
  assert.equal(parsed.artifacts[0].sha256, "ab".repeat(32));
});

test("semver numérico: 1.3.10 supera a 1.3.9 y la beta va antes de la estable", () => {
  assert.equal(compareVersions("1.3.10", "1.3.9"), 1);
  assert.equal(compareVersions("1.3.9", "1.3.10"), -1);
  assert.equal(compareVersions("1.10.0", "1.9.9"), 1);
  assert.equal(compareVersions("1.4.0", "1.4.0"), 0);
  assert.equal(compareVersions("1.4.0-beta.2", "1.4.0"), -1);
  assert.equal(compareVersions("1.4.0", "1.4.0-beta.2"), 1);
  assert.equal(compareVersions("1.4.0-beta.1", "1.4.0-beta.2"), -1);
  assert.equal(isNewerVersion("1.3.10", "1.3.9"), true);
  assert.equal(isNewerVersion("1.4.0-beta.1", "1.4.0"), false);
  assert.equal(isNewerVersion("1.4.0", "1.4.0"), false);
  assert.throws(() => compareVersions("1.4", "1.4.0"), UpdateManifestError);
});

test("rolloutBucket es determinista, cae en 0-99 y coincide con sha256 de node:crypto", () => {
  const first = rolloutBucket("device-1", "1.4.0");
  assert.equal(rolloutBucket("device-1", "1.4.0"), first);
  assert.ok(first >= 0 && first < 100, "el bucket debe estar entre 0 y 99");
  assert.equal(first, expectedBucket("device-1|1.4.0"));

  const longId = "equipo-".repeat(20);
  assert.equal(rolloutBucket(longId, "1.4.0"), expectedBucket(`${longId}|1.4.0`));

  // La semilla incluye la versión: no se hereda el bucket de otra release.
  assert.equal(rolloutBucket("device-1", "1.5.0"), expectedBucket("device-1|1.5.0"));
  assert.equal(rolloutBucket("", "1.4.0"), expectedBucket("|1.4.0"), "un id vacío también es determinista");

  const buckets = new Set(
    ["a", "b", "c", "d", "e"].map((deviceId) => rolloutBucket(deviceId, "1.4.0"))
  );
  assert.ok(buckets.size > 1, "equipos distintos deben repartirse");
});

test("evaluar una versión nueva y del canal correcto permite actualizar", () => {
  assert.deepEqual(
    evaluateUpdate({
      manifest: baseManifest(),
      currentVersion: "1.3.5",
      shellVersion: "1.3.5",
      deviceId: "device-1",
      channel: "stable"
    }),
    { allowed: true, reason: "newer" }
  );
});

test("la misma versión está al día y una versión anterior bloquea el retroceso", () => {
  const base = {
    manifest: baseManifest(),
    shellVersion: "1.3.5",
    deviceId: "device-1",
    channel: "stable" as const
  };
  assert.deepEqual(evaluateUpdate({ ...base, currentVersion: "1.4.0" }), {
    allowed: false,
    reason: "up-to-date"
  });
  assert.deepEqual(evaluateUpdate({ ...base, currentVersion: "1.5.0" }), {
    allowed: false,
    reason: "downgrade"
  });
});

test("un manifiesto de otro canal queda bloqueado", () => {
  const beta = baseManifest({ channel: "beta", version: "1.5.0-beta.1" });
  assert.deepEqual(
    evaluateUpdate({
      manifest: beta,
      currentVersion: "1.4.0",
      shellVersion: "1.4.0",
      deviceId: "device-1",
      channel: "stable"
    }),
    { allowed: false, reason: "channel" }
  );

  assert.deepEqual(
    evaluateUpdate({
      manifest: baseManifest({ version: "1.5.0" }),
      currentVersion: "1.4.0",
      shellVersion: "1.4.0",
      deviceId: "device-1",
      channel: "beta"
    }),
    { allowed: false, reason: "channel" }
  );
});

test("notBefore futuro bloquea la instalación hasta la hora indicada", () => {
  const manifest = baseManifest({ notBefore: "2026-12-01T00:00:00.000Z" });
  const base = {
    manifest,
    currentVersion: "1.3.5",
    shellVersion: "1.3.5",
    deviceId: "device-1",
    channel: "stable" as const
  };

  assert.deepEqual(evaluateUpdate({ ...base, now: Date.parse("2026-11-22T12:00:00.000Z") }), {
    allowed: false,
    reason: "not-before"
  });
  assert.deepEqual(evaluateUpdate({ ...base, now: Date.parse("2026-12-01T00:00:00.000Z") }), {
    allowed: true,
    reason: "newer"
  });
});

test("sin deviceId el rollout no es auditable y la evaluación es inválida", () => {
  assert.deepEqual(
    evaluateUpdate({
      manifest: baseManifest(),
      currentVersion: "1.3.5",
      shellVersion: "1.3.5",
      deviceId: "   ",
      channel: "stable"
    }),
    { allowed: false, reason: "invalid" }
  );
});

test("el shell mínimo bloquea clientes viejos y deja pasar a los nuevos", () => {
  const manifest = baseManifest({ version: "1.5.0", minShellVersion: "1.4.0" });
  const base = {
    manifest,
    currentVersion: "1.4.0",
    deviceId: "device-1",
    channel: "stable" as const
  };

  assert.deepEqual(evaluateUpdate({ ...base, shellVersion: "1.3.5" }), {
    allowed: false,
    reason: "shell-too-old"
  });
  assert.deepEqual(evaluateUpdate({ ...base, shellVersion: "1.4.0" }), {
    allowed: true,
    reason: "newer"
  });
});

test("el rollout es estable por equipo y bloquea fuera del porcentaje", () => {
  const deviceId = "device-rollout";
  const bucket = rolloutBucket(deviceId, "1.4.0");
  const base = {
    currentVersion: "1.3.5",
    shellVersion: "1.3.5",
    deviceId,
    channel: "stable" as const
  };

  assert.deepEqual(
    evaluateUpdate({ ...base, manifest: baseManifest({ rollout: bucket }) }),
    { allowed: false, reason: "rollout" },
    "bucket >= rollout queda fuera"
  );
  assert.deepEqual(
    evaluateUpdate({ ...base, manifest: baseManifest({ rollout: bucket + 1 }) }),
    { allowed: true, reason: "newer" },
    "bucket < rollout entra"
  );
  assert.deepEqual(
    evaluateUpdate({ ...base, manifest: baseManifest({ rollout: 0 }) }),
    { allowed: false, reason: "rollout" }
  );
  assert.deepEqual(
    evaluateUpdate({ ...base, manifest: baseManifest({ rollout: 100 }) }),
    { allowed: true, reason: "newer" }
  );
});

test("límites del rollout: 0 no llega a nadie y 100 llega a todos", () => {
  const devices = ["equipo-1", "equipo-2", "equipo-3", "equipo-4", "equipo-5"];
  const base = {
    currentVersion: "1.3.5",
    shellVersion: "1.3.5",
    channel: "stable" as const
  };

  for (const deviceId of devices) {
    // Determinismo: la misma consulta repetida decide igual.
    assert.equal(rolloutBucket(deviceId, "1.4.0"), rolloutBucket(deviceId, "1.4.0"));
    assert.deepEqual(
      evaluateUpdate({ ...base, deviceId, manifest: baseManifest({ rollout: 0 }) }),
      { allowed: false, reason: "rollout" },
      `${deviceId} no debe recibir un rollout 0`
    );
    assert.deepEqual(
      evaluateUpdate({ ...base, deviceId, manifest: baseManifest({ rollout: 100 }) }),
      { allowed: true, reason: "newer" },
      `${deviceId} debe recibir un rollout 100`
    );
  }
});

test("un manifiesto corrupto se evalúa como inválido sin actualizar", () => {
  assert.deepEqual(
    evaluateUpdate({
      manifest: { ...baseManifest(), artifacts: [] },
      currentVersion: "1.3.5",
      shellVersion: "1.3.5",
      deviceId: "device-1",
      channel: "stable"
    }),
    { allowed: false, reason: "invalid" }
  );
  assert.deepEqual(
    evaluateUpdate({
      manifest: baseManifest(),
      currentVersion: "1.3",
      shellVersion: "1.3.5",
      deviceId: "device-1",
      channel: "stable"
    }),
    { allowed: false, reason: "invalid" }
  );
});

test("firma ES256 real: se verifica contra la clave pública y excluye signature del payload", async () => {
  const signed = await signUpdateManifest(baseManifest(), signingKeys.privateKey, "clave-2026");

  assert.equal(signed.keyId, "clave-2026");
  assert.equal(typeof signed.signature, "string");
  assert.ok((signed.signature as string).length > 0);
  assert.deepEqual(await verifyUpdateManifest(signed, { publicJwk, requireSignature: true }), {
    ok: true
  });

  const payload = JSON.parse(manifestSigningInput(signed)) as Record<string, unknown>;
  assert.equal(payload.signature, undefined, "la firma no se firma a sí misma");
  assert.equal(payload.keyId, "clave-2026", "keyId sí forma parte del payload firmado");
});

test("una firma manipulada o de otra clave se rechaza", async () => {
  const signed = await signUpdateManifest(baseManifest(), signingKeys.privateKey, "clave-2026");

  assert.deepEqual(
    await verifyUpdateManifest({ ...signed, version: "9.9.9" }, { publicJwk }),
    { ok: false, reason: "invalid-signature" }
  );
  assert.deepEqual(
    await verifyUpdateManifest({ ...signed, rollout: 100, notes: "alterado" }, { publicJwk }),
    { ok: false, reason: "invalid-signature" }
  );
  assert.deepEqual(
    await verifyUpdateManifest(signed, { publicJwk: otherPublicJwk }),
    { ok: false, reason: "invalid-signature" }
  );
});

test("requireSignature exige firma y los datos corruptos nunca lanzan", async () => {
  const unsigned = baseManifest();

  assert.deepEqual(await verifyUpdateManifest(unsigned, { publicJwk }), { ok: true });
  assert.deepEqual(await verifyUpdateManifest(unsigned, { publicJwk, requireSignature: true }), {
    ok: false,
    reason: "missing-signature"
  });

  assert.deepEqual(await verifyUpdateManifest(null, { publicJwk }), {
    ok: false,
    reason: "invalid-manifest"
  });
  // Firma con caracteres fuera de base64url: se rechaza como firma, no como manifiesto.
  assert.deepEqual(
    await verifyUpdateManifest({ ...unsigned, signature: "%%%no-base64%%%" }, { publicJwk }),
    { ok: false, reason: "invalid-signature" }
  );
  // Firma decodificable pero de 3 bytes: ES256 exige 64 bytes exactos (r||s).
  assert.deepEqual(
    await verifyUpdateManifest({ ...unsigned, signature: "AAAA" }, { publicJwk }),
    { ok: false, reason: "invalid-signature" }
  );
  assert.deepEqual(
    await verifyUpdateManifest(
      { ...unsigned, signature: toBase64Url(new Uint8Array(63)) },
      { publicJwk }
    ),
    { ok: false, reason: "invalid-signature" }
  );
  assert.deepEqual(
    await verifyUpdateManifest(
      { ...unsigned, signature: toBase64Url(new Uint8Array(64)) },
      { publicJwk }
    ),
    { ok: false, reason: "invalid-signature" }
  );
});

test("la clave de verificación exige ES256 y coordenadas P-256 de 32 bytes", async () => {
  assert.deepEqual(checkUpdatePublicJwk(publicJwk), { ok: true });
  assert.deepEqual(checkUpdatePublicJwk(publicJwk, UPDATE_SIGNATURE_ALG), { ok: true });
  assert.equal(UPDATE_SIGNATURE_ALG, "ES256");
  assert.equal(UPDATE_KEY_CURVE, "P-256");

  const invalidKeys: Array<[string, unknown]> = [
    ["sin clave", undefined],
    ["objeto vacío", {}],
    ["kty distinto", { ...publicJwk, kty: "RSA" }],
    ["curva distinta", p384PublicJwk],
    ["x truncada", { ...publicJwk, x: (publicJwk.x as string).slice(0, 20) }],
    ["y con relleno", { ...publicJwk, y: `${publicJwk.y as string}===` }],
    ["con material privado", { ...publicJwk, d: "AAAA" }],
    ["key_ops de firma", { ...publicJwk, key_ops: ["sign"] }],
    ["use de cifrado", { ...publicJwk, use: "enc" }]
  ];
  for (const [label, jwk] of invalidKeys) {
    assert.deepEqual(checkUpdatePublicJwk(jwk), { ok: false, reason: "invalid-key" }, label);
  }

  assert.deepEqual(checkUpdatePublicJwk({ ...publicJwk, alg: "ES384" }), {
    ok: false,
    reason: "unsupported-algorithm"
  });
  assert.deepEqual(checkUpdatePublicJwk(publicJwk, "ES384"), {
    ok: false,
    reason: "unsupported-algorithm"
  });
  assert.deepEqual(checkUpdatePublicJwk(publicJwk, "ES256"), { ok: true });
  assert.deepEqual(checkUpdatePublicJwk({ ...publicJwk, key_ops: ["verify"] }), { ok: true });
});

test("verifyUpdateManifest rechaza claves débiles y algoritmos no permitidos", async () => {
  const signed = await signUpdateManifest(baseManifest(), signingKeys.privateKey, "clave-2026");

  assert.deepEqual(await verifyUpdateManifest(signed, { publicJwk: p384PublicJwk }), {
    ok: false,
    reason: "invalid-key"
  });
  assert.deepEqual(
    await verifyUpdateManifest(signed, {
      publicJwk: { ...publicJwk, x: (publicJwk.x as string).slice(0, 10) }
    }),
    { ok: false, reason: "invalid-key" }
  );
  assert.deepEqual(await verifyUpdateManifest(signed, { publicJwk, algorithm: "ES384" }), {
    ok: false,
    reason: "unsupported-algorithm"
  });
  assert.deepEqual(
    await verifyUpdateManifest(signed, { publicJwk: { ...publicJwk, alg: "RS256" } }),
    { ok: false, reason: "unsupported-algorithm" }
  );
});

test("firmar valida la clave (P-256), el keyId y el propio manifiesto", async () => {
  await assert.rejects(
    signUpdateManifest(baseManifest(), p384Keys.privateKey, "clave-2026"),
    (error: unknown) =>
      error instanceof UpdateManifestError && error.code === "signing-key-invalid"
  );

  await assert.rejects(
    signUpdateManifest(baseManifest({ rollout: 150 }), signingKeys.privateKey, "clave-2026"),
    (error: unknown) => error instanceof UpdateManifestError && error.code === "rollout-range"
  );

  await assert.rejects(
    signUpdateManifest(baseManifest(), signingKeys.privateKey, "clave con espacio"),
    (error: unknown) => error instanceof UpdateManifestError && error.code === "key-id-invalid"
  );

  const signed = await signUpdateManifest(baseManifest({ notBefore: "2026-11-22T06:00:00.000Z" }), signingKeys.privateKey);
  assert.equal(signed.notBefore, "2026-11-22T06:00:00.000Z");
  assert.deepEqual(await verifyUpdateManifest(signed, { publicJwk }), { ok: true });
});
