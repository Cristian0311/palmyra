/**
 * Pruebas de scripts/check-release-assets.mjs y de la configuración de release.
 *
 * - La versión del tag se compara con package.json en solo lectura: nada se
 *   modifica y el test sirve para cualquier versión del producto.
 * - El verificador se ejecuta sobre fixtures temporales (Setup, APK, latest.yml
 *   y manifiesto) para comprobar el camino feliz y cada fallo esperado. El APK
 *   del fixture es un ZIP real: el checker lee assets/web/version.json para
 *   exigir que el APK se compilara con la versión del manifiesto.
 * - Se vigila que el pipeline siga usando el verificador con --require-signature
 *   y que las variantes de red (res/xml vs res-lan) no se mezclen.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deflateRawSync } from "node:zlib";

interface CheckLine {
  ok: boolean;
  message: string;
}

interface CheckResult {
  ok: boolean;
  version: string;
  channel: string;
  dir: string;
  lanApks: string[];
  checks: CheckLine[];
  issues: string[];
  warnings: string[];
}

interface CheckOptions {
  dir?: string;
  version?: string;
  tag?: string;
  packageVersion?: string;
  manifestPath?: string;
  requireManifest?: boolean;
  requireSignature?: boolean;
  requireBlockmap?: boolean;
  root?: string;
}

interface LatestEntry {
  url?: string;
  size?: string;
  sha512?: string;
}

interface LatestYml {
  version?: string;
  path?: string;
  sha512?: string;
  files: LatestEntry[];
}

interface CheckerModule {
  SETUP: string;
  APK: string;
  LATEST: string;
  MANIFEST: string;
  SETUP_BLOCKMAP: string;
  APK_VERSION_ENTRY: string;
  SEMVER_RE: RegExp;
  LAN_APK_RE: RegExp;
  isLanApkName(fileName: string): boolean;
  lanApksIn(names: string[]): string[];
  readApkVersion(apkPath: string): { version: string; error: string };
  validateTagVersion(input: { tag?: string; version?: string; packageVersion?: string }): {
    ok: boolean;
    version: string;
    issues: string[];
  };
  parseLatestYml(text: string): LatestYml;
  readPackageVersion(root?: string): string;
  checkReleaseAssets(options?: CheckOptions): CheckResult;
  formatReport(result: CheckResult): string;
  runCli(argv?: string[], io?: { out?: (line: string) => void; err?: (line: string) => void }): number;
}

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SCRIPT = path.join(ROOT, "scripts", "check-release-assets.mjs");
const checker = (await import(pathToFileURL(SCRIPT).href)) as unknown as CheckerModule;

const PACKAGE_VERSION = JSON.parse(
  fs.readFileSync(path.join(ROOT, "package.json"), "utf8")
).version as string;

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function sha512(buffer: Buffer): string {
  return createHash("sha512").update(buffer).digest("base64");
}

// --- Fixtures de APK -------------------------------------------------------
// El checker lee assets/web/version.json dentro del APK, así que los fixtures
// son ZIP reales (método STORE o DEFLATE), no bytes cualquiera.

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

interface ZipEntryInput {
  name: string;
  data: Buffer;
  deflate?: boolean;
}

function makeZip(entries: ZipEntryInput[]): Buffer {
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

/** APK mínimo con la versión que build-apk.sh empaqueta en assets/web. */
function makeApk(version: string, deflate = false): Buffer {
  const versionJson = Buffer.from(
    JSON.stringify({ app: "PALMYRA", version, buildId: `${version}-fixture` }, null, 2) + "\n",
    "utf8"
  );
  return makeZip([
    { name: "AndroidManifest.xml", data: Buffer.from("manifiesto-binario") },
    { name: "classes.dex", data: Buffer.from("dex") },
    { name: checker.APK_VERSION_ENTRY, data: versionJson, deflate }
  ]);
}

interface FixtureOptions {
  version?: string;
  setup?: Buffer;
  apk?: Buffer;
  /** Versión empaquetada dentro del APK (por defecto, la del release). */
  apkVersion?: string;
  /** Comprime assets/web/version.json con DEFLATE (los APK reales lo hacen). */
  apkDeflate?: boolean;
  signed?: boolean;
  /** Bytes del .blockmap; null/ausente = no se genera ni se declara. */
  blockmap?: Buffer | null;
  latestVersion?: string;
  /** Valor de `path` en latest.yml (por defecto, el Setup estable). */
  latestPath?: string;
  dropApk?: boolean;
  dropSetup?: boolean;
  /** Firma falsa del APK en el manifiesto (simula un artefacto alterado). */
  manifestApkSha?: string;
  /** Contenido alternativo del APK en el manifiesto (tamaño distinto). */
  manifestApkBytes?: number;
  /** Nombre de un APK de red local que se deja caer en el directorio. */
  lanApk?: string;
  /** Nombre que el manifiesto declara para Android (por defecto, el estable). */
  manifestAndroidName?: string;
}

