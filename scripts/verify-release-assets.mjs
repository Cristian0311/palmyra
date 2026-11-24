#!/usr/bin/env node
/**
 * Verifica los artefactos de un Release de PALMYRA antes de publicarlos.
 *
 * Node ESM sin dependencias. Comprueba, en este orden:
 *   1. La versión del manifiesto es la de package.json y el tag del pipeline.
 *   2. Existen PALMYRA-POS-Setup.exe, latest.yml y PALMYRA-Android.apk, con
 *      tamaño > 0 y sin artefactos extra (p. ej. .blockmap).
 *   3. El sha256 y los bytes de cada artefacto coinciden con el manifiesto y la
 *      URL apunta a la etiqueta v<versión>.
 *   4. latest.yml declara la misma versión y el sha512/tamaño reales del Setup.
 *   5. SHA256SUMS cubre los archivos publicados con los mismos hashes.
 *   6. Con --require-signature, el manifiesto trae firma ES256; con
 *      --public-key <pem>, además se verifica criptográficamente.
 *   7. Con --web-zip <archivo>, el ZIP OTA se verifica contra el artefacto web
 *      del manifiesto firmado (falla si el manifiesto no lo declara).
 *   8. Con --patch-latest-size, se parchea el `size` que electron-builder omite
 *      (differentialPackage:false) con el byte real del archivo y se regenera
 *      SHA256SUMS con los hashes FINALES: es el paso post `desktop:dist`.
 *
 * Uso:
 *   node scripts/verify-release-assets.mjs \
 *     --dir artifacts --manifest update-manifest.json --sums SHA256SUMS \
 *     --version 1.3.5 --channel stable --require-signature \
 *     [--public-key update-public.pem] [--web-zip palmyra-web-1.3.5.zip] \
 *     [--patch-latest-size]
 */

import { createHash, createPublicKey, verify } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SETUP = "PALMYRA-POS-Setup.exe";
const APK = "PALMYRA-Android.apk";
const LATEST = "latest.yml";
const MANIFEST_NAME = "update-manifest.json";
/** Nombre estable por plataforma: es lo que sirve /download/* y latest.yml. */
const STABLE_NAMES = { windows: SETUP, android: APK };
const REQUIRED_IN_DIR = [SETUP, LATEST, APK];
const SEMVER_RE = /^\d+\.\d+\.\d+(-beta(?:\.\d+)?)?$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

function fail(message) {
  console.error(`[verify-release-assets] ${message}`);
  process.exit(1);
}

function ok(message) {
  console.log(`[verify-release-assets] ${message}`);
}

function printHelp() {
  console.log(`Verifica los artefactos de un Release de PALMYRA.

Opciones:
  --dir <carpeta>        Carpeta con el Setup, latest.yml y el APK (por defecto artifacts).
  --manifest <archivo>   Manifiesto firmado (por defecto update-manifest.json).
  --sums <archivo>       SHA256SUMS a comprobar (con --patch-latest-size, a regenerar).
  --version <x.y.z>      Versión esperada del tag (por defecto, la de package.json).
  --channel <stable|beta> Canal esperado (por defecto, derivado de la versión).
  --require-signature    Exige que el manifiesto traiga firma ES256.
  --public-key <archivo> Clave pública PEM (SPKI) para verificar la firma ES256.
  --web-zip <archivo>    ZIP OTA a verificar contra el artefacto web del manifiesto.
  --patch-latest-size    Parchea el size real en latest.yml y regenera SHA256SUMS
                         (paso posterior a electron-builder, que omite el size con
                         differentialPackage:false). Exige --sums.
  --help                 Esta ayuda.`);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (!raw.startsWith("--")) fail(`Argumento no reconocido: ${raw}`);
    const separator = raw.indexOf("=");
    const flag = separator === -1 ? raw : raw.slice(0, separator);
    let inline = separator === -1 ? undefined : raw.slice(separator + 1);
    const readValue = () => {
      if (inline !== undefined) return inline;
      index += 1;
      if (index >= argv.length) fail(`Falta el valor de ${flag}.`);
      return argv[index];
    };
    switch (flag) {
      case "--dir":
        options.dir = readValue();
        break;
      case "--manifest":
        options.manifest = readValue();
        break;
      case "--sums":
        options.sums = readValue();
        break;
      case "--version":
        options.version = readValue();
        break;
      case "--channel":
        options.channel = readValue();
        break;
      case "--public-key":
        options.publicKey = readValue();
        break;
      case "--web-zip":
        options.webZip = readValue();
        break;
      case "--require-signature":
        options.requireSignature = true;
        break;
      case "--patch-latest-size":
        options.patchLatestSize = true;
        break;
      case "--help":
        printHelp();
        process.exit(0);
        break;
      default:
        fail(`Argumento no reconocido: ${flag}`);
    }
  }
  return options;
}

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`No se pudo leer ${filePath}: ${error instanceof Error ? error.message : error}`);
  }
}

