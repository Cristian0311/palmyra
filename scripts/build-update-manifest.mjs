#!/usr/bin/env node
/**
 * Genera el manifiesto de actualizaciones de PALMYRA (update-manifest.json).
 *
 * Node ESM sin dependencias. Calcula sha256 y bytes reales de cada artefacto,
 * comprueba que el nombre/extensión corresponda a la plataforma declarada,
 * rechaza retrocesos de versión frente a un manifiesto anterior y firma el JSON
 * canónico con ES256 (r||s / IEEE P1363).
 *
 * El texto firmado debe coincidir exactamente con manifestSigningInput() de
 * src/services/updates/verify.ts: claves ordenadas, sin espacios, sin
 * `signature` y con `keyId` incluido si existe.
 *
 * Uso:
 *   node scripts/build-update-manifest.mjs \
 *     --version 1.4.0 --channel stable --out update-manifest.json \
 *     --windows release/PALMYRA-POS-Setup.exe \
 *     --android release/PALMYRA-Android.apk \
 *     [--notes-file notes.md | --notes "texto"] [--min-shell 1.3.5] \
 *     [--rollout 100] [--key-id palmyra-2026] [--key signing-key.pem] \
 *     [--previous-manifest anterior.json] [--released-at 2026-11-23T00:00:00.000Z] \
 *     [--base-url https://github.com/Cristian0311/palmyra/releases/download/v1.4.0] \
 *     [--require-signature]
 *
 * Firma: se usa la primera clave disponible de --key <PEM PKCS8>, la variable
 * UPDATE_SIGNING_KEY (PEM PKCS8) o, por compatibilidad, UPDATE_MANIFEST_KEY_JWK
 * (JWK privada EC P-256). Ninguna clave vive en el repositorio.
 *
 * `--require-signature` (o UPDATE_MANIFEST_REQUIRE_SIGNATURE=1) es el modo
 * release: sin clave falla en vez de escribir un manifiesto sin firma que los
 * clientes no podrían autenticar.
 */

import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_BASE = "https://github.com/Cristian0311/palmyra/releases/download";
export const SEMVER_RE = /^\d+\.\d+\.\d+(-beta(?:\.\d+)?)?$/;
export const PLATFORMS = new Set(["windows", "android", "web"]);
/** Plataformas sin las cuales un release de PALMYRA no está completo. */
export const REQUIRED_PLATFORMS = ["windows", "android"];
/** Orden estable de artefactos en el manifiesto (determinismo del JSON). */
export const PLATFORM_ORDER = ["windows", "android", "web"];
export const PLATFORM_EXTENSIONS = {
  windows: /\.exe$/i,
  android: /\.apk$/i,
  web: /\.zip$/i
};

class ManifestError extends Error {}

function fail(message) {
  throw new ManifestError(message);
}

export function printHelp() {
  console.log(`Genera update-manifest.json para PALMYRA.

Opciones:
  --version <x.y.z>            Versión publicada (obligatoria).
  --channel <stable|beta>      Canal (por defecto, derivado de la versión).
  --out <archivo>              Salida (por defecto update-manifest.json).
  --artifacts <p=archivo>      Repetible. p: windows, android o web.
  --windows <archivo>          Atajo de --artifacts windows=<archivo>.
  --android <archivo>          Atajo de --artifacts android=<archivo>.
  --web <archivo>              Atajo de --artifacts web=<archivo> (.zip).
  --notes <texto>              Notas de la versión (texto en línea).
  --notes-file <archivo>       Notas de la versión desde un archivo.
  --min-shell <x.y.z>          Shell mínimo requerido (no mayor que --version).
  --rollout <0-100>            Porcentaje de despliegue (por defecto 100).
  --key-id <id>                Identificador de clave firmante.
  --key <archivo>              Clave privada ES256 P-256 en PEM PKCS8.
  --base-url <url>             Base de descargas; debe terminar en /v<versión>.
  --previous-manifest <file>   Manifiesto anterior: rechaza retrocesos de versión.
  --previous <file>            Alias de --previous-manifest.
  --released-at <ISO>          Fecha de publicación (por defecto, ahora).
  --allow-missing-platform <p> Permite un manifiesto parcial (repetible).
  --sign                       Exige firma (igual que --require-signature).
  --require-signature          Falla si no hay clave de firma (modo release).
  --help                       Esta ayuda.

Firma: define UPDATE_SIGNING_KEY con la clave PEM PKCS8 (EC P-256) o usa
--key <archivo>. Se acepta UPDATE_MANIFEST_KEY_JWK por compatibilidad.`);
}