interface Fixture {
  dir: string;
  apkPath: string;
  setupPath: string;
  manifestPath: string;
}

const VERSION = PACKAGE_VERSION;
const BASE_URL = "https://github.com/Cristian0311/palmyra/releases/download";

function writeFixture(options: FixtureOptions = {}): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "palmyra-release-check-"));
  const version = options.version ?? VERSION;
  const setup = options.setup ?? Buffer.from("setup-binario-de-prueba");
  const apk = options.apk ?? makeApk(options.apkVersion ?? version, options.apkDeflate);

  const setupPath = path.join(dir, checker.SETUP);
  const apkPath = path.join(dir, checker.APK);
  if (!options.dropSetup) fs.writeFileSync(setupPath, setup);
  if (!options.dropApk) fs.writeFileSync(apkPath, apk);
  if (options.lanApk) {
    fs.writeFileSync(path.join(dir, options.lanApk), makeApk(version));
  }

  const files: string[] = [
    `  - url: ${checker.SETUP}`,
    `    sha512: ${sha512(setup)}`,
    `    size: ${setup.length}`
  ];
  if (options.blockmap) {
    fs.writeFileSync(path.join(dir, checker.SETUP_BLOCKMAP), options.blockmap);
    files.push(`  - url: ${checker.SETUP_BLOCKMAP}`, `    size: ${options.blockmap.length}`);
  }
  const latestYml = [
    `version: ${options.latestVersion ?? version}`,
    "files:",
    ...files,
    `path: ${options.latestPath ?? checker.SETUP}`,
    `sha512: ${sha512(setup)}`,
    "releaseDate: '2026-11-23T00:00:00.000Z'",
    ""
  ].join("\n");
  fs.writeFileSync(path.join(dir, checker.LATEST), latestYml, "utf8");

  const manifest: Record<string, unknown> = {
    v: 1,
    version,
    channel: version.includes("-beta") ? "beta" : "stable",
    releasedAt: "2026-11-23T00:00:00.000Z",
    rollout: 100,
    artifacts: [
      {
        platform: "windows",
        name: checker.SETUP,
        url: `${BASE_URL}/v${version}/${checker.SETUP}`,
        sha256: sha256(setup),
        bytes: setup.length
      },
      {
        platform: "android",
        name: options.manifestAndroidName ?? checker.APK,
        url: `${BASE_URL}/v${version}/${options.manifestAndroidName ?? checker.APK}`,
        sha256: options.manifestApkSha ?? sha256(apk),
        bytes: options.manifestApkBytes ?? apk.length
      }
    ]
  };
  if (options.signed !== false) {
    // ECDSA P-256 IEEE P1363 en base64url: 86 caracteres. No se verifica aquí
    // (eso es responsabilidad de src/services/updates/verify.ts); solo formato.
    manifest.signature = "A".repeat(86);
    manifest.keyId = "fixture-key";
  }
  const manifestPath = path.join(dir, checker.MANIFEST);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  return { dir, apkPath, setupPath, manifestPath };
}

