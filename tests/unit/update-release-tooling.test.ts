/**
 * Pruebas de scripts/build-update-manifest.mjs y scripts/check-release-assets.mjs.
 *
 * Cubre el contrato del pipeline de release (F5):
 *   - semver estricto, artefactos obligatorios (windows + android), plataforma
 *     repetida, canal coherente con la versión y URL escapada;
 *   - sha256/bytes reales y URLs de la etiqueta v<versión> en GitHub Releases;
 *   - rechazo de retrocesos frente a --previous-manifest (y permiso para
 *     republicar la misma versión);
 *   - firma ES256 P-256 con una clave efímera (nunca se versiona) y rechazo de
 *     manifiestos sin firma en modo release;
 *   - check-release-assets: hash alterado, latest.yml ausente y firma que no
 *     verifica con la clave pública.
 *
 * Todo se ejecuta con child_process.execFileSync sobre los scripts reales y en
 * directorios temporales que se eliminan al terminar. No se ejecuta
 * electron-builder ni se usa ninguna clave real.
 */
import assert from "node:assert/strict";
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  verify
} from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deflateRawSync } from "node:zlib";

interface BuilderModule {
  canonicalJson(value: unknown): string;
  compareVersions(left: string, right: string): number;
  manifestSigningInput(manifest: Record<string, unknown>): string;
  inspect(
    options: Record<string, unknown>,
    env?: NodeJS.ProcessEnv
  ): { manifest: Record<string, unknown>; warnings: string[]; signed: boolean };
  main(argv?: string[], io?: { out?: (line: string) => void; err?: (line: string) => void }): number;
}

interface Artifact {
  platform: string;
  name: string;
  url: string;
  sha256: string;
  bytes: number;
}

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const BUILDER = path.join(ROOT, "scripts", "build-update-manifest.mjs");
const CHECKER = path.join(ROOT, "scripts", "check-release-assets.mjs");
const builder = (await import(pathToFileURL(BUILDER).href)) as unknown as BuilderModule;

const VERSION = JSON.parse(
  fs.readFileSync(path.join(ROOT, "package.json"), "utf8")
).version as string;
const RELEASED_AT = "2026-11-23T00:00:00.000Z";
const BASE_URL = "https://github.com/Cristian0311/palmyra/releases/download";
/** Nunca debe heredarse una clave de firma del entorno del desarrollador. */
const NO_KEY_ENV = {
  UPDATE_SIGNING_KEY: "",
  UPDATE_MANIFEST_KEY_PEM: "",
  UPDATE_MANIFEST_KEY_JWK: "",
  UPDATE_MANIFEST_REQUIRE_SIGNATURE: ""
};

// --- Helpers de ejecución ------------------------------------------------

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runScript(script: string, args: string[], env: NodeJS.ProcessEnv = {}): RunResult {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...NO_KEY_ENV, ...env },
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.error) throw result.error;
  return {
    status: result.status ?? 1,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? "")
  };
}

function build(args: string[], env: NodeJS.ProcessEnv = {}): RunResult {
  return runScript(BUILDER, args, env);
}

function check(args: string[]): RunResult {
  return runScript(CHECKER, args);
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function sha512(buffer: Buffer): string {
  return createHash("sha512").update(buffer).digest("base64");
}

// --- APK fixture (ZIP real con assets/web/version.json) ------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

interface ZipEntry {
  name: string;
  data: Buffer;
  deflate?: boolean;
}

function makeZip(entries: ZipEntry[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const payload = entry.deflate ? deflateRawSync(entry.data) : entry.data;
    const method = entry.deflate ? 8 : 0;
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, payload);

    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x0800, 8);
    record.writeUInt16LE(method, 10);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(payload.length, 20);
    record.writeUInt32LE(entry.data.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(offset, 42);
    central.push(record, name);

    offset += local.length + name.length + payload.length;
  }
  const directory = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, eocd]);
}

