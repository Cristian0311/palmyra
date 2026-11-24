/**
 * Pruebas de /download/android sin levantar Express.
 *
 * La ruta delega la decisión en `pickAndroidAsset`, función pura del módulo
 * server.ts: aquí se comprueba qué artefactos son públicos y cuáles no. El
 * puerto no se abre porque se define PALMYRA_SKIP_SERVER_BOOT=1 antes de
 * importar el módulo.
 *
 * Regla de producto: la descarga pública sirve SOLO el APK estándar con su
 * nombre exacto (PALMYRA-Android.apk). Cualquier APK de red local (--lan, con
 * cleartext hacia el hub HTTP) se rechaza y, si es el único presente, la ruta
 * responde 404: nunca se degrada a servirlo.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

interface ApkCandidate {
  name: string;
  fullPath: string;
  mtimeMs: number;
}

interface AndroidAssetPick {
  file: ApkCandidate | null;
  lanRejected: string[];
  ignored: string[];
}

interface ServerDownloadModule {
  PUBLIC_ANDROID_APK: string;
  ANDROID_APK_RE: RegExp;
  isLanAndroidApk(fileName: string): boolean;
  pickAndroidAsset(candidates: ApkCandidate[]): AndroidAssetPick;
}

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

// Debe definirse ANTES de importar server.ts: el módulo arranca el servidor al
// cargarse si la variable no vale '1'.
process.env.PALMYRA_SKIP_SERVER_BOOT = "1";
process.env.DOTENV_CONFIG_QUIET = "true";

const server = (await import(
  pathToFileURL(path.join(ROOT, "server.ts")).href
)) as unknown as ServerDownloadModule;

function candidate(name: string, mtimeMs = 1): ApkCandidate {
  return { name, fullPath: `release/${name}`, mtimeMs };
}

test("la ruta pública solo sirve el APK estándar con su nombre exacto", () => {
  assert.equal(server.PUBLIC_ANDROID_APK, "PALMYRA-Android.apk");

  const mixed = server.pickAndroidAsset([
    candidate("PALMYRA-Android.apk", 100),
    candidate("PALMYRA-Android-LAN.apk", 900)
  ]);
  assert.equal(mixed.file?.name, "PALMYRA-Android.apk");
  assert.deepEqual(mixed.lanRejected, ["PALMYRA-Android-LAN.apk"]);
  assert.deepEqual(mixed.ignored, []);

  // Un APK versionado no es el nombre estable del build: no se sirve.
  const versioned = server.pickAndroidAsset([
    candidate("PALMYRA-Android-1.3.5.apk", 900),
    candidate("PALMYRA.apk", 500)
  ]);
  assert.equal(versioned.file, null);
  assert.deepEqual(versioned.ignored, ["PALMYRA-Android-1.3.5.apk", "PALMYRA.apk"]);
  assert.deepEqual(versioned.lanRejected, []);

  // Archivos que empiezan por el nombre estable pero no son el APK (firma).
  const idsig = server.pickAndroidAsset([candidate("PALMYRA-Android.apk.idsig", 900)]);
  assert.equal(idsig.file, null);
  assert.deepEqual(idsig.lanRejected, []);
  assert.deepEqual(idsig.ignored, []);
});

test("cualquier variante LAN se rechaza aunque sea más reciente", () => {
  const lanNames = [
    "PALMYRA-Android-LAN.apk",
    "PALMYRA-Android-lan.apk",
    "PALMYRA-Android_LAN.apk",
    "PALMYRA-Android.Lan.apk",
    "PALMYRA-Android-LAN-1.3.5.apk",
    "PALMYRA-LAN.apk"
  ];
  for (const name of lanNames) {
    assert.equal(server.isLanAndroidApk(name), true, name);
    const pick = server.pickAndroidAsset([candidate(name, 999), candidate("PALMYRA-Android.apk", 1)]);
    assert.equal(pick.file?.name, "PALMYRA-Android.apk", name);
    assert.deepEqual(pick.lanRejected, [name], name);
  }

  assert.equal(server.isLanAndroidApk("PALMYRA-Android.apk"), false);
  assert.equal(server.isLanAndroidApk("PALMYRA-POS-Setup.exe"), false);
  assert.equal(server.isLanAndroidApk(""), false);
});

test("si solo hay APK LAN no hay descarga pública: la ruta responde 404", () => {
  const onlyLan = server.pickAndroidAsset([candidate("PALMYRA-Android-LAN.apk", 900)]);
  assert.equal(onlyLan.file, null);
  assert.deepEqual(onlyLan.lanRejected, ["PALMYRA-Android-LAN.apk"]);
  // La ruta usa esta condición para responder 404 en vez del fallback público.
  assert.ok(onlyLan.lanRejected.length > 0);

  const nothing = server.pickAndroidAsset([]);
  assert.equal(nothing.file, null);
  assert.deepEqual(nothing.lanRejected, []);
  assert.deepEqual(nothing.ignored, []);

  // Entradas nulas o sin nombre no rompen la selección (función pura).
  const junk = server.pickAndroidAsset([
    { name: "", fullPath: "", mtimeMs: 1 },
    { name: "PALMYRA-Android.apk", fullPath: "", mtimeMs: 0 }
  ]);
  assert.equal(junk.file?.name, "PALMYRA-Android.apk");
});

test("el nombre público coincide con el que produce build-apk.sh sin --lan", () => {
  const script = fs.readFileSync(path.join(ROOT, "android", "build-apk.sh"), "utf8");
  assert.match(script, /^APK_NAME="PALMYRA-Android\.apk"$/m, "build-apk.sh debe usar el nombre estable");
  assert.match(script, /APK_NAME="PALMYRA-Android-LAN\.apk"/, "la variante --lan debe llevar sufijo LAN");
  assert.ok(server.ANDROID_APK_RE.test(server.PUBLIC_ANDROID_APK));
});