function readValue(argv, index, inline, flag) {
  if (inline !== undefined) return { value: inline, index };
  const next = index + 1;
  if (next >= argv.length) fail(`Falta el valor de ${flag}.`);
  return { value: argv[next], index: next };
}

export function parseArgs(argv = []) {
  const options = { artifacts: [], allowMissingPlatforms: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const raw = String(argv[index]);
    if (!raw.startsWith("--")) fail(`Argumento no reconocido: ${raw}`);
    const separator = raw.indexOf("=");
    const flag = separator === -1 ? raw : raw.slice(0, separator);
    const inline = separator === -1 ? undefined : raw.slice(separator + 1);
    switch (flag) {
      case "--version":
        ({ value: options.version, index } = readValue(argv, index, inline, flag));
        break;
      case "--channel":
        ({ value: options.channel, index } = readValue(argv, index, inline, flag));
        break;
      case "--out":
        ({ value: options.out, index } = readValue(argv, index, inline, flag));
        break;
      case "--notes":
        ({ value: options.notes, index } = readValue(argv, index, inline, flag));
        break;
      case "--notes-file":
        ({ value: options.notesFile, index } = readValue(argv, index, inline, flag));
        break;
      case "--min-shell":
        ({ value: options.minShell, index } = readValue(argv, index, inline, flag));
        break;
      case "--rollout":
        ({ value: options.rollout, index } = readValue(argv, index, inline, flag));
        break;
      case "--key-id":
        ({ value: options.keyId, index } = readValue(argv, index, inline, flag));
        break;
      case "--key":
        ({ value: options.key, index } = readValue(argv, index, inline, flag));
        break;
      case "--base-url":
        ({ value: options.baseUrl, index } = readValue(argv, index, inline, flag));
        break;
      case "--previous":
      case "--previous-manifest":
        ({ value: options.previousManifest, index } = readValue(argv, index, inline, flag));
        break;
      case "--released-at":
        ({ value: options.releasedAt, index } = readValue(argv, index, inline, flag));
        break;
      case "--allow-missing-platform": {
        const read = readValue(argv, index, inline, flag);
        index = read.index;
        options.allowMissingPlatforms.push(read.value);
        break;
      }
      case "--artifacts":
      case "--artifact": {
        const read = readValue(argv, index, inline, flag);
        index = read.index;
        options.artifacts.push(read.value);
        break;
      }
      case "--windows":
      case "--android":
      case "--web": {
        const read = readValue(argv, index, inline, flag);
        index = read.index;
        options.artifacts.push(`${flag.slice(2)}=${read.value}`);
        break;
      }
      case "--sign":
      case "--require-signature":
        options.requireSignature = true;
        break;
      case "--help":
        return { help: true, options };
      default:
        fail(`Argumento no reconocido: ${flag}`);
    }
  }
  return { help: false, options };
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

/** Manifiesto sin la firma: es exactamente lo que se firma. */
export function manifestSigningInput(manifest) {
  const { signature: _ignored, ...signable } = manifest;
  return canonicalJson(signable);
}

/** Nombre esperado -> plataforma. Evita publicar un EXE como Android. */
export function platformForName(name) {
  if (name === "PALMYRA-POS-Setup.exe") return "windows";
  if (name === "PALMYRA-Android.apk") return "android";
  if (/\.zip$/i.test(name)) return "web";
  return null;
}

export function compareVersions(left, right) {
  const parse = (value) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-beta(?:\.(\d+))?)?$/.exec(String(value ?? "").trim());
    if (!match) return null;
    return {
      major: Number(match[1]),
      minor: Number(match[2]),
      patch: Number(match[3]),
      beta: match[4] === undefined ? null : Number(match[4])
    };
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) throw new TypeError(`Versión no comparable: "${left}" vs "${right}"`);
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  // Una versión estable es posterior a cualquier beta de la misma base.
  if (a.beta === null && b.beta === null) return 0;
  if (a.beta === null) return 1;
  if (b.beta === null) return -1;
  if (a.beta === b.beta) return 0;
  return a.beta < b.beta ? -1 : 1;
}