function makeApk(version: string): Buffer {
  const versionJson = Buffer.from(
    JSON.stringify({ app: "PALMYRA", version, buildId: `${version}-fixture` }, null, 2) + "\n",
    "utf8"
  );
  return makeZip([
    { name: "AndroidManifest.xml", data: Buffer.from("manifiesto-binario") },
    { name: "classes.dex", data: Buffer.from("dex") },
    { name: "assets/web/version.json", data: versionJson, deflate: true }
  ]);
}

// --- Workspace temporal --------------------------------------------------

interface Workspace {
  dir: string;
  setupPath: string;
  apkPath: string;
  keyPath: string;
  pubPath: string;
  manifestPath: string;
  latestPath: string;
}

function writeKeyPair(dir: string, name = "signing"): { keyPath: string; pubPath: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" }
  });
  const keyPath = path.join(dir, `${name}-private.pem`);
  const pubPath = path.join(dir, `${name}-public.pem`);
  fs.writeFileSync(keyPath, privateKey, "utf8");
  fs.writeFileSync(pubPath, publicKey, "utf8");
  return { keyPath, pubPath };
}

function makeWorkspace(): Workspace {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "palmyra-update-tooling-"));
  const setupPath = path.join(dir, "PALMYRA-POS-Setup.exe");
  const apkPath = path.join(dir, "PALMYRA-Android.apk");
  fs.writeFileSync(setupPath, Buffer.from(`setup-${VERSION}-fixture`));
  fs.writeFileSync(apkPath, makeApk(VERSION));
  const { keyPath, pubPath } = writeKeyPair(dir);
  return {
    dir,
    setupPath,
    apkPath,
    keyPath,
    pubPath,
    manifestPath: path.join(dir, "update-manifest.json"),
    latestPath: path.join(dir, "latest.yml")
  };
}

function writeLatestYml(workspace: Workspace): void {
  const setup = fs.readFileSync(workspace.setupPath);
  const latest = [
    `version: ${VERSION}`,
    "files:",
    "  - url: PALMYRA-POS-Setup.exe",
    `    sha512: ${sha512(setup)}`,
    `    size: ${setup.length}`,
    "path: PALMYRA-POS-Setup.exe",
    `sha512: ${sha512(setup)}`,
    `releaseDate: '${RELEASED_AT}'`,
    ""
  ].join("\n");
  fs.writeFileSync(workspace.latestPath, latest, "utf8");
}

function withWorkspace(run: (workspace: Workspace) => void): void {
  const workspace = makeWorkspace();
  try {
    run(workspace);
  } finally {
    fs.rmSync(workspace.dir, { recursive: true, force: true });
  }
}

function baseArgs(workspace: Workspace): string[] {
  return [
    "--version",
    VERSION,
    "--windows",
    workspace.setupPath,
    "--android",
    workspace.apkPath,
    "--released-at",
    RELEASED_AT
  ];
}

function readManifest(workspace: Workspace): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(workspace.manifestPath, "utf8")) as Record<string, unknown>;
}

// --- Manifest: validaciones ---------------------------------------------

test("el manifiesto rechaza versiones que no son semver estricto", () => {
  withWorkspace((workspace) => {
    for (const version of ["1.4", "v1.4.0", "1.4.0.1", "1.4.0+build"]) {
      const result = build([
        "--version",
        version,
        "--windows",
        workspace.setupPath,
        "--android",
        workspace.apkPath,
        "--out",
        workspace.manifestPath
      ]);
      assert.equal(result.status, 1, `debería rechazar ${version}`);
      assert.match(result.stderr, /Versión inválida/);
      assert.equal(fs.existsSync(workspace.manifestPath), false);
    }
  });
});

