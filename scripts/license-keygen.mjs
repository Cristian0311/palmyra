/**
 * Genera el par de claves ES256 (ECDSA P-256) del lease de licencia.
 *
 * Uso: node scripts/license-keygen.mjs [--force] [--out <ruta>]
 *
 * Escribe `LEASE_PRIVATE_JWK` y `LEASE_PUBLIC_JWK` en el archivo de secretos
 * FUERA del repositorio (por defecto ../.secrets/license.env). Nunca imprime
 * material de clave: solo la ruta del archivo y la huella SHA-256 (hex) de la
 * clave pública. Sin `--force` no sobrescribe un archivo existente.
 *
 * `generateKeyPairJwks()` se exporta para pruebas; los JWK viven solo en
 * memoria y no se registran.
 */
import {
  createHash,
  createPublicKey,
  generateKeyPairSync
} from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Raíz del repo (scripts/ -> repo). */
const ROOT = fileURLToPath(new URL("../", import.meta.url));
/** .secrets queda como hermano del repo, nunca dentro del árbol versionado. */
const DEFAULT_SECRETS_DIR = path.resolve(ROOT, "..", ".secrets");
const DEFAULT_ENV_PATH = path.join(DEFAULT_SECRETS_DIR, "license.env");

/** Campos públicos permitidos: nunca se copian `d` ni parámetros privados. */
const PUBLIC_JWK_FIELDS = ["kty", "crv", "x", "y"];

function toPublicJwk(jwk) {
  const clean = {};
  for (const field of PUBLIC_JWK_FIELDS) clean[field] = jwk[field];
  return clean;
}

/**
 * Huella SHA-256 (hex) determinista de la clave pública: se calcula sobre el
 * SPKI DER, así es estable entre exportaciones JWK equivalentes.
 */
export function publicKeyFingerprint(publicJwk) {
  const key = createPublicKey({ key: publicJwk, format: "jwk" });
  const der = key.export({ format: "der", type: "spki" });
  return createHash("sha256").update(der).digest("hex");
}

/**
 * Genera el par y devuelve los JWK listos para exportar. El privado incluye
 * `d`; el público solo `kty`, `crv`, `x` e `y`.
 */
export function generateKeyPairJwks() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1"
  });
  const privateJwk = privateKey.export({ format: "jwk" });
  const publicJwk = toPublicJwk(publicKey.export({ format: "jwk" }));
  if (
    privateJwk.kty !== "EC" ||
    privateJwk.crv !== "P-256" ||
    typeof privateJwk.d !== "string" ||
    publicJwk.kty !== "EC" ||
    publicJwk.crv !== "P-256" ||
    typeof publicJwk.x !== "string" ||
    typeof publicJwk.y !== "string"
  ) {
    throw new Error("No se pudo exportar un par ES256 P-256 válido.");
  }
  return {
    privateJwk,
    publicJwk,
    fingerprint: publicKeyFingerprint(publicJwk)
  };
}

/** Contenido del archivo de secretos: dos líneas, una variable por línea. */
export function buildLicenseEnv({ privateJwk, publicJwk }) {
  return [
    `LEASE_PRIVATE_JWK='${JSON.stringify(privateJwk)}'`,
    `LEASE_PUBLIC_JWK='${JSON.stringify(publicJwk)}'`,
    ""
  ].join("\n");
}

function parseArgs(argv) {
  let force = false;
  let outPath = DEFAULT_ENV_PATH;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (arg === "--out") {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) throw new Error("Falta la ruta después de --out.");
      outPath = path.resolve(next);
      index += 1;
      continue;
    }
    throw new Error(`Argumento no reconocido: ${arg}`);
  }
  return { force, outPath };
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[license-keygen] ${error instanceof Error ? error.message : "argumentos inválidos"}`);
    process.exitCode = 1;
    return;
  }

  if (existsSync(args.outPath) && !args.force) {
    console.error(`[license-keygen] Ya existe el archivo de secretos: ${args.outPath}`);
    console.error("[license-keygen] No se sobrescribe sin --force.");
    process.exitCode = 1;
    return;
  }

  const pair = generateKeyPairJwks();
  mkdirSync(path.dirname(args.outPath), { recursive: true });
  writeFileSync(args.outPath, buildLicenseEnv(pair), { encoding: "utf8", mode: 0o600 });

  // Solo ruta y huella: nunca el JWK (privado ni público completo).
  console.log("[license-keygen] Par ES256 (P-256) generado.");
  console.log(`[license-keygen] Archivo: ${args.outPath}`);
  console.log(`[license-keygen] Huella SHA-256 (SPKI, hex): ${pair.fingerprint}`);
  console.log("[license-keygen] Variables escritas: LEASE_PRIVATE_JWK, LEASE_PUBLIC_JWK.");
}

const invokedDirectly =
  typeof process.argv[1] === "string" &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) main();