/**
 * Resuelve un artefacto platform=archivo: extensión, existencia, tamaño y
 * sha256 reales. Devuelve { platform, name, sha256, bytes, path }.
 */
export function resolveArtifact(entry) {
  const separator = String(entry).indexOf("=");
  if (separator <= 0) {
    fail(`Formato de artefacto inválido: "${entry}". Usa platform=archivo.`);
  }
  const platform = String(entry).slice(0, separator).trim();
  const filePath = path.resolve(String(entry).slice(separator + 1).trim());
  if (!PLATFORMS.has(platform)) {
    fail(`Plataforma inválida: "${platform}". Usa windows, android o web.`);
  }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    fail(`No existe el artefacto: ${filePath}`);
  }
  const name = path.basename(filePath);
  const expected = platformForName(name);
  if (!expected) {
    fail(
      `Nombre de artefacto no reconocido: ${name}. ` +
        "Se esperaba PALMYRA-POS-Setup.exe, PALMYRA-Android.apk o un archivo .zip."
    );
  }
  if (expected !== platform) {
    fail(`El artefacto ${name} corresponde a ${expected}, no a ${platform}.`);
  }
  if (!PLATFORM_EXTENSIONS[platform].test(name)) {
    fail(`La extensión de ${name} no corresponde a ${platform}.`);
  }
  const bytes = statSync(filePath).size;
  if (bytes <= 0) fail(`El artefacto ${name} está vacío.`);
  const sha256 = createHash("sha256").update(readFileSync(filePath)).digest("hex");
  return { platform, name, sha256, bytes, path: filePath };
}

function normaliseBaseUrl(raw, version) {
  const base = String(raw || `${DEFAULT_BASE}/v${version}`).trim().replace(/\/+$/, "");
  let parsed;
  try {
    parsed = new URL(base);
  } catch {
    fail(`--base-url inválida: "${raw}". Debe ser una URL absoluta https.`);
  }
  if (parsed.protocol !== "https:") {
    fail(`--base-url debe usar https: "${base}".`);
  }
  // check-release-assets exige que cada URL cuelgue de /v<versión>/.
  if (!parsed.pathname.endsWith(`/v${version}`)) {
    fail(
      `--base-url debe terminar en /v${version} (etiqueta del release): "${base}".`
    );
  }
  return base;
}

function normalisePem(raw) {
  return String(raw).replace(/\\n/g, "\n").trim();
}

