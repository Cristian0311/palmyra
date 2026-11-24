/**
 * TLS del hub LAN: certificado autofirmado ECDSA P-256 generado en el equipo.
 *
 * Solo corre en Node (proceso principal de Electron y pruebas). Nunca debe
 * importarse desde el bundle web: usa `node:crypto`, `node:https` y el disco.
 *
 * La confianza no viene de una CA: el cliente fija la huella SHA-256 del
 * certificado (pin) y la comprueba contra el certificado que presenta el par.
 * La clave privada se persiste con permisos de solo dueño y nunca se registra.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import type { TLSSocket } from "node:tls";

const TLS_DIR_NAME = "hub-tls";
const TLS_FILE_NAME = "hub-tls.json";
const COMMON_NAME = "palmyra-hub.local";
const LOCAL_HOSTNAMES = ["palmyra-hub.local", "localhost"];
const LOCAL_IPS = ["127.0.0.1", "::1"];
/** ~825 días: el máximo práctico que aceptan los clientes de escritorio. */
const VALIDITY_DAYS = 825;
/** Se regenera si le quedan menos días de vida que esto. */
const RENEW_BEFORE_MS = 7 * 24 * 60 * 60 * 1000;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** OID ecdsa-with-SHA256 (1.2.840.10045.4.3.2), sin parámetros. */
const OID_ECDSA_SHA256 = "1.2.840.10045.4.3.2";
const OID_COMMON_NAME = "2.5.4.3";
const OID_BASIC_CONSTRAINTS = "2.5.29.19";
const OID_KEY_USAGE = "2.5.29.15";
const OID_EXT_KEY_USAGE = "2.5.29.37";
const OID_SUBJECT_ALT_NAME = "2.5.29.17";
const OID_SERVER_AUTH = "1.3.6.1.5.5.7.3.1";

export interface HubTlsMaterial {
  certPem: string;
  keyPem: string;
  /** sha256 en hex minúsculas del DER del certificado (64 caracteres). */
  fingerprint: string;
}

export interface EnsureHubTlsOptions {
  /** Milisegundos; se inyecta en pruebas para simular vencimientos. */
  now?: number;
}

interface StoredTls extends HubTlsMaterial {
  version: 1;
  createdAt: string;
  notAfter: string;
}

// ─── DER a mano (Node no genera X.509) ──────────────────────────────────────

function derLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  let value = length;
  while (value > 0) {
    bytes.unshift(value & 0xff);
    value >>>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function der(tag: number, ...parts: Buffer[]): Buffer {
  const content = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);
}

const derSequence = (...parts: Buffer[]): Buffer => der(0x30, ...parts);
const derSet = (...parts: Buffer[]): Buffer => der(0x31, ...parts);

function derInteger(value: Buffer): Buffer {
  // DER exige el bit de signo en cero para enteros positivos.
  const body = value.length > 0 && (value[0] & 0x80) !== 0
    ? Buffer.concat([Buffer.from([0x00]), value])
    : value;
  return der(0x02, body);
}

function derOid(oid: string): Buffer {
  const parts = oid.split(".").map((part) => Number(part));
  if (parts.length < 2 || parts.some((part) => !Number.isInteger(part) || part < 0)) {
    throw new Error(`OID inválido: ${oid}`);
  }
  const bytes: number[] = [40 * parts[0] + parts[1]];
  for (const part of parts.slice(2)) {
    const chunk: number[] = [part & 0x7f];
    let rest = part >>> 7;
    while (rest > 0) {
      chunk.unshift((rest & 0x7f) | 0x80);
      rest >>>= 7;
    }
    bytes.push(...chunk);
  }
  return der(0x06, Buffer.from(bytes));
}

function derUtf8(value: string): Buffer {
  return der(0x0c, Buffer.from(value, "utf8"));
}

function derIpa(value: string): Buffer {
  return der(0x16, Buffer.from(value, "ascii"));
}

function derBitString(bytes: Buffer, unusedBits = 0): Buffer {
  return der(0x03, Buffer.from([unusedBits]), bytes);
}

function derOctetString(bytes: Buffer): Buffer {
  return der(0x04, bytes);
}

/** UTCTime: obligatorio hasta 2049, suficiente para la vigencia del hub. */
function derUtcTime(date: Date): Buffer {
  const two = (value: number): string => String(value).padStart(2, "0");
  const stamp =
    two(date.getUTCFullYear() % 100) +
    two(date.getUTCMonth() + 1) +
    two(date.getUTCDate()) +
    two(date.getUTCHours()) +
    two(date.getUTCMinutes()) +
    two(date.getUTCSeconds()) +
    "Z";
  return der(0x17, Buffer.from(stamp, "ascii"));
}