function hashFile(filePath, algorithm) {
  return createHash(algorithm).update(readFileSync(filePath)).digest();
}

function requireFile(filePath, label) {
  if (!existsSync(filePath)) fail(`No existe ${label || filePath}.`);
  const stats = statSync(filePath);
  if (!stats.isFile()) fail(`${label || filePath} no es un archivo.`);
  if (stats.size <= 0) fail(`${label || filePath} está vacío (0 bytes).`);
  return stats.size;
}

/** Lector mínimo de latest.yml (solo las claves que usa electron-updater). */
function parseLatestYml(text) {
  const result = { files: [] };
  let inFiles = false;
  let current = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const indented = /^\s/.test(rawLine);
    if (!indented) {
      inFiles = line === "files:";
      current = null;
      if (!inFiles) {
        const match = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
        if (match && match[2] !== "") result[match[1]] = unquote(match[2]);
      }
      continue;
    }
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
  }
  return result;
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

/** SHA256SUMS: "<hex>  <nombre>" (dos espacios o " *" de modo binario). */
function parseSums(filePath) {
  const sums = new Map();
  for (const rawLine of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "") continue;
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
    if (!match) fail(`Línea inválida en ${path.basename(filePath)}: "${line}"`);
    const name = match[2].trim();
    if (name !== path.posix.basename(name) || name.includes("\\")) {
      fail(`SHA256SUMS contiene una ruta no permitida: "${name}".`);
    }
    if (sums.has(name)) fail(`SHA256SUMS repite ${name}.`);
    sums.set(name, match[1]);
  }
  return sums;
}

