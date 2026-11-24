/**
 * Descubrimiento mDNS del hub LAN (`_palmyra-hub._tcp.local`).
 *
 * Solo corre en Node: el proceso principal anuncia el hub en la red local y
 * los equipos pueden listarlo sin escribir una IP. La huella TLS viaja en el
 * TXT (`fp`) para que el pin se pueda fijar en el mismo paso que el descubrimiento.
 *
 * Codificar y decodificar el mensaje es puro (se prueba sin red); el anunciador
 * y el descubrimiento aceptan sockets inyectables y nunca lanzan por fallos de
 * red o de multicast.
 */
import dgram from "node:dgram";
import os from "node:os";
import { normalizeFingerprint } from "./tls";

export const MDNS_GROUP = "224.0.0.251";
export const MDNS_PORT = 5353;
export const HUB_SERVICE_NAME = "_palmyra-hub._tcp.local";
export const HUB_TXT_PATH = "/lan/v1";

const DEFAULT_TTL_SECONDS = 120;
const MAX_NAME_JUMPS = 16;
const MAX_LABELS = 32;

export const MDNS_RECORD_TYPES = {
  A: 1,
  PTR: 12,
  TXT: 16,
  AAAA: 28,
  SRV: 33
} as const;

export function recordTypeName(type: number): string {
  switch (type) {
    case MDNS_RECORD_TYPES.A:
      return "A";
    case MDNS_RECORD_TYPES.PTR:
      return "PTR";
    case MDNS_RECORD_TYPES.TXT:
      return "TXT";
    case MDNS_RECORD_TYPES.AAAA:
      return "AAAA";
    case MDNS_RECORD_TYPES.SRV:
      return "SRV";
    default:
      return `TYPE${type}`;
  }
}

export interface MdnsQuestion {
  name: string;
  type: number;
  typeName: string;
  klass: number;
}

export interface MdnsRecord {
  name: string;
  type: number;
  typeName: string;
  klass: number;
  ttl: number;
  /** PTR y SRV. */
  target?: string;
  priority?: number;
  weight?: number;
  port?: number;
  /** TXT: una entrada por cadena. */
  txt?: string[];
  /** A/AAAA en formato textual. */
  address?: string;
  /** RDATA crudo para tipos no soportados. */
  data?: Buffer;
}

export interface MdnsMessage {
  id: number;
  flags: number;
  questions: MdnsQuestion[];
  answers: MdnsRecord[];
  authorities: MdnsRecord[];
  additionals: MdnsRecord[];
}

export interface MdnsDiscoveredHub {
  host: string;
  port: number;
  url: string;
  fingerprint: string;
  name: string;
}

/** Socket mínimo que usan anunciador y descubrimiento (dgram o falso). */
export interface MdnsSocketLike {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  send(
    message: Buffer,
    port?: number,
    address?: string,
    callback?: (error: Error | null) => void
  ): void;
  close(callback?: () => void): void;
  bind?(port?: number, address?: string, callback?: () => void): void;
  setMulticastTTL?(ttl: number): void;
  setMulticastLoopback?(loopback: boolean): void;
}

// ─── Codificación ───────────────────────────────────────────────────────────

function normalizeName(name: string): string {
  const trimmed = String(name ?? "").trim().replace(/\.+$/, "");
  if (!trimmed) throw new Error("Nombre DNS vacío");
  if (trimmed.length > 253) throw new Error("Nombre DNS demasiado largo");
  return trimmed;
}

class DnsWriter {
  private parts: Buffer[] = [];
  private size = 0;
  private offsets = new Map<string, number>();

  get length(): number {
    return this.size;
  }

  push(buffer: Buffer): void {
    this.parts.push(buffer);
    this.size += buffer.length;
  }

  writeUInt16(value: number): void {
    const buffer = Buffer.alloc(2);
    buffer.writeUInt16BE(value & 0xffff, 0);
    this.push(buffer);
  }

  writeUInt32(value: number): void {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32BE(value >>> 0, 0);
    this.push(buffer);
  }

  /** Reserva la longitud de un RDATA y devuelve la función que la rellena. */
  reserveUInt16(): (value: number) => void {
    const slot = Buffer.alloc(2);
    this.push(slot);
    return (value: number): void => {
      slot.writeUInt16BE(value & 0xffff, 0);
    };
  }

