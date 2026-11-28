/**
 * Servicio Centralizado de Logs de Sincronización y Red
 * Registra en tiempo real los eventos de red, errores de Supabase,
 * reintentos de cola offline y eventos de sincronización multi-dispositivo.
 */

export interface SyncLogEntry {
  id: string;
  timestamp: string;
  level: 'error' | 'warning' | 'info' | 'success';
  source: 'supabase_rpc' | 'offline_queue' | 'network' | 'background_sync' | 'realtime';
  title: string;
  details?: string;
  entityType?: string;
  actionId?: string;
  retryAttempt?: number;
  maxRetries?: number;
  httpStatus?: number;
}

import { getPalmyraScopedStorageKey } from '../services/localScope';
import { downloadGeneratedFile } from './downloadFile';

const STORAGE_KEY_PREFIX = 'palmyra_sync_logs_v2';
const MAX_LOGS = 200;
/** Ventana de agrupado: una ráfaga de la cola produce una sola escritura. */
const FLUSH_DELAY_MS = 400;

function isSyncLogEntry(value: unknown): value is SyncLogEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<SyncLogEntry>;
  return (
    typeof entry.level === 'string' &&
    typeof entry.source === 'string' &&
    typeof entry.title === 'string'
  );
}

/**
 * El WebView antiguo y los orígenes no seguros no exponen `randomUUID`, y este
 * módulo se llama desde el encolado y el vaciado de la cola: un fallo de
 * diagnóstico jamás puede tumbar una operación de negocio.
 */
function makeId(): string {
  try {
    const subtle = (globalThis.crypto as (Crypto & { randomUUID?: () => string }) | undefined);
    if (subtle && typeof subtle.randomUUID === 'function') return subtle.randomUUID();
  } catch {
    // Se usa el identificador local.
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/*
 * Caché + escritura agrupada.
 *
 * El vaciado registra un evento por elemento: leer y serializar 200 filas en
 * cada uno bloqueaba el hilo durante toda la subida. Se conserva una copia en
 * memoria y la escritura difiere unos cientos de milisegundos; si cambia el
 * alcance (usuario/empresa) se descarta y se vuelve a leer. Una pestaña ajena
 * puede pisar el archivo: solo se pierden líneas de diagnóstico.
 */
let cacheKey: string | null = null;
let cacheLogs: SyncLogEntry[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function readStored(key: string): SyncLogEntry[] {
  try {
    const raw = localStorage.getItem(key);
    // Sin registros reales la lista queda vacía: nunca se inventan eventos de
    // demostración (hacían creer que la sincronización ya había ocurrido).
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isSyncLogEntry).slice(0, MAX_LOGS) : [];
  } catch (e) {
    console.error('[syncLogger] Error al leer logs de sincronización:', e);
    return [];
  }
}

function writeLogs(key: string): void {
  try {
    localStorage.setItem(key, JSON.stringify(cacheLogs));
  } catch (e) {
    console.error('[syncLogger] Error al guardar log:', e);
  }
}

function cancelFlush(): void {
  if (flushTimer === null) return;
  clearTimeout(flushTimer);
  flushTimer = null;
}

/** Persiste de inmediato lo pendiente (cambio de alcance, cierre, exportación). */
function flushNow(): void {
  const key = cacheKey;
  cancelFlush();
  if (!key) return;
  writeLogs(key);
}

function scheduleFlush(): void {
  if (flushTimer !== null) return;
  const key = cacheKey;
  if (!key) return;
  // En Node no hay ciclo de vida de página: se escribe sin esperar el timer.
  if (typeof window === 'undefined' || typeof window.setTimeout !== 'function') {
    writeLogs(key);
    return;
  }
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (cacheKey === key) writeLogs(key);
  }, FLUSH_DELAY_MS);
}

let lifecycleBound = false;
function bindLifecycleFlush(): void {
  if (lifecycleBound || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  lifecycleBound = true;
  // La pestaña puede cerrarse justo después del último evento de la cola.
  const onLeave = () => flushNow();
  window.addEventListener('pagehide', onLeave);
  document.addEventListener?.('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushNow();
  });
}

/** Lista actual (más reciente primero). Copia: el llamador no muta la caché. */
export function getSyncLogs(): SyncLogEntry[] {
  bindLifecycleFlush();
  const key = getPalmyraScopedStorageKey(STORAGE_KEY_PREFIX);
  if (!key) return [];
  if (cacheKey !== key) {
    flushNow();
    cacheKey = key;
    cacheLogs = readStored(key);
  }
  return cacheLogs.slice();
}

export function addSyncLog(entry: Omit<SyncLogEntry, 'id' | 'timestamp'>): SyncLogEntry {
  const newLog: SyncLogEntry = { ...entry, id: makeId(), timestamp: new Date().toISOString() };
  try {
    if (getPalmyraScopedStorageKey(STORAGE_KEY_PREFIX)) {
      const logs = getSyncLogs();
      cacheLogs = [newLog, ...logs].slice(0, MAX_LOGS);
      scheduleFlush();
    }
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent('sync_log_event', { detail: { log: newLog } }));
    }
  } catch (e) {
    console.error('[syncLogger] Error al registrar log:', e);
  }
  return newLog;
}

export function clearSyncLogs(): void {
  const key = getPalmyraScopedStorageKey(STORAGE_KEY_PREFIX);
  // Lo pendiente del alcance anterior ya no tiene destino: se descarta aquí.
  cancelFlush();
  cacheKey = key;
  cacheLogs = [];
  if (!key) return;
  try {
    localStorage.removeItem(key);
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent('sync_log_event', { detail: { cleared: true, logs: [] } }));
    }
  } catch (e) {
    console.error('[syncLogger] Error al limpiar logs:', e);
  }
}

export function exportSyncLogsJSON(): void {
  flushNow();
  const logs = getSyncLogs();
  const outcome = downloadGeneratedFile(
    new TextEncoder().encode(JSON.stringify(logs, null, 2)),
    `sync_logs_audit_${new Date().toISOString().split('T')[0]}.json`,
    'application/json'
  );
  if (outcome.status !== 'saved') {
    console.error('[syncLogger] El log JSON no se descargó:', outcome);
  }
}

export function exportSyncLogsTXT(): void {
  flushNow();
  const logs = getSyncLogs();
  const lines = logs.map(l => {
    const time = new Date(l.timestamp).toLocaleString('es-CU');
    return `[${time}] [${l.level.toUpperCase()}] [${l.source.toUpperCase()}] ${l.title} ${l.details ? ' - Details: ' + l.details : ''} ${l.retryAttempt ? `(Reintento ${l.retryAttempt}/${l.maxRetries || 5})` : ''}`;
  });

  const header = `=====================================================\nINFORME DE AUDITORÍA Y LOGS DE SINCRONIZACIÓN POS\nFecha de Exportación: ${new Date().toLocaleString('es-CU')}\nTotal de Registros: ${logs.length}\n=====================================================\n\n`;
  
  const outcome = downloadGeneratedFile(
    new TextEncoder().encode(header + lines.join('\n')),
    `sync_logs_report_${new Date().toISOString().split('T')[0]}.txt`,
    'text/plain;charset=utf-8'
  );
  if (outcome.status !== 'saved') {
    console.error('[syncLogger] El log TXT no se descargó:', outcome);
  }
}