/** Carga la clave privada ES256 P-256 desde --key, entorno PEM o JWK legacy. */
export function loadSigningKey(options = {}, env = process.env) {
  const warnings = [];
  let material = null;
  let source = "";
  if (options.key) {
    const keyPath = path.resolve(options.key);
    if (!existsSync(keyPath)) {
      fail(`No existe la clave de firma indicada en --key: ${keyPath}.`);
    }
    material = { kind: "pem", value: readFileSync(keyPath, "utf8") };
    source = keyPath;
  } else {
    const pemEnv = String(env.UPDATE_SIGNING_KEY || env.UPDATE_MANIFEST_KEY_PEM || "").trim();
    if (pemEnv) {
      material = {
        kind: "pem",
        value: normalisePem(
          !pemEnv.includes("BEGIN") && existsSync(pemEnv) ? readFileSync(pemEnv, "utf8") : pemEnv
        )
      };
      source = "UPDATE_SIGNING_KEY";
    } else if (env.UPDATE_MANIFEST_KEY_JWK) {
      material = { kind: "jwk", value: env.UPDATE_MANIFEST_KEY_JWK };
      source = "UPDATE_MANIFEST_KEY_JWK";
      warnings.push(
        "UPDATE_MANIFEST_KEY_JWK está obsoleto; migra a UPDATE_SIGNING_KEY (PEM PKCS8)."
      );
    }
  }
  if (!material) return { key: null, source: "", warnings };

  let key;
  try {
    if (material.kind === "jwk") {
      let jwk;
      try {
        jwk = JSON.parse(material.value);
      } catch {
        fail("UPDATE_MANIFEST_KEY_JWK no es JSON válido.");
      }
      if (!jwk || jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.d !== "string") {
        fail("UPDATE_MANIFEST_KEY_JWK debe ser una JWK privada EC P-256 (kty=EC, crv=P-256, d).");
      }
      key = createPrivateKey({ key: jwk, format: "jwk" });
    } else {
      key = createPrivateKey({ key: normalisePem(material.value), format: "pem" });
    }
  } catch (error) {
    if (error instanceof ManifestError) throw error;
    fail(
      `No se pudo leer la clave de firma (${source}): ` +
        `${error instanceof Error ? error.message : error}. ` +
        "Se espera una clave PEM PKCS8 EC P-256."
    );
  }
  const details = key.asymmetricKeyDetails ?? {};
  const curve = String(details.namedCurve ?? "");
  if (key.asymmetricKeyType !== "ec" || !/^(prime256v1|P-256|secp256r1)$/.test(curve)) {
    fail(
      `La clave de firma (${source}) no es ES256 P-256 ` +
        `(tipo=${key.asymmetricKeyType ?? "?"}, curva=${curve || "?"}).`
    );
  }
  return { key, source, warnings };
}

function resolveNotes(options) {
  if (options.notes !== undefined && options.notesFile !== undefined) {
    fail("Usa --notes o --notes-file, no ambos.");
  }
  if (options.notes !== undefined) {
    const text = String(options.notes).trim();
    if (!text) fail("--notes está vacío.");
    return text;
  }
  if (options.notesFile !== undefined) {
    const notesPath = path.resolve(options.notesFile);
    if (!existsSync(notesPath)) fail(`No existe el archivo de notas: ${notesPath}`);
    const text = readFileSync(notesPath, "utf8").trim();
    if (!text) fail(`El archivo de notas está vacío: ${notesPath}`);
    return text;
  }
  return undefined;
}

function readPreviousVersion(filePath) {
  const resolved = path.resolve(filePath);
  if (!existsSync(resolved)) {
    fail(`No existe el manifiesto anterior: ${resolved}`);
  }
  let previous;
  try {
    previous = JSON.parse(readFileSync(resolved, "utf8"));
  } catch (error) {
    fail(
      `El manifiesto anterior no es JSON válido: ${resolved} ` +
        `(${error instanceof Error ? error.message : error}).`
    );
  }
  if (!previous || typeof previous !== "object" || Array.isArray(previous)) {
    fail(`El manifiesto anterior no es un objeto JSON: ${resolved}.`);
  }
  const previousVersion = String(previous.version ?? "").trim();
  if (!SEMVER_RE.test(previousVersion)) {
    fail(`El manifiesto anterior declara una versión inválida: "${previousVersion}".`);
  }
  return { version: previousVersion, manifest: previous };
}

/**
 * Construye el manifiesto sin escribirlo. Devuelve { manifest, artifacts,
 * warnings, out, signed }. Lanza ManifestError con mensajes en español.
 */