/** Espejo de src/services/updates/verify.ts (mismo texto firmado). */
function canonicalJson(value) {
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
function manifestSigningInput(manifest) {
  const { signature: _ignored, ...signable } = manifest;
  return canonicalJson(signable);
}

/** Verifica la firma ES256 del manifiesto con una clave pública PEM (SPKI). */
function verifyManifestSignature(manifest, publicKeyPem) {
  if (typeof manifest?.signature !== "string" || manifest.signature.trim() === "") {
    fail("El manifiesto no trae firma ES256; --public-key exige un manifiesto firmado.");
  }
  let publicKey;
  try {
    publicKey = createPublicKey(publicKeyPem);
  } catch (error) {
    fail(
      `La clave pública no es válida: ${error instanceof Error ? error.message : error}.`
    );
  }
  if (publicKey.asymmetricKeyType !== "ec") {
    fail("La clave pública no es EC P-256.");
  }
  try {
    const input = Buffer.from(manifestSigningInput(manifest), "utf8");
    const signature = Buffer.from(manifest.signature, "base64url");
    const valid = verify(
      "sha256",
      input,
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      signature
    );
    if (!valid) {
      fail(
        "La firma del manifiesto no verifica con la clave pública indicada. " +
          "Revisa que la clave de firma corresponda a esta clave pública."
      );
    }
    ok("firma ES256 verificada con la clave pública");
  } catch (error) {
    fail(
      `No se pudo verificar la firma ES256: ${error instanceof Error ? error.message : error}.`
    );
  }
}

/**
 * Parchea en latest.yml el `size` de cada entrada de `files` con el byte real
 * del archivo en disco. electron-builder con differentialPackage:false omite el
 * campo size; sin él, el verificador pre-instalación no puede rechazar
 * descargas con tamaño erróneo. Devuelve el número de entradas parcheadas.
 */
function patchLatestYmlSizes(latestPath, parsed, artifactDir) {
  const original = readFileSync(latestPath, "utf8");
  const newline = original.includes("\r\n") ? "\r\n" : "\n";
  const lines = original.split(/\r?\n/);
  const entries = new Map((parsed.files ?? []).map((entry) => [entry.url, entry]));
  const out = [];
  let patched = 0;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const item = /^(\s*)-\s+url:\s*(.*)$/.exec(line);
    if (item && entries.has(unquote(item[2].trim()))) {
      const indent = item[1];
      const childIndent = `${indent}  `;
      const url = unquote(item[2].trim());
      const filePath = path.join(artifactDir, url);
      const bytes = existsSync(filePath) && statSync(filePath).isFile()
        ? statSync(filePath).size
        : null;
      out.push(line);
      index += 1;
      let sawSize = false;
      while (index < lines.length) {
        const next = lines[index];
        const nextItem = /^\s*-\s+url:/.test(next);
        const unindented = next.trim() !== "" && !/^\s/.test(next);
        if (nextItem || unindented) break;
        if (/^\s*size:\s*/.test(next)) {
          sawSize = true;
          const declared = unquote(next.replace(/^\s*size:\s*/, "").trim());
          if (bytes !== null && declared !== String(bytes)) {
            out.push(`${childIndent}size: ${bytes}`);
            patched += 1;
          } else {
            out.push(next);
          }
        } else {
          out.push(next);
        }
        index += 1;
      }
      if (!sawSize && bytes !== null) {
        out.push(`${childIndent}size: ${bytes}`);
        patched += 1;
      }
      continue;
    }
    out.push(line);
    index += 1;
  }
  if (patched > 0) {
    writeFileSync(latestPath, out.join(newline), "utf8");
  }
  return patched;
}

const options = parseArgs(process.argv.slice(2));

// La versión técnica es siempre la de package.json; el tag solo la confirma.
const packageJson = readJson(path.join(ROOT, "package.json"));
const pkgVersion = String(packageJson.version || "").trim();
if (!SEMVER_RE.test(pkgVersion)) {
  fail(`package.json tiene una versión no válida: "${pkgVersion}".`);
}
const version = (options.version || pkgVersion).trim();
if (version !== pkgVersion) {
  fail(`La versión del pipeline (${version}) no coincide con package.json (${pkgVersion}).`);
}

const derivedChannel = version.includes("-beta") ? "beta" : "stable";
const channel = (options.channel || derivedChannel).trim();
if (channel !== "stable" && channel !== "beta") {
  fail(`Canal inválido: "${channel}". Usa stable o beta.`);
}
if (channel !== derivedChannel) {
  fail(
    `El canal ${channel} no corresponde a la versión ${version} ` +
      `(se esperaba ${derivedChannel}).`
  );
}

const artifactDir = path.resolve(options.dir || "artifacts");
if (!existsSync(artifactDir) || !statSync(artifactDir).isDirectory()) {
  fail(`No existe la carpeta de artefactos: ${artifactDir}`);
}

const manifestPath = path.resolve(options.manifest || MANIFEST_NAME);
if (path.basename(manifestPath) !== MANIFEST_NAME) {
  fail(`El manifiesto debe publicarse como ${MANIFEST_NAME}.`);
}
requireFile(manifestPath, MANIFEST_NAME);

