/**
 * Runtime de escritorio que corre en el proceso principal de Electron.
 *
 * Se empaqueta con esbuild a `dist/desktop-runtime.cjs` y main.electron.cjs lo
 * carga en tiempo de ejecución. Nunca importa `electron`: aquí solo viven el
 * hub LAN sobre el adaptador SQLite y el guardián del manifiesto de updates.
 */
import path from "node:path";
import fs from "node:fs";
import { createHash } from "node:crypto";
import type { LocalDbDriver } from "../services/localDb/contract";
import type { SqliteAdapter } from "../services/localDb/sqlite/adapter";
import { createSqliteDriver } from "../services/localDb/sqlite/driver";
import { createHubHandler, type HubHandler, type HubHandlerOptions } from "../services/lanHub/handler";
import { createHubRatesProvider } from "../services/lanHub/rates";
import {
  RATE_BOOT_DELAY_MS,
  RATE_FAILURE_MIN_MS,
  RATE_MAX_MS,
  buildRateSnapshot,
  mergeRateSnapshot,
  nextRateDelayMs,
  readRateSnapshot,
  type HubRateSnapshot
} from "../services/lanHub/rateScheduler";
import { readChangeFeed } from "../services/lanHub/changesFeed";
import { createHubNodeServer, type HubNodeServer } from "../services/lanHub/nodeServer";
import { recordRequest } from "../services/requestBudget";
import type { HubRateQuote, HubRequest, HubResponse } from "../services/lanHub/protocol";
import { canonicalizeRates, parseExchangeRates } from "../lib/exchangeRates";
import { ensureHubTls, type HubTlsMaterial } from "../services/lanHub/tls";
import {
  HUB_TXT_PATH,
  createMdnsAnnouncer,
  discoverHubs as discoverMdnsHubs,
  lanIpv4Addresses,
  type MdnsAnnouncer,
  type MdnsDiscoveredHub
} from "../services/lanHub/mdns";
import { createBackup } from "../services/lanHub/backup";
import {
  loadOrCreateBackupKey,
  rotateBackups,
  writeBackupFile,
  type BackupKeyHandle
} from "../services/lanHub/backupStoreNode";
import {
  parseUpdateManifest,
  type UpdateArtifact,
  type UpdateChannel,
  type UpdateManifestV1
} from "../services/updates/manifest";
import { evaluateUpdate, verifyUpdateManifest } from "../services/updates/verify";
import type { DesktopHubStatus } from "../lib/desktopRuntime";

const DEFAULT_HUB_PORT = 48900;
const MANIFEST_MAX_BYTES = 512 * 1024;
const MANIFEST_TIMEOUT_MS = 15000;
/** Pausa antes del reintento cuando la descarga del manifiesto falla una vez. */
const MANIFEST_RETRY_DELAY_MS = 1500;
/** Respaldo cifrado del hub: uno al día y rotación 7 diarios + 4 semanales. */
const HUB_BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Única fuente de tasas del hub; el renderer de los clientes nunca la llama. */
const RATES_UPSTREAM_URL = "https://tasas.eltoque.com/v1/trmi";
const RATES_TOKEN_ENV = "ELTOQUE_API_TOKEN";
const RATES_FETCH_TIMEOUT_MS = 12_000;
/** Copia válida junto a la base local; solo la lee el proceso principal. */
const RATES_FILE_NAME = "hub-rates.json";

/** Adaptador del proceso principal; `whenFree` permite esperar a una transacción ajena. */
export interface HubAdapter extends SqliteAdapter {
  whenFree?: (source?: "hub") => Promise<void>;
}

export interface HubRuntimeOptions {
  adapter: HubAdapter;
  dataDir: string;
  log?: (line: string) => void;
  lanEnabled: boolean;
  hubId: string;
  /**
   * TLS del hub. Si no se indica, se lee `PALMYRA_HUB_TLS` ("1"/"true" activa;
   * cualquier otro valor o ausencia lo deja desactivado para no romper
   * instalaciones existentes). Con TLS pedido nunca se degrada a HTTP.
   */
  tlsEnabled?: boolean;
  tls?: { enabled: boolean };
  now?: () => number;
}