function withFixture(options: FixtureOptions, run: (fixture: Fixture) => void): void {
  const fixture = writeFixture(options);
  try {
    run(fixture);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
}

function run(options: CheckOptions): CheckResult {
  return checker.checkReleaseAssets({ version: VERSION, packageVersion: VERSION, ...options });
}

test("el tag del release debe ser v<versión de package.json>", () => {
  assert.match(PACKAGE_VERSION, checker.SEMVER_RE, "package.json debe tener versión semver");

  const ok = checker.validateTagVersion({
    tag: `v${PACKAGE_VERSION}`,
    version: PACKAGE_VERSION,
    packageVersion: PACKAGE_VERSION
  });
  assert.equal(ok.ok, true, ok.issues.join("; "));

  const wrongTag = checker.validateTagVersion({
    tag: "v9.9.9",
    version: PACKAGE_VERSION,
    packageVersion: PACKAGE_VERSION
  });
  assert.equal(wrongTag.ok, false);
  assert.match(wrongTag.issues.join(" "), /no coincide con la versión/);

  const noPrefix = checker.validateTagVersion({ tag: PACKAGE_VERSION, version: PACKAGE_VERSION });
  assert.equal(noPrefix.ok, false);
  assert.match(noPrefix.issues.join(" "), /Tag inválido/);

  const wrongPackage = checker.validateTagVersion({
    tag: `v${PACKAGE_VERSION}`,
    version: PACKAGE_VERSION,
    packageVersion: "1.0.0"
  });
  assert.equal(wrongPackage.ok, false);
  assert.match(wrongPackage.issues.join(" "), /package\.json/);

  assert.equal(checker.validateTagVersion({ version: "1.3" }).ok, false);

  // Solo lectura: el helper lee package.json y no lo toca.
  assert.equal(checker.readPackageVersion(ROOT), PACKAGE_VERSION);
});

test("un release completo y firmado se acepta y la CLI devuelve 0", () => {
  withFixture({ signed: true, blockmap: Buffer.from("blockmap-de-prueba") }, (fixture) => {
    const result = run({
      dir: fixture.dir,
      tag: `v${VERSION}`,
      requireManifest: true,
      requireSignature: true,
      requireBlockmap: true
    });
    assert.equal(result.ok, true, result.issues.join("; "));
    assert.deepEqual(result.issues, []);
    assert.match(checker.formatReport(result), /Resultado: OK/);

    const lines: string[] = [];
    const code = checker.runCli(
      [
        "--dir",
        fixture.dir,
        "--version",
        VERSION,
        "--tag",
        `v${VERSION}`,
        "--manifest",
        fixture.manifestPath,
        "--require-manifest",
        "--require-signature",
        "--require-blockmap"
      ],
      { out: (line) => lines.push(line), err: (line) => lines.push(line) }
    );
    assert.equal(code, 0, lines.join("\n"));
    assert.match(lines.join("\n"), /Resultado: OK/);
    assert.match(lines.join("\n"), /sha256 y tamaño coinciden/);
  });
});

test("un APK alterado respecto al manifiesto rompe la verificación", () => {
  withFixture({ signed: true }, (fixture) => {
    fs.appendFileSync(fixture.apkPath, Buffer.from("manipulado"));

    const result = run({ dir: fixture.dir });
    assert.equal(result.ok, false);
    assert.match(result.issues.join(" "), /(sha256 de|Tamaño de) PALMYRA-Android\.apk/);

    const lines: string[] = [];
    const code = checker.runCli(["--dir", fixture.dir, "--version", VERSION], {
      out: (line) => lines.push(line),
      err: (line) => lines.push(line)
    });
    assert.equal(code, 1);
    assert.match(lines.join("\n"), /Resultado: FALLA/);
  });
});

test("falta el APK y el manifiesto sin firma se rechaza cuando se exige", () => {
  withFixture({ dropApk: true, signed: false }, (fixture) => {
    const missing = run({ dir: fixture.dir });
    assert.equal(missing.ok, false);
    assert.ok(
      missing.issues.some((issue) => issue.includes("PALMYRA-Android.apk")),
      missing.issues.join("; ")
    );

    const unsigned = run({ dir: fixture.dir, requireSignature: true });
    assert.equal(unsigned.ok, false);
    assert.ok(
      unsigned.issues.some((issue) => issue.includes("firma ES256")),
      unsigned.issues.join("; ")
    );
  });
});

test("latest.yml debe declarar la misma versión y el sha512 real del Setup", () => {
  withFixture({ signed: true, latestVersion: "9.9.9" }, (fixture) => {
    const result = run({ dir: fixture.dir });
    assert.equal(result.ok, false);
    assert.match(result.issues.join(" "), /latest\.yml declara v9\.9\.9/);
  });

  withFixture({ signed: true }, (fixture) => {
    fs.appendFileSync(fixture.setupPath, Buffer.from("otra-compilacion"));
    const result = run({ dir: fixture.dir });
    assert.equal(result.ok, false);
    assert.match(result.issues.join(" "), /latest\.yml declara un sha512|sha512 del Setup/);
  });
});

test("el .blockmap solo se exige si la actualización diferencial está activa", () => {
  withFixture({ signed: true }, (fixture) => {
    const withoutFlag = run({ dir: fixture.dir });
    assert.equal(withoutFlag.ok, true, withoutFlag.issues.join("; "));
    assert.ok(
      withoutFlag.warnings.some((warning) => warning.includes(".blockmap")),
      withoutFlag.warnings.join("; ")
    );

    const required = run({ dir: fixture.dir, requireBlockmap: true });
    assert.equal(required.ok, false);
    assert.match(required.issues.join(" "), /Falta PALMYRA-POS-Setup\.exe\.blockmap/);
  });

  withFixture({ signed: true, blockmap: Buffer.from("blockmap") }, (fixture) => {
    const result = run({ dir: fixture.dir, requireBlockmap: true });
    assert.equal(result.ok, true, result.issues.join("; "));
    assert.ok(result.checks.some((check) => check.message.includes("blockmap")));
  });
});

test("latest.yml se parsea con las claves de electron-updater", () => {
  const parsed = checker.parseLatestYml(
    [
      "version: 1.3.5",
      "files:",
      "  - url: PALMYRA-POS-Setup.exe",
      "    sha512: abc==",
      "    size: 123",
      "path: PALMYRA-POS-Setup.exe",
      `sha512: ${"A".repeat(86)}==`,
      "releaseDate: '2026-11-23T00:00:00.000Z'",
      ""
    ].join("\n")
  );
  assert.equal(parsed.version, "1.3.5");
  assert.equal(parsed.path, "PALMYRA-POS-Setup.exe");
  assert.equal(parsed.files.length, 1);
  assert.equal(parsed.files[0].url, "PALMYRA-POS-Setup.exe");
  assert.equal(parsed.files[0].size, "123");
});

test("el script build no duplica el bundle de desktop-runtime", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  assert.equal(
    /mainRuntime/.test(pkg.scripts.build),
    false,
    "build no debe empaquetar src/desktop/mainRuntime.ts (lo genera build:desktop)"
  );
  assert.match(pkg.scripts["build:desktop"], /src\/desktop\/mainRuntime\.ts/);
});