// 1. Manifiesto coherente con package.json y con la firma exigida.
const manifest = readJson(manifestPath);
if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
  fail("El manifiesto no es un objeto JSON.");
}
if (manifest.v !== 1) fail(`Versión de contrato del manifiesto no soportada: ${manifest.v}.`);
if (manifest.version !== pkgVersion) {
  fail(`El manifiesto declara v${manifest.version} y package.json v${pkgVersion}.`);
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
if (options.requireSignature) {
  if (typeof manifest.signature !== "string" || manifest.signature.trim() === "") {
    fail(
      "El manifiesto no tiene firma ES256 y este release la exige. " +
        "Define UPDATE_MANIFEST_KEY_JWK antes de publicar."
    );
  }
  // ECDSA P-256 en IEEE P1363 son 64 bytes -> 86 caracteres base64url.
  if (!/^[A-Za-z0-9_-]{80,}$/.test(manifest.signature)) {
    fail("La firma del manifiesto no parece un base64url ES256 válido.");
  }
  if (manifest.keyId !== undefined && typeof manifest.keyId !== "string") {
    fail("keyId del manifiesto no es texto.");
  }
}

// 1b. Verificación criptográfica real de la firma con --public-key.
if (options.publicKey) {
  let publicKeyPem;
  try {
    publicKeyPem = readFileSync(path.resolve(options.publicKey), "utf8");
  } catch (error) {
    fail(
      `No se pudo leer la clave pública ${options.publicKey}: ` +
        `${error instanceof Error ? error.message : error}.`
    );
  }
  verifyManifestSignature(manifest, publicKeyPem);
}

// 2. Artefactos obligatorios presentes, no vacíos y sin sobrantes.
for (const name of REQUIRED_IN_DIR) {
  requireFile(path.join(artifactDir, name), name);
}
const webArtifact = Array.isArray(manifest.artifacts)
  ? manifest.artifacts.find((item) => item?.platform === "web")
  : undefined;
const webZipPath = options.webZip ? path.resolve(options.webZip) : null;
if (webArtifact && !webZipPath) {
  fail(
    "El manifiesto declara un artefacto web y falta --web-zip <archivo> para " +
      "verificar que el ZIP OTA está cubierto por la firma."
  );
}
if (webZipPath && !webArtifact) {
  fail(
    "--web-zip apunta a un ZIP que el manifiesto firmado NO declara como " +
      "artefacto web; no se publica un bundle sin cobertura de firma."
  );
}
if (webArtifact && webZipPath && path.basename(webZipPath) !== webArtifact.name) {
  fail(
    `--web-zip es ${path.basename(webZipPath)} y el manifiesto declara ` +
      `${webArtifact.name}; el nombre del bundle debe coincidir con la URL firmada.`
  );
}
if (webArtifact && webZipPath) {
  requireFile(webZipPath, webArtifact.name);
}
const extras = [];
const sumsPath = options.sums ? path.resolve(options.sums) : null;
for (const entry of readdirSync(artifactDir)) {
  if (REQUIRED_IN_DIR.includes(entry)) continue;
  // El manifiesto y SHA256SUMS pueden vivir dentro de la carpeta si se generan ahí.
  if (path.resolve(artifactDir, entry) === manifestPath) continue;
  if (sumsPath !== null && path.resolve(artifactDir, entry) === sumsPath) continue;
  // El ZIP OTA es un asset publicable más; se verifica aparte contra la firma.
  if (webZipPath !== null && path.resolve(artifactDir, entry) === webZipPath) continue;
  // Un .blockmap publicado por error dejaría a electron-updater buscando un
  // asset que el release no tiene (la actualización diferencial fallaría).
  extras.push(entry);
}
if (extras.length > 0) {
  fail(`La carpeta de artefactos contiene archivos no publicables: ${extras.join(", ")}.`);
}

// 3. Cada artefacto del manifiesto coincide en nombre, URL, bytes y sha256.
if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
  fail("El manifiesto no declara artefactos.");
}
const seenPlatforms = new Set();
for (const artifact of manifest.artifacts) {
  const platform = artifact.platform;
  if (platform !== "web" && !Object.prototype.hasOwnProperty.call(STABLE_NAMES, platform)) {
    fail(`Plataforma inválida en el manifiesto: "${platform}".`);
  }
  if (seenPlatforms.has(platform)) {
    fail(`El manifiesto repite la plataforma ${platform}.`);
  }
  seenPlatforms.add(platform);

  // windows y android usan nombre estable; el bundle web se publica con su
  // nombre y se verifica contra --web-zip.
  const expectedName = platform === "web" ? artifact.name : STABLE_NAMES[platform];
  if (platform !== "web" && artifact.name !== expectedName) {
    fail(`Nombre no estable para ${platform}: "${artifact.name}" (se esperaba ${expectedName}).`);
  }
  if (platform === "web" && !/\.zip$/i.test(String(artifact.name))) {
    fail(`El artefacto web debe ser un .zip: "${artifact.name}".`);
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(String(artifact.url));
  } catch {
    fail(`URL inválida para ${platform}: "${artifact.url}".`);
  }
  if (parsedUrl.protocol !== "https:") {
    fail(`La URL de ${platform} debe ser https: "${artifact.url}".`);
  }
  let urlName = "";
  try {
    urlName = decodeURIComponent(path.posix.basename(parsedUrl.pathname));
  } catch {
    fail(`La URL de ${platform} no se puede decodificar: "${artifact.url}".`);
  }
  if (urlName !== expectedName) {
    fail(`La URL de ${platform} apunta a "${urlName}" y no a ${expectedName}.`);
  }
  if (!parsedUrl.pathname.includes(`/v${version}/`)) {
    fail(`La URL de ${platform} no cuelga de la etiqueta v${version}.`);
  }

  if (typeof artifact.sha256 !== "string" || !SHA256_RE.test(artifact.sha256)) {
    fail(`sha256 inválido en el manifiesto para ${platform}.`);
  }
  const filePath = platform === "web" ? webZipPath : path.join(artifactDir, expectedName);
  const stats = statSync(filePath);
  if (artifact.bytes !== stats.size) {
    fail(
      `Tamaño de ${expectedName} distinto al manifiesto: ` +
        `disco=${stats.size}, manifiesto=${artifact.bytes}.`
    );
  }
  const actualSha256 = hashFile(filePath, "sha256").toString("hex");
  if (actualSha256 !== artifact.sha256) {
    fail(
      `sha256 de ${expectedName} no coincide con el manifiesto: ` +
        `disco=${actualSha256}, manifiesto=${artifact.sha256}.`
    );
  }
}
for (const platform of Object.keys(STABLE_NAMES)) {
  if (!seenPlatforms.has(platform)) {
    fail(`El manifiesto no incluye la plataforma ${platform}.`);
  }
}

