#!/usr/bin/env node
/**
 * Comprueba que un directorio de artefactos de PALMYRA está listo para publicar.
 *
 * Node ESM sin dependencias. Se usa en .github/workflows/release.yml como
 * puerta previa a crear el Release y también en local antes de etiquetar:
 *
 *   node scripts/check-release-assets.mjs --dir release --version 1.3.5 \
 *     --tag v1.3.5 --manifest update-manifest.json --require-manifest \
 *     --require-signature [--public-key update-public.pem]
 *
 * Valida:
 *   1. Que la versión sea semver, que coincida con package.json (si se conoce)
 *      y que el tag del pipeline sea exactamente v<versión>.
 *   2. Que existan y no estén vacíos PALMYRA-POS-Setup.exe, PALMYRA-Android.apk
 *      y latest.yml.
 *   3. Formato de latest.yml: version, path (que debe existir en el
 *      directorio), sha512, tamaño, lista `files` y, si referencia un
 *      .blockmap, que ese archivo exista y tenga su tamaño.
 *   4. Si hay manifiesto: versión, canal, releasedAt, rollout, URLs https que
 *      cuelgan de v<versión>, y sha256/bytes reales de Setup, APK y (si el
 *      manifiesto lo declara) del bundle web .zip.
 *   5. Que el APK se haya compilado con la misma versión que el release y el
 *      manifiesto: se lee assets/web/version.json dentro del propio APK.
 *   6. Con --require-signature: que el manifiesto traiga firma ES256.
 *   7. Con --require-blockmap: que exista el .blockmap del Setup (solo cuando
 *      nsis.differentialPackage está activo).
 *   8. Que no haya ningún *LAN*.apk en el directorio de publicación y que ni
 *      latest.yml ni el manifiesto apunten a un APK de red local: ese APK lleva
 *      cleartext hacia el hub HTTP de la red privada y nunca se publica.
 *
 * Salida legible por líneas, exit code 1 si algo falla. Las funciones puras
 * (validateTagVersion, parseLatestYml, isLanApkName, readApkVersion) y
 * checkReleaseAssets se exportan para tests/unit/release-assets.test.ts.
 */

import { createHash, createPublicKey, verify } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inflateRawSync } from "node:zlib";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const SETUP = "PALMYRA-POS-Setup.exe";
export const APK = "PALMYRA-Android.apk";
export const LATEST = "latest.yml";
export const MANIFEST = "update-manifest.json";
export const SETUP_BLOCKMAP = `${SETUP}.blockmap`;
export const STABLE_NAMES = { windows: SETUP, android: APK };
/** Extensión obligatoria por plataforma: un .zip no puede pasar por Setup. */
export const PLATFORM_EXTENSIONS = { windows: /\.exe$/i, android: /\.apk$/i, web: /\.zip$/i };
/** Nombre estable por plataforma: es lo que sirve /download/* y latest.yml. */
export const REQUIRED_FILES = [SETUP, APK, LATEST];
export const SEMVER_RE = /^\d+\.\d+\.\d+(-beta(?:\.\d+)?)?$/;
export const TAG_RE = /^v\d+\.\d+\.\d+(-beta(?:\.\d+)?)?$/;
export const SHA256_RE = /^[0-9a-f]{64}$/;
/** sha512 en base64: 64 bytes -> 88 caracteres terminados en "==". */
export const SHA512_BASE64_RE = /^[A-Za-z0-9+/]{86}==$/;
/** ECDSA P-256 en IEEE P1363: 64 bytes -> 86 caracteres base64url. */
export const SIGNATURE_RE = /^[A-Za-z0-9_-]{80,}$/;
/**
 * Un APK de red local (build-apk.sh --lan) permite cleartext hacia el hub HTTP
 * de la red privada: nunca se publica ni se sirve en /download/android.
 */
export const LAN_APK_RE = /lan/i;

/** True si el nombre es un APK LAN (p. ej. PALMYRA-Android-LAN.apk). */
export function isLanApkName(fileName) {
  const base = path.posix.basename(String(fileName ?? "").trim().replaceAll("\\", "/"));
  if (!/\.apk$/i.test(base)) return false;
  return LAN_APK_RE.test(base.slice(0, -4));
}

