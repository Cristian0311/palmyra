import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

// El paquete es ESM y el módulo es CommonJS puro (sin electron ni PowerShell).
const requireCjs = createRequire(import.meta.url);
const {
  SIGNATURE_PS_SCRIPT,
  VERSION_PS_SCRIPT,
  parseAuthenticodeJson,
  parseProductVersion,
  compareLooseVersions,
  normalizeThumbprint,
  evaluateOfflineInstaller
} = requireCjs("../../electron/offline-update.cjs");

const THUMBPRINT = "A1B2C3D4E5F60718293A4B5C6D7E8F9012345678";

test("parseAuthenticodeJson lee la salida de ConvertTo-Json", () => {
  const raw = JSON.stringify({
    Status: "Valid",
    Subject: "",
    Thumbprint: "",
    SignerCertificate: {
      Subject: "CN=PALMYRA POS, O=Palmyra, C=CU",
      Thumbprint: THUMBPRINT
    }
  });
  assert.deepEqual(parseAuthenticodeJson(raw), {
    status: "Valid",
    subject: "CN=PALMYRA POS, O=Palmyra, C=CU",
    thumbprint: THUMBPRINT
  });
});

test("parseAuthenticodeJson tolera BOM y mayúsculas distintas", () => {
  const raw = `\uFEFF${JSON.stringify({
    status: "Valid",
    signercertificate: { subject: "CN=Palmyra", thumbprint: THUMBPRINT }
  })}`;
  const parsed = parseAuthenticodeJson(raw);
  assert.equal(parsed.status, "Valid");
  assert.equal(parsed.subject, "CN=Palmyra");
  assert.equal(parsed.thumbprint, THUMBPRINT);
});

test("parseAuthenticodeJson tolera un certificado nulo", () => {
  const raw = JSON.stringify({ Status: "NotSigned", SignerCertificate: null });
  assert.deepEqual(parseAuthenticodeJson(raw), { status: "NotSigned", subject: "", thumbprint: "" });
});

test("parseAuthenticodeJson acepta la primera entrada de una lista", () => {
  const raw = JSON.stringify([
    { Status: "Valid", SignerCertificate: { Subject: "CN=A", Thumbprint: THUMBPRINT } }
  ]);
  assert.equal(parseAuthenticodeJson(raw).status, "Valid");
});

test("parseAuthenticodeJson rechaza basura", () => {
  assert.equal(parseAuthenticodeJson(""), null);
  assert.equal(parseAuthenticodeJson("no es json"), null);
  assert.equal(parseAuthenticodeJson("null"), null);
  assert.equal(parseAuthenticodeJson("[]"), null);
  assert.equal(parseAuthenticodeJson(JSON.stringify({ Other: 1 })), null);
  assert.equal(parseAuthenticodeJson(null), null);
  assert.equal(parseAuthenticodeJson(undefined), null);
});

test("parseProductVersion acepta 3 o 4 componentes numéricos", () => {
  assert.equal(parseProductVersion("1.3.6"), "1.3.6");
  assert.equal(parseProductVersion("1.3.6.0"), "1.3.6");
  assert.equal(parseProductVersion("  \uFEFF1.10.2.7\r\n"), "1.10.2");
  assert.equal(parseProductVersion("2.0.0"), "2.0.0");
});

test("parseProductVersion rechaza texto no numérico o incompleto", () => {
  assert.equal(parseProductVersion(""), null);
  assert.equal(parseProductVersion("   "), null);
  assert.equal(parseProductVersion("1.2"), null);
  assert.equal(parseProductVersion("v1.3.6"), null);
  assert.equal(parseProductVersion("1.3.6-beta"), null);
  assert.equal(parseProductVersion("1.3.6.0.1"), null);
  assert.equal(parseProductVersion("abc"), null);
  assert.equal(parseProductVersion(null), null);
});

test("compareLooseVersions compara numéricamente hasta 4 componentes", () => {
  assert.equal(compareLooseVersions("1.3.6", "1.3.5"), 1);
  assert.equal(compareLooseVersions("1.3.5", "1.3.6"), -1);
  assert.equal(compareLooseVersions("1.3.5.1", "1.3.5"), 1);
  assert.equal(compareLooseVersions("1.3", "1.3.0"), 0);
  assert.equal(compareLooseVersions("1.10.0", "1.9.9"), 1);
  assert.equal(compareLooseVersions("1.3.5", "1.3.5.0"), 0);
  // Entradas ilegibles: sin orden confiable (documentado en el módulo).
  assert.equal(compareLooseVersions("abc", "1.0.0"), 0);
  assert.equal(compareLooseVersions("1.0.0", ""), 0);
});

