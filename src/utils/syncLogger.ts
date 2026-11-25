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

export function getSyncLogs(): SyncLogEntry[] {
  const storageKey = getPalmyraScopedStorageKey(STORAGE_KEY_PREFIX);
  if (!storageKey) return [];
  try {
    const raw = localStorage.getItem(storageKey);
    // Sin registros reales la lista queda vacía: nunca se inventan eventos de
    // demostración (hacían creer que la sincronización ya había ocurrido).
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SyncLogEntry[]) : [];
  } catch (e) {
    console.error('[syncLogger] Error al leer logs de sincronización:', e);
    return [];
  }
}

export function addSyncLog(entry: Omit<SyncLogEntry, 'id' | 'timestamp'>): SyncLogEntry {
  const logs = getSyncLogs();
  const newLog: SyncLogEntry = {
    ...entry,
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString()
  };

  // Prepend y limitar a MAX_LOGS
  const updated = [newLog, ...logs].slice(0, MAX_LOGS);

  const storageKey = getPalmyraScopedStorageKey(STORAGE_KEY_PREFIX);
  if (!storageKey) return newLog;
  try {
    localStorage.setItem(storageKey, JSON.stringify(updated));
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('sync_log_event', { detail: { log: newLog, logs: updated } }));
    }
  } catch (e) {
    console.error('[syncLogger] Error al guardar log:', e);
  }

  return newLog;
}

export function clearSyncLogs(): void {
  const storageKey = getPalmyraScopedStorageKey(STORAGE_KEY_PREFIX);
  if (!storageKey) return;
  try {
    localStorage.removeItem(storageKey);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('sync_log_event', { detail: { cleared: true, logs: [] } }));
    }
  } catch (e) {
    console.error('[syncLogger] Error al limpiar logs:', e);
  }
}

export function exportSyncLogsJSON(): void {
  const logs = getSyncLogs();
  try {
    downloadGeneratedFile(
      new TextEncoder().encode(JSON.stringify(logs, null, 2)),
      `sync_logs_audit_${new Date().toISOString().split('T')[0]}.json`,
      'application/json'
    );
  } catch (e) {
    console.error('[syncLogger] Error al descargar el log JSON:', e);
  }
}

export function exportSyncLogsTXT(): void {
  const logs = getSyncLogs();
  const lines = logs.map(l => {
    const time = new Date(l.timestamp).toLocaleString('es-CU');
    return `[${time}] [${l.level.toUpperCase()}] [${l.source.toUpperCase()}] ${l.title} ${l.details ? ' - Details: ' + l.details : ''} ${l.retryAttempt ? `(Reintento ${l.retryAttempt}/${l.maxRetries || 5})` : ''}`;
  });

  const header = `=====================================================\nINFORME DE AUDITORÍA Y LOGS DE SINCRONIZACIÓN POS\nFecha de Exportación: ${new Date().toLocaleString('es-CU')}\nTotal de Registros: ${logs.length}\n=====================================================\n\n`;
  
  try {
    downloadGeneratedFile(
      new TextEncoder().encode(header + lines.join('\n')),
      `sync_logs_report_${new Date().toISOString().split('T')[0]}.txt`,
      'text/plain;charset=utf-8'
    );
  } catch (e) {
    console.error('[syncLogger] Error al descargar el log TXT:', e);
  }
}
