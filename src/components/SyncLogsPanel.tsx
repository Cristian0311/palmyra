import React, { useState, useEffect, useMemo } from 'react';
import { 
  Wifi, WifiOff, RefreshCw, AlertCircle, CheckCircle2, AlertTriangle, 
  Info, Database, Download, Trash2, Filter, Search, ShieldCheck, 
  Activity, ArrowUpRight, ArrowDownRight, Terminal, Copy, Check, ChevronDown, ChevronUp, Pause, Play, X
} from 'lucide-react';
import { 
  getSyncLogs, addSyncLog, clearSyncLogs, exportSyncLogsJSON, exportSyncLogsTXT, SyncLogEntry 
} from '../utils/syncLogger';
import { getOfflineQueue, getOfflineQueueCount } from '../services/offlineQueue';
import { testSupabaseTables } from '../services/supabaseSync';
import { useStore } from '../store/useStore';
import { cn } from '../lib/utils';

export function SyncLogsPanel() {
  const [logs, setLogs] = useState<SyncLogEntry[]>([]);
  const [levelFilter, setLevelFilter] = useState<'all' | 'error' | 'warning' | 'success' | 'info'>('all');
  const [sourceFilter, setSourceFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedLogId, setExpandedLogId] = useState<string | null>(null);
  const [copiedLogId, setCopiedLogId] = useState<string | null>(null);
  
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [pendingQueueCount, setPendingQueueCount] = useState(getOfflineQueueCount());
  const [isSyncing, setIsSyncing] = useState(false);
  const [isTestingLatency, setIsTestingLatency] = useState(false);
  const [pingLatency, setPingLatency] = useState<number | null>(null);
  const [isPaused, setIsPaused] = useState(false);

  const { syncWithSupabase, addNotification } = useStore();

  // Escuchar eventos en tiempo real de logs y red
  useEffect(() => {
    setLogs(getSyncLogs());

    const handleLogEvent = (e: any) => {
      if (isPaused) return;
      if (e.detail?.cleared) {
        setLogs([]);
      } else if (e.detail?.logs) {
        setLogs(e.detail.logs);
      }
    };

    const handleQueueUpdate = () => {
      setPendingQueueCount(getOfflineQueueCount());
    };

    const handleOnline = () => {
      setIsOnline(true);
      addSyncLog({
        level: 'success',
        source: 'network',
        title: 'Dispositivo En Línea',
        details: 'Se ha detectado conexión a Internet activa en el navegador.'
      });
    };

    const handleOffline = () => {
      setIsOnline(false);
      addSyncLog({
        level: 'warning',
        source: 'network',
        title: 'Conexión Perdida (Modo Offline)',
        details: 'El navegador ha entrado en modo sin conexión. Las operaciones se guardarán en la cola offline local.'
      });
    };

    window.addEventListener('sync_log_event', handleLogEvent);
    window.addEventListener('offline_queue_updated', handleQueueUpdate);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('sync_log_event', handleLogEvent);
      window.removeEventListener('offline_queue_updated', handleQueueUpdate);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [isPaused]);

  // Medir latencia de Supabase / BD
  const handleTestLatency = async () => {
    setIsTestingLatency(true);
    const start = performance.now();
    try {
      const res = await testSupabaseTables();
      const end = performance.now();
      const duration = Math.round(end - start);
      setPingLatency(duration);

      if (res.connected) {
        addSyncLog({
          level: 'success',
          source: 'supabase_rpc',
          title: `Ping a Base de Datos Exitoso (${duration} ms)`,
          details: `Conexión verificada con Supabase. Resumen: ${res.summary}`
        });
      } else {
        addSyncLog({
          level: 'error',
          source: 'supabase_rpc',
          title: 'Error de Ping a Base de Datos',
          details: res.summary
        });
      }
    } catch (err: any) {
      setPingLatency(null);
      addSyncLog({
        level: 'error',
        source: 'network',
        title: 'Fallo al medir latencia de Supabase',
        details: err.message || 'Sin respuesta del servidor'
      });
    } finally {
      setIsTestingLatency(false);
    }
  };

  // Sincronización manual forzada
  const handleManualSync = async () => {
    if (isSyncing) return;
    setIsSyncing(true);
    addSyncLog({
      level: 'info',
      source: 'offline_queue',
      title: 'Iniciando Sincronización Manual',
      details: `Procesando cola offline (${pendingQueueCount} elementos pendientes) y solicitando sincronización con Supabase.`
    });

    try {
      const { processOfflineQueue } = await import('../services/offlineSync');
      const res = await processOfflineQueue();
      setPendingQueueCount(res.remaining);
      await syncWithSupabase();

      const localQueue = getOfflineQueue();
      const queueDetails = localQueue
        .filter(item => item.status !== 'synced' && item.status !== 'conflict')
        .map(item => {
          const detail = item.lastError || 'La operación permanece pendiente por una dependencia de otra operación que no se pudo confirmar.';
          return `${item.type} · ${item.actionId}: ${detail}`;
        });
      const resultDetails = (res.errors || []).map(e => `${e.type} · ${e.actionId}: ${e.message}`);
      const detailLines = [...new Set([...resultDetails, ...queueDetails])].slice(0, 12);
      const hasPending = res.remaining > 0;
      const hasErrors = res.failed > 0 || (res.errors?.length || 0) > 0;
      if (hasPending || hasErrors) {
        const summary = `Confirmadas: ${res.processed}. Fallidas/error: ${res.failed}. Restantes en cola: ${res.remaining}.`;
        addSyncLog({
          level: 'warning',
          source: 'background_sync',
          title: 'Sincronización Manual Incompleta',
          details: `${summary}\\n${detailLines.join('\\n')}`
        });
        if (addNotification) {
          addNotification(
            `Sincronización incompleta: ${res.processed} confirmadas; ${res.remaining} pendientes.`,
            'warning',
            detailLines.length ? detailLines.join('\\n') : summary
          );
        }
      } else {
        addSyncLog({
          level: 'success',
          source: 'background_sync',
          title: 'Sincronización Manual Completada',
          details: `Se procesaron ${res.processed} elementos pendientes. Restantes en cola: 0.`
        });
        if (addNotification) addNotification('Sincronización completada correctamente', 'success');
      }
    } catch (err: any) {
      addSyncLog({
        level: 'error',
        source: 'background_sync',
        title: 'Error durante Sincronización Manual',
        details: err.message || 'Error desconocido'
      });
      if (addNotification) addNotification('Error durante la sincronización', 'error');
    } finally {
      setIsSyncing(false);
    }
  };

  const handleClear = () => {
    clearSyncLogs();
    setLogs([]);
    if (addNotification) addNotification('Logs de sincronización limpiados', 'info');
  };

  const handleCopyDetail = (log: SyncLogEntry) => {
    const text = JSON.stringify(log, null, 2);
    navigator.clipboard.writeText(text);
    setCopiedLogId(log.id);
    setTimeout(() => setCopiedLogId(null), 2000);
  };

  // Contadores de métricas
  const stats = useMemo(() => {
    const total = logs.length;
    const errors = logs.filter(l => l.level === 'error').length;
    const warnings = logs.filter(l => l.level === 'warning').length;
    const retries = logs.filter(l => (l.retryAttempt || 0) > 0).length;
    return { total, errors, warnings, retries };
  }, [logs]);

  // Filtrado de logs
  const filteredLogs = useMemo(() => {
    return logs.filter(log => {
      // Nivel
      if (levelFilter !== 'all' && log.level !== levelFilter) return false;
      // Fuente
      if (sourceFilter !== 'all' && log.source !== sourceFilter) return false;
      // Búsqueda
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const titleMatch = log.title?.toLowerCase().includes(q);
        const detailsMatch = log.details?.toLowerCase().includes(q);
        const entityMatch = log.entityType?.toLowerCase().includes(q);
        const actionMatch = log.actionId?.toLowerCase().includes(q);
        return titleMatch || detailsMatch || entityMatch || actionMatch;
      }
      return true;
    });
  }, [logs, levelFilter, sourceFilter, searchQuery]);

  return (
    <div className="bg-secondary rounded-2xl border border-base p-4 sm:p-5 space-y-4 shadow-sm">
      {/* Encabezado Principal */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-base pb-3.5">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-indigo-50 dark:bg-indigo-950/50 border border-indigo-200 dark:border-indigo-800 flex items-center justify-center text-indigo-600 dark:text-indigo-400 shrink-0">
            <Activity className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-black text-primary uppercase tracking-tight">
                Monitor de Logs de Sincronización
              </h3>
              <span className="text-[8px] font-black uppercase px-2 py-0.5 rounded-md bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border border-indigo-500/20">
                Tiempo Real
              </span>
            </div>
            <p className="text-[9px] font-bold text-muted uppercase tracking-wider mt-0.5">
              Supervisión de errores de red, peticiones Supabase RPC y cola offline
            </p>
          </div>
        </div>

        {/* Botones de Exportación e Historial */}
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={exportSyncLogsJSON}
            className="px-3 py-1.5 bg-subtle hover:bg-slate-200 dark:hover:bg-slate-800 text-primary rounded-xl text-[9px] font-black uppercase tracking-wider transition-all flex items-center gap-1.5 cursor-pointer border border-base"
            title="Exportar logs en formato JSON"
          >
            <Download className="w-3.5 h-3.5 text-indigo-500" />
            <span>JSON</span>
          </button>

          <button
            type="button"
            onClick={exportSyncLogsTXT}
            className="px-3 py-1.5 bg-subtle hover:bg-slate-200 dark:hover:bg-slate-800 text-primary rounded-xl text-[9px] font-black uppercase tracking-wider transition-all flex items-center gap-1.5 cursor-pointer border border-base"
            title="Exportar informe técnico en archivo TXT"
          >
            <Terminal className="w-3.5 h-3.5 text-emerald-500" />
            <span>TXT</span>
          </button>

          <button
            type="button"
            onClick={handleClear}
            className="px-3 py-1.5 bg-rose-500/10 hover:bg-rose-500/20 text-rose-600 dark:text-rose-400 rounded-xl text-[9px] font-black uppercase tracking-wider transition-all flex items-center gap-1.5 cursor-pointer border border-rose-500/20"
            title="Limpiar registro de logs"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>Limpiar</span>
          </button>
        </div>
      </div>

      {/* Tarjetas de Métricas de Estado de Red y Sincronización */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        {/* Conexión de Red */}
        <div className={cn(
          "p-3 rounded-xl border flex flex-col justify-between transition-all",
          isOnline ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-800 dark:text-emerald-300" : "bg-amber-500/10 border-amber-500/20 text-amber-800 dark:text-amber-300"
        )}>
          <div className="flex items-center justify-between">
            <span className="text-[8px] font-black uppercase tracking-widest opacity-80">Estado Red</span>
            {isOnline ? <Wifi className="w-3.5 h-3.5 text-emerald-500" /> : <WifiOff className="w-3.5 h-3.5 text-amber-500 animate-pulse" />}
          </div>
          <p className="text-xs font-black uppercase mt-1">
            {isOnline ? 'En Línea' : 'Sin Conexión'}
          </p>
        </div>

        {/* Latencia Supabase BD */}
        <div className="p-3 rounded-xl bg-indigo-500/10 border border-indigo-500/20 text-indigo-900 dark:text-indigo-200 flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-[8px] font-black uppercase tracking-widest opacity-80">Latencia BD</span>
            <Database className="w-3.5 h-3.5 text-indigo-500" />
          </div>
          <div className="flex items-center justify-between mt-1">
            <p className="text-xs font-black font-mono">
              {pingLatency !== null ? `${pingLatency} ms` : 'Sin medir'}
            </p>
            <button
              type="button"
              onClick={handleTestLatency}
              disabled={isTestingLatency}
              className="text-[8px] font-black uppercase px-2 py-0.5 rounded bg-indigo-600 text-white hover:bg-indigo-700 transition-all cursor-pointer disabled:opacity-50"
            >
              {isTestingLatency ? 'Probando...' : 'Ping'}
            </button>
          </div>
        </div>

        {/* Elementos Pendientes en Cola */}
        <div className={cn(
          "p-3 rounded-xl border flex flex-col justify-between transition-all",
          pendingQueueCount > 0 ? "bg-amber-500/10 border-amber-500/20 text-amber-900 dark:text-amber-200" : "bg-subtle border-base text-primary"
        )}>
          <div className="flex items-center justify-between">
            <span className="text-[8px] font-black uppercase tracking-widest opacity-80">Cola Offline</span>
            <RefreshCw className={cn("w-3.5 h-3.5", pendingQueueCount > 0 && "text-amber-500 animate-spin")} />
          </div>
          <div className="flex items-center justify-between mt-1">
            <p className="text-xs font-black font-mono">
              {pendingQueueCount} pend.
            </p>
            <button
              type="button"
              onClick={handleManualSync}
              disabled={isSyncing || !isOnline}
              className="text-[8px] font-black uppercase px-2 py-0.5 rounded bg-indigo-600 text-white hover:bg-indigo-700 transition-all cursor-pointer disabled:opacity-50"
            >
              {isSyncing ? 'Subiendo...' : 'Sincro'}
            </button>
          </div>
        </div>

        {/* Reintentos y Errores */}
        <div className="p-3 rounded-xl bg-subtle border border-base text-primary flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-[8px] font-black uppercase tracking-widest text-muted">Errores / Reintentos</span>
            <AlertTriangle className={cn("w-3.5 h-3.5", stats.errors > 0 ? "text-rose-500" : "text-muted")} />
          </div>
          <div className="flex items-center gap-2 mt-1">
            <span className={cn("text-xs font-black font-mono", stats.errors > 0 ? "text-rose-600 dark:text-rose-400" : "text-primary")}>
              {stats.errors} err.
            </span>
            <span className="text-[9px] font-bold text-muted">·</span>
            <span className="text-xs font-black font-mono text-amber-600 dark:text-amber-400">
              {stats.retries} reint.
            </span>
          </div>
        </div>
      </div>

      {/* Barra de Filtros y Búsqueda */}
      <div className="space-y-2 pt-1">
        <div className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-2">
          {/* Tabs por Nivel */}
          <div className="flex items-center gap-1 p-1 bg-subtle rounded-xl border border-base overflow-x-auto custom-scrollbar">
            {(['all', 'error', 'warning', 'success', 'info'] as const).map(lvl => (
              <button
                key={lvl}
                type="button"
                onClick={() => setLevelFilter(lvl)}
                className={cn(
                  "px-3 py-1.5 rounded-lg text-[9px] font-black uppercase tracking-wider transition-all whitespace-nowrap cursor-pointer",
                  levelFilter === lvl
                    ? lvl === 'error' ? "bg-rose-600 text-white shadow-sm"
                    : lvl === 'warning' ? "bg-amber-600 text-white shadow-sm"
                    : lvl === 'success' ? "bg-emerald-600 text-white shadow-sm"
                    : lvl === 'info' ? "bg-indigo-600 text-white shadow-sm"
                    : "bg-primary text-primary shadow-sm"
                    : "text-muted hover:text-primary"
                )}
              >
                {lvl === 'all' && `Todos (${stats.total})`}
                {lvl === 'error' && `Errores (${stats.errors})`}
                {lvl === 'warning' && `Advertencias (${stats.warnings})`}
                {lvl === 'success' && `Éxitos`}
                {lvl === 'info' && `Info`}
              </button>
            ))}
          </div>

          {/* Selector de Fuente y Pausa Live Stream */}
          <div className="flex items-center gap-2">
            <select
              value={sourceFilter}
              onChange={e => setSourceFilter(e.target.value)}
              className="px-3 py-1.5 bg-subtle border border-base rounded-xl text-[9px] font-black uppercase text-primary outline-none focus:ring-2 focus:ring-indigo-500/20 cursor-pointer"
            >
              <option value="all">Todas las Fuentes</option>
              <option value="supabase_rpc">Supabase RPC / BD</option>
              <option value="offline_queue">Cola Offline</option>
              <option value="network">Red / Conexión</option>
              <option value="background_sync">Sincronización Background</option>
              <option value="realtime">Canal Realtime</option>
            </select>

            <button
              type="button"
              onClick={() => setIsPaused(!isPaused)}
              className={cn(
                "px-3 py-1.5 rounded-xl text-[9px] font-black uppercase tracking-wider transition-all flex items-center gap-1.5 cursor-pointer border",
                isPaused ? "bg-amber-500/20 text-amber-600 border-amber-500/30" : "bg-subtle text-muted border-base hover:text-primary"
              )}
              title={isPaused ? "Reanudar flujo en tiempo real" : "Pausar actualización en vivo"}
            >
              {isPaused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
              <span>{isPaused ? 'Pausado' : 'En vivo'}</span>
            </button>
          </div>
        </div>

        {/* Input de Búsqueda */}
        <div className="relative">
          <Search className="w-3.5 h-3.5 text-muted absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Filtrar por título, entidad, error o detalles técnicos..."
            className="w-full pl-9 pr-8 py-2 bg-subtle border border-base rounded-xl text-xs font-bold text-primary outline-none focus:ring-2 focus:ring-indigo-500/20 placeholder:text-muted/60"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-primary p-0.5 rounded-full"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Lista de Logs en Vivo */}
      <div className="border border-base rounded-xl overflow-hidden bg-primary">
        <div className="bg-subtle px-3.5 py-2 border-b border-base flex items-center justify-between text-[8px] font-black uppercase tracking-widest text-muted">
          <span>Registro de Eventos ({filteredLogs.length})</span>
          <span>Marca Temporal</span>
        </div>

        {filteredLogs.length === 0 ? (
          <div className="p-8 text-center space-y-2">
            <Activity className="w-8 h-8 text-muted mx-auto opacity-40" />
            <p className="text-xs font-black uppercase text-muted">No hay registros de sincronización</p>
            <p className="text-[10px] text-muted">
              {searchQuery || levelFilter !== 'all' || sourceFilter !== 'all'
                ? 'Prueba modificando los filtros de búsqueda.'
                : 'Todas las operaciones están sincronizadas y sin errores.'}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-base max-h-[420px] overflow-y-auto custom-scrollbar">
            {filteredLogs.map(log => {
              const isExpanded = expandedLogId === log.id;
              const dateObj = new Date(log.timestamp);
              const formattedTime = dateObj.toLocaleTimeString('es-CU');
              const formattedDate = dateObj.toLocaleDateString('es-CU', { day: '2-digit', month: '2-digit' });

              return (
                <div 
                  key={log.id} 
                  className={cn(
                    "p-3 transition-colors hover:bg-subtle/50 text-left",
                    log.level === 'error' && "bg-rose-500/5 hover:bg-rose-500/10",
                    log.level === 'warning' && "bg-amber-500/5 hover:bg-amber-500/10"
                  )}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-2.5 min-w-0 flex-1">
                      {/* Icono de Nivel */}
                      <div className="mt-0.5 shrink-0">
                        {log.level === 'error' && <AlertCircle className="w-4 h-4 text-rose-500" />}
                        {log.level === 'warning' && <AlertTriangle className="w-4 h-4 text-amber-500" />}
                        {log.level === 'success' && <CheckCircle2 className="w-4 h-4 text-emerald-500" />}
                        {log.level === 'info' && <Info className="w-4 h-4 text-indigo-500" />}
                      </div>

                      {/* Título e Info */}
                      <div className="min-w-0 flex-1 space-y-0.5">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-xs font-black text-primary uppercase tracking-tight">
                            {log.title}
                          </span>

                          {/* Fuente Tag */}
                          <span className="text-[7px] font-black uppercase px-1.5 py-0.5 rounded bg-subtle text-muted border border-base">
                            {log.source.replace('_', ' ')}
                          </span>

                          {/* Reintento Badge */}
                          {log.retryAttempt !== undefined && log.retryAttempt > 0 && (
                            <span className="text-[7px] font-black uppercase px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-700 dark:text-amber-300 border border-amber-500/30">
                              Reintento {log.retryAttempt}/{log.maxRetries || 5}
                            </span>
                          )}

                          {/* HTTP Status */}
                          {log.httpStatus && (
                            <span className={cn(
                              "text-[7px] font-black font-mono px-1.5 py-0.5 rounded border",
                              log.httpStatus >= 400 ? "bg-rose-500/20 text-rose-600 border-rose-500/30" : "bg-emerald-500/20 text-emerald-600 border-emerald-500/30"
                            )}>
                              HTTP {log.httpStatus}
                            </span>
                          )}
                        </div>

                        {/* Detalle Resumido */}
                        {log.details && (
                          <p className="text-[10px] text-muted font-medium leading-relaxed truncate">
                            {log.details}
                          </p>
                        )}
                      </div>
                    </div>

                    {/* Fecha / Hora y Botón Expandir */}
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-[9px] font-bold font-mono text-muted uppercase">
                        {formattedTime} <span className="opacity-60 text-[8px]">{formattedDate}</span>
                      </span>

                      <button
                        type="button"
                        onClick={() => setExpandedLogId(isExpanded ? null : log.id)}
                        className="p-1 hover:bg-subtle rounded-lg text-muted hover:text-primary transition-colors cursor-pointer"
                        title={isExpanded ? "Ocultar detalles técnicos" : "Ver detalles técnicos completos"}
                      >
                        {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                      </button>
                    </div>
                  </div>

                  {/* Panel Expandido de Detalles Técnicos */}
                  {isExpanded && (
                    <div className="mt-3 p-3 bg-subtle rounded-xl border border-base space-y-2 animate-in fade-in slide-in-from-top-1 duration-150">
                      <div className="flex items-center justify-between">
                        <span className="text-[8px] font-black uppercase tracking-widest text-muted">Detalles Técnicos & JSON Payload</span>
                        <button
                          type="button"
                          onClick={() => handleCopyDetail(log)}
                          className="px-2 py-1 bg-primary text-primary hover:bg-slate-200 dark:hover:bg-slate-800 rounded-lg text-[8px] font-black uppercase tracking-wider transition-all flex items-center gap-1 border border-base cursor-pointer"
                        >
                          {copiedLogId === log.id ? <Check className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3 text-muted" />}
                          <span>{copiedLogId === log.id ? '¡Copiado!' : 'Copiar JSON'}</span>
                        </button>
                      </div>

                      <pre className="text-[9px] font-mono p-2.5 bg-slate-950 text-slate-200 rounded-lg overflow-x-auto custom-scrollbar leading-relaxed whitespace-pre-wrap">
                        {JSON.stringify({
                          id: log.id,
                          timestamp: log.timestamp,
                          level: log.level,
                          source: log.source,
                          title: log.title,
                          details: log.details,
                          entityType: log.entityType,
                          actionId: log.actionId,
                          retryAttempt: log.retryAttempt,
                          httpStatus: log.httpStatus
                        }, null, 2)}
                      </pre>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