  /** Nombres con compresión por sufijo (punteros 0xC000 | offset). */
  writeName(name: string, compress: boolean): void {
    const labels = normalizeName(name).split(".");
    if (labels.length > MAX_LABELS) throw new Error("Nombre DNS con demasiadas etiquetas");
    for (let index = 0; index < labels.length; index += 1) {
      const suffix = labels.slice(index).join(".").toLowerCase();
      const known = compress ? this.offsets.get(suffix) : undefined;
      if (known !== undefined && known < 0x3fff) {
        this.writeUInt16(0xc000 | known);
        return;
      }
      if (compress) this.offsets.set(suffix, this.size);
      const label = Buffer.from(labels[index], "ascii");
      if (label.length === 0 || label.length > 63) throw new Error("Etiqueta DNS inválida");
      this.push(Buffer.from([label.length]));
      this.push(label);
    }
    this.push(Buffer.from([0]));
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.parts);
  }
}

/** Consulta PTR estándar (mDNS: ID 0, sin flags). */
export function encodeMdnsQuery(name: string = HUB_SERVICE_NAME): Buffer {
  const writer = new DnsWriter();
  writer.writeUInt16(0); // ID
  writer.writeUInt16(0); // flags
  writer.writeUInt16(1); // QDCOUNT
  writer.writeUInt16(0); // ANCOUNT
  writer.writeUInt16(0); // NSCOUNT
  writer.writeUInt16(0); // ARCOUNT
  writer.writeName(name, false);
  writer.writeUInt16(MDNS_RECORD_TYPES.PTR);
  writer.writeUInt16(1); // clase IN
  return writer.toBuffer();
}

export interface MdnsResponseInput {
  /** Servicio, por defecto `_palmyra-hub._tcp.local`. */
  service?: string;
  /** Etiqueta del equipo o FQDN completo del servicio. */
  instanceName?: string;
  /** Nombre del host que resolverán los A; por defecto `palmyra-hub.local`. */
  hostName?: string;
  port: number;
  addresses: string[];
  txt?: Record<string, string> | string[];
  ttlSeconds?: number;
  /** Por defecto true: los sufijos repetidos se emiten como punteros. */
  compress?: boolean;
}

function instanceFqdn(instanceName: string | undefined, service: string): string {
  const label = String(instanceName ?? "").trim().replace(/\.+$/, "");
  if (!label) return `palmyra-hub.${service}`;
  if (label.toLowerCase().endsWith(`.${service.toLowerCase()}`)) return label;
  return `${label}.${service}`;
}

function txtEntries(txt: Record<string, string> | string[] | undefined): string[] {
  if (!txt) return [];
  if (Array.isArray(txt)) return txt.filter((entry) => typeof entry === "string");
  return Object.entries(txt)
    .filter(([key]) => key.trim() !== "")
    .map(([key, value]) => `${key}=${value}`);
}

function ipv4Octets(address: string): Buffer | null {
  const octets = address.split(".");
  if (octets.length !== 4) return null;
  const bytes = octets.map((octet) => Number(octet));
  if (bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) return null;
  return Buffer.from(bytes);
}

/**
 * Respuesta completa del anuncio: PTR + SRV + TXT + un A por dirección.
 * Los nombres se comprimen igual que en un responder real.
 */