/** Nombres de un listado que corresponden a APK de red local. */
export function lanApksIn(names) {
  return (Array.isArray(names) ? names : []).filter((name) => isLanApkName(name));
}

const ZIP_EOCD_SIG = 0x06054b50;
const ZIP_CD_SIG = 0x02014b50;
const ZIP_LOCAL_SIG = 0x04034b50;
/** El APK empaqueta el bundle web en assets/web y ahí publica su versión. */
export const APK_VERSION_ENTRY = "assets/web/version.json";

/**
 * Lee una entrada de un ZIP sin dependencias externas (EOCD + directorio
 * central + cabecera local). Devuelve { data } o { error } y nunca lanza.
 */
function readZipEntry(filePath, entryName) {
  let fd = -1;
  try {
    fd = openSync(filePath, "r");
    const size = fstatSync(fd).size;
    const tailLength = Math.min(size, 66 * 1024);
    if (tailLength < 22) return { error: "el archivo es demasiado pequeño para ser un ZIP" };
    const tail = Buffer.alloc(tailLength);
    readSync(fd, tail, 0, tailLength, size - tailLength);

    let eocd = -1;
    for (let index = tail.length - 22; index >= 0; index -= 1) {
      if (tail.readUInt32LE(index) === ZIP_EOCD_SIG) {
        eocd = index;
        break;
      }
    }
    if (eocd < 0) return { error: "no es un ZIP válido (sin registro EOCD)" };

    const entries = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (cdOffset === 0xffffffff || cdSize === 0xffffffff) {
      return { error: "ZIP64 no soportado" };
    }
    if (cdOffset + cdSize > size) return { error: "directorio central fuera del archivo" };

    const cd = Buffer.alloc(cdSize);
    readSync(fd, cd, 0, cdSize, cdOffset);

    let cursor = 0;
    for (let index = 0; index < entries && cursor + 46 <= cd.length; index += 1) {
      if (cd.readUInt32LE(cursor) !== ZIP_CD_SIG) {
        return { error: "directorio central corrupto" };
      }
      const method = cd.readUInt16LE(cursor + 10);
      const compressedSize = cd.readUInt32LE(cursor + 20);
      const nameLength = cd.readUInt16LE(cursor + 28);
      const extraLength = cd.readUInt16LE(cursor + 30);
      const commentLength = cd.readUInt16LE(cursor + 32);
      const localOffset = cd.readUInt32LE(cursor + 42);
      const name = cd.toString("utf8", cursor + 46, cursor + 46 + nameLength);
      cursor += 46 + nameLength + extraLength + commentLength;
      if (name !== entryName) continue;

      const local = Buffer.alloc(30);
      readSync(fd, local, 0, 30, localOffset);
      if (local.readUInt32LE(0) !== ZIP_LOCAL_SIG) {
        return { error: "cabecera local corrupta" };
      }
      const dataOffset =
        localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      const raw = Buffer.alloc(compressedSize);
      readSync(fd, raw, 0, compressedSize, dataOffset);
      if (method === 0) return { data: raw };
      if (method === 8) return { data: inflateRawSync(raw) };
      return { error: `compresión ZIP no soportada (método ${method})` };
    }
    return { error: `${entryName} no está dentro del APK` };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (fd >= 0) {
      try {
        closeSync(fd);
      } catch {
        // El descriptor ya estaba cerrado: nada que hacer.
      }
    }
  }
}

/**
 * Versión con la que se compiló el APK, leída de assets/web/version.json
 * (scripts/write-version.mjs la escribe antes de empaquetar el bundle web).
 * Devuelve { version, error }; `version` vacío significa que no se pudo leer.
 */
export function readApkVersion(apkPath) {
  const entry = readZipEntry(apkPath, APK_VERSION_ENTRY);
  if (!entry.data) return { version: "", error: entry.error || "no se pudo leer el APK" };
  try {
    const parsed = JSON.parse(entry.data.toString("utf8"));
    const version = typeof parsed?.version === "string" ? parsed.version.trim() : "";
    if (!version) return { version: "", error: `${APK_VERSION_ENTRY} no declara version` };
    return { version, error: "" };
  } catch (error) {
    return {
      version: "",
      error: `${APK_VERSION_ENTRY} no es JSON válido (${error instanceof Error ? error.message : error})`
    };
  }
}

