/**
 * Contrato del empaquetado Android (fase F4).
 *
 * Ejecuta el validador real (`scripts/check-android-package.mjs`) como función
 * exportada, primero sobre el repo (debe pasar) y después sobre fixtures
 * temporales con una degradación concreta cada uno: allowBackup, versión
 * desalineada, cleartext público, firma literal, bridge ausente y `exported`
 * omitido. Así el pipeline no puede romperse sin que estas pruebas lo detecten.
 *
 * No compila nada ni usa el SDK: el validador solo lee archivos.
 */
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const MODULE_PATH = join(REPO_ROOT, "scripts/check-android-package.mjs");

/** Versión y versionCode esperados: derivados de package.json, la única fuente. */
const PACKAGE_VERSION: string = JSON.parse(
  readFileSync(join(REPO_ROOT, "package.json"), "utf8")
).version as string;
const EXPECTED_VERSION_CODE: number = PACKAGE_VERSION
  .split(".")
  .slice(0, 3)
  .map((part) => Number(part))
  .reduce((code, part) => code * 100 + part, 0);

type Check = { ok: boolean; section: string; name: string; detail: string };
type ValidationResult = {
  ok: boolean;
  root: string;
  checks: Check[];
  failures: Check[];
  version: string | null;
  expectedVersionCode: number | null;
};
type Validator = {
  inspect: (options?: { root?: string }) => ValidationResult;
  main: (argv?: string[], options?: { root?: string; log?: (line: string) => void }) => ValidationResult;
};

const validator = (await import(pathToFileURL(MODULE_PATH).href)) as unknown as Validator;

/** Archivos que el validador lee; el fixture los copia tal cual del repo. */
const FIXTURE_FILES = [
  "package.json",
  "android/app/build.gradle",
  "android/app/src/main/AndroidManifest.xml",
  "android/app/src/main/res/xml/network_security_config.xml",
  "android/app/src/main/res-lan/xml/network_security_config.xml",
  "android/app/src/main/java/cu/palmyra/app/MainActivity.java",
  "android/app/src/main/java/cu/palmyra/app/NativeDb.java",
  "android/app/src/main/java/cu/palmyra/app/PalmyraPrinterBridge.java",
  "android/app/src/main/java/cu/palmyra/app/PalmyraPermissions.java",
  "android/app/src/main/java/cu/palmyra/app/PalmyraNotifications.java",
  "android/app/src/main/java/cu/palmyra/app/UpdateApkProvider.java"
];

type Patch = { file: string; find: string; replace: string };