export function buildMdnsResponse(input: MdnsResponseInput): Buffer {
  const service = normalizeName(input.service ?? HUB_SERVICE_NAME).toLowerCase();
  const instance = normalizeName(instanceFqdn(input.instanceName, service));
  const hostName = normalizeName(input.hostName ?? "palmyra-hub.local");
  const port = Number(input.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Puerto mDNS inválido: ${String(input.port)}`);
  }
  const ttl = Number.isFinite(input.ttlSeconds) && (input.ttlSeconds as number) > 0
    ? Math.floor(input.ttlSeconds as number)
    : DEFAULT_TTL_SECONDS;
  const compress = input.compress !== false;
  const entries = txtEntries(input.txt);
  const addresses = (input.addresses ?? [])
    .map((address) => ({ address, bytes: ipv4Octets(address) }))
    .filter((entry): entry is { address: string; bytes: Buffer } => entry.bytes !== null);

  const answerCount = 3 + addresses.length;
  const writer = new DnsWriter();
  writer.writeUInt16(0); // ID
  writer.writeUInt16(0x8400); // QR + respuesta autoritativa
  writer.writeUInt16(0); // QDCOUNT
  writer.writeUInt16(answerCount);
  writer.writeUInt16(0); // NSCOUNT
  writer.writeUInt16(0); // ARCOUNT

  const writeRecord = (
    name: string,
    type: number,
    writeRdata: () => void
  ): void => {
    writer.writeName(name, compress);
    writer.writeUInt16(type);
    writer.writeUInt16(1);
    writer.writeUInt32(ttl);
    const patch = writer.reserveUInt16();
    const start = writer.length;
    writeRdata();
    patch(writer.length - start);
  };

  writeRecord(service, MDNS_RECORD_TYPES.PTR, () => writer.writeName(instance, compress));
  writeRecord(instance, MDNS_RECORD_TYPES.SRV, () => {
    writer.writeUInt16(0); // prioridad
    writer.writeUInt16(0); // peso
    writer.writeUInt16(port);
    writer.writeName(hostName, compress);
  });
  writeRecord(instance, MDNS_RECORD_TYPES.TXT, () => {
    if (entries.length === 0) {
      writer.push(Buffer.from([0]));
      return;
    }
    for (const entry of entries) {
      const bytes = Buffer.from(entry, "utf8").subarray(0, 255);
      writer.push(Buffer.from([bytes.length]));
      writer.push(bytes);
    }
  });
  for (const entry of addresses) {
    writeRecord(hostName, MDNS_RECORD_TYPES.A, () => writer.push(Buffer.from(entry.bytes)));
  }
  return writer.toBuffer();
}

// ─── Decodificación ─────────────────────────────────────────────────────────

interface ParsedName {
  name: string;
  end: number;
}

/** Lee un nombre con punteros de compresión; nunca sigue más de MAX_NAME_JUMPS. */
function readName(buffer: Buffer, offset: number): ParsedName {
  const labels: string[] = [];
  let cursor = offset;
  let end = -1;
  let jumps = 0;
  for (;;) {
    if (cursor < 0 || cursor >= buffer.length) throw new RangeError("nombre fuera del mensaje");
    const length = buffer[cursor];
    if (length === 0) {
      cursor += 1;
      if (end === -1) end = cursor;
      break;
    }
    if ((length & 0xc0) === 0xc0) {
      if (cursor + 1 >= buffer.length) throw new RangeError("puntero truncado");
      const pointer = ((length & 0x3f) << 8) | buffer[cursor + 1];
      if (end === -1) end = cursor + 2;
      jumps += 1;
      if (jumps > MAX_NAME_JUMPS || pointer >= buffer.length) {
        throw new RangeError("puntero de nombre inválido");
      }
      cursor = pointer;
      continue;
    }
    if (length > 63 || cursor + 1 + length > buffer.length) {
      throw new RangeError("etiqueta truncada");
    }
    labels.push(buffer.toString("ascii", cursor + 1, cursor + 1 + length));
    cursor += 1 + length;
    if (labels.length > MAX_LABELS) throw new RangeError("demasiadas etiquetas");
  }
  return { name: labels.join("."), end: end === -1 ? cursor : end };
}

function readTxt(buffer: Buffer, start: number, end: number): string[] {
  const entries: string[] = [];
  let cursor = start;
  while (cursor < end) {
    const length = buffer[cursor];
    cursor += 1;
    if (length === 0) continue;
    if (cursor + length > end) break;
    entries.push(buffer.toString("utf8", cursor, cursor + length));
    cursor += length;
  }
  return entries;
}

function formatIpv6(buffer: Buffer): string {
  const groups: string[] = [];
  for (let index = 0; index < buffer.length; index += 2) {
    groups.push(buffer.readUInt16BE(index).toString(16));
  }
  // Representación compacta suficiente para comparar direcciones.
  const raw = groups.join(":");
  const zeros = groups.findIndex((group, index) => group === "0" && groups[index + 1] === "0");
  if (zeros === -1) return raw;
  let last = zeros;
  while (last + 1 < groups.length && groups[last + 1] === "0") last += 1;
  return `${groups.slice(0, zeros).join(":")}::${groups.slice(last + 1).join(":")}`;
}

function parseRecord(buffer: Buffer, offset: number): { record: MdnsRecord; end: number } {
  const owner = readName(buffer, offset);
  let cursor = owner.end;
  if (cursor + 10 > buffer.length) throw new RangeError("cabecera de registro truncada");
  const type = buffer.readUInt16BE(cursor);
  const klass = buffer.readUInt16BE(cursor + 2);
  const ttl = buffer.readUInt32BE(cursor + 4);
  const length = buffer.readUInt16BE(cursor + 8);
  cursor += 10;
  const rdataStart = cursor;
  const rdataEnd = rdataStart + length;
  if (rdataEnd > buffer.length) throw new RangeError("rdata truncado");

  const record: MdnsRecord = {
    name: owner.name,
    type,
    typeName: recordTypeName(type),
    klass,
    ttl
  };

  if (type === MDNS_RECORD_TYPES.PTR) {
    record.target = readName(buffer, rdataStart).name;
  } else if (type === MDNS_RECORD_TYPES.SRV) {
    if (length < 7) throw new RangeError("SRV truncado");
    record.priority = buffer.readUInt16BE(rdataStart);
    record.weight = buffer.readUInt16BE(rdataStart + 2);
    record.port = buffer.readUInt16BE(rdataStart + 4);
    record.target = readName(buffer, rdataStart + 6).name;
  } else if (type === MDNS_RECORD_TYPES.TXT) {
    record.txt = readTxt(buffer, rdataStart, rdataEnd);
  } else if (type === MDNS_RECORD_TYPES.A) {
    if (length === 4) record.address = Array.from(buffer.subarray(rdataStart, rdataEnd)).join(".");
  } else if (type === MDNS_RECORD_TYPES.AAAA) {
    if (length === 16) record.address = formatIpv6(buffer.subarray(rdataStart, rdataEnd));
  } else {
    record.data = Buffer.from(buffer.subarray(rdataStart, rdataEnd));
  }
  return { record, end: rdataEnd };
}

function parseSection(
  buffer: Buffer,
  count: number,
  offset: number,
  into: MdnsRecord[]
): number {
  let cursor = offset;
  for (let index = 0; index < count; index += 1) {
    const parsed = parseRecord(buffer, cursor);
    into.push(parsed.record);
    cursor = parsed.end;
  }
  return cursor;
}

/** Decodifica el mensaje completo. Con basura devuelve lo que se pudo leer. */
export function decodeMdnsMessage(buffer: Buffer): MdnsMessage {
  const message: MdnsMessage = {
    id: 0,
    flags: 0,
    questions: [],
    answers: [],
    authorities: [],
    additionals: []
  };
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return message;
  try {
    message.id = buffer.readUInt16BE(0);
    message.flags = buffer.readUInt16BE(2);
    const counts = [
      buffer.readUInt16BE(4),
      buffer.readUInt16BE(6),
      buffer.readUInt16BE(8),
      buffer.readUInt16BE(10)
    ];
    let cursor = 12;
    for (let index = 0; index < counts[0]; index += 1) {
      const question = readName(buffer, cursor);
      cursor = question.end;
      if (cursor + 4 > buffer.length) return message;
      message.questions.push({
        name: question.name,
        type: buffer.readUInt16BE(cursor),
        typeName: recordTypeName(buffer.readUInt16BE(cursor)),
        klass: buffer.readUInt16BE(cursor + 2)
      });
      cursor += 4;
    }
    try {
      cursor = parseSection(buffer, counts[1], cursor, message.answers);
    } catch {
      return message;
    }
    try {
      cursor = parseSection(buffer, counts[2], cursor, message.authorities);
    } catch {
      return message;
    }
    try {
      parseSection(buffer, counts[3], cursor, message.additionals);
    } catch {
      return message;
    }
  } catch {
    // Mensaje truncado o mal formado: se responde con lo ya leído.
  }
  return message;
}

// ─── Anunciador ─────────────────────────────────────────────────────────────

export interface MdnsAnnouncerOptions {
  port: number;
  addresses: string[];
  txt?: Record<string, string>;
  instanceName?: string;
  ttlSeconds?: number;
  /** Escribe las líneas de diagnóstico; nunca incluye claves ni tokens. */
  log?: (line: string) => void;
  /** Socket ya creado (pruebas); si falta se abre un UDP con reuseAddr. */
  socket?: MdnsSocketLike;
  group?: string;
  mdnsPort?: number;
  /** Reanuncio periódico; por defecto media vida del TTL. */
  announceIntervalMs?: number;
}

export interface MdnsAnnouncer {
  start(): void;
  stop(): void;
  readonly started: boolean;
}

function createUdpSocket(): MdnsSocketLike {
  return dgram.createSocket({ type: "udp4", reuseAddr: true }) as unknown as MdnsSocketLike;
}

export function lanIpv4Addresses(): string[] {
  const found: string[] = [];
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== "IPv4") continue;
      if (!found.includes(entry.address)) found.push(entry.address);
    }
  }
  return found;
}

/**
 * Announcer del hub. Los fallos de red (sin multicast, puerto ocupado) solo se
 * registran: el hub sigue sirviendo por IP.
 */
export function createMdnsAnnouncer(options: MdnsAnnouncerOptions): MdnsAnnouncer {
  const group = options.group ?? MDNS_GROUP;
  const mdnsPort = options.mdnsPort ?? MDNS_PORT;
  const ttlSeconds = Number.isFinite(options.ttlSeconds) && (options.ttlSeconds as number) > 0
    ? Math.floor(options.ttlSeconds as number)
    : DEFAULT_TTL_SECONDS;
  const log = options.log;
  const instanceName = options.instanceName ?? os.hostname() ?? "palmyra-hub";
  const announceIntervalMs =
    Number.isFinite(options.announceIntervalMs) && (options.announceIntervalMs as number) > 0
      ? Math.floor(options.announceIntervalMs as number)
      : Math.max(30_000, ttlSeconds * 500);
  const injected = options.socket ?? null;

  let socket: MdnsSocketLike | null = injected;
  let timer: ReturnType<typeof setInterval> | null = null;
  let started = false;

  function payload(): Buffer {
    return buildMdnsResponse({
      instanceName,
      port: options.port,
      addresses: options.addresses,
      txt: options.txt,
      ttlSeconds
    });
  }

  function send(): void {
    const current = socket;
    if (!current) return;
    try {
      current.send(payload(), mdnsPort, group, () => {
        // El error del callback ya no se puede accionar: el anuncio es best-effort.
      });
    } catch (error) {
      log?.(`mDNS: no se pudo anunciar: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function start(): void {
    if (started) return;
    started = true;
    if (!socket) {
      socket = createUdpSocket();
      socket.on("error", (error: unknown) => {
        log?.(`mDNS: error del socket: ${error instanceof Error ? error.message : String(error)}`);
      });
      // Se escucha en 5353 para que el anuncio salga con el puerto estándar.
      // TTL y multicast solo se configuran con el socket ya enlazado.
      try {
        socket.bind?.(MDNS_PORT, "0.0.0.0", () => {
          try {
            socket?.setMulticastTTL?.(255);
            socket?.setMulticastLoopback?.(false);
          } catch {
            // Algunos sistemas no permiten ajustar el TTL: se anuncia igual.
          }
          send();
        });
      } catch {
        send();
      }
    } else {
      send();
    }
    timer = setInterval(send, announceIntervalMs);
    timer.unref?.();
  }

  function stop(): void {
    started = false;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    const current = socket;
    socket = null;
    if (!current) return;
    try {
      current.close();
    } catch {
      // Ya estaba cerrado.
    }
  }

  return {
    start,
    stop,
    get started(): boolean {
      return started;
    }
  };
}

// ─── Descubrimiento ─────────────────────────────────────────────────────────

export interface DiscoverHubsOptions {
  timeoutMs?: number;
  /** Recibe la consulta enviada (pruebas o diagnóstico). */
  query?: (buffer: Buffer) => void;
  /** Fábrica de sockets inyectable en pruebas. */
  sockets?: { create?: () => MdnsSocketLike };
  service?: string;
  group?: string;
  mdnsPort?: number;
  timeoutSeconds?: number;
  log?: (line: string) => void;
}

function parseTxt(entries: string[] | undefined): Record<string, string> {
  const values: Record<string, string> = {};
  for (const entry of entries ?? []) {
    const cut = entry.indexOf("=");
    if (cut > 0) values[entry.slice(0, cut).toLowerCase()] = entry.slice(cut + 1);
  }
  return values;
}

/**
 * Consulta PTR y acumula respuestas hasta el timeout. Sin multicast o con
 * respuestas corruptas devuelve lo encontrado (normalmente nada) sin lanzar.
 */
export function discoverHubs(options: DiscoverHubsOptions = {}): Promise<MdnsDiscoveredHub[]> {
  const timeoutMs =
    Number.isFinite(options.timeoutMs) && (options.timeoutMs as number) > 0
      ? Math.floor(options.timeoutMs as number)
      : 1500;
  const service = String(options.service ?? HUB_SERVICE_NAME).toLowerCase().replace(/\.+$/, "");
  const group = options.group ?? MDNS_GROUP;
  const mdnsPort = options.mdnsPort ?? MDNS_PORT;

  return new Promise<MdnsDiscoveredHub[]>((resolve) => {
    let settled = false;
    let socket: MdnsSocketLike | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    // Instancias anunciadas y sus datos, indexados por nombre completo.
    const instances = new Map<string, { target: string }>();
    const services = new Map<string, { port: number; target: string }>();
    const texts = new Map<string, Record<string, string>>();
    const addresses = new Map<string, string[]>();
    let lastSeenAddress = "";

    const build = (): MdnsDiscoveredHub[] => {
      const hubs: MdnsDiscoveredHub[] = [];
      const seen = new Set<string>();
      for (const [instance, ptr] of instances) {
        const srv = services.get(instance);
        if (!srv) continue;
        const txt = texts.get(instance) ?? {};
        const fingerprint = normalizeFingerprint(txt.fp);
        const candidates = addresses.get(srv.target.toLowerCase()) ?? [];
        const host = candidates[0] ?? lastSeenAddress;
        if (!host) continue;
        const key = `${host}:${srv.port}`;
        if (seen.has(key)) continue;
        seen.add(key);
        hubs.push({
          host,
          port: srv.port,
          url: `${fingerprint ? "https" : "http"}://${host}:${srv.port}`,
          fingerprint,
          name: instance.split(".")[0] || ptr.target
        });
      }
      return hubs;
    };

    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const current = socket;
      socket = null;
      if (current) {
        try {
          current.close();
        } catch {
          // El socket ya estaba cerrado.
        }
      }
      resolve(build());
    };

    const absorb = (message: MdnsMessage): void => {
      const records = [...message.answers, ...message.additionals];
      for (const record of records) {
        const name = record.name.toLowerCase();
        if (record.type === MDNS_RECORD_TYPES.PTR && record.target) {
          if (name === service) instances.set(record.target.toLowerCase(), { target: record.target });
        } else if (record.type === MDNS_RECORD_TYPES.SRV && record.port !== undefined && record.target) {
          services.set(name, { port: record.port, target: record.target.toLowerCase() });
        } else if (record.type === MDNS_RECORD_TYPES.TXT) {
          texts.set(name, parseTxt(record.txt));
        } else if (record.type === MDNS_RECORD_TYPES.A && record.address) {
          if (record.address !== "0.0.0.0") {
            const list = addresses.get(name) ?? [];
            if (!list.includes(record.address)) list.push(record.address);
            addresses.set(name, list);
          }
        }
      }
    };

    try {
      socket = options.sockets?.create ? options.sockets.create() : createUdpSocket();
    } catch (error) {
      options.log?.(`mDNS: sin socket para descubrir: ${error instanceof Error ? error.message : String(error)}`);
      resolve([]);
      return;
    }

    const query = encodeMdnsQuery(service);
    socket.on("message", (...args: unknown[]) => {
      const message = args[0];
      const remote = args[1] as { address?: string } | undefined;
      if (remote && typeof remote.address === "string") lastSeenAddress = remote.address;
      if (!Buffer.isBuffer(message)) return;
      try {
        absorb(decodeMdnsMessage(message));
      } catch {
        // Respuesta corrupta: se ignora y se sigue escuchando.
      }
    });
    socket.on("error", (error: unknown) => {
      options.log?.(`mDNS: no se pudo descubrir: ${error instanceof Error ? error.message : String(error)}`);
      finish();
    });

    // Sin unref: el que llama espera esta promesa y el temporizador es corto.
    timer = setTimeout(finish, timeoutMs);

    try {
      options.query?.(query);
      socket.send(query, mdnsPort, group, () => {
        // Un fallo de envío no cancela la escucha: se resuelve en el timeout.
      });
    } catch {
      finish();
    }
  });
}