function nameDer(commonName: string): Buffer {
  const attribute = derSequence(derOid(OID_COMMON_NAME), derUtf8(commonName));
  return derSequence(derSet(attribute));
}

interface Extension {
  oid: string;
  critical: boolean;
  value: Buffer;
}

function extensionDer(extension: Extension): Buffer {
  const parts = [derOid(extension.oid)];
  if (extension.critical) parts.push(der(0x01, Buffer.from([0xff])));
  parts.push(derOctetString(extension.value));
  return derSequence(...parts);
}

function ipv4Bytes(address: string): Buffer | null {
  const octets = address.split(".");
  if (octets.length !== 4) return null;
  const bytes = octets.map((octet) => Number(octet));
  if (bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) return null;
  return Buffer.from(bytes);
}

function ipv6Bytes(address: string): Buffer | null {
  const raw = address.trim().replace(/^\[|\]$/g, "");
  if (!raw.includes(":")) return null;
  const halves = raw.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - (head.length + tail.length);
  if (halves.length === 1 ? head.length !== 8 : missing < 0) return null;
  const groups = [...head, ...Array.from({ length: halves.length === 2 ? missing : 0 }, () => "0"), ...tail];
  const buffer = Buffer.alloc(16);
  groups.forEach((group, index) => {
    const value = Number.parseInt(group || "0", 16);
    if (!Number.isFinite(value) || value < 0 || value > 0xffff) return;
    buffer.writeUInt16BE(value, index * 2);
  });
  return buffer;
}

function ipBytes(address: string): Buffer | null {
  return ipv4Bytes(address) ?? ipv6Bytes(address);
}

function sanDer(dnsNames: string[], ips: string[]): Buffer {
  const entries: Buffer[] = [];
  for (const name of dnsNames) entries.push(der(0x82, Buffer.from(name, "ascii")));
  for (const ip of ips) {
    const bytes = ipBytes(ip);
    if (bytes) entries.push(der(0x87, bytes));
  }
  return derSequence(...entries);
}

function certificateDer(input: {
  privateKey: crypto.KeyObject;
  publicKeyDer: Buffer;
  serial: Buffer;
  notBefore: Date;
  notAfter: Date;
  dnsNames: string[];
  ips: string[];
}): Buffer {
  const algorithm = derSequence(derOid(OID_ECDSA_SHA256));
  const extensions = derSequence(
    ...[
      // CA:FALSE se expresa con el SEQUENCE vacío (cA es DEFAULT FALSE).
      { oid: OID_BASIC_CONSTRAINTS, critical: true, value: derSequence() },
      // digitalSignature: bit 0 del primer octeto útil.
      { oid: OID_KEY_USAGE, critical: true, value: derBitString(Buffer.from([0x80]), 7) },
      { oid: OID_EXT_KEY_USAGE, critical: false, value: derSequence(derOid(OID_SERVER_AUTH)) },
      { oid: OID_SUBJECT_ALT_NAME, critical: false, value: sanDer(input.dnsNames, input.ips) }
    ].map(extensionDer)
  );

  const tbs = derSequence(
    der(0xa0, derInteger(Buffer.from([0x02]))), // version v3
    derInteger(input.serial),
    algorithm,
    nameDer(COMMON_NAME),
    derSequence(derUtcTime(input.notBefore), derUtcTime(input.notAfter)),
    nameDer(COMMON_NAME),
    input.publicKeyDer,
    der(0xa3, extensions)
  );

  const signature = crypto.sign("sha256", tbs, input.privateKey);
  return derSequence(tbs, algorithm, derBitString(signature, 0));
}

function fingerprintOf(raw: Buffer): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function lanIpv4Addresses(): string[] {
  const found: string[] = [];
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== "IPv4") continue;
      const bytes = ipv4Bytes(entry.address);
      if (bytes && !found.includes(entry.address)) found.push(entry.address);
    }
  }
  return found;
}

/** Nombres e IPs del SAN; se omiten las direcciones repetidas. */
function subjectAltNames(): { dnsNames: string[]; ips: string[] } {
  const ips = [...LOCAL_IPS];
  for (const address of lanIpv4Addresses()) {
    if (!ips.includes(address)) ips.push(address);
  }
  return { dnsNames: [...LOCAL_HOSTNAMES], ips };
}