/** Copia el paquete real a un directorio temporal y aplica una degradación. */
function makeFixture(patches: Patch[] = [], extraFiles: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "palmyra-android-packaging-"));
  for (const relative of FIXTURE_FILES) {
    const target = join(root, relative);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(REPO_ROOT, relative), target);
  }
  for (const [relative, content] of Object.entries(extraFiles)) {
    const target = join(root, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  for (const patch of patches) {
    const file = join(root, patch.file);
    const text = readFileSync(file, "utf8");
    assert.ok(text.includes(patch.find), `fixture: no se encontró el fragmento a sustituir en ${patch.file}`);
    writeFileSync(file, text.replace(patch.find, patch.replace));
  }
  return root;
}

/** Texto plano de los fallos, para asertar sobre el mensaje y no sobre el orden. */
function failureText(result: ValidationResult): string {
  return result.failures.map((failure) => `${failure.section}/${failure.name}: ${failure.detail}`).join("\n");
}

test("el empaquetado real del repo cumple el contrato", () => {
  const result = validator.inspect();

  assert.equal(result.ok, true, `fallos inesperados:\n${failureText(result)}`);
  assert.equal(result.failures.length, 0);
  assert.equal(result.version, PACKAGE_VERSION);
  assert.equal(
    result.expectedVersionCode,
    EXPECTED_VERSION_CODE,
    `${PACKAGE_VERSION} debe derivar en versionCode ${EXPECTED_VERSION_CODE}`
  );
  assert.ok(result.checks.length >= 30, `se esperaban las comprobaciones completas (${result.checks.length})`);
});

test("main() devuelve OK sobre el repo y no lanza", () => {
  const lines: string[] = [];
  const result = validator.main([], { log: (line: string) => lines.push(line) });
  assert.equal(result.ok, true, `main() falló:\n${failureText(result)}`);
  assert.equal(process.exitCode ?? 0, 0, "main() no debe marcar exit code en un paquete válido");
  assert.ok(lines.includes("CHECK ANDROID: OK"), "main() debe imprimir el resumen OK");
});

test("detecta allowBackup=true", (t) => {
  const root = makeFixture([
    {
      file: "android/app/src/main/AndroidManifest.xml",
      find: 'android:allowBackup="false"',
      replace: 'android:allowBackup="true"'
    }
  ]);
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = validator.inspect({ root });
  assert.equal(result.ok, false);
  assert.match(failureText(result), /allowBackup/);
  assert.match(failureText(result), /"true"/);

  // El CLI debe fallar con exit code 1 para que el pipeline se detenga.
  const exit = validator.main(["--root", root], { log: () => {} });
  assert.equal(exit.ok, false);
  assert.equal(process.exitCode, 1, "main() debe marcar exit code 1 con el paquete degradado");
  process.exitCode = 0; // el proceso de test debe terminar limpio
});

test("detecta versionName desalineado de package.json", (t) => {
  const root = makeFixture([
    {
      file: "android/app/build.gradle",
      find: "versionName appVersionName",
      replace: 'versionName "1.3.4"'
    }
  ]);
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = validator.inspect({ root });
  assert.equal(result.ok, false);
  assert.match(failureText(result), /versionName/);
  assert.match(failureText(result), /1\.3\.4/);
});

test("detecta versionCode que no sigue el esquema de la versión", (t) => {
  const root = makeFixture([
    {
      file: "android/app/build.gradle",
      find: "versionCode appVersionCode",
      replace: "versionCode 10304"
    }
  ]);
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = validator.inspect({ root });
  assert.equal(result.ok, false);
  assert.match(failureText(result), /versionCode/);
  assert.match(failureText(result), new RegExp(String(EXPECTED_VERSION_CODE)));
});

test("detecta cleartext hacia un dominio público", (t) => {
  const root = makeFixture([
    {
      file: "android/app/src/main/res/xml/network_security_config.xml",
      find: "</domain-config>",
      replace: '    <domain includeSubdomains="true">api.palmyra.example</domain>\n    </domain-config>'
    }
  ]);
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = validator.inspect({ root });
  assert.equal(result.ok, false);
  assert.match(failureText(result), /api\.palmyra\.example/);
  assert.match(failureText(result), /dominio público/);
});

test("detecta credenciales de firma literales en build.gradle", (t) => {
  const root = makeFixture([
    {
      file: "android/app/build.gradle",
      find: "storePassword keystorePassword",
      replace: 'storePassword "hunter2"'
    }
  ]);
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = validator.inspect({ root });
  assert.equal(result.ok, false);
  assert.match(failureText(result), /storePassword/);
  assert.match(failureText(result), /literal/);
});

test("detecta un bridge nativo ausente", (t) => {
  const root = makeFixture([
    {
      file: "android/app/src/main/java/cu/palmyra/app/MainActivity.java",
      find: 'web.addJavascriptInterface(nativeDb, "PALMYRA_DB");',
      replace: ""
    }
  ]);
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = validator.inspect({ root });
  assert.equal(result.ok, false);
  assert.match(failureText(result), /PALMYRA_DB/);
});

test("detecta el puente de impresión sin el registro en la WebView", (t) => {
  const root = makeFixture([
    {
      file: "android/app/src/main/java/cu/palmyra/app/MainActivity.java",
      find: 'web.addJavascriptInterface(printerBridge, "PALMYRA_PRINTER");',
      replace: ""
    }
  ]);
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = validator.inspect({ root });
  assert.equal(result.ok, false);
  assert.match(failureText(result), /PALMYRA_PRINTER/);
});

test("detecta un método del puente de impresión renombrado", (t) => {
  const root = makeFixture([
    {
      file: "android/app/src/main/java/cu/palmyra/app/PalmyraPrinterBridge.java",
      find: "public String permissionStatus() {",
      replace: "public String printerStatus() {"
    }
  ]);
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = validator.inspect({ root });
  assert.equal(result.ok, false);
  assert.match(failureText(result), /PALMYRA_PRINTER\.permissionStatus/);
});

test("detecta que el resultado de permisos ya no vuelve a la web", (t) => {
  const root = makeFixture([
    {
      file: "android/app/src/main/java/cu/palmyra/app/MainActivity.java",
      find: String.raw`"if (window.__palmyraHardwarePermissions) window.__palmyraHardwarePermissions(\""`,
      replace: String.raw`"if (window.legacyPush) window.legacyPush(\""`
    }
  ]);
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = validator.inspect({ root });
  assert.equal(result.ok, false);
  assert.match(failureText(result), /Devolver el resultado/);
});

test("detecta que el APK pierde el canal de avisos del sistema", (t) => {
  const root = makeFixture([
    {
      file: "android/app/src/main/java/cu/palmyra/app/MainActivity.java",
      find: "public String showNotification(String title, String body, String tag) {",
      replace: "public String pushBanner(String title, String body, String tag) {"
    }
  ]);
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = validator.inspect({ root });
  assert.equal(result.ok, false);
  assert.match(failureText(result), /PALMYRA_NATIVE\.showNotification/);
});

test("detecta un aviso nativo sin NotificationChannel", (t) => {
  const root = makeFixture([
    {
      file: "android/app/src/main/java/cu/palmyra/app/PalmyraNotifications.java",
      find: "manager.createNotificationChannel(channel);",
      replace: "// canal eliminado"
    }
  ]);
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = validator.inspect({ root });
  assert.equal(result.ok, false);
  assert.match(failureText(result), /Canal de avisos/);
});

test("detecta un componente sin android:exported explícito", (t) => {
  const root = makeFixture([
    {
      file: "android/app/src/main/AndroidManifest.xml",
      find: 'android:exported="false"',
      replace: ""
    }
  ]);
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = validator.inspect({ root });
  assert.equal(result.ok, false);
  assert.match(failureText(result), /exported de \.UpdateApkProvider/);
  assert.match(failureText(result), /no verificable/);
});

test("detecta un FileProvider con rutas genéricas (no solo APK)", (t) => {
  const provider = [
    '        <provider',
    '            android:name="androidx.core.content.FileProvider"',
    '            android:authorities="cu.palmyra.app.files"',
    '            android:exported="false"',
    '            android:grantUriPermissions="true">',
    '            <meta-data android:name="android.support.FILE_PROVIDER_PATHS" android:resource="@xml/file_paths" />',
    '        </provider>',
    "    </application>"
  ].join("\n");
  const root = makeFixture(
    [
      {
        file: "android/app/src/main/AndroidManifest.xml",
        find: "</application>",
        replace: provider
      }
    ],
    { "android/app/src/main/res/xml/file_paths.xml": '<paths><root-path name="root" path="/" /></paths>' }
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = validator.inspect({ root });
  assert.equal(result.ok, false);
  assert.match(failureText(result), /FileProvider/);
  assert.match(failureText(result), /rutas genéricas/);
});