export interface HubRuntime {
  start(input: { companyId: string }): Promise<DesktopHubStatus>;
  stop(): Promise<DesktopHubStatus>;
  status(): DesktopHubStatus;
  newPairingCode(): Promise<DesktopHubStatus>;
  close(): Promise<void>;
}

interface HubSession {
  companyId: string;
  driver: LocalDbDriver;
  handler: HubHandler;
  server: HubNodeServer;
  mdns: MdnsAnnouncer | null;
  backupTimer: ReturnType<typeof setInterval> | null;
}

function hubPort(): number {
  const configured = Number(process.env.PALMYRA_HUB_PORT);
  return Number.isInteger(configured) && configured > 0 && configured <= 65535
    ? configured
    : DEFAULT_HUB_PORT;
}

function envTlsEnabled(): boolean {
  const raw = (process.env.PALMYRA_HUB_TLS ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true";
}

function resolveTlsEnabled(options: HubRuntimeOptions): boolean {
  if (typeof options.tlsEnabled === "boolean") return options.tlsEnabled;
  if (options.tls && typeof options.tls.enabled === "boolean") return options.tls.enabled;
  return envTlsEnabled();
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.replace(/\s+/g, " ").trim().slice(0, 200);
}

/**
 * Consulta puntual a elTOQUE desde el proceso principal del hub. El token viaja
 * solo en esta petición: no se registra, no se persiste y nunca llega al
 * renderer ni a los equipos de la red local.
 */
async function fetchUpstreamRateQuotes(token: string, nowMs: number): Promise<HubRateQuote[]> {
  const fetcher = typeof fetch === "function" ? fetch : null;
  if (!fetcher) throw new Error("este runtime no tiene fetch disponible");
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), RATES_FETCH_TIMEOUT_MS) : null;
  let response: Response;
  try {
    response = await fetcher(RATES_UPSTREAM_URL, {
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      ...(controller ? { signal: controller.signal } : {})
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!response.ok) {
    throw new Error(
      response.status === 401 || response.status === 403
        ? "la credencial de elTOQUE fue rechazada"
        : `la fuente de tasas respondió ${response.status}`
    );
  }
  const body: unknown = await response.json().catch(() => null);
  const capturedAt = new Date(nowMs).toISOString();
  const quotes = canonicalizeRates(parseExchangeRates(body)).flatMap(rate => {
    const value = rate.value ?? rate.buy ?? rate.sell;
    if (value === undefined || !Number.isFinite(value) || value <= 0) return [];
    return [{ code: rate.code, rate: value, capturedAt, source: "elTOQUE API", stale: false }];
  });
  if (!quotes.length) throw new Error("la fuente no entregó cotizaciones válidas");
  return quotes;
}

export function createHubRuntime(options: HubRuntimeOptions): HubRuntime {
  const log = options.log ?? (() => {});
  const port = hubPort();
  const host = options.lanEnabled ? "0.0.0.0" : "127.0.0.1";
  const tlsEnabled = resolveTlsEnabled(options);
  let session: HubSession | null = null;
  let lastError = "";
  /** Se conserva entre reinicios para no regenerar si el certificado sigue vigente. */
  let tlsMaterial: HubTlsMaterial | null = null;
  const backupDir = path.join(options.dataDir, "hub-backups");
  let backupKey: BackupKeyHandle | null = null;
  let backupRunning = false;

  // ─── Tasas: el hub consulta elTOQUE y reparte la copia ────────────────────
  const clock = options.now ?? (() => Date.now());
  const ratesFilePath = path.join(options.dataDir, RATES_FILE_NAME);
  let rateSnapshot: HubRateSnapshot | null = null;
  let rateTimer: ReturnType<typeof setTimeout> | null = null;
  let rateSchedulerStopped = false;
  let rateRefreshing = false;
  let rateFailures = 0;
  let lastRateAttemptAt: number | null = null;
  let missingTokenLogged = false;

  /** Copia persistida junto a la base local; nunca lanza al arrancar. */
  function loadRateSnapshotFromDisk(): HubRateSnapshot | null {
    try {
      const raw = fs.readFileSync(ratesFilePath, "utf8");
      const snapshot = readRateSnapshot(JSON.parse(raw) as unknown);
      if (snapshot) {
        log(`Tasa del hub cargada (${snapshot.quotes.length} divisas, captura ${snapshot.fetchedAt}).`);
      }
      return snapshot;
    } catch {
      return null;
    }
  }

  /**
   * Escritura atómica (archivo temporal + rename) con permisos de propietario
   * únicamente. Un fallo de disco solo se registra: no tumba el hub.
   */
  function persistRateSnapshotFile(snapshot: HubRateSnapshot): void {
    const temp = `${ratesFilePath}.tmp`;
    try {
      fs.mkdirSync(path.dirname(ratesFilePath), { recursive: true });
      fs.writeFileSync(temp, JSON.stringify(snapshot), { encoding: "utf8", mode: 0o600 });
      try { fs.chmodSync(temp, 0o600); } catch { /* Windows sin POSIX */ }
      fs.renameSync(temp, ratesFilePath);
      try { fs.chmodSync(ratesFilePath, 0o600); } catch { /* Windows sin POSIX */ }
    } catch (error) {
      log(`No se pudo guardar la tasa del hub: ${describeError(error)}`);
    }
  }

  function scheduleRateRefresh(delayMs: number): void {
    if (rateSchedulerStopped || rateTimer) return;
    const delay = Math.max(0, Math.trunc(Number.isFinite(delayMs) ? delayMs : RATE_MAX_MS));
    rateTimer = setTimeout(() => {
      rateTimer = null;
      void refreshRates();
    }, delay);
    // Nunca retiene el cierre de la aplicación.
    (rateTimer as { unref?: () => void }).unref?.();
  }

  /**
   * Un ciclo del dueño de las tasas: consulta elTOQUE, fusiona con la copia
   * anterior, persiste y programa el siguiente ciclo (45 min ± jitter, con
   * retroceso 5→10→20→30 tras fallos). Nunca lanza.
   */
  async function refreshRates(): Promise<void> {
    if (rateSchedulerStopped) return;
    const token = String(process.env[RATES_TOKEN_ENV] ?? "").trim();
    if (!token) {
      if (!missingTokenLogged) {
        missingTokenLogged = true;
        log(`Tasa del hub: falta ${RATES_TOKEN_ENV}; se conserva la última copia válida.`);
      }
      scheduleRateRefresh(RATE_MAX_MS);
      return;
    }
    if (rateRefreshing) {
      scheduleRateRefresh(RATE_FAILURE_MIN_MS);
      return;
    }
    missingTokenLogged = false;
    rateRefreshing = true;
    lastRateAttemptAt = clock();
    const startedAt = Date.now();
    try {
      const quotes = await fetchUpstreamRateQuotes(token, clock());
      recordRequest("rates/hub", { ms: Date.now() - startedAt, ok: true });
      const fresh = buildRateSnapshot(quotes, clock(), "hub");
      const merged = mergeRateSnapshot(rateSnapshot, fresh);
      if (merged) {
        rateSnapshot = merged;
        persistRateSnapshotFile(merged);
      }
      rateFailures = 0;
      log(`Tasa del hub actualizada (${quotes.length} divisas desde elTOQUE).`);
    } catch (error) {
      rateFailures += 1;
      recordRequest("rates/hub", { ms: Date.now() - startedAt, ok: false });
      log(`No se pudo actualizar la tasa del hub: ${describeError(error)}`);
    } finally {
      rateRefreshing = false;
    }
    if (rateSchedulerStopped) return;
    scheduleRateRefresh(nextRateDelayMs({
      lastSuccessAt: rateFailures === 0 ? lastRateAttemptAt : null,
      failures: rateFailures,
      random: Math.random()
    }));
  }

  /** Proveedor que sirve `/lan/v1/rates` desde la copia del proceso principal. */
  const ratesProvider = createHubRatesProvider({
    cacheReader: () => rateSnapshot,
    maxAgeMs: RATE_MAX_MS
  });

  rateSnapshot = loadRateSnapshotFromDisk();
  // Primera consulta diez segundos después del arranque; luego, la cadencia.
  scheduleRateRefresh(RATE_BOOT_DELAY_MS);

  function snapshot(): DesktopHubStatus {
    const pairing = session ? session.handler.currentPairingSession() : null;
    return {
      enabled: options.lanEnabled,
      running: session !== null,
      host,
      port: session ? session.server.port : port,
      companyId: session ? session.companyId : "",
      pairingCode: pairing ? pairing.code : "",
      pairingExpiresAt: pairing ? pairing.expiresAt : "",
      lastError,
      tlsEnabled,
      tlsFingerprint: session ? session.server.fingerprint : ""
    };
  }

  function startAnnouncer(server: HubNodeServer): MdnsAnnouncer | null {
    // Sin LAN no hay red que anunciar; loopback no sirve a otros equipos.
    if (!options.lanEnabled) return null;
    try {
      const announcer = createMdnsAnnouncer({
        port: server.port,
        addresses: lanIpv4Addresses(),
        instanceName: (options.hubId || "palmyra-hub").replace(/[^A-Za-z0-9_-]/g, "-"),
        txt: {
          v: "1",
          path: HUB_TXT_PATH,
          ...(server.fingerprint ? { fp: server.fingerprint } : {})
        },
        log
      });
      announcer.start();
      return announcer;
    } catch (error) {
      // Sin mDNS el hub sigue sirviendo por IP: no es un fallo de arranque.
      log(`No se pudo anunciar el hub por mDNS: ${describeError(error)}`);
      return null;
    }
  }

  /** Un respaldo que falla no tumba el hub: se registra y el siguiente día reintenta. */
  async function performBackup(current: {
    companyId: string;
    driver: LocalDbDriver;
  }): Promise<void> {
    if (backupRunning) return;
    backupRunning = true;
    try {
      if (!backupKey) backupKey = await loadOrCreateBackupKey(backupDir);
      const gateSource = options.adapter.whenFree;
      if (typeof gateSource === "function") await gateSource();
      const envelope = await createBackup(current.driver, {
        companyId: current.companyId,
        key: backupKey.key,
        ...(options.now ? { now: () => new Date(options.now!()).toISOString() } : {})
      });
      const written = await writeBackupFile(backupDir, envelope, {
        ...(options.now ? { now: () => new Date(options.now!()).toISOString() } : {})
      });
      const rotation = await rotateBackups(backupDir, {
        ...(options.now ? { now: () => new Date(options.now!()).toISOString() } : {})
      });
      log(
        `Respaldo del hub escrito (${written.bytes} bytes); ` +
          `${rotation.dailyKept} diarios y ${rotation.weeklyKept} semanales conservados.`
      );
    } catch (error) {
      log(`No se pudo escribir el respaldo del hub: ${describeError(error)}`);
    } finally {
      backupRunning = false;
    }
  }

  function startBackupLoop(current: HubSession): ReturnType<typeof setInterval> {
    const timer = setInterval(() => {
      void performBackup(current);
    }, HUB_BACKUP_INTERVAL_MS);
    // Un respaldo pendiente no debe impedir que Electron cierre la app.
    (timer as { unref?: () => void }).unref?.();
    return timer;
  }

  async function stopSession(): Promise<void> {
    const current = session;
    session = null;
    if (!current) return;
    try {
      current.mdns?.stop();
    } catch {
      // El anunciador ya estaba detenido.
    }
    if (current.backupTimer) clearInterval(current.backupTimer);
    // Último respaldo antes de soltar el driver; su fallo solo se registra.
    await performBackup(current);
    try {
      await current.server.close();
    } catch (error) {
      lastError = `No se pudo detener el hub: ${describeError(error)}`;
      log(lastError);
    }
    try {
      await current.driver.close();
    } catch {
      // El driver ya estaba cerrado por el servidor.
    }
  }

  async function start(input: { companyId: string }): Promise<DesktopHubStatus> {
    const companyId = typeof input?.companyId === "string" ? input.companyId.trim() : "";
    if (!companyId) {
      lastError = "Falta la empresa del hub.";
      return snapshot();
    }
    if (session) {
      if (session.companyId === companyId) return snapshot();
      await stopSession();
    }

    let driver: LocalDbDriver | null = null;
    let server: HubNodeServer | null = null;
    let announcer: MdnsAnnouncer | null = null;
    try {
      if (tlsEnabled && !tlsMaterial) {
        // Si el certificado no se puede crear NO se arranca en HTTP: el pedido
        // de TLS es explícito y degradarlo en silencio rompería el pin.
        tlsMaterial = ensureHubTls(options.dataDir, options.now ? { now: options.now() } : {});
        log("Certificado TLS del hub listo (huella fijada).");
      }

      driver = await createSqliteDriver({
        adapter: options.adapter,
        filePath: path.join(options.dataDir, "palmyra.db"),
        ...(options.now ? { now: () => new Date(options.now!()).toISOString() } : {})
      });
      await driver.ready();
      const db: LocalDbDriver = driver;

      const handlerOptions: HubHandlerOptions = {
        driver: db,
        hubId: options.hubId,
        companyId,
        // Las tasas las publica el proceso principal: el hub solo sirve su copia.
        rates: ratesProvider,
        ...(options.now ? { now: options.now } : {})
      };
      const handler = createHubHandler(handlerOptions);

      // Las peticiones del hub esperan a que el renderer cierre su transacción:
      // el adaptador síncrono no puede bloquear el bucle de eventos.
      const gateSource = options.adapter.whenFree;
      const gated: HubHandler = Object.assign(
        async (request: HubRequest): Promise<HubResponse> => {
          if (typeof gateSource === "function") await gateSource();
          return handler(request);
        },
        {
          createPairingSession: handler.createPairingSession,
          currentPairingSession: handler.currentPairingSession
        }
      );

      server = await createHubNodeServer({
        handler: gated,
        port,
        host,
        allowLan: options.lanEnabled,
        ...(tlsEnabled && tlsMaterial ? { tls: tlsMaterial } : {}),
        // El canal SSE sondea el journal directamente: la firma del cliente se
        // valida una sola vez al abrir y la conexión ya no caduca.
        changes: async (input) => {
          if (typeof gateSource === "function") await gateSource();
          return readChangeFeed(db, {
            companyId,
            since: input.since,
            limit: input.limit
          });
        },
        log
      });

      announcer = startAnnouncer(server);
      session = { companyId, driver, handler, server, mdns: announcer, backupTimer: null };
      // Respaldo inicial sin bloquear el arranque del hub; luego uno al día.
      void performBackup(session);
      session.backupTimer = startBackupLoop(session);
      lastError = "";
      log(`Hub LAN escuchando en ${server.url} (empresa ${companyId.slice(0, 8)}…)`);
      return snapshot();
    } catch (error) {
      lastError = `No se pudo iniciar el hub LAN: ${describeError(error)}`;
      log(lastError);
      try {
        announcer?.stop();
      } catch {
        // El anunciador no llegó a arrancar.
      }
      if (server) {
        try { await server.close(); } catch { /* ya cerrado */ }
      }
      if (driver) {
        try { await driver.close(); } catch { /* ya cerrado */ }
      }
      return snapshot();
    }
  }

  async function stop(): Promise<DesktopHubStatus> {
    await stopSession();
    return snapshot();
  }

  async function newPairingCode(): Promise<DesktopHubStatus> {
    if (!session) {
      lastError = "El hub LAN no está iniciado.";
      return snapshot();
    }
    try {
      session.handler.createPairingSession();
      lastError = "";
    } catch (error) {
      lastError = `No se pudo crear el código de emparejamiento: ${describeError(error)}`;
      log(lastError);
    }
    return snapshot();
  }

  return {
    start,
    stop,
    status: snapshot,
    newPairingCode,
    close: async () => {
      // El programador de tasas pertenece al proceso principal: se detiene aquí
      // y no al parar el hub LAN, para seguir repartiendo la copia válida.
      rateSchedulerStopped = true;
      if (rateTimer) {
        clearTimeout(rateTimer);
        rateTimer = null;
      }
      await stop();
    }
  };
}

/**
 * Busca hubs en la LAN por mDNS. Nunca lanza: sin red multicast o sin
 * respuestas devuelve la lista vacía.
 */
export async function discoverHubs(
  timeoutMs = 1500
): Promise<{ ok: true; hubs: MdnsDiscoveredHub[] } | { ok: false; error: string }> {
  try {
    const hubs = await discoverMdnsHubs({ timeoutMs });
    return { ok: true, hubs };
  } catch (error) {
    return { ok: false, error: `No se pudo buscar el hub LAN: ${describeError(error)}` };
  }
}

// ─── Guardián del manifiesto de actualización ───────────────────────────────

export interface UpdateManifestGuardInput {
  manifestUrl: string;
  /** Sin clave se acepta el manifiesto: compatibilidad con instalaciones antiguas. */
  publicJwk?: JsonWebKey | null;
  currentVersion: string;
  shellVersion: string;
  deviceId: string;
  channel?: UpdateChannel;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface UpdateManifestGuardResult {
  ok: boolean;
  reason: string;
  version?: string;
  /** Artefactos ya cubiertos por la firma verificada; solo si `ok`. */
  artifacts?: UpdateArtifact[];
}

function publicJwkLooksValid(publicJwk: JsonWebKey): boolean {
  return Boolean(publicJwk) && typeof publicJwk === "object" && publicJwk.kty === "EC";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Descarga y verifica el manifiesto antes de permitir la descarga del Setup.
 * Nunca lanza: cualquier fallo se traduce en `{ok:false}` con un motivo corto.
 */
export async function verifyUpdateManifestForBoot(
  input: UpdateManifestGuardInput
): Promise<UpdateManifestGuardResult> {
  try {
    if (!input || typeof input.manifestUrl !== "string" || !/^https:\/\//i.test(input.manifestUrl)) {
      return { ok: false, reason: "manifiesto-sin-url" };
    }
    if (!input.publicJwk) return { ok: true, reason: "unverified" };
    if (!publicJwkLooksValid(input.publicJwk)) {
      return { ok: false, reason: "clave-invalida" };
    }

    const fetcher = input.fetchImpl ?? (typeof fetch === "function" ? fetch : null);
    if (!fetcher) return { ok: false, reason: "sin-red" };

    const timeoutMs =
      Number.isFinite(input.timeoutMs) && Number(input.timeoutMs) > 0
        ? Number(input.timeoutMs)
        : MANIFEST_TIMEOUT_MS;

    // Un fallo transitorio (corte de red, limitación temporal de GitHub) no debe
    // tumbar la actualización: se reintenta la descarga una sola vez antes de
    // rendirse. Cada intento tiene su propio límite de tiempo. Se conserva el
    // contrato: excepción de red → "error"; respuesta HTTP no válida →
    // "descarga-fallida".
    let response: Response | null = null;
    let lastFailure: "throw" | "http" | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = typeof AbortController === "function" ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
      try {
        response = await fetcher(input.manifestUrl, {
          headers: { accept: "application/json" },
          ...(controller ? { signal: controller.signal } : {})
        });
      } catch {
        response = null;
        lastFailure = "throw";
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (response && response.ok) {
        lastFailure = null;
        break;
      }
      if (response) lastFailure = "http";
      if (attempt === 0) await sleep(MANIFEST_RETRY_DELAY_MS);
    }
    if (!response || !response.ok) {
      return { ok: false, reason: lastFailure === "throw" ? "error" : "descarga-fallida" };
    }

    const raw = await response.text();
    if (typeof raw !== "string" || raw.length > MANIFEST_MAX_BYTES) {
      return { ok: false, reason: "manifiesto-demasiado-grande" };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, reason: "manifiesto-invalido" };
    }

    let manifest: UpdateManifestV1;
    try {
      manifest = parseUpdateManifest(parsed);
    } catch {
      return { ok: false, reason: "manifiesto-invalido" };
    }

    const verification = await verifyUpdateManifest(manifest, {
      publicJwk: input.publicJwk,
      requireSignature: true
    });
    if (!verification.ok) return { ok: false, reason: "firma-invalida", version: manifest.version };

    const evaluation = evaluateUpdate({
      manifest,
      currentVersion: input.currentVersion,
      shellVersion: input.shellVersion,
      deviceId: input.deviceId,
      channel: input.channel ?? "stable"
    });
    if (!evaluation.allowed) {
      return { ok: false, reason: evaluation.reason, version: manifest.version };
    }
    return {
      ok: true,
      reason: "manifesto-verificado",
      version: manifest.version,
      artifacts: manifest.artifacts.map((artifact) => ({ ...artifact }))
    };
  } catch {
    return { ok: false, reason: "error" };
  }
}

// ─── Verificación pre-instalación del instalador descargado ─────────────────

export interface ArtifactFileCheck {
  ok: boolean;
  reason: "ok" | "not-found" | "size-mismatch" | "hash-mismatch" | "io-error";
  /** Mensaje en español listo para mostrar; vacío si ok. */
  message: string;
  expectedBytes: number;
  actualBytes: number | null;
  expectedSha256: string;
  actualSha256: string | null;
}

/**
 * Comprueba un archivo ya descargado contra el artefacto del manifiesto
 * FIRMADO, antes de ejecutarlo: primero el tamaño (barato) y luego el sha256.
 * Nunca lanza: un fallo de lectura es io-error y la instalación no procede.
 * Es la misma regla que Android y PWA: descarga que no cuadra, no se aplica.
 */
export function verifyArtifactFileAgainstManifest(
  filePath: string,
  artifact: UpdateArtifact
): ArtifactFileCheck {
  const expectedBytes = Number(artifact?.bytes);
  const expectedSha256 = String(artifact?.sha256 ?? "").toLowerCase();
  const reject = (
    reason: ArtifactFileCheck["reason"],
    message: string,
    actualBytes: number | null,
    actualSha256: string | null
  ): ArtifactFileCheck => ({
    ok: false,
    reason,
    message,
    expectedBytes,
    actualBytes,
    expectedSha256,
    actualSha256
  });

  let stats: fs.Stats;
  try {
    stats = fs.statSync(filePath);
  } catch {
    return reject(
      "not-found",
      `No existe el instalador descargado en ${filePath}. No se instalará.`,
      null,
      null
    );
  }
  if (!stats.isFile() || stats.size <= 0) {
    return reject(
      "not-found",
      `El instalador descargado está vacío o no es un archivo: ${filePath}. No se instalará.`,
      null,
      null
    );
  }

  const actualBytes = stats.size;
  if (Number.isSafeInteger(expectedBytes) && expectedBytes > 0 && actualBytes !== expectedBytes) {
    return reject(
      "size-mismatch",
      `El tamaño del instalador no coincide con el manifiesto firmado ` +
        `(esperado ${expectedBytes} bytes, recibido ${actualBytes}). No se instalará.`,
      actualBytes,
      null
    );
  }

  let actualSha256: string;
  try {
    actualSha256 = createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  } catch (error) {
    return reject(
      "io-error",
      `No se pudo leer el instalador descargado para verificarlo ` +
        `(${error instanceof Error ? error.message : String(error)}). No se instalará.`,
      actualBytes,
      null
    );
  }

  if (actualSha256 !== expectedSha256) {
    return reject(
      "hash-mismatch",
      `El instalador no coincide con el manifiesto firmado ` +
        `(sha256 esperado ${expectedSha256}, recibido ${actualSha256}). No se instalará.`,
      actualBytes,
      actualSha256
    );
  }
  return {
    ok: true,
    reason: "ok",
    message: "",
    expectedBytes,
    actualBytes,
    expectedSha256,
    actualSha256
  };
}