test("el manifiesto rechaza artefactos ausentes y plataformas incompletas", () => {
  withWorkspace((workspace) => {
    const missing = build([
      "--version",
      VERSION,
      "--windows",
      workspace.setupPath,
      "--android",
      path.join(workspace.dir, "no-existe.apk")
    ]);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /No existe el artefacto/);

    const noAndroid = build(["--version", VERSION, "--windows", workspace.setupPath]);
    assert.equal(noAndroid.status, 1);
    assert.match(noAndroid.stderr, /Falta el artefacto de android/);

    // Un manifiesto parcial explícito sí se permite.
    const partial = build([
      "--version",
      VERSION,
      "--windows",
      workspace.setupPath,
      "--allow-missing-platform",
      "android",
      "--out",
      workspace.manifestPath
    ]);
    assert.equal(partial.status, 0, partial.stderr);
    const platforms = (readManifest(workspace).artifacts as Artifact[]).map((item) => item.platform);
    assert.deepEqual(platforms, ["windows"]);
  });
});

test("el manifiesto rechaza plataformas repetidas y canales incoherentes", () => {
  withWorkspace((workspace) => {
    const duplicate = build([
      "--version",
      VERSION,
      "--windows",
      workspace.setupPath,
      "--windows",
      workspace.setupPath,
      "--android",
      workspace.apkPath
    ]);
    assert.equal(duplicate.status, 1);
    assert.match(duplicate.stderr, /Plataforma repetida: windows/);

    const wrongChannel = build([...baseArgs(workspace), "--channel", "beta"]);
    assert.equal(wrongChannel.status, 1);
    assert.match(wrongChannel.stderr, /no corresponde a la versión/);
  });
});

// --- Manifest: contenido, hashes y URLs ---------------------------------

test("el manifiesto calcula sha256/bytes reales y URLs escapadas de la etiqueta", () => {
  withWorkspace((workspace) => {
    const webPath = path.join(workspace.dir, "bundle+ota.zip");
    fs.writeFileSync(webPath, Buffer.from("web-bundle"));

    const result = build([
      ...baseArgs(workspace),
      "--web",
      webPath,
      "--out",
      workspace.manifestPath
    ]);
    assert.equal(result.status, 0, result.stderr);

    const manifest = readManifest(workspace);
    assert.equal(manifest.v, 1);
    assert.equal(manifest.version, VERSION);
    assert.equal(manifest.channel, "stable");
    assert.equal(manifest.releasedAt, RELEASED_AT);
    assert.equal(manifest.rollout, 100);
    assert.equal(manifest.signature, undefined, "sin clave no debe haber firma");

    const artifacts = manifest.artifacts as Artifact[];
    assert.deepEqual(
      artifacts.map((item) => item.platform),
      ["windows", "android", "web"]
    );

    const setup = fs.readFileSync(workspace.setupPath);
    assert.equal(artifacts[0].sha256, sha256(setup));
    assert.equal(artifacts[0].bytes, setup.length);
    assert.equal(
      artifacts[0].url,
      `${BASE_URL}/v${VERSION}/PALMYRA-POS-Setup.exe`
    );

    const apk = fs.readFileSync(workspace.apkPath);
    assert.equal(artifacts[1].sha256, sha256(apk));
    assert.equal(artifacts[1].bytes, apk.length);

    // Un "+" en el nombre nunca puede llegar sin escapar a la URL del asset.
    assert.equal(artifacts[2].url, `${BASE_URL}/v${VERSION}/bundle%2Bota.zip`);
    assert.match(result.stderr, /SIN firma/);
    assert.equal(builder.canonicalJson({ b: 1, a: [true, null] }), '{"a":[true,null],"b":1}');
  });
});