export function inspect(options = {}, env = process.env) {
  const warnings = [];
  const version = String(options.version ?? "").trim();
  if (!version) fail("Falta --version.");
  if (!SEMVER_RE.test(version)) fail(`Versión inválida: "${version}". Usa x.y.z o x.y.z-beta.N.`);

  const derivedChannel = version.includes("-beta") ? "beta" : "stable";
  const channel = String(options.channel ?? derivedChannel).trim();
  if (channel !== "stable" && channel !== "beta") {
    fail(`Canal inválido: "${channel}". Usa stable o beta.`);
  }
  if (channel !== derivedChannel) {
    fail(
      `El canal ${channel} no corresponde a la versión ${version} ` +
        `(se esperaba ${derivedChannel}).`
    );
  }

  const minShell = options.minShell === undefined ? undefined : String(options.minShell).trim();
  if (minShell !== undefined && !SEMVER_RE.test(minShell)) {
    fail(`--min-shell inválido: "${minShell}". Usa x.y.z.`);
  }
  if (minShell !== undefined && compareVersions(minShell, version) > 0) {
    fail(`--min-shell (${minShell}) no puede ser posterior a la versión ${version}.`);
  }

  const rollout = options.rollout === undefined ? 100 : Number(options.rollout);
  if (!Number.isInteger(rollout) || rollout < 0 || rollout > 100) {
    fail(`--rollout inválido: "${options.rollout}". Usa un entero entre 0 y 100.`);
  }

  let releasedAt = new Date().toISOString();
  if (options.releasedAt !== undefined) {
    const raw = String(options.releasedAt).trim();
    const parsed = Date.parse(raw);
    if (Number.isNaN(parsed)) {
      fail(`--released-at inválido: "${raw}". Usa una fecha ISO 8601.`);
    }
    releasedAt = new Date(parsed).toISOString();
  }

  const allowedMissing = new Set(options.allowMissingPlatforms ?? []);
  for (const platform of allowedMissing) {
    if (!PLATFORMS.has(platform)) {
      fail(`--allow-missing-platform inválido: "${platform}". Usa windows, android o web.`);
    }
  }

  if (!Array.isArray(options.artifacts) || options.artifacts.length === 0) {
    fail("Falta al menos un artefacto: usa --windows/--android o --artifacts platform=archivo.");
  }

  const artifacts = [];
  const seenPlatforms = new Set();
  const seenNames = new Set();
  for (const entry of options.artifacts) {
    const artifact = resolveArtifact(entry);
    if (seenPlatforms.has(artifact.platform)) {
      fail(`Plataforma repetida: ${artifact.platform}. Declara un único artefacto por plataforma.`);
    }
    if (seenNames.has(artifact.name)) {
      fail(`Artefacto repetido: ${artifact.name}. No se puede publicar dos veces.`);
    }
    seenPlatforms.add(artifact.platform);
    seenNames.add(artifact.name);
    artifacts.push(artifact);
  }

  for (const platform of REQUIRED_PLATFORMS) {
    if (!seenPlatforms.has(platform) && !allowedMissing.has(platform)) {
      fail(
        `Falta el artefacto de ${platform}. Un release de PALMYRA exige windows ` +
          "(PALMYRA-POS-Setup.exe) y android (PALMYRA-Android.apk). " +
          `Si es un manifiesto parcial, añade --allow-missing-platform ${platform}.`
      );
    }
  }

  const baseUrl = normaliseBaseUrl(options.baseUrl, version);
  artifacts.sort(
    (left, right) => PLATFORM_ORDER.indexOf(left.platform) - PLATFORM_ORDER.indexOf(right.platform)
  );
  const manifestArtifacts = artifacts.map((artifact) => ({
    platform: artifact.platform,
    name: artifact.name,
    url: `${baseUrl}/${encodeURIComponent(artifact.name)}`,
    sha256: artifact.sha256,
    bytes: artifact.bytes
  }));

  const notes = resolveNotes(options);

  const manifest = {
    v: 1,
    version,
    channel,
    releasedAt
  };
  if (minShell !== undefined) manifest.minShellVersion = minShell;
  if (notes !== undefined) manifest.notes = notes;
  manifest.rollout = rollout;
  manifest.artifacts = manifestArtifacts;

  if (options.previousManifest !== undefined) {
    const previous = readPreviousVersion(options.previousManifest);
    const delta = compareVersions(version, previous.version);
    if (delta < 0) {
      fail(
        `Retroceso de versión: el manifiesto anterior publica v${previous.version} y el nuevo ` +
          `v${version}. Un release no puede bajar de versión.`
      );
    }
    if (delta === 0) {
      warnings.push(
        `La versión v${version} coincide con el manifiesto anterior; se permite republicar el mismo tag.`
      );
    }
  }

  const requireSignature =
    options.requireSignature === true ||
    /^(1|true|yes)$/i.test(String(env.UPDATE_MANIFEST_REQUIRE_SIGNATURE ?? "").trim());

  const { key, source, warnings: keyWarnings } = loadSigningKey(options, env);
  warnings.push(...keyWarnings);
  if (!key) {
    if (requireSignature) {
      fail(
        "No hay clave de firma y se exige firma (--require-signature). " +
          "Define UPDATE_SIGNING_KEY (PEM PKCS8) o pasa --key <archivo>. " +
          "No se publica un manifiesto sin firma."
      );
    }
    if (options.keyId) {
      warnings.push("--key-id se ignora porque no hay clave de firma.");
    }
    warnings.push("Manifiesto SIN firma: los clientes no podrán autenticarlo.");
  } else {
    if (options.keyId) manifest.keyId = String(options.keyId).trim();
    else warnings.push("Se firma sin --key-id: el manifiesto no podrá rotar de clave.");
    const input = Buffer.from(manifestSigningInput(manifest), "utf8");
    let signature;
    try {
      signature = sign("sha256", input, { key, dsaEncoding: "ieee-p1363" });
    } catch (error) {
      fail(`No se pudo firmar el manifiesto: ${error instanceof Error ? error.message : error}`);
    }
    // Autoverificación: una firma que no verifica no se publica nunca.
    const publicKey = createPublicKey(key);
    const valid = verify("sha256", input, { key: publicKey, dsaEncoding: "ieee-p1363" }, signature);
    if (!valid) fail("La firma generada no verifica con la clave pública derivada; no se publica.");
    manifest.signature = signature.toString("base64url");
  }
  if (requireSignature && !manifest.signature) {
    fail("Se exigió firma y el manifiesto quedó sin `signature`; no se publica.");
  }

  return {
    manifest,
    artifacts,
    warnings,
    out: path.resolve(options.out || "update-manifest.json"),
    signed: Boolean(manifest.signature),
    keySource: source
  };
}

