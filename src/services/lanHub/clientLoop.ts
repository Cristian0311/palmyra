/**
 * Bucle del cliente LAN: mantiene este equipo al día con el journal del hub y
 * le propone las escrituras locales pendientes.
 *
 * Estrategia de entrada: si hay sesión se intenta primero el canal SSE
 * (`/lan/v1/events`); si el canal no llega a abrirse se cae a sondeo de
 * `GET /lan/v1/changes` cada `pollMs`. En ambos caminos la página se aplica con
 * `applyHubChanges` (una sola transacción idempotente) y solo después se avanza
 * el cursor persistido, que nunca retrocede.
 *
 * Estrategia de salida: un bucle aparte lee el journal local con el outbox y
 * propone lotes idempotentes a `POST /lan/v1/ops`. El cursor de salida solo
 * avanza cuando el hub acusa el lote sin rechazos; un rechazo lo congela para
 * que nada se pierda. Los dos bucles comparten sesión pero no temporizadores.
 *
 * `startHubClientLoop` es idempotente: dos arranques devuelven el mismo mando y
 * no duplican stream ni temporizador alguno. El bucle escucha los cambios de
 * sesión: al emparejar arranca y al desvincular se detiene la actividad.
 *
 * Resistencia (F2-D): cada pull y push acusado anota un contacto con el hub
 * (`resilience.ts`). Tras 72 h sin contacto el bucle deja de proponer lotes
 * —sin tocar el outbox ni su cursor— y el equipo pasa a solo lectura; el pull
 * sigue corriendo por si el hub vuelve. Los rechazos del hub se registran como
 * conflictos visibles (`conflicts.ts`) y se limpian cuando un envío posterior
 * los acusa como `accepted`/`duplicate`.
 */
import type { LocalDbDriver } from "../localDb/contract";
import { createHubOutbox } from "../localDb/hubOutbox";
import { getRuntimeDriver } from "../localDb/runtimeDriver";
import { getPalmyraLocalScope } from "../localScope";
import { getDeviceId } from "../lanPresence";
import { createHubClient } from "./client";
import { clearResolvedHubConflicts, recordHubConflictForOps } from "./conflicts";
import { openHubEvents } from "./events";
import { createHubOpsClient, type HubOpsBatchResult } from "./opsClient";
import {
  canWriteToHub,
  getHubResilienceState,
  markHubUnreachable,
  recordHubContact,
  type HubResilienceMode
} from "./resilience";
import {
  advanceCursor,
  getHubSession,
  loadHubOutboxCursor,
  saveHubOutboxCursor,
  subscribeHubSession,
  type HubSession
} from "./session";
import { applyHubChanges, type HubChange } from "./syncClient";

/** Tablas internas del hub: viajan en el journal pero no se replican. */
const INTERNAL_TABLES = new Set<string>(["hub_devices", "hub_receipts"]);

/** Tablas que nunca se proponen al hub (internas y la propia bandeja). */
const PUSH_FILTERED_TABLES = new Set<string>(["hub_devices", "hub_receipts", "outbox"]);

/** Cadencia mínima de la sonda de contacto mientras el equipo está bloqueado. */
const BLOCKED_PROBE_MS = 60_000;

/** Resumen de un intento de push; se entrega a `onPush` sin lanzar. */
export interface HubPushResult {
  /** Operaciones propuestas en el intento. */
  pushed: number;
  accepted: number;
  duplicated: number;
  rejected: number;
  /** Código del fallo de transporte; ausente si el hub acusó el lote. */
  error?: string;
  /** Operaciones que el hub rechazó; su lote no avanza el cursor. */
  rejectedActionIds: string[];
  /** Código del hub por operación rechazada (`actionId` → código). */
  rejectedCodes?: Record<string, string>;
  /** Estado del enlace con el hub al hacer el intento. */
  mode?: HubResilienceMode;
  /**
   * true si el lote ni siquiera se propuso: el equipo lleva 72 h sin contacto
   * con el hub y está en solo lectura. El outbox y su cursor quedan intactos.
   */
  blocked?: boolean;
}