test("el manifiesto rechaza retrocesos y permite republicar la misma versión", () => {
  withWorkspace((workspace) => {
    const previousPath = path.join(workspace.dir, "previous-manifest.json");
    fs.writeFileSync(
      previousPath,
      `${JSON.stringify({ v: 1, version: "9.9.9", channel: "stable" }, null, 2)}\n`,
      "utf8"
    );
    const downgrade = build([
      ...baseArgs(workspace),
      "--previous-manifest",
      previousPath,
      "--out",
      workspace.manifestPath
    ]);
    assert.equal(downgrade.status, 1);
    assert.match(downgrade.stderr, /Retroceso de versión/);
    assert.equal(fs.existsSync(workspace.manifestPath), false);

    fs.writeFileSync(
      previousPath,
      `${JSON.stringify({ v: 1, version: VERSION, channel: "stable" }, null, 2)}\n`,
      "utf8"
    );
    const sameVersion = build([
      ...baseArgs(workspace),
      "--previous",
      previousPath,
      "--out",
      workspace.manifestPath
    ]);
    assert.equal(sameVersion.status, 0, sameVersion.stderr);
    assert.match(sameVersion.stderr, /coincide con el manifiesto anterior/);
    assert.equal(builder.compareVersions("1.4.0-beta.1", "1.4.0"), -1);
    assert.equal(builder.compareVersions("1.4.0", "1.4.0-beta.2"), 1);
  });
});

// --- Manifest: firma -----------------------------------------------------

test("la firma ES256 es verificable y se exige en modo release", () => {
  withWorkspace((workspace) => {
    const unsigned = build([
      ...baseArgs(workspace),
      "--require-signature",
      "--out",
      workspace.manifestPath
    ]);
    assert.equal(unsigned.status, 1);
    assert.match(unsigned.stderr, /No hay clave de firma/);
    assert.equal(fs.existsSync(workspace.manifestPath), false);

    const signed = build([
      ...baseArgs(workspace),
      "--key",
      workspace.keyPath,
      "--key-id",
      "fixture-key",
      "--require-signature",
      "--out",
      workspace.manifestPath
    ]);
    assert.equal(signed.status, 0, signed.stderr);
    const manifest = readManifest(workspace);
    assert.equal(manifest.keyId, "fixture-key");
    assert.equal(typeof manifest.signature, "string");
    assert.match(String(manifest.signature), /^[A-Za-z0-9_-]{80,}$/);

    const publicKey = createPublicKey(fs.readFileSync(workspace.pubPath, "utf8"));
    const valid = verify(
      "sha256",
      Buffer.from(builder.manifestSigningInput(manifest), "utf8"),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(String(manifest.signature), "base64url")
    );
    assert.equal(valid, true, "la firma debe verificar con la clave pública derivada");

    // Una clave que no es P-256 se rechaza antes de firmar.
    const { privateKey: rsaKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" }
    });
    const rsaPath = path.join(workspace.dir, "rsa.pem");
    fs.writeFileSync(rsaPath, rsaKey, "utf8");
    const wrongCurve = build([
      ...baseArgs(workspace),
      "--key",
      rsaPath,
      "--out",
      path.join(workspace.dir, "rsa-manifest.json")
    ]);
    assert.equal(wrongCurve.status, 1);
    assert.match(wrongCurve.stderr, /no es ES256 P-256/);
  });
});

// --- check-release-assets ------------------------------------------------