/** Escribe el manifiesto construido. */
export function writeManifest(result) {
  mkdirSync(path.dirname(result.out), { recursive: true });
  writeFileSync(result.out, `${JSON.stringify(result.manifest, null, 2)}\n`, "utf8");
}

/** CLI sin side effects de proceso: devuelve el código de salida. */
export function main(argv = process.argv.slice(2), io = {}) {
  const out = io.out ?? ((line) => console.log(line));
  const err = io.err ?? ((line) => console.error(line));
  try {
    const parsed = parseArgs(argv);
    if (parsed.help) {
      printHelp();
      return 0;
    }
    const result = inspect(parsed.options);
    for (const warning of result.warnings) err(`[update-manifest] Aviso: ${warning}`);
    writeManifest(result);
    out(
      `[update-manifest] ${result.signed ? "Firmado" : "Sin firma"} · ` +
        `v${result.manifest.version} (${result.manifest.channel}) · ` +
        `${result.artifacts.length} artefacto(s) · ${result.out}`
    );
    return 0;
  } catch (error) {
    if (error instanceof ManifestError) err(`[update-manifest] ${error.message}`);
    else err(`[update-manifest] Error inesperado: ${error instanceof Error ? error.message : error}`);
    return 1;
  }
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (entry === import.meta.url) {
  process.exit(main(process.argv.slice(2)));
}