export type HubClientLoopSource = "events" | "poll";

export interface HubClientLoopResult {
  applied: number;
  deleted: number;
  skipped: number;
  conflicts: number;
  /** Cursor persistido tras aplicar esta página. */
  cursor: number;
  source: HubClientLoopSource;
}

export interface StartHubClientLoopOptions {
  onChanges?: (result: HubClientLoopResult) => void;
  /** Periodo del sondeo de respaldo en ms (por defecto 5000). */
  pollMs?: number;
  /** Filas por página del sondeo (por defecto 200). */
  pageLimit?: number;
  /** Empresa a replicar; si falta se toma del alcance local verificado. */
  companyId?: string;
  /** Almacén local; por defecto el driver del runtime. */
  driver?: LocalDbDriver;
  /**
   * Identidad con la que este equipo escribe su journal local. El id de la
   * sesión del hub sirve para firmar con el token, pero no es el origen de
   * las filas propias: confundirlos descarta las ventas antes de enviarlas.
   */
  localDeviceId?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Backoff del canal SSE tras una caída (por defecto 1000 ms). */
  eventsBaseDelayMs?: number;
  /** Periodo del bucle de salida en ms (por defecto 2000). */
  pushMs?: number;
  /** Filas del journal local por lote (por defecto 200). */
  pushLimit?: number;
  /** Espera tras un rechazo o un fallo reintentable (por defecto 5000 ms). */
  pushBackoffMs?: number;
  /** Lotes seguidos por tick antes de ceder el turno (por defecto 5). */
  maxPushBatchesPerTick?: number;
  /** Resumen de cada intento de push; se traga cualquier error del consumidor. */
  onPush?: (result: HubPushResult) => void;
}

export interface HubClientLoopHandle {
  /** Detiene stream, temporizadores y suscripción. Seguro de llamar dos veces. */
  stop(): void;
  isRunning(): boolean;
}

interface Channel {
  key: string;
  abort: AbortController;
  timer: ReturnType<typeof setTimeout> | null;
  mode: HubClientLoopSource;
}

let active: HubClientLoopHandle | null = null;

function positiveInt(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value as number) >= 1 ? Math.floor(value as number) : fallback;
}

/**
 * Origen real de las filas propias. Sin opción explícita se usa la identidad
 * del equipo que también sella la presencia LAN y las escrituras locales.
 */
function resolveLocalDeviceId(explicit: string | undefined): string {
  const value = typeof explicit === "string" ? explicit.trim() : "";
  if (value) return value;
  try {
    return getDeviceId();
  } catch {
    return "";
  }
}

/** Guardas explícitas: el proyecto compila sin `strictNullChecks`. */
function isOpsSuccess(
  result: HubOpsBatchResult
): result is Extract<HubOpsBatchResult, { ok: true }> {
  return result.ok === true;
}

function channelKey(session: HubSession): string {
  return `${session.baseUrl}|${session.hubId}|${session.deviceId}|${session.joinedAt}`;
}

function pageCursor(page: { changes: readonly unknown[]; cursor: number }, appliedThrough: number, since: number): number {
  if (appliedThrough > since) return appliedThrough;
  // Página vacía: el hub confirmó que no queda nada por encima del cursor.
  if (page.changes.length === 0 && page.cursor > since) return page.cursor;
  return since;
}

/**
 * Arranca el bucle (o devuelve el que ya corre). No lanza: los fallos de red
 * se reintentan en el siguiente tick.
 */