test("la configuración conserva firma, HTTPS y la separación de red estándar/LAN", () => {
  const builder = fs.readFileSync(path.join(ROOT, "electron-builder.yml"), "utf8");
  assert.match(builder, /^asar: true$/m);
  assert.match(builder, /publisherName: PALMYRA/);
  assert.match(builder, /perMachine: false/);
  assert.match(builder, /provider: github/);

  const workflow = fs.readFileSync(path.join(ROOT, ".github", "workflows", "release.yml"), "utf8");
  assert.match(workflow, /check-release-assets\.mjs/);
  assert.match(workflow, /--require-signature/);
  assert.match(workflow, /--require-manifest/);

  const standard = fs.readFileSync(
    path.join(ROOT, "android", "app", "src", "main", "res", "xml", "network_security_config.xml"),
    "utf8"
  );
  assert.match(standard, /<base-config cleartextTrafficPermitted="false"/);
  assert.match(standard, /<domain [^>]*>127\.0\.0\.1<\/domain>/);

  const lan = fs.readFileSync(
    path.join(ROOT, "android", "app", "src", "main", "res-lan", "xml", "network_security_config.xml"),
    "utf8"
  );
  assert.match(lan, /<base-config cleartextTrafficPermitted="true"/);

  const buildScript = fs.readFileSync(path.join(ROOT, "android", "build-apk.sh"), "utf8");
  assert.match(buildScript, /--lan/);
  assert.match(buildScript, /res-lan/);
  assert.match(buildScript, /APKSIGNER/);
  // El wrapper no se inventa: el script informa el comando exacto para crearlo.
  assert.match(buildScript, /gradle wrapper --gradle-version 8\.9 --distribution-type bin/);
  assert.match(buildScript, /gradle-wrapper\.jar/);

  const wrapper = fs.readFileSync(
    path.join(ROOT, "android", "gradle", "wrapper", "gradle-wrapper.properties"),
    "utf8"
  );
  assert.match(wrapper, /gradle-8\.9-bin\.zip/);
  assert.match(wrapper, /gradle wrapper/);
});

test("isLanApkName distingue el APK LAN del estándar", () => {
  assert.equal(checker.isLanApkName("PALMYRA-Android-LAN.apk"), true);
  assert.equal(checker.isLanApkName("palmyra-android-lan.apk"), true);
  assert.equal(checker.isLanApkName("PALMYRA-LAN.apk"), true);
  assert.match("PALMYRA-Android-LAN.apk", checker.LAN_APK_RE);

  assert.equal(checker.isLanApkName("PALMYRA-Android.apk"), false);
  assert.equal(checker.isLanApkName("PALMYRA-POS-Setup.exe"), false);
  assert.equal(checker.isLanApkName(""), false);

  assert.deepEqual(
    checker.lanApksIn([
      "PALMYRA-POS-Setup.exe",
      "PALMYRA-Android.apk",
      "PALMYRA-Android-LAN.apk",
      "latest.yml"
    ]),
    ["PALMYRA-Android-LAN.apk"]
  );
});