function createMaterial(now: number): { material: HubTlsMaterial; notAfter: Date; createdAt: Date } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", {
    namedCurve: "prime256v1"
  });
  const publicKeyDer = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const keyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const createdAt = new Date(now);
  const notAfter = new Date(now + VALIDITY_DAYS * 24 * 60 * 60 * 1000);
  const serial = crypto.randomBytes(16);
  serial[0] = (serial[0] & 0x7f) | 0x01;

  const { dnsNames, ips } = subjectAltNames();
  const raw = certificateDer({
    privateKey,
    publicKeyDer,
    serial,
    // Un minuto de margen: el reloj del cliente puede ir ligeramente atrás.
    notBefore: new Date(now - 60_000),
    notAfter,
    dnsNames,
    ips
  });
  const certPem = [
    "-----BEGIN CERTIFICATE-----",
    ...raw.toString("base64").match(/.{1,64}/g) ?? [],
    "-----END CERTIFICATE-----",
    ""
  ].join("\n");

  return {
    material: { certPem, keyPem, fingerprint: fingerprintOf(raw) },
    notAfter,
    createdAt
  };
}

function isReusable(record: unknown, now: number): record is StoredTls {
  if (!record || typeof record !== "object") return false;
  const candidate = record as Partial<StoredTls>;
  if (typeof candidate.certPem !== "string" || typeof candidate.keyPem !== "string") return false;
  try {
    const cert = new crypto.X509Certificate(candidate.certPem);
    if (!candidate.keyPem.includes("PRIVATE KEY")) return false;
    const key = crypto.createPrivateKey(candidate.keyPem);
    // La clave debe corresponder al certificado; si no, el servidor TLS fallaría.
    const probe = Buffer.from("palmyra-hub-tls-check", "utf8");
    const signature = crypto.sign("sha256", probe, key);
    if (!crypto.verify("sha256", probe, cert.publicKey, signature)) return false;
    const notAfter = cert.validToDate ? new Date(cert.validToDate) : null;
    if (!notAfter || !Number.isFinite(notAfter.getTime())) return false;
    if (notAfter.getTime() - now < RENEW_BEFORE_MS) return false;
    return true;
  } catch {
    return false;
  }
}

function tlsFilePath(dataDir: string): string {
  return path.join(dataDir, TLS_DIR_NAME, TLS_FILE_NAME);
}

function readStored(dataDir: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(tlsFilePath(dataDir), "utf8"));
  } catch {
    return null;
  }
}

function writeStored(dataDir: string, stored: StoredTls): void {
  const dir = path.join(dataDir, TLS_DIR_NAME);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = tlsFilePath(dataDir);
  fs.writeFileSync(file, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
  // En Windows chmod solo ajusta el bit de solo lectura; en POSIX deja 0600.
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Sin chmod el archivo sigue existiendo; el fallo no cambia el material.
  }
}

function toMaterial(stored: StoredTls): HubTlsMaterial {
  // La huella se recalcula del DER real: el valor guardado nunca manda.
  const fingerprint = fingerprintOf(new crypto.X509Certificate(stored.certPem).raw);
  return { certPem: stored.certPem, keyPem: stored.keyPem, fingerprint };
}

/**
 * Devuelve el material TLS del hub, generándolo la primera vez y reutilizándolo
 * mientras el certificado se pueda parsear y le queden más de 7 días.
 */
export function ensureHubTls(dataDir: string, options: EnsureHubTlsOptions = {}): HubTlsMaterial {
  const rawDir = typeof dataDir === "string" ? dataDir.trim() : "";
  if (!rawDir) throw new Error("Falta el directorio de datos para el TLS del hub");
  const now = Number.isFinite(options.now) ? (options.now as number) : Date.now();

  const existing = readStored(rawDir);
  if (isReusable(existing, now)) return toMaterial(existing);

  const { material, notAfter, createdAt } = createMaterial(now);
  const stored: StoredTls = {
    version: 1,
    ...material,
    createdAt: createdAt.toISOString(),
    notAfter: notAfter.toISOString()
  };
  try {
    writeStored(rawDir, stored);
  } catch (error) {
    // Sin persistencia la huella cambiaría en cada arranque y ningún pin
    // sobreviviría: se prefiere no arrancar antes que servir un certificado
    // distinto cada vez.
    const detail = error instanceof Error ? error.message : String(error ?? "");
    throw new Error(`No se pudo guardar el certificado TLS del hub: ${detail}`);
  }
  return material;
}