function sha(filePath, algorithm) {
  return createHash(algorithm).update(readFileSync(filePath)).digest();
}

/** Versión de package.json sin modificar nada (solo lectura). */
export function readPackageVersion(root = ROOT) {
  try {
    const parsed = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    return typeof parsed.version === "string" ? parsed.version.trim() : "";
  } catch {
    return "";
  }
}

/**
 * Compara la versión del release con package.json y con el tag del pipeline.
 * Función pura: no toca el disco y no lanza.
 */
export function validateTagVersion({ tag, version, packageVersion } = {}) {
  const issues = [];
  const releaseVersion = typeof version === "string" ? version.trim() : "";
  if (!SEMVER_RE.test(releaseVersion)) {
    issues.push(`Versión inválida: "${version}". Usa x.y.z o x.y.z-beta.N.`);
  }
  if (packageVersion !== undefined) {
    const pkg = String(packageVersion).trim();
    if (!SEMVER_RE.test(pkg)) {
      issues.push(`package.json tiene una versión no válida: "${pkg}".`);
    } else if (pkg !== releaseVersion) {
      issues.push(
        `La versión del release (${releaseVersion || "vacía"}) no coincide con package.json (${pkg}).`
      );
    }
  }
  if (tag !== undefined) {
    const value = String(tag).trim();
    if (!TAG_RE.test(value)) {
      issues.push(`Tag inválido: "${tag}". Debe ser v${releaseVersion || "x.y.z"}.`);
    } else if (value !== `v${releaseVersion}`) {
      issues.push(
        `El tag ${value} no coincide con la versión ${releaseVersion}; etiqueta como v${releaseVersion}.`
      );
    }
  }
  return { ok: issues.length === 0, version: releaseVersion, issues };
}

function unquote(value) {
  const text = value.trim();
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
      return text.slice(1, -1);
    }
  }
  return text;
}

