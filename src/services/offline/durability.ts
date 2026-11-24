/**
 * Durabilidad de la cola offline.
 *
 * La garantía del producto es la cola en IndexedDB, no la petición de red: una
 * operación confirmada en la UI ya está escrita como registro durable antes de
 * salir hacia la nube. Este módulo cubre los dos huecos que quedaban alrededor
 * de esa garantía:
 *
 * 1. Arranque: una hidratación incompleta (IndexedDB escrita por otra ventana,
 *    alcance de empresa resuelto después del primer render o una migración que
 *    falló) no puede ocultar operaciones reales. Se fusiona memoria + espejo
 *    durable, se deduplica por clave idempotente y nunca se descarta nada.
 * 2. Cierre abrupto: un elemento guardado como `processing` significa que la
 *    aplicación murió entre el envío y la confirmación. Vuelve a `pending` con
 *    la MISMA clave idempotente y un backoff, de modo que el reintento no
 *    duplique la operación en el servidor.
 *
 * Todo es puro o inyectable a propósito: se prueba sin navegador ni IndexedDB.
 */
import type { OfflineQueueItem } from '../offlineQueueTypes';
import {
  compareOfflineQueueItems,
  dedupeOfflineQueueItems,
  offlineIdempotencyKey
} from './syncContract';

/** Primer reintento de una operación interrumpida por un cierre abrupto. */
export const INTERRUPTED_RETRY_BASE_MS = 30_000;
/** Tope del backoff: una tablet puede tardar horas en volver a tener red. */
export const INTERRUPTED_RETRY_MAX_MS = 15 * 60_000;

/** Motivo visible para el operador cuando la operación quedó a medio enviar. */
export const INTERRUPTED_RETRY_MESSAGE =
  'La aplicación se cerró mientras se enviaba esta operación. Sigue guardada y se reintentará automáticamente.';

/**
 * Espera antes de reintentar una operación interrumpida. Crece con los intentos
 * previos y lleva ±20 % de jitter para que varias cajas no reintenten a la vez.
 */
export function interruptedRetryDelayMs(
  retryCount = 0,
  random: () => number = Math.random
): number {
  const attempts = Math.max(0, Math.floor(Number(retryCount) || 0));
  const base = Math.min(INTERRUPTED_RETRY_MAX_MS, INTERRUPTED_RETRY_BASE_MS * 2 ** Math.min(5, attempts));
  const jitter = 0.8 + Math.max(0, Math.min(1, random())) * 0.4;
  return Math.round(base * jitter);
}

export interface InterruptedRecoveryOptions {
  now?: number;
  random?: () => number;
  /** Fuerza un retraso concreto (pruebas y llamadas desde el motor de sync). */
  delayMs?: (retryCount: number) => number;
  /**
   * false conserva los `processing` tal cual: este proceso los tiene en vuelo
   * ahora mismo y reiniciarlos provocaría un envío duplicado.
   */
  recoverInFlight?: boolean;
}

export interface InterruptedRecoveryResult {
  /** Cola completa (mismo orden relativo) con la clave idempotente materializada. */
  items: OfflineQueueItem[];
  /** Solo los elementos que estaban en vuelo y volvieron a `pending`. */
  recovered: OfflineQueueItem[];
}

/**
 * Devuelve los elementos "en vuelo" a `pending` conservando id, actionId y
 * clave idempotente. No elimina ni reinicia contadores: un cierre abrupto no es
 * un rechazo del servidor.
 */
export function recoverInterruptedQueueItems(
  items: readonly OfflineQueueItem[],
  options: InterruptedRecoveryOptions = {}
): InterruptedRecoveryResult {
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const recovered: OfflineQueueItem[] = [];
  const next: OfflineQueueItem[] = [];

  for (const item of items || []) {
    if (!item || !item.id) continue;
    const withKey: OfflineQueueItem = item.idempotencyKey
      ? item
      : { ...item, idempotencyKey: offlineIdempotencyKey(item) };
    if (withKey.status !== 'processing' || options.recoverInFlight === false) {
      next.push(withKey);
      continue;
    }
    const retryCount = Number(withKey.retryCount || 0);
    const delay = options.delayMs
      ? options.delayMs(retryCount)
      : interruptedRetryDelayMs(retryCount, options.random);
    const resumed: OfflineQueueItem = {
      ...withKey,
      status: 'pending',
      interruptedAt: new Date(now).toISOString(),
      // El backoff se respeta aunque el elemento esté `pending`: el motor de
      // sync no lo envía antes de esta marca.
      nextRetryAt: now + Math.max(0, Math.round(delay)),
      lastError: withKey.lastError || INTERRUPTED_RETRY_MESSAGE
    };
    recovered.push(resumed);
    next.push(resumed);
  }

  return { items: next, recovered };
}