/**
 * Acepta la huella como la pegue un humano: `AA:BB:…`, con espacios o en
 * mayúsculas. Cualquier otra cosa devuelve cadena vacía.
 */
export function normalizeFingerprint(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const cleaned = raw.replace(/[\s:]/g, "").toLowerCase();
  return SHA256_HEX.test(cleaned) ? cleaned : "";
}

function headerRecord(headers: RequestInit["headers"]): Record<string, string> {
  if (!headers) return {};
  if (typeof Headers === "function" && headers instanceof Headers) {
    const record: Record<string, string> = {};
    headers.forEach((value, key) => {
      record[key] = value;
    });
    return record;
  }
  if (Array.isArray(headers)) {
    const record: Record<string, string> = {};
    for (const [key, value] of headers) record[String(key).toLowerCase()] = String(value);
    return record;
  }
  const record: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers as Record<string, string>)) {
    record[key.toLowerCase()] = String(value);
  }
  return record;
}

function nodeHeadersToRecord(raw: Record<string, string | string[] | undefined>): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    record[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  return record;
}

function requestBody(body: RequestInit["body"]): Buffer | null {
  if (body === undefined || body === null) return null;
  if (typeof body === "string") return Buffer.from(body, "utf8");
  if (body instanceof Uint8Array) return Buffer.from(body);
  // Streams y FormData quedan fuera: el cliente del hub solo manda JSON.
  throw new TypeError("createPinnedFetch solo admite cuerpos de texto");
}

/**
 * `fetch` de Node para el hub con huella fijada.
 *
 * El certificado del hub es autofirmado, así que la cadena de CA no aporta: se
 * desactiva `rejectUnauthorized` y se compara a mano el sha256 del DER del par.
 * Un pin distinto corta la conexión antes de leer el cuerpo.
 */
export function createPinnedFetch(
  pin: string,
  options: { allowSelfSigned?: boolean } = {}
): typeof fetch {
  const expected = normalizeFingerprint(pin);
  if (!expected) throw new Error("Huella TLS del hub LAN inválida");
  // Con `allowSelfSigned: false` además de la huella se exige cadena válida.
  const rejectUnauthorized = options.allowSelfSigned === false;

  const pinnedFetch = (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    return new Promise<Response>((resolve, reject) => {
      let url: URL;
      try {
        const value =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : "";
        if (!value) throw new TypeError("URL no válida");
        url = new URL(value);
      } catch {
        reject(new TypeError("createPinnedFetch requiere una URL de texto"));
        return;
      }
      if (url.protocol !== "https:") {
        reject(new Error("El hub LAN con huella fijada exige https"));
        return;
      }

      let payload: Buffer | null;
      try {
        payload = requestBody(init.body);
      } catch (error) {
        reject(error);
        return;
      }

      const headers = headerRecord(init.headers);
      if (payload) headers["content-length"] = String(payload.length);

      const request = https.request({
        hostname: url.hostname.replace(/^\[|\]$/g, ""),
        port: url.port ? Number(url.port) : 443,
        path: `${url.pathname}${url.search}`,
        method: (init.method ?? "GET").toUpperCase(),
        headers,
        rejectUnauthorized,
        ...(init.signal ? { signal: init.signal } : {})
      });

      request.on("error", (error) => reject(error));
      request.on("response", (response) => {
        const socket = response.socket as TLSSocket | null;
        let peer: { raw?: Buffer } | null = null;
        try {
          peer = socket ? socket.getPeerCertificate(true) : null;
        } catch {
          peer = null;
        }
        const raw = peer && peer.raw ? peer.raw : null;
        if (!raw) {
          response.destroy();
          reject(new Error("El hub LAN no presentó un certificado TLS"));
          return;
        }
        const actual = fingerprintOf(raw);
        if (actual !== expected) {
          response.destroy();
          reject(new Error("La huella TLS del hub LAN no coincide con la fijada"));
          return;
        }

        const status = response.statusCode ?? 0;
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("error", (error) => reject(error));
        response.on("end", () => {
          const body = Buffer.concat(chunks);
          const headers = nodeHeadersToRecord(response.headers);
          const nullBody = status === 204 || status === 205 || status === 304 || body.length === 0;
          try {
            resolve(
              new Response(nullBody ? null : body, {
                status,
                statusText: response.statusMessage ?? "",
                headers
              })
            );
          } catch (error) {
            reject(error);
          }
        });
      });

      if (payload) request.write(payload);
      request.end();
    });
  };

  return pinnedFetch as typeof fetch;
}