test("normalizeThumbprint quita espacios, dos puntos y pasa a mayúsculas", () => {
  assert.equal(normalizeThumbprint(THUMBPRINT.toLowerCase()), THUMBPRINT);
  assert.equal(normalizeThumbprint(" a1 b2\r\nc3 "), "A1B2C3");
  assert.equal(normalizeThumbprint("A1:B2:C3"), "A1B2C3");
  assert.equal(normalizeThumbprint(""), "");
  assert.equal(normalizeThumbprint(null), "");
});

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    status: "Valid",
    subject: "CN=PALMYRA POS",
    thumbprint: THUMBPRINT,
    productVersion: "1.3.6",
    currentVersion: "1.3.5",
    ...overrides
  };
}

test("evaluateOfflineInstaller acepta una firma válida y una versión más nueva", () => {
  assert.deepEqual(evaluateOfflineInstaller(baseInput()), { ok: true });
});

test("evaluateOfflineInstaller bloquea un instalador sin firma", () => {
  assert.deepEqual(evaluateOfflineInstaller(baseInput({ status: "NotSigned" })), {
    ok: false,
    code: "unsigned"
  });
  assert.deepEqual(evaluateOfflineInstaller(baseInput({ status: "" })), { ok: false, code: "unsigned" });
  assert.deepEqual(evaluateOfflineInstaller(baseInput({ thumbprint: "" })), {
    ok: false,
    code: "unsigned"
  });
  assert.deepEqual(evaluateOfflineInstaller(null), { ok: false, code: "unsigned" });
});

test("evaluateOfflineInstaller exige la huella fijada cuando está configurada", () => {
  const other = "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF";
  assert.deepEqual(evaluateOfflineInstaller(baseInput({ pinnedThumbprint: other })), {
    ok: false,
    code: "publisher-mismatch"
  });
  // Espacios, dos puntos y minúsculas no afectan la comparación.
  const spaced = "a1b2 c3d4 e5f6 0718 293a 4b5c 6d7e 8f90 1234 5678";
  assert.deepEqual(evaluateOfflineInstaller(baseInput({ pinnedThumbprint: spaced })), { ok: true });
  assert.deepEqual(evaluateOfflineInstaller(baseInput({ pinnedThumbprint: "   " })), { ok: true });
});

test("evaluateOfflineInstaller bloquea una versión ilegible", () => {
  assert.deepEqual(evaluateOfflineInstaller(baseInput({ productVersion: null })), {
    ok: false,
    code: "version-unknown"
  });
  assert.deepEqual(evaluateOfflineInstaller(baseInput({ productVersion: "sin-version" })), {
    ok: false,
    code: "version-unknown"
  });
  assert.deepEqual(evaluateOfflineInstaller(baseInput({ currentVersion: "" })), {
    ok: false,
    code: "version-unknown"
  });
});

test("evaluateOfflineInstaller nunca acepta la misma versión ni una anterior", () => {
  assert.deepEqual(evaluateOfflineInstaller(baseInput({ productVersion: "1.3.5" })), {
    ok: false,
    code: "not-newer"
  });
  assert.deepEqual(evaluateOfflineInstaller(baseInput({ productVersion: "1.3.5.0" })), {
    ok: false,
    code: "not-newer"
  });
  assert.deepEqual(evaluateOfflineInstaller(baseInput({ productVersion: "1.2.9" })), {
    ok: false,
    code: "not-newer"
  });
});

test("los scripts de PowerShell usan LiteralPath con el marcador __PATH__", () => {
  for (const script of [SIGNATURE_PS_SCRIPT, VERSION_PS_SCRIPT]) {
    assert.equal(typeof script, "string");
    assert.ok(script.includes("__PATH__"));
    assert.ok(script.includes("-LiteralPath '__PATH__'"));
  }
  assert.ok(SIGNATURE_PS_SCRIPT.includes("Get-AuthenticodeSignature"));
  assert.ok(SIGNATURE_PS_SCRIPT.includes("ConvertTo-Json"));
  assert.ok(VERSION_PS_SCRIPT.includes("VersionInfo"));
});
