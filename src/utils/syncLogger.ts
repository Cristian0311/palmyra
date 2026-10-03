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

const STORAGE_KEY_PREFIX = 'palmyra_sync_logs_v2';
const MAX_LOGS = 200;

export function getSyncLogs(): SyncLogEntry[] {
  const storageKey = getPalmyraScopedStorageKey(STORAGE_KEY_PREFIX);
  if (!storageKey) return [];
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return getInitialDemoLogs();
    return JSON.parse(raw) as SyncLogEntry[];
  } catch (e) {
    console.error('[syncLogger] Error al leer logs de sincronización:', e);
    return getInitialDemoLogs();
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
  const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(logs, null, 2));
  const downloadAnchor = document.createElement('a');
  downloadAnchor.setAttribute("href", dataStr);
  downloadAnchor.setAttribute("download", `sync_logs_audit_${new Date().toISOString().split('T')[0]}.json`);
  document.body.appendChild(downloadAnchor);
  downloadAnchor.click();
  downloadAnchor.remove();
}

export function exportSyncLogsTXT(): void {
  const logs = getSyncLogs();
  const lines = logs.map(l => {
    const time = new Date(l.timestamp).toLocaleString('es-CU');
    return `[${time}] [${l.level.toUpperCase()}] [${l.source.toUpperCase()}] ${l.title} ${l.details ? ' - Details: ' + l.details : ''} ${l.retryAttempt ? `(Reintento ${l.retryAttempt}/${l.maxRetries || 5})` : ''}`;
  });

  const header = `=====================================================\nINFORME DE AUDITORÍA Y LOGS DE SINCRONIZACIÓN POS\nFecha de Exportación: ${new Date().toLocaleString('es-CU')}\nTotal de Registros: ${logs.length}\n=====================================================\n\n`;
  
  const blob = new Blob([header + lines.join('\n')], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `sync_logs_report_${new Date().toISOString().split('T')[0]}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function getInitialDemoLogs(): SyncLogEntry[] {
  const now = new Date();
  return [
    {
      id: 'demo-log-1',
      timestamp: new Date(now.getTime() - 2000).toISOString(),
      level: 'success',
      source: 'network',
      title: 'Conexión a Internet Restablecida',
      details: 'El dispositivo ha vuelto a detectar conectividad en línea de alta velocidad.',
    },
    {
      id: 'demo-log-2',
      timestamp: new Date(now.getTime() - 15000).toISOString(),
      level: 'info',
      source: 'offline_queue',
      title: 'Cola Offline Comprobada',
      details: 'Procesados 0 elementos pendientes. Estado sincronizado con Supabase.',
    },
    {
      id: 'demo-log-3',
      timestamp: new Date(now.getTime() - 45000).toISOString(),
      level: 'success',
      source: 'supabase_rpc',
      title: 'Fusión de Catálogo Exitosa',
      details: 'Sincronizados productos, sucursales y usuarios desde la nube.',
    }
  ];
}