test("un APK LAN en el directorio de publicación rompe el checker y la CLI", () => {
  withFixture({ signed: true, lanApk: "PALMYRA-Android-LAN.apk" }, (fixture) => {
    const result = run({ dir: fixture.dir });
    assert.equal(result.ok, false);
    assert.deepEqual(result.lanApks, ["PALMYRA-Android-LAN.apk"]);
    assert.match(result.issues.join(" "), /APK de red local/);

    const lines: string[] = [];
    const code = checker.runCli(["--dir", fixture.dir, "--version", VERSION], {
      out: (line) => lines.push(line),
      err: (line) => lines.push(line)
    });
    assert.equal(code, 1);
    assert.match(lines.join("\n"), /Resultado: FALLA/);
  });
});

test("el manifiesto no puede publicar el APK de red local", () => {
  withFixture(
    { signed: true, lanApk: "PALMYRA-Android-LAN.apk", manifestAndroidName: "PALMYRA-Android-LAN.apk" },
    (fixture) => {
      const result = run({ dir: fixture.dir });
      assert.equal(result.ok, false);
      assert.match(result.issues.join(" "), /APK de red local/);
      assert.ok(
        result.issues.some((issue) => issue.includes("manifiesto")),
        result.issues.join("; ")
      );
    }
  );
});

test("el APK debe haberse compilado con la versión del manifiesto", () => {
  withFixture({ signed: true }, (fixture) => {
    const result = run({ dir: fixture.dir, requireManifest: true });
    assert.equal(result.ok, true, result.issues.join("; "));
    assert.ok(
      result.checks.some((check) => check.message.includes("alineado con el manifiesto")),
      result.checks.map((check) => check.message).join("; ")
    );
  });

  // APK viejo junto a un manifiesto nuevo: el teléfono instalaría código
  // desactualizado aunque los hashes internos del release fueran coherentes.
  withFixture({ signed: true, apkVersion: "1.2.9" }, (fixture) => {
    const result = run({ dir: fixture.dir, requireManifest: true });
    assert.equal(result.ok, false);
    assert.match(result.issues.join(" "), /se compiló con v1\.2\.9/);

    const lines: string[] = [];
    const code = checker.runCli(["--dir", fixture.dir, "--version", VERSION], {
      out: (line) => lines.push(line),
      err: (line) => lines.push(line)
    });
    assert.equal(code, 1);
    assert.match(lines.join("\n"), /v1\.2\.9/);
  });

  // Un APK que no es un ZIP legible no permite demostrar la alineación: falla.
  withFixture({ signed: true, apk: Buffer.from("no-es-un-zip") }, (fixture) => {
    const result = run({ dir: fixture.dir });
    assert.equal(result.ok, false);
    assert.match(result.issues.join(" "), /No se pudo verificar la versión de PALMYRA-Android\.apk/);
  });
});

test("readApkVersion lee assets/web/version.json con STORE y DEFLATE", () => {
  withFixture({ signed: true }, (fixture) => {
    assert.deepEqual(checker.readApkVersion(fixture.apkPath), { version: VERSION, error: "" });
  });

  // El APK real compila resources.arsc con STORE y el resto con DEFLATE.
  withFixture({ signed: true, apkDeflate: true }, (fixture) => {
    assert.equal(checker.readApkVersion(fixture.apkPath).version, VERSION);
  });

  const missing = checker.readApkVersion(path.join(os.tmpdir(), "palmyra-no-existe.apk"));
  assert.equal(missing.version, "");
  assert.notEqual(missing.error, "");
});

test("latest.yml debe apuntar a un archivo que exista en el directorio", () => {
  withFixture({ signed: true, latestPath: "PALMYRA-POS-1.9.9-Setup.exe" }, (fixture) => {
    const result = run({ dir: fixture.dir });
    assert.equal(result.ok, false);
    assert.match(result.issues.join(" "), /apunta a "PALMYRA-POS-1\.9\.9-Setup\.exe"/);
  });

  withFixture({ signed: true, dropSetup: true }, (fixture) => {
    const result = run({ dir: fixture.dir });
    assert.equal(result.ok, false);
    assert.match(
      result.issues.join(" "),
      /latest\.yml apunta a PALMYRA-POS-Setup\.exe, que no existe/
    );
  });
});