// 4. latest.yml describe exactamente el Setup que se publica.
const latestPath = path.join(artifactDir, LATEST);
if (options.patchLatestSize && !sumsPath) {
  fail("--patch-latest-size exige --sums <SHA256SUMS> para regenerar los hashes finales.");
}
let latestText = readFileSync(latestPath, "utf8");
if (options.patchLatestSize) {
  const patched = patchLatestYmlSizes(latestPath, parseLatestYml(latestText), artifactDir);
  latestText = readFileSync(latestPath, "utf8");
  if (patched > 0) {
    ok(`latest.yml parcheado: size del Setup ajustado al byte real (${patched} entrada(s)).`);
  } else {
    ok("latest.yml ya declaraba el size real del Setup.");
  }
}
const latest = parseLatestYml(latestText);
if (latest.version !== pkgVersion) {
  fail(`${LATEST} declara v${latest.version} y package.json v${pkgVersion}.`);
}
if (latest.path !== SETUP) {
  fail(`${LATEST} apunta a "${latest.path}" y no a ${SETUP}.`);
}
const setupPath = path.join(artifactDir, SETUP);
const setupSha512 = hashFile(setupPath, "sha512").toString("base64");
if (latest.sha512 !== setupSha512) {
  fail(`${LATEST} declara un sha512 que no corresponde al Setup publicado.`);
}
if (!Array.isArray(latest.files) || latest.files.length === 0) {
  fail(`${LATEST} no declara la lista files de electron-updater.`);
}
if (latest.files[0].url !== SETUP) {
  fail(`${LATEST} lista "${latest.files[0].url}" como primer archivo y no ${SETUP}.`);
}
for (const entry of latest.files) {
  if (typeof entry.url !== "string" || entry.url.trim() === "") {
    fail(`${LATEST} tiene una entrada sin url.`);
  }
  if (entry.url !== path.posix.basename(entry.url) || entry.url.includes("\\")) {
    fail(`${LATEST} referencia una ruta no permitida: "${entry.url}".`);
  }
  const entryPath = path.join(artifactDir, entry.url);
  if (!existsSync(entryPath)) {
    fail(`${LATEST} referencia ${entry.url}, que no se publica en este release.`);
  }
  const entryStats = statSync(entryPath);
  if (!Number.isInteger(Number(entry.size)) || Number(entry.size) !== entryStats.size) {
    fail(`${LATEST} declara size=${entry.size} para ${entry.url} y pesa ${entryStats.size}.`);
  }
  if (typeof entry.sha512 === "string" && entry.sha512 !== hashFile(entryPath, "sha512").toString("base64")) {
    fail(`${LATEST} declara un sha512 que no corresponde a ${entry.url}.`);
  }
}