export function startHubClientLoop(
  options: StartHubClientLoopOptions = {}
): HubClientLoopHandle {
  if (active) return active;

  const pollMs = Number.isFinite(options.pollMs) && (options.pollMs as number) > 0
    ? Math.floor(options.pollMs as number)
    : 5_000;
  const pageLimit =
    Number.isFinite(options.pageLimit) && (options.pageLimit as number) >= 1
      ? Math.floor(options.pageLimit as number)
      : 200;
  const pushMs = positiveInt(options.pushMs, 2_000);
  const pushLimit = positiveInt(options.pushLimit, 200);
  const pushBackoffMs = positiveInt(options.pushBackoffMs, 5_000);
  const maxPushBatchesPerTick = positiveInt(options.maxPushBatchesPerTick, 5);
  // Reloj inyectable: fechas de resiliencia y de las pruebas.
  const clock = options.now ?? (() => Date.now());

  let stopped = false;
  let current: Channel | null = null;
  let unsubscribe: () => void = () => {};

  // Bucle de salida: temporizador propio y estado separado del canal de entrada.
  let pushTimer: ReturnType<typeof setTimeout> | null = null;
  let pushInFlight = false;
  /** Instante antes del cual no se reintenta (backoff por rechazo o red). */
  let nextPushAt = 0;
  /** Sesión para la que corre el push; cambiarla perdona el backoff. */
  let pushSessionKey = "";
  /** Evita repetir el aviso de "solo lectura" en cada tick. */
  let blockedReported = false;
  /** Última comprobación de contacto hecha desde el modo solo lectura. */
  let lastBlockedProbeAt = 0;

  function closeChannel(): void {
    if (!current) return;
    const closing = current;
    current = null;
    try {
      closing.abort.abort();
    } catch {
      // El aborto de un canal ya cerrado no es un error.
    }
    if (closing.timer !== null) {
      clearTimeout(closing.timer);
      closing.timer = null;
    }
  }

  async function resolveCompanyId(): Promise<string> {
    const explicit = typeof options.companyId === "string" ? options.companyId.trim() : "";
    if (explicit) return explicit;
    try {
      return getPalmyraLocalScope()?.companyId ?? "";
    } catch {
      return "";
    }
  }

  async function resolveDriver(): Promise<LocalDbDriver> {
    return options.driver ?? getRuntimeDriver();
  }

  /* ---------------------------------------------------------------- */
  /* Bucle de salida (push)                                            */
  /* ---------------------------------------------------------------- */

  function reportPush(result: HubPushResult): void {
    try {
      options.onPush?.(result);
    } catch {
      // Un consumidor roto no detiene el envío.
    }
  }

  function cancelPushTimer(): void {
    if (pushTimer !== null) {
      clearTimeout(pushTimer);
      pushTimer = null;
    }
  }

  function schedulePush(delayMs: number): void {
    if (stopped) return;
    // Un solo temporizador: reprogramar sustituye al anterior.
    cancelPushTimer();
    const wait = Number.isFinite(delayMs) ? Math.max(0, Math.floor(delayMs)) : 0;
    pushTimer = setTimeout(() => {
      pushTimer = null;
      void pushTick();
    }, wait);
  }

  /**
   * Despierta el push conservando el backoff vigente. Se invoca en cada aviso
   * de sesión (incluidos los avances del cursor de entrada) para que un lote
   * recién escrito no espere el periodo completo.
   */
  function wakePush(): void {
    if (stopped) return;
    schedulePush(Math.max(0, nextPushAt - Date.now()));
  }

  async function pushTick(): Promise<void> {
    // Un tick en vuelo reprograma al terminar: no se apilan temporizadores.
    if (stopped || pushInFlight) return;
    pushInFlight = true;
    let nextDelay: number | null = null;
    try {
      const session = await getHubSession();
      // Sin sesión no hay a quién proponer; el aviso de sesión lo despertará.
      if (session) nextDelay = await pushPendingBatches(session);
    } catch {
      // Driver o red caídos: se reintenta en el siguiente tick.
      nextDelay = pushBackoffMs;
    } finally {
      pushInFlight = false;
      if (!stopped && nextDelay !== null) {
        schedulePush(Math.max(nextDelay, nextPushAt - Date.now()));
      }
    }
  }

  /**
   * Envía lotes hasta agotar el journal local o tocar el tope del tick.
   * Devuelve el retardo del siguiente tick, o null si el bucle debe dormir
   * hasta el próximo aviso (equipo detenido o sin sesión).
   */
  /**
   * Comprobación de contacto desde modo solo lectura, como mucho una vez por
   * minuto. Cubre el caso silencioso: un canal SSE abierto y sin cambios deja
   * de producir páginas, así que sin esta sonda un equipo conectado pero ocioso
   * podría creerse caído. Solo lee (`/changes`): jamás propone operaciones.
   */
  async function probeHubContact(session: HubSession): Promise<void> {
    const at = clock();
    if (at - lastBlockedProbeAt < BLOCKED_PROBE_MS) return;
    lastBlockedProbeAt = at;
    try {
      await readChangesPage(session, session.cursor);
      recordHubContact(clock());
    } catch {
      markHubUnreachable(clock());
    }
  }

  async function pushPendingBatches(session: HubSession): Promise<number | null> {
    // Puerta de escritura: tras 72 h sin contacto el equipo solo consulta y
    // exporta. No se toca ni la red de operaciones ni el cursor del outbox,
    // así que todo lo pendiente viaja igual en cuanto el hub vuelva.
    const gate = canWriteToHub(clock());
    if (!gate.allowed) {
      await probeHubContact(session);
      if (!blockedReported) {
        blockedReported = true;
        reportPush({
          pushed: 0,
          accepted: 0,
          duplicated: 0,
          rejected: 0,
          error: "offline_limit",
          rejectedActionIds: [],
          mode: "read_only",
          blocked: true
        });
      }
      return pushMs;
    }
    blockedReported = false;

    const companyId = await resolveCompanyId();
    if (!companyId) return pushMs;
    const driver = await resolveDriver();
    const outbox = createHubOutbox(driver, {
      deviceId: session.deviceId,
      companyId,
      originDevice: resolveLocalDeviceId(options.localDeviceId),
      cursor: { loadCursor: loadHubOutboxCursor, saveCursor: saveHubOutboxCursor },
      limit: pushLimit
    });
    const opsClient = createHubOpsClient({
      baseUrl: session.baseUrl,
      token: session.token,
      deviceId: session.deviceId,
      fetchImpl: options.fetchImpl,
      now: options.now
    });

    for (let batchIndex = 0; batchIndex < maxPushBatchesPerTick; batchIndex += 1) {
      if (stopped) return null;
      const from = await outbox.loadCursor();
      const batch = await outbox.collect();
      const ops = batch.ops.filter((op) => !PUSH_FILTERED_TABLES.has(String(op.table)));

      if (ops.length === 0) {
        // La ventana solo traía tablas internas u otra empresa: se salta. Si
        // no avanzara, el cursor quedaría atascado para siempre.
        if (batch.nextSeq > from) {
          await outbox.saveCursor(batch.nextSeq);
          continue;
        }
        return pushMs;
      }

      const result = await opsClient.push(ops);
      const observedAt = clock();
      if (!isOpsSuccess(result)) {
        // Un fallo de transporte no avanza el cursor: el mismo lote viaja de
        // nuevo con los mismos `actionId` y el hub deduplica si ya lo aplicó.
        // El backoff también cubre un 4xx para no martillar credenciales malas.
        if (result.error === "network_error" || result.error === "timeout") {
          markHubUnreachable(observedAt);
        }
        nextPushAt = Date.now() + pushBackoffMs;
        reportPush({
          pushed: ops.length,
          accepted: 0,
          duplicated: 0,
          rejected: 0,
          error: result.error,
          rejectedActionIds: [],
          mode: getHubResilienceState(observedAt).mode
        });
        return pushBackoffMs;
      }

      // El hub respondió y acusó el lote: el plazo de 72 h se reinicia aquí.
      recordHubContact(observedAt);

      let accepted = 0;
      let duplicated = 0;
      const rejectedActionIds: string[] = [];
      const rejectedCodes: Record<string, string> = {};
      const resolvedActionIds: string[] = [];
      for (const outcome of result.results) {
        if (outcome.status === "accepted") accepted += 1;
        else if (outcome.status === "duplicate") duplicated += 1;
        else {
          rejectedActionIds.push(outcome.actionId);
          rejectedCodes[outcome.actionId] = outcome.error || "rejected";
        }
        if (outcome.status !== "rejected") resolvedActionIds.push(outcome.actionId);
      }

      const summary: HubPushResult = {
        pushed: ops.length,
        accepted,
        duplicated,
        rejected: rejectedActionIds.length,
        rejectedActionIds,
        mode: getHubResilienceState(observedAt).mode
      };
      if (rejectedActionIds.length > 0) summary.rejectedCodes = rejectedCodes;

      // Lo que el hub ya acusó (aunque fuera en un reintento) deja de ser un
      // conflicto visible: el estado final es el propuesto.
      if (resolvedActionIds.length > 0) clearResolvedHubConflicts(resolvedActionIds);

      if (rejectedActionIds.length > 0) {
        // El rechazo se hace visible agrupado por código del hub; el cursor
        // sigue congelado para no perder las operaciones posteriores.
        const byCode = new Map<string, string[]>();
        for (const actionId of rejectedActionIds) {
          const code = rejectedCodes[actionId] || "rejected";
          const bucket = byCode.get(code);
          if (bucket) bucket.push(actionId);
          else byCode.set(code, [actionId]);
        }
        const opList = ops;
        for (const [code, actionIds] of byCode) {
          recordHubConflictForOps(opList, actionIds, code);
        }
        nextPushAt = Date.now() + pushBackoffMs;
        reportPush(summary);
        return pushBackoffMs;
      }

      await outbox.saveCursor(batch.nextSeq);
      nextPushAt = 0;
      reportPush(summary);
    }
    return pushMs;
  }

  /**
   * Lee una página de `GET /lan/v1/changes` tolerando las tablas internas.
   *
   * El journal del hub incluye `hub_devices` y `hub_receipts`, que
   * `applyHubChanges` rechaza por diseño (`invalid_change`). `fetchHubChanges`
   * valida el lote completo y por eso se atascaría en el primer registro
   * interno. Aquí se descartan esos registros antes de aplicar, pero su `seq`
   * sí avanza el cursor para no volver a leerlos.
   */
  async function readChangesPage(
    session: HubSession,
    since: number
  ): Promise<{ changes: HubChange[]; cursor: number }> {
    const client = createHubClient({
      baseUrl: session.baseUrl,
      deviceId: session.deviceId,
      token: session.token,
      fetchImpl: options.fetchImpl,
      now: options.now
    });
    const page = await client.changes({ since, limit: pageLimit });
    if (!page || !Array.isArray(page.changes)) {
      throw new Error("El hub LAN devolvió una página de cambios inválida");
    }
    const accepted: HubChange[] = [];
    let lastSeq = since;
    for (const record of page.changes) {
      const seq = typeof record?.seq === "number" && Number.isSafeInteger(record.seq) && record.seq >= 0
        ? record.seq
        : null;
      if (seq === null) throw new Error("El hub LAN devolvió un cambio sin seq válido");
      if (seq > lastSeq) lastSeq = seq;
      if (INTERNAL_TABLES.has(String(record.table ?? ""))) continue;
      accepted.push(record as unknown as HubChange);
    }
    const declared = Number.isSafeInteger(page.latestSeq) && page.latestSeq >= 0 ? page.latestSeq : null;
    const cursor =
      lastSeq > since
        ? lastSeq
        : page.changes.length === 0 && declared !== null && declared > since
          ? declared
          : since;
    return { changes: accepted, cursor };
  }

  /**
   * Aplica una página y persiste el cursor solo si la transacción confirmó.
   * Devuelve el resumen o null si ya no hay sesión/empresa.
   */
  async function applyPage(
    page: { changes: HubChange[]; cursor: number },
    source: HubClientLoopSource
  ): Promise<HubClientLoopResult | null> {
    const session = await getHubSession();
    if (!session) return null;
    const companyId = await resolveCompanyId();
    if (!companyId) return null;

    const applicable: HubChange[] = page.changes.filter(
      (change) => !INTERNAL_TABLES.has(String(change?.table ?? ""))
    );
    const filtered = { changes: applicable, cursor: page.cursor };

    const driver = await resolveDriver();
    const outcome = await applyHubChanges({
      driver,
      companyId,
      changes: applicable
    });
    // El hub entregó una página válida (también por SSE): hay contacto.
    recordHubContact(clock());

    const next = Math.max(session.cursor, pageCursor(filtered, outcome.appliedThrough, session.cursor));
    if (next > session.cursor) await advanceCursor(next);

    const result: HubClientLoopResult = {
      applied: outcome.applied,
      deleted: outcome.deleted,
      skipped: outcome.skipped,
      conflicts: outcome.conflicts,
      cursor: Math.max(next, session.cursor),
      source
    };
    // Sin cambios reales no se molesta al consumidor (ni se registra ruido cada
    // `pollMs`); el cursor igual quedó persistido arriba.
    if (outcome.applied + outcome.deleted + outcome.skipped + outcome.conflicts > 0) {
      try {
        options.onChanges?.(result);
      } catch {
        // Un consumidor roto no detiene la replicación.
      }
    }
    return result;
  }

  function pollTick(holder: Channel): void {
    void (async () => {
      if (stopped || current !== holder) return;
      try {
        const session = await getHubSession();
        if (!session) return;
        const page = await readChangesPage(session, session.cursor);
        // Cada sondeo acusado cuenta como contacto: mantiene vivo el plazo de
        // 72 h mientras el hub responda, aunque no haya cambios que aplicar.
        recordHubContact(clock());
        if (stopped || current !== holder) return;
        await applyPage(page, "poll");
      } catch {
        // Red caída, hub apagado o página corrupta: el siguiente tick reintenta.
        // Una página corrupta no avanza el cursor, así que no se pierde nada.
        // El fallo también alimenta el plazo de solo lectura.
        markHubUnreachable(clock());
      }
      if (stopped || current !== holder) return;
      holder.timer = setTimeout(() => pollTick(holder), pollMs);
    })();
  }

  async function openEvents(holder: Channel, session: HubSession): Promise<void> {
    try {
      await openHubEvents({
        since: session.cursor,
        fetchImpl: options.fetchImpl,
        now: options.now,
        baseDelayMs: options.eventsBaseDelayMs,
        signal: holder.abort.signal,
        onChanges: async (page) => {
          await applyPage({ changes: page.changes, cursor: page.cursor }, "events");
        }
      });
      // Resolver sin aborto solo ocurre si se agotó la sesión: cae a sondeo.
      if (!stopped && current === holder && !holder.abort.signal.aborted) {
        holder.mode = "poll";
        pollTick(holder);
      }
    } catch {
      if (stopped || current !== holder || holder.abort.signal.aborted) return;
      // SSE no disponible (hub antiguo, proxy o red): sondeo con firma nueva.
      holder.mode = "poll";
      pollTick(holder);
    }
  }

  async function reconcile(): Promise<void> {
    if (stopped) return;
    const session = await getHubSession();
    if (stopped) return;
    if (!session) {
      closeChannel();
      // Sin sesión el push duerme; emparejar de nuevo lo despierta.
      cancelPushTimer();
      nextPushAt = 0;
      pushSessionKey = "";
      return;
    }

    const key = channelKey(session);
    if (key !== pushSessionKey) {
      // Equipo o hub nuevo: la bandeja arranca sin backoff heredado.
      pushSessionKey = key;
      nextPushAt = 0;
      wakePush();
    }
    if (current && current.key === key) return;

    closeChannel();
    const holder: Channel = {
      key,
      abort: new AbortController(),
      timer: null,
      mode: "events"
    };
    current = holder;
    await openEvents(holder, session);
  }

  const handle: HubClientLoopHandle = {
    stop(): void {
      if (stopped) return;
      stopped = true;
      unsubscribe();
      unsubscribe = () => {};
      closeChannel();
      cancelPushTimer();
      if (active === handle) active = null;
    },
    isRunning(): boolean {
      return !stopped;
    }
  };

  unsubscribe = subscribeHubSession(() => {
    // Un aviso de sesión también adelanta el envío pendiente (respetando el
    // backoff); no reinicia el canal de entrada por sí solo.
    wakePush();
    void reconcile();
  });
  active = handle;
  void reconcile();
  return handle;
}