/** Puertos que el motor de sync implementa sobre la cola real. */
export interface OfflineQueueHydrationPorts {
  /** Espera a que la migración/lectura inicial de la cola haya terminado. */
  ready(): Promise<void>;
  /** Copia en memoria de esta ventana (puede estar vacía o incompleta). */
  readMemory(): OfflineQueueItem[];
  /** Espejo durable (IndexedDB). `null` cuando no está disponible. */
  readDurable(): Promise<OfflineQueueItem[] | null>;
  /** Reemplaza la copia en memoria y emite el evento de contadores. */
  writeMemory(items: OfflineQueueItem[]): void;
  /** Persiste la cola reparada. */
  persist(items: OfflineQueueItem[]): Promise<void>;
  now?: () => number;
  random?: () => number;
}

export type OfflineQueueHydrationSource = 'memory' | 'merged' | 'durable-unavailable';

export interface OfflineQueueHydrationResult {
  queue: OfflineQueueItem[];
  /** Elementos que estaban en vuelo al cerrarse la aplicación. */
  recovered: number;
  /** Elementos que existían en el espejo durable y faltaban en memoria. */
  restored: number;
  source: OfflineQueueHydrationSource;
  /** true cuando hubo que reescribir memoria/espejo. */
  changed: boolean;
}

/**
 * Hidrata la cola antes de que cualquier pantalla lea datos y repara:
 * - operaciones encoladas por otra ventana o antes del último cambio de alcance,
 * - operaciones que un cierre abrupto dejó en vuelo.
 *
 * Nunca devuelve una cola más corta que la memoria o el espejo durable.
 * `recover: false` deja los elementos en vuelo intactos: se usa cuando este
 * proceso está drenando la cola ahora mismo y un `processing` es real.
 */
export async function hydrateOfflineQueueForBoot(
  ports: OfflineQueueHydrationPorts,
  options: { recover?: boolean } = {}
): Promise<OfflineQueueHydrationResult> {
  try {
    await ports.ready();
  } catch {
    // La cola ya intentó hidratarse; seguimos con lo que haya disponible.
  }

  const memory = (ports.readMemory() || []).filter(item => item && item.id && item.type && item.actionId);
  let durable: OfflineQueueItem[] | null = null;
  try {
    durable = await ports.readDurable();
  } catch {
    durable = null;
  }

  const durableRows = Array.isArray(durable)
    ? durable.filter(item => item && item.id && item.type && item.actionId)
    : [];
  const memoryIds = new Set(memory.map(item => String(item.id)));
  const restored = durableRows.filter(item => !memoryIds.has(String(item.id))).length;

  const mergedSource = durableRows.length > 0 ? [...memory, ...durableRows] : [...memory];
  const deduped = dedupeOfflineQueueItems(mergedSource).sort(compareOfflineQueueItems);
  const { items, recovered } = recoverInterruptedQueueItems(deduped, {
    now: ports.now ? ports.now() : Date.now(),
    random: ports.random,
    recoverInFlight: options.recover !== false
  });

  const changed = recovered.length > 0 || restored > 0;
  const source: OfflineQueueHydrationSource = durable === null
    ? 'durable-unavailable'
    : durableRows.length > 0 ? 'merged' : 'memory';

  let queue = items;
  if (changed) {
    // `readDurable()` es asíncrono: mientras tanto la UI puede haber confirmado
    // una operación nueva en memoria. Se relee justo antes de escribir para que
    // esa venta/operación no la borre la instantánea de la hidratación.
    const latestMemory = (ports.readMemory() || []).filter(item => item && item.id && item.type && item.actionId);
    const known = new Set(queue.map(item => String(item.id)));
    const added = latestMemory.filter(item => !known.has(String(item.id)));
    if (added.length > 0) {
      queue = dedupeOfflineQueueItems([...queue, ...added]).sort(compareOfflineQueueItems);
    }
    ports.writeMemory(queue);
    try {
      await ports.persist(queue);
    } catch (error) {
      // La copia en memoria ya refleja el trabajo real; el espejo se reintenta
      // en el siguiente ciclo de persistencia. Nunca se descarta nada.
      console.warn('[offlineDurability] No se pudo reescribir la cola reparada:', error);
    }
  }

  return { queue, recovered: recovered.length, restored, source, changed };
}

/**
 * ¿Debe el motor saltarse este elemento en la pasada actual por backoff?
 * Aplica a fallos transitorios y a operaciones recuperadas de un cierre.
 */
export function isQueueItemDeferred(
  item: Pick<OfflineQueueItem, 'status' | 'nextRetryAt' | 'interruptedAt'>,
  now: number = Date.now()
): boolean {
  if (item.status === 'conflict') return false;
  const until = Number(item.nextRetryAt || 0);
  if (!Number.isFinite(until) || until <= now) return false;
  // Un reloj que retrocedió (o una marca heredada) no puede congelar la cola:
  // el backoff real nunca pasa del tope, así que una espera mayor no es válida.
  if (until - now > INTERRUPTED_RETRY_MAX_MS * 2) return false;
  return item.status === 'failed' || Boolean(item.interruptedAt);
}