/** Lector mínimo de latest.yml con las claves que usa electron-updater. */
export function parseLatestYml(text) {
  const result = { files: [] };
  let inFiles = false;
  let current = null;
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (/^\s/.test(rawLine)) {
      if (!inFiles) continue;
      const item = /^-\s+([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
      if (item) {
        current = { [item[1]]: unquote(item[2]) };
        result.files.push(current);
        continue;
      }
      if (current) {
        const match = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
        if (match) current[match[1]] = unquote(match[2]);
      }
      continue;
    }
    inFiles = line === "files:";
    current = null;
    if (!inFiles) {
      const match = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
      if (match && match[2] !== "") result[match[1]] = unquote(match[2]);
    }
  }
  return result;
}

function sizeOf(filePath) {
  try {
    const stats = statSync(filePath);
    return stats.isFile() ? stats.size : -1;
  } catch {
    return -1;
  }
}

function readJsonObject(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

/** Espejo de src/services/license/canonicalJson.ts (mismo texto firmado). */
export function canonicalJson(value) {
  if (value === null) return "null";
  const type = typeof value;
  if (type === "string") return JSON.stringify(value);
  if (type === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Número no finito en JSON canónico");
    return JSON.stringify(value);
  }
  if (type === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
  }
  if (type === "object") {
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new TypeError(`Tipo no serializable en JSON canónico: ${type}`);
}

/** Texto firmado del manifiesto: canónico, con keyId y sin signature. */
export function manifestSigningInput(manifest) {
  const { signature: _ignored, ...signable } = manifest;
  return canonicalJson(signable);
}

/**
 * Verifica la firma ES256 del manifiesto con una clave pública PEM (SPKI).
 * Devuelve { ok, error } y nunca lanza.
 */
export function verifyManifestSignature(manifest, publicKeyPem) {
  if (typeof manifest?.signature !== "string" || !manifest.signature) {
    return { ok: false, error: "el manifiesto no trae signature" };
  }
  let publicKey;
  try {
    publicKey = createPublicKey(publicKeyPem);
  } catch (error) {
    return {
      ok: false,
      error: `la clave pública no es válida (${error instanceof Error ? error.message : error})`
    };
  }
  if (publicKey.asymmetricKeyType !== "ec") {
    return { ok: false, error: "la clave pública no es EC P-256" };
  }
  try {
    const signature = Buffer.from(manifest.signature, "base64url");
    const input = Buffer.from(manifestSigningInput(manifest), "utf8");
    const ok = verify("sha256", input, { key: publicKey, dsaEncoding: "ieee-p1363" }, signature);
    return ok ? { ok: true, error: "" } : { ok: false, error: "la firma no verifica" };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Verificación completa. Devuelve { ok, version, channel, dir, lanApks, checks,
 * issues, warnings }. No imprime ni termina el proceso: la CLI y los tests
 * comparten esta función. `lanApks` son los APK de red local detectados en el
 * directorio de publicación (siempre vacío en un release válido).
 */
export function checkReleaseAssets(options = {}) {
  const root = options.root ? path.resolve(options.root) : ROOT;
  const dir = path.resolve(options.dir || path.join(root, "release"));
  const checks = [];
  const issues = [];
  const warnings = [];
  const pass = (message) => checks.push({ ok: true, message });
  const fail = (message) => {
    checks.push({ ok: false, message });
    issues.push(message);
  };
  const warn = (message) => warnings.push(message);

  const packageVersion = options.packageVersion ?? readPackageVersion(root);
  const version = String(options.version || packageVersion || "").trim();
  const channel = version.includes("-beta") ? "beta" : "stable";

  // 1. Versión y tag.
  const tagCheck = validateTagVersion({
    version,
    packageVersion: packageVersion || undefined,
    tag: options.tag
  });
  if (tagCheck.ok) {
    pass(
      `versión ${version}` +
        (packageVersion ? " = package.json" : "") +
        (options.tag ? ` = tag ${options.tag}` : "")
    );
  } else {
    for (const message of tagCheck.issues) fail(message);
  }

  // 2. Carpeta y archivos obligatorios.
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    fail(`No existe la carpeta de artefactos: ${dir}`);
    return { ok: false, version, channel, dir, lanApks: [], checks, issues, warnings };
  }

  const required = [...REQUIRED_FILES];
  const latestPath = options.latestPath
    ? path.resolve(options.latestPath)
    : path.join(dir, LATEST);
  for (const name of required) {
    const filePath = name === LATEST ? latestPath : path.join(dir, name);
    const bytes = sizeOf(filePath);
    if (bytes <= 0) {
      fail(
        `Falta o está vacío: ${name}` +
          `${bytes === 0 ? " (0 bytes)" : ""}` +
          `${name === LATEST && options.latestPath ? ` en ${latestPath}` : ""}`
      );
    } else {
      pass(`${name} presente (${bytes} bytes)`);
    }
  }

  // 2b. Ningún APK de red local puede quedar en el directorio de publicación.
  // Aunque latest.yml y el manifiesto apunten al nombre estable, un *LAN*.apk
  // suelto se subiría al Release con el resto de artefactos.
  let lanApks = [];
  try {
    lanApks = lanApksIn(readdirSync(dir));
  } catch (error) {
    fail(`No se pudo listar ${dir}: ${error instanceof Error ? error.message : error}`);
  }
  if (lanApks.length > 0) {
    fail(
      `APK de red local en el directorio de publicación: ${lanApks.join(", ")}. ` +
        "El APK LAN habilita cleartext hacia el hub HTTP y nunca se publica."
    );
  } else {
    pass("sin APK de red local (*LAN*.apk) en el directorio de publicación");
  }

  // 2c. El APK publicado debe ser el de esta versión. Se lee la versión que
  // write-version.mjs dejó en assets/web/version.json dentro del propio APK:
  // un APK viejo junto a un manifiesto nuevo instalaría código desactualizado.
  const apkPath = path.join(dir, APK);
  if (sizeOf(apkPath) > 0) {
    const apkVersion = readApkVersion(apkPath);
    if (!apkVersion.version) {
      fail(`No se pudo verificar la versión de ${APK}: ${apkVersion.error}.`);
    } else if (apkVersion.version !== version) {
      fail(
        `El APK se compiló con v${apkVersion.version} y el release/manifiesto declara ` +
          `v${version}; vuelve a ejecutar android/build-apk.sh antes de publicar.`
      );
    } else {
      pass(`${APK} compilado con v${apkVersion.version} (alineado con el manifiesto)`);
    }
  }

  // 3. latest.yml (en <dir> o en la ruta explícita de --latest-yml).
  let latest = null;
  if (sizeOf(latestPath) > 0) {
    try {
      latest = parseLatestYml(readFileSync(latestPath, "utf8"));
    } catch (error) {
      fail(`No se pudo leer ${LATEST}: ${error instanceof Error ? error.message : error}`);
    }
  }
  if (latest) {
    if (latest.version !== version) {
      fail(`${LATEST} declara v${latest.version ?? "?"} y se esperaba v${version}.`);
    } else {
      pass(`${LATEST} declara v${version}`);
    }
    if (latest.path !== SETUP) {
      fail(`${LATEST} apunta a "${latest.path ?? ""}" y no a ${SETUP}.`);
    } else if (sizeOf(path.join(dir, String(latest.path))) <= 0) {
      // Un path válido que no existe dejaría al updater con un 404.
      fail(`${LATEST} apunta a ${SETUP}, que no existe en el directorio de publicación.`);
    } else {
      pass(`${LATEST} apunta a ${SETUP} (presente)`);
    }
    if (!Array.isArray(latest.files) || latest.files.length === 0) {
      fail(`${LATEST} no declara la lista files de electron-updater.`);
    } else if (latest.files[0].url !== SETUP) {
      fail(`${LATEST} lista "${latest.files[0].url}" como primer archivo y no ${SETUP}.`);
    } else {
      pass(`${LATEST} lista ${SETUP} (${latest.files.length} archivo(s))`);
    }

    const setupPath = path.join(dir, SETUP);
    if (sizeOf(setupPath) > 0) {
      const actualSha512 = sha(setupPath, "sha512").toString("base64");
      if (typeof latest.sha512 !== "string" || !SHA512_BASE64_RE.test(latest.sha512)) {
        fail(`${LATEST} no declara un sha512 con formato válido.`);
      } else if (latest.sha512 !== actualSha512) {
        fail(`${LATEST} declara un sha512 que no corresponde al ${SETUP} real.`);
      } else {
        pass(`${LATEST} sha512 del Setup coincide`);
      }
    }

    for (const entry of latest.files ?? []) {
      const url = typeof entry.url === "string" ? entry.url.trim() : "";
      if (!url) {
        fail(`${LATEST} tiene una entrada sin url.`);
        continue;
      }
      if (isLanApkName(url)) {
        fail(`${LATEST} referencia el APK de red local "${url}"; no se publica.`);
        continue;
      }
      if (url !== path.posix.basename(url) || url.includes("\\")) {
        fail(`${LATEST} referencia una ruta no permitida: "${url}".`);
        continue;
      }
      const entryPath = path.join(dir, url);
      const bytes = sizeOf(entryPath);
      if (bytes <= 0) {
        fail(`${LATEST} referencia ${url}, que no se publica en este release.`);
        continue;
      }
      if (entry.size === undefined || entry.size === null || String(entry.size).trim() === "") {
        fail(
          `${LATEST} no declara size para ${url} (electron-builder con differentialPackage:false ` +
            "lo omite) y el verificador pre-instalación no podrá rechazar tamaños erróneos. " +
            "Parchea el valor real con: " +
            `node scripts/verify-release-assets.mjs --dir ${dir} --patch-latest-size --sums <SHA256SUMS>`
        );
      } else if (Number(entry.size) !== bytes) {
        fail(`${LATEST} declara size=${entry.size} para ${url} y pesa ${bytes}.`);
      }
      if (typeof entry.sha512 === "string" && SHA512_BASE64_RE.test(entry.sha512)) {
        if (entry.sha512 !== sha(entryPath, "sha512").toString("base64")) {
          fail(`${LATEST} declara un sha512 que no corresponde a ${url}.`);
        }
      }
    }
  }

  // 4. Manifiesto firmado (opcional salvo --require-manifest).
  const manifestPath = path.resolve(options.manifestPath || path.join(dir, MANIFEST));
  const manifestBytes = sizeOf(manifestPath);
  let manifest = null;
  if (manifestBytes <= 0) {
    if (options.requireManifest) {
      fail(`Falta o está vacío: ${path.basename(manifestPath)}`);
    } else {
      warn(`Sin ${MANIFEST}: no se validan hashes del APK ni la firma del actualizador.`);
    }
  } else {
    try {
      manifest = readJsonObject(manifestPath);
    } catch (error) {
      fail(`No se pudo leer ${path.basename(manifestPath)}: ${error instanceof Error ? error.message : error}`);
    }
  }

  if (manifest) {
    if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
      fail("El manifiesto no es un objeto JSON.");
    } else {
      if (manifest.v !== 1) fail(`Versión de contrato del manifiesto no soportada: ${manifest.v}.`);
      if (manifest.version !== version) {
        fail(`El manifiesto declara v${manifest.version} y se esperaba v${version}.`);
      } else {
        pass(`manifiesto declara v${version}`);
      }
      if (manifest.channel !== channel) {
        fail(`El manifiesto es del canal ${manifest.channel} y se esperaba ${channel}.`);
      }
      if (!Number.isInteger(manifest.rollout) || manifest.rollout < 0 || manifest.rollout > 100) {
        fail(`rollout inválido en el manifiesto: ${manifest.rollout}.`);
      }
      if (typeof manifest.releasedAt !== "string" || Number.isNaN(Date.parse(manifest.releasedAt))) {
        fail("releasedAt del manifiesto no es una fecha ISO válida.");
      }

      if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
        fail("El manifiesto no declara artefactos.");
      } else {
        const seen = new Set();
        for (const artifact of manifest.artifacts) {
          const platform = artifact?.platform;
          if (!PLATFORM_EXTENSIONS[platform]) {
            fail(`Plataforma inválida en el manifiesto: "${platform}".`);
            continue;
          }
          if (seen.has(platform)) fail(`El manifiesto repite la plataforma ${platform}.`);
          seen.add(platform);

          // windows y android usan nombre estable; el artefacto web (.zip OTA)
          // se publica con su nombre de bundle y se verifica contra ese archivo.
          const expectedName = platform === "web" ? artifact.name : STABLE_NAMES[platform];
          if (isLanApkName(artifact.name)) {
            fail(
              `El manifiesto publica un APK de red local para ${platform}: "${artifact.name}". ` +
                "El APK LAN nunca se sirve como descarga pública."
            );
            continue;
          }
          if (platform !== "web" && artifact.name !== expectedName) {
            fail(`Nombre no estable para ${platform}: "${artifact.name}" (se esperaba ${expectedName}).`);
            continue;
          }
          if (!PLATFORM_EXTENSIONS[platform].test(expectedName)) {
            fail(
              `El artefacto de ${platform} debe terminar en ` +
                `${platform === "windows" ? ".exe" : platform === "android" ? ".apk" : ".zip"}: "${expectedName}".`
            );
            continue;
          }

          let url = null;
          try {
            url = new URL(String(artifact.url));
          } catch {
            fail(`URL inválida para ${platform}: "${artifact.url}".`);
            continue;
          }
          if (url.protocol !== "https:") {
            fail(`La URL de ${platform} debe ser https: "${artifact.url}".`);
          }
          let urlName = "";
          try {
            urlName = decodeURIComponent(path.posix.basename(url.pathname));
          } catch {
            fail(`La URL de ${platform} no se puede decodificar.`);
          }
          if (urlName !== expectedName) {
            fail(`La URL de ${platform} apunta a "${urlName}" y no a ${expectedName}.`);
          }
          if (isLanApkName(urlName)) {
            fail(`La URL de ${platform} apunta al APK de red local "${urlName}"; no se publica.`);
          }
          if (!url.pathname.includes(`/v${version}/`)) {
            fail(`La URL de ${platform} no cuelga de la etiqueta v${version}.`);
          }

          const filePath = path.join(dir, expectedName);
          const bytes = sizeOf(filePath);
          if (bytes <= 0) {
            fail(`El manifiesto declara ${expectedName}, que no está en ${dir}.`);
            continue;
          }
          if (artifact.bytes !== bytes) {
            fail(
              `Tamaño de ${expectedName} distinto al manifiesto: ` +
                `disco=${bytes}, manifiesto=${artifact.bytes}.`
            );
          }
          if (typeof artifact.sha256 !== "string" || !SHA256_RE.test(artifact.sha256)) {
            fail(`sha256 inválido en el manifiesto para ${platform}.`);
          } else {
            const actual = sha(filePath, "sha256").toString("hex");
            if (actual !== artifact.sha256) {
              fail(
                `sha256 de ${expectedName} no coincide con el manifiesto: ` +
                  `disco=${actual}, manifiesto=${artifact.sha256}.`
              );
            } else {
              pass(`${expectedName} sha256 y tamaño coinciden con el manifiesto`);
            }
          }
        }
        for (const platform of Object.keys(STABLE_NAMES)) {
          if (!seen.has(platform)) fail(`El manifiesto no incluye la plataforma ${platform}.`);
        }
      }

      // 5. Firma ES256 del manifiesto.
      const hasSignature = typeof manifest.signature === "string" && manifest.signature.trim() !== "";
      if (options.requireSignature) {
        if (!hasSignature) {
          fail(
            "El manifiesto no tiene firma ES256 y este release la exige. " +
              "Define UPDATE_MANIFEST_KEY_JWK antes de publicar."
          );
        } else if (!SIGNATURE_RE.test(manifest.signature)) {
          fail("La firma del manifiesto no parece un base64url ES256 válido (86 caracteres).");
        } else if (manifest.keyId !== undefined && typeof manifest.keyId !== "string") {
          fail("keyId del manifiesto no es texto.");
        } else {
          pass(`manifiesto firmado (${manifest.signature.length} caracteres base64url)`);
        }
      } else if (!hasSignature) {
        warn("El manifiesto no está firmado: los clientes no podrán autenticarlo.");
      } else {
        pass("manifiesto firmado");
      }

      // 5b. Verificación criptográfica opcional con --public-key.
      let publicKeyPem = options.publicKeyPem ? String(options.publicKeyPem) : "";
      if (!publicKeyPem && options.publicKey) {
        try {
          publicKeyPem = readFileSync(path.resolve(options.publicKey), "utf8");
        } catch (error) {
          fail(
            `No se pudo leer la clave pública ${options.publicKey}: ` +
              `${error instanceof Error ? error.message : error}.`
          );
        }
      }
      if (publicKeyPem) {
        const verification = verifyManifestSignature(manifest, publicKeyPem);
        if (!verification.ok) {
          fail(
            `La firma del manifiesto no verifica con la clave pública indicada: ` +
              `${verification.error}. Revisa que UPDATE_SIGNING_KEY corresponda a esa clave.`
          );
        } else {
          pass("firma ES256 verificada con la clave pública");
        }
      } else if (options.requireSignature) {
        warn(
          "Firma comprobada solo por formato; pasa --public-key para verificar la criptografía."
        );
      }
    }
  }

  // 6. Blockmap (actualización diferencial).
  const blockmapPath = path.join(dir, SETUP_BLOCKMAP);
  const blockmapBytes = sizeOf(blockmapPath);
  const blockmapEntry =
    latest && Array.isArray(latest.files)
      ? latest.files.find((entry) => /\.blockmap$/.test(String(entry?.url ?? "")))
      : undefined;
  if (blockmapBytes > 0) {
    pass(`${SETUP_BLOCKMAP} presente (${blockmapBytes} bytes)`);
    if (blockmapEntry && Number(blockmapEntry.size) !== blockmapBytes) {
      fail(
        `${LATEST} declara size=${blockmapEntry.size} para ${SETUP_BLOCKMAP} y pesa ${blockmapBytes}.`
      );
    } else if (!blockmapEntry) {
      warn(`${SETUP_BLOCKMAP} no aparece en ${LATEST}; electron-updater hará descarga completa.`);
    }
  } else if (blockmapEntry) {
    fail(`${LATEST} referencia ${blockmapEntry.url}, que no está en el release.`);
  } else if (options.requireBlockmap) {
    fail(
      `Falta ${SETUP_BLOCKMAP}: electron-builder tiene la actualización diferencial activa ` +
        "(nsis.differentialPackage distinto de false) y el release debe publicarlo."
    );
  } else {
    warn(
      `Sin ${SETUP_BLOCKMAP}: actualización diferencial desactivada ` +
        "(nsis.differentialPackage=false en electron-builder.yml)."
    );
  }

  return { ok: issues.length === 0, version, channel, dir, lanApks, checks, issues, warnings };
}

/** Informe legible, una línea por comprobación. */
export function formatReport(result) {
  const lines = [
    `[check-release-assets] Release v${result.version || "?"} (${result.channel || "?"}) · ${result.dir}`
  ];
  for (const check of result.checks ?? []) {
    lines.push(`  ${check.ok ? "OK   " : "FALLA"} ${check.message}`);
  }
  for (const warning of result.warnings ?? []) {
    lines.push(`  AVISO ${warning}`);
  }
  lines.push(
    result.ok
      ? `Resultado: OK (${(result.checks ?? []).length} comprobaciones)`
      : `Resultado: FALLA (${(result.issues ?? []).length} problema(s))`
  );
  return lines.join("\n");
}

function printHelp() {
  console.log(`Comprueba los artefactos de un Release de PALMYRA.

Opciones:
  --dir <carpeta>        Carpeta con Setup, APK y latest.yml (por defecto release).
  --version <x.y.z>      Versión esperada (por defecto, la de package.json).
  --tag <vX.Y.Z>         Tag del pipeline; debe ser v<versión>.
  --manifest <archivo>   Manifiesto firmado (por defecto <dir>/update-manifest.json).
  --latest-yml <archivo> latest.yml explícito (por defecto <dir>/latest.yml).
  --public-key <archivo> Clave pública PEM (SPKI) para verificar la firma ES256.
  --require-manifest     Falla si el manifiesto no existe.
  --require-signature    Falla si el manifiesto no trae firma ES256.
  --require-blockmap     Falla si falta el .blockmap del Setup.
  --root <carpeta>       Raíz del repo para leer package.json.
  --help                 Esta ayuda.`);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (!raw.startsWith("--")) return { error: `Argumento no reconocido: ${raw}` };
    const separator = raw.indexOf("=");
    const flag = separator === -1 ? raw : raw.slice(0, separator);
    const inline = separator === -1 ? undefined : raw.slice(separator + 1);
    const readValue = () => {
      if (inline !== undefined) return { value: inline };
      index += 1;
      if (index >= argv.length) return { error: `Falta el valor de ${flag}.` };
      return { value: argv[index] };
    };
    switch (flag) {
      case "--dir":
      case "--version":
      case "--tag":
      case "--manifest":
      case "--latest-yml":
      case "--public-key":
      case "--root": {
        const read = readValue();
        if (read.error) return { error: read.error };
        options[flag.slice(2)] = read.value;
        break;
      }
      case "--require-manifest":
        options.requireManifest = true;
        break;
      case "--require-signature":
        options.requireSignature = true;
        break;
      case "--require-blockmap":
        options.requireBlockmap = true;
        break;
      case "--help":
        options.help = true;
        break;
      default:
        return { error: `Argumento no reconocido: ${flag}` };
    }
  }
  return { options };
}

/** CLI sin side effects de proceso: devuelve el código de salida. */
export function runCli(argv = [], io = {}) {
  const out = io.out ?? ((line) => console.log(line));
  const err = io.err ?? ((line) => console.error(line));
  const parsed = parseArgs(argv);
  if (parsed.error) {
    err(`[check-release-assets] ${parsed.error}`);
    return 1;
  }
  const options = parsed.options;
  if (options.help) {
    printHelp();
    return 0;
  }
  if (options.manifest) options.manifestPath = options.manifest;
  if (options["latest-yml"]) options.latestPath = options["latest-yml"];
  if (options["public-key"]) options.publicKey = options["public-key"];
  const result = checkReleaseAssets(options);
  out(formatReport(result));
  return result.ok ? 0 : 1;
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (entry === import.meta.url) {
  process.exit(runCli(process.argv.slice(2)));
}