// 5. SHA256SUMS cubre los archivos publicados con los hashes reales.
if (sumsPath !== null) {
  // Con --patch-latest-size, latest.yml cambió: los hashes viejos quedaron
  // obsoletos y se regeneran con los valores FINALES de los archivos.
  if (options.patchLatestSize) {
    const sumsEntries = [];
    for (const name of REQUIRED_IN_DIR) {
      sumsEntries.push({
        name,
        digest: hashFile(path.join(artifactDir, name), "sha256").toString("hex")
      });
    }
    sumsEntries.push({ name: MANIFEST_NAME, digest: hashFile(manifestPath, "sha256").toString("hex") });
    if (webArtifact && webZipPath) {
      sumsEntries.push({
        name: webArtifact.name,
        digest: hashFile(webZipPath, "sha256").toString("hex")
      });
    }
    writeFileSync(
      sumsPath,
      `${sumsEntries.map((entry) => `${entry.digest}  ${entry.name}`).join("\n")}\n`,
      "utf8"
    );
    ok(`SHA256SUMS regenerados con los hashes finales (${sumsEntries.length} archivos).`);
  }
  requireFile(sumsPath, path.basename(sumsPath));
  const sums = parseSums(sumsPath);
  const expected = new Map();
  for (const name of REQUIRED_IN_DIR) {
    expected.set(name, hashFile(path.join(artifactDir, name), "sha256").toString("hex"));
  }
  expected.set(MANIFEST_NAME, hashFile(manifestPath, "sha256").toString("hex"));
  if (webArtifact && webZipPath) {
    expected.set(webArtifact.name, hashFile(webZipPath, "sha256").toString("hex"));
  }
  for (const [name, digest] of expected) {
    if (!sums.has(name)) fail(`SHA256SUMS no incluye ${name}.`);
    if (sums.get(name) !== digest) {
      fail(`SHA256SUMS no coincide con el sha256 real de ${name}.`);
    }
  }
  for (const name of sums.keys()) {
    if (!expected.has(name)) fail(`SHA256SUMS incluye un archivo no publicado: ${name}.`);
  }
  ok(`SHA256SUMS verificados (${sums.size} archivos).`);
}

ok(
  `Release v${version} (${channel}) verificado: ${SETUP}, ${LATEST}, ${APK}, ` +
    `${MANIFEST_NAME}${manifest.signature ? " firmado" : " SIN firma"}` +
    `${webArtifact && webZipPath ? ` + ZIP OTA ${webArtifact.name}` : ""}.`
);