test("check-release-assets pasa con un manifiesto firmado y hashes correctos", () => {
  withWorkspace((workspace) => {
    writeLatestYml(workspace);
    const built = build([
      ...baseArgs(workspace),
      "--key",
      workspace.keyPath,
      "--key-id",
      "fixture-key",
      "--out",
      workspace.manifestPath
    ]);
    assert.equal(built.status, 0, built.stderr);

    const result = check([
      "--dir",
      workspace.dir,
      "--version",
      VERSION,
      "--tag",
      `v${VERSION}`,
      "--latest-yml",
      workspace.latestPath,
      "--manifest",
      workspace.manifestPath,
      "--require-manifest",
      "--require-signature",
      "--public-key",
      workspace.pubPath
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Resultado: OK/);
    assert.match(result.stdout, /firma ES256 verificada con la clave pública/);
    assert.match(result.stdout, /sha256 y tamaño coinciden/);
  });
});

test("check-release-assets falla si un artefacto no coincide con el manifiesto", () => {
  withWorkspace((workspace) => {
    writeLatestYml(workspace);
    const built = build([
      ...baseArgs(workspace),
      "--key",
      workspace.keyPath,
      "--out",
      workspace.manifestPath
    ]);
    assert.equal(built.status, 0, built.stderr);

    fs.appendFileSync(workspace.apkPath, Buffer.from("manipulado"));

    const result = check([
      "--dir",
      workspace.dir,
      "--version",
      VERSION,
      "--manifest",
      workspace.manifestPath,
      "--require-manifest",
      "--require-signature"
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /Resultado: FALLA/);
    assert.match(
      result.stdout,
      /(sha256 de|Tamaño de) PALMYRA-Android\.apk/
    );
  });
});

test("check-release-assets exige latest.yml y una firma que verifique", () => {
  withWorkspace((workspace) => {
    writeLatestYml(workspace);
    const built = build([
      ...baseArgs(workspace),
      "--key",
      workspace.keyPath,
      "--out",
      workspace.manifestPath
    ]);
    assert.equal(built.status, 0, built.stderr);

    const missingLatest = check([
      "--dir",
      workspace.dir,
      "--version",
      VERSION,
      "--latest-yml",
      path.join(workspace.dir, "latest-ausente.yml")
    ]);
    assert.equal(missingLatest.status, 1);
    assert.match(missingLatest.stdout, /Falta o está vacío: latest\.yml/);

    const { pubPath: otherPublicKey } = writeKeyPair(workspace.dir, "otra-clave");
    const wrongKey = check([
      "--dir",
      workspace.dir,
      "--version",
      VERSION,
      "--manifest",
      workspace.manifestPath,
      "--require-manifest",
      "--require-signature",
      "--public-key",
      otherPublicKey
    ]);
    assert.equal(wrongKey.status, 1);
    assert.match(wrongKey.stdout, /no verifica con la clave pública/);

    const unsigned = build([
      ...baseArgs(workspace),
      "--out",
      path.join(workspace.dir, "sin-firma.json")
    ]);
    assert.equal(unsigned.status, 0, unsigned.stderr);
    const requiresSignature = check([
      "--dir",
      workspace.dir,
      "--version",
      VERSION,
      "--manifest",
      path.join(workspace.dir, "sin-firma.json"),
      "--require-manifest",
      "--require-signature"
    ]);
    assert.equal(requiresSignature.status, 1);
    assert.match(requiresSignature.stdout, /firma ES256/);
  });
});

test("la CLI del manifiesto acepta un argumento desconocido con exit 1", () => {
  const result = build(["--version", VERSION, "--no-existe"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Argumento no reconocido/);
});

test("el pipeline publica los cinco assets y usa check:android", () => {
  const workflow = fs.readFileSync(
    path.join(ROOT, ".github", "workflows", "release.yml"),
    "utf8"
  );
  for (const asset of [
    "PALMYRA-POS-Setup.exe",
    "latest.yml",
    "PALMYRA-Android.apk",
    "update-manifest.json",
    "SHA256SUMS"
  ]) {
    assert.ok(workflow.includes(asset), `el workflow debe publicar ${asset}`);
  }
  assert.match(workflow, /npm run check:android/);
  assert.match(workflow, /UPDATE_SIGNING_KEY/);
  assert.match(workflow, /ANDROID_KEYSTORE_PASSWORD/);
  assert.match(workflow, /ANDROID_KEY_ALIAS/);
  assert.match(workflow, /ANDROID_KEY_PASSWORD/);
  assert.match(workflow, /--require-signature/);
  assert.match(workflow, /--previous-manifest/);
  assert.equal(
    /onrender\.com|render\.com/.test(workflow),
    false,
    "el release nunca publica ni descarga desde Render"
  );
});
