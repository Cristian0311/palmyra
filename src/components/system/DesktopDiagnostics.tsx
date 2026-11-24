import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  Copy,
  Database,
  Download,
  FolderOpen,
  Monitor,
  Network,
  RefreshCw,
  RotateCcw,
  ShieldAlert
} from "lucide-react";
import { cn } from "../../lib/utils";
import { PRODUCT_DISPLAY_VERSION, PRODUCT_VERSION } from "../../lib/productVersion";
import {
  DESKTOP_UPDATE_STATUS_LABELS,
  getDesktopUpdater,
  normalizeDesktopUpdateState,
  type DesktopUpdateState
} from "../../lib/desktopUpdate";
import {
  buildDesktopReport,
  desktopFileBasename,
  formatReportForClipboard
} from "../../lib/desktopReport";
import { useDesktopRuntimeStatus } from "../../hooks/useDesktopRuntimeStatus";
import { useDesktopUpdate } from "../../hooks/useDesktopUpdate";
import { SettingsSectionHeader } from "../settings/SettingsSectionHeader";

const DASH = "—";

// El puente real lo expone electron/preload.cjs con contextBridge. Aquí se
// declara en local (sin tocar los tipos globales) porque este panel usa además
// la instalación desde archivo, que no forma parte del contrato general.
type OfflineUpdateBridge = {
  getState(): Promise<DesktopUpdateState | null>;
  check(): Promise<DesktopUpdateState | null>;
  installFile(): Promise<{ ok: boolean; error?: string }>;
  onState(callback: (state: DesktopUpdateState) => void): () => void;
};

function getOfflineUpdateBridge(): OfflineUpdateBridge | null {
  if (typeof window === "undefined") return null;
  const candidate = (window as unknown as { palmyraDesktopUpdate?: Partial<OfflineUpdateBridge> })
    .palmyraDesktopUpdate;
  if (!candidate || typeof candidate !== "object") return null;
  if (
    typeof candidate.getState !== "function" ||
    typeof candidate.check !== "function" ||
    typeof candidate.installFile !== "function" ||
    typeof candidate.onState !== "function"
  ) {
    return null;
  }
  return candidate as OfflineUpdateBridge;
}

// Respaldo y restauración del hub LAN. El puente solo existe en el escritorio
// (electron/preload.cjs); en la instalación web no se muestra este bloque.
type HubBackupEntry = {
  fileName: string;
  createdAt: string;
  sizeBytes: number;
  totalRows: number;
  tableCount: number;
  companyId: string;
  safety: boolean;
};

type HubBackupListResult = { ok: boolean; backups?: HubBackupEntry[]; error?: string };
type HubRestoreResult = {
  ok: boolean;
  restoredFrom?: string;
  safetySnapshot?: string;
  written?: number;
  tables?: number;
  cancelled?: boolean;
  error?: string;
};

type HubBackupBridge = {
  list(): Promise<HubBackupListResult>;
  restore(request: { fileName: string; confirmation: string }): Promise<HubRestoreResult>;
};

const HUB_RESTORE_CONFIRMATION_WORD = "RESTAURAR";
const HUB_RELEASES_URL = "https://github.com/Cristian0311/palmyra/releases";

function getHubBackupBridge(): HubBackupBridge | null {
  if (typeof window === "undefined") return null;
  const candidate = (window as unknown as { palmyraHubBackup?: Partial<HubBackupBridge> })
    .palmyraHubBackup;
  if (!candidate || typeof candidate !== "object") return null;
  if (typeof candidate.list !== "function" || typeof candidate.restore !== "function") return null;
  return candidate as HubBackupBridge;
}

function formatCount(value: number): string {
  if (!Number.isFinite(value) || value < 0) return DASH;
  return Math.round(value).toLocaleString("es-ES");
}

function lastUpdateStateText(state: DesktopUpdateState | null): string {
  if (!state) return "Sin datos del actualizador.";
  const parts = [
    `Estado: ${DESKTOP_UPDATE_STATUS_LABELS[state.status]}`,
    `Versión actual: ${state.currentVersion || PRODUCT_VERSION}`
  ];
  if (state.version) parts.push(`Versión nueva: ${state.version}`);
  if (state.error) parts.push(`Error: ${state.error}`);
  else if (state.message) parts.push(state.message);
  return parts.join(" · ");
}

function formatMoment(value: string): string {
  if (!value) return DASH;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return DASH;
  return date.toLocaleString("es-ES", { dateStyle: "short", timeStyle: "short" });
}

function formatSize(sizeBytes: number): string {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return DASH;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatEpoch(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0 || ms > 8.64e15) return DASH;
  return formatMoment(new Date(ms).toISOString());
}

function statusPill(ok: boolean, okLabel: string, badLabel: string) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-sm font-semibold",
        ok
          ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"
          : "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300"
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", ok ? "bg-emerald-500" : "bg-amber-500")} />
      {ok ? okLabel : badLabel}
    </span>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
      <dt className="text-sm font-medium text-muted">{label}</dt>
      <dd className="min-w-0 break-words text-right text-sm font-semibold text-primary">{children}</dd>
    </div>
  );
}

function updateResultText(state: DesktopUpdateState | null): string {
  if (!state) return "No se pudo leer el estado del actualizador.";
  switch (state.status) {
    case "not-available":
      return "Todo al día: no hay versiones nuevas.";
    case "available":
      return `Hay una versión nueva${state.version ? ` (${state.version})` : ""}. Se descargará en segundo plano.`;
    case "downloading":
      return `Descargando la actualización${state.percent ? ` (${state.percent} %)` : ""}.`;
    case "downloaded":
      return "Actualización descargada. Se aplicará al reiniciar PALMYRA.";
    case "error":
      return `No se pudo comprobar la actualización: ${state.error || state.message || "sin detalle"}.`;
    case "unsupported":
      return "Las actualizaciones automáticas no están disponibles en esta instalación.";
    case "checking":
      return "Buscando actualizaciones…";
    default:
      return "Búsqueda completada.";
  }
}

export default function DesktopDiagnostics() {
  const { available, db, hub, refreshing, refresh } = useDesktopRuntimeStatus();
  const update = useDesktopUpdate();
  const [copied, setCopied] = useState(false);
  const [manualReport, setManualReport] = useState("");
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [checkedOnce, setCheckedOnce] = useState(false);
  const [updateFeedback, setUpdateFeedback] = useState("");
  const offlineBridge = useMemo(() => getOfflineUpdateBridge(), []);
  const [offlineBusy, setOfflineBusy] = useState<"check" | "install" | null>(null);
  const [offlineMessage, setOfflineMessage] = useState("");
  const [offlineState, setOfflineState] = useState<DesktopUpdateState | null>(null);

  const hubBackupBridge = useMemo(() => getHubBackupBridge(), []);
  const [hubBackups, setHubBackups] = useState<HubBackupEntry[]>([]);
  const [hubBackupsBusy, setHubBackupsBusy] = useState(false);
  const [hubBackupsLoaded, setHubBackupsLoaded] = useState(false);
  const [hubBackupsError, setHubBackupsError] = useState("");
  const [selectedHubBackup, setSelectedHubBackup] = useState("");
  const [hubRestorePhrase, setHubRestorePhrase] = useState("");
  const [hubRestoreAck, setHubRestoreAck] = useState(false);
  const [hubRestoring, setHubRestoring] = useState(false);
  const [hubRestoreMessage, setHubRestoreMessage] = useState("");

  const loadHubBackups = useCallback(async () => {
    if (!hubBackupBridge) return;
    setHubBackupsBusy(true);
    setHubBackupsError("");
    try {
      const result = await hubBackupBridge.list();
      if (!result || !result.ok) {
        setHubBackups([]);
        setHubBackupsError(result?.error || "No se pudieron leer los respaldos del hub.");
        return;
      }
      const backups = Array.isArray(result.backups) ? result.backups : [];
      setHubBackups(backups);
      // Si el respaldo elegido ya no está en la lista, se limpia la selección
      // para que nunca se restaure un nombre que dejó de existir.
      setSelectedHubBackup(current =>
        backups.some(entry => entry.fileName === current) ? current : ""
      );
    } catch {
      setHubBackups([]);
      setHubBackupsError("No se pudieron leer los respaldos del hub.");
    } finally {
      setHubBackupsBusy(false);
      setHubBackupsLoaded(true);
    }
  }, [hubBackupBridge]);

  useEffect(() => {
    if (!hubBackupBridge) return;
    void loadHubBackups();
  }, [hubBackupBridge, loadHubBackups]);

  const selectedHubBackupEntry =
    hubBackups.find(entry => entry.fileName === selectedHubBackup) ?? null;
  const hubRestoreReady =
    Boolean(selectedHubBackup) &&
    hubRestorePhrase.trim() === HUB_RESTORE_CONFIRMATION_WORD &&
    hubRestoreAck &&
    !hubRestoring;

  const handleHubRestore = async () => {
    if (!hubBackupBridge || !hubRestoreReady) return;
    setHubRestoring(true);
    setHubRestoreMessage("Esperando la confirmación del sistema…");
    try {
      const result = await hubBackupBridge.restore({
        fileName: selectedHubBackup,
        confirmation: HUB_RESTORE_CONFIRMATION_WORD
      });
      if (result?.ok) {
        setHubRestoreMessage(
          `Hub restaurado desde ${result.restoredFrom || selectedHubBackup}. ` +
            `Copia previa de seguridad: ${result.safetySnapshot || DASH}. ` +
            `Se escribieron ${formatCount(result.written ?? 0)} filas en ${formatCount(
              result.tables ?? 0
            )} tablas. Reinicia PALMYRA para que todas las pantallas recarguen los datos.`
        );
        setHubRestorePhrase("");
        setHubRestoreAck(false);
        setSelectedHubBackup("");
        await loadHubBackups();
      } else if (result?.cancelled) {
        setHubRestoreMessage("Restauración cancelada: no se modificó ningún dato.");
      } else {
        setHubRestoreMessage(result?.error || "No se pudo restaurar el hub.");
      }
    } catch {
      setHubRestoreMessage("No se pudo restaurar el hub.");
    } finally {
      setHubRestoring(false);
    }
  };

  // Último estado conocido del actualizador: primero lo que ya trae el hook y
  // después cada aviso del proceso principal (descarga, verificación, error).
  useEffect(() => {
    if (!offlineBridge) return;
    let active = true;
    const unsubscribe = offlineBridge.onState(state => {
      if (active) setOfflineState(state);
    });
    void offlineBridge
      .getState()
      .then(state => {
        if (active && state) setOfflineState(state);
      })
      .catch(() => {});
    return () => {
      active = false;
      unsubscribe();
    };
  }, [offlineBridge]);

  const handleOfflineCheck = async () => {
    if (!offlineBridge || offlineBusy) return;
    setOfflineBusy("check");
    setOfflineMessage("Buscando actualizaciones…");
    try {
      const state = await offlineBridge.check();
      setOfflineMessage(state ? updateResultText(state) : "No se pudo leer el estado del actualizador.");
    } catch {
      setOfflineMessage("No se pudo buscar actualizaciones. Revisa la conexión e inténtalo de nuevo.");
    } finally {
      setOfflineBusy(null);
    }
  };

  const handleInstallFile = async () => {
    if (!offlineBridge || offlineBusy) return;
    setOfflineBusy("install");
    setOfflineMessage("Selecciona el instalador .exe de PALMYRA. Se verificará la firma antes de instalar.");
    try {
      const result = await offlineBridge.installFile();
      if (result.ok) {
        setOfflineMessage("Instalador verificado. PALMYRA se reiniciará para aplicar la actualización.");
      } else {
        setOfflineMessage(result.error || "No se pudo instalar desde el archivo.");
      }
    } catch {
      setOfflineMessage("No se pudo instalar desde el archivo.");
    } finally {
      setOfflineBusy(null);
    }
  };

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2400);
    return () => window.clearTimeout(timer);
  }, [copied]);

  // Mientras el proceso principal descarga o confirma, el mensaje sigue el
  // estado real del actualizador en vez de quedarse en «Buscando…».
  useEffect(() => {
    if (!checkedOnce || checkingUpdates) return;
    setUpdateFeedback(updateResultText(update.state));
  }, [checkedOnce, checkingUpdates, update.state]);

  const reportText = useCallback(
    () =>
      formatReportForClipboard(
        buildDesktopReport({
          appVersion: PRODUCT_VERSION,
          generatedAt: new Date().toISOString(),
          db,
          hub,
          updater: update.state
        })
      ),
    [db, hub, update.state]
  );

  const handleCopy = async () => {
    const text = reportText();
    setManualReport("");
    try {
      if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
        throw new Error("Portapapeles no disponible");
      }
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setManualReport(text);
    }
  };

  const handleCheckUpdates = async () => {
    if (checkingUpdates || !update.supported) return;
    setCheckingUpdates(true);
    setCheckedOnce(true);
    setUpdateFeedback("Buscando actualizaciones…");
    try {
      await update.checkNow();
      const bridge = getDesktopUpdater();
      const latest = bridge ? normalizeDesktopUpdateState(await bridge.getState()) : null;
      setUpdateFeedback(updateResultText(latest ?? update.state));
    } catch {
      setUpdateFeedback("No se pudo buscar actualizaciones. Revisa la conexión e inténtalo de nuevo.");
    } finally {
      setCheckingUpdates(false);
    }
  };

  const pairingExpiresAt = hub.pairingExpiresAt;
  const pairingExpiresMs = pairingExpiresAt ? Date.parse(pairingExpiresAt) : Number.NaN;
  const pairingActive =
    hub.running &&
    Boolean(hub.pairingCode) &&
    Number.isFinite(pairingExpiresMs) &&
    pairingExpiresMs > Date.now();

  const updaterStatus = update.supported ? update.state?.status ?? "idle" : "unsupported";
  const updaterMessage = update.state?.message || update.state?.error || DASH;
  const displayVersion = PRODUCT_DISPLAY_VERSION;
  const dbFileName = useMemo(() => desktopFileBasename(db.filePath) || DASH, [db.filePath]);

  if (!available) return null;

  return (
    <section className="rounded-2xl border border-base bg-secondary p-3 sm:p-5 shadow-sm space-y-4 min-w-0">
      <SettingsSectionHeader
        icon={Monitor}
        title="Diagnóstico de escritorio"
        subtitle="Estado real de la base local, la red del negocio y las actualizaciones de esta instalación."
        action={
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={refreshing}
            aria-label="Actualizar diagnóstico"
            className="h-11 w-11 rounded-xl border border-base bg-primary text-primary flex items-center justify-center hover:bg-subtle disabled:opacity-50 transition-colors"
          >
            <RefreshCw size={15} className={refreshing ? "animate-spin" : ""} />
          </button>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void handleCopy()}
          className="h-11 w-full sm:w-auto px-4 rounded-xl bg-violet-600 text-white text-sm font-semibold flex items-center justify-center gap-1.5 hover:bg-violet-700 transition-colors"
        >
          <Copy size={15} /> Copiar informe
        </button>
        <span
          role="status"
          aria-live="polite"
          className="text-sm font-semibold text-emerald-600 dark:text-emerald-400"
        >
          {copied ? "Copiado" : ""}
        </span>
      </div>

      {!db.ready && (
        <p
          role="alert"
          className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm font-medium leading-6 text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200"
        >
          <AlertTriangle size={15} className="mr-1 inline align-[-2px]" />
          La base local no está lista. Si el problema continúa, envía{" "}
          <span className="font-mono font-semibold">desktop.log</span> a soporte.
          {db.lastError ? <span className="mt-1 block break-words">Detalle: {db.lastError}</span> : null}
        </p>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <div className="rounded-xl border border-base bg-primary p-3 space-y-2.5 min-w-0">
          <h4 className="flex items-center gap-2 text-sm font-bold text-primary">
            <Database size={15} className="text-violet-600 shrink-0" /> Base local
          </h4>
          <dl className="space-y-1.5">
            <Row label="Estado">{statusPill(db.ready, "Listo", "No disponible")}</Row>
            <Row label="Tamaño">{formatSize(db.sizeBytes)}</Row>
            <Row label="Esquema">{db.schemaVersion > 0 ? `v${db.schemaVersion}` : DASH}</Row>
            <Row label="Archivo">
              <span className="font-mono break-all">{dbFileName}</span>
            </Row>
            <Row label="Última escritura">{formatEpoch(db.lastWriteAt)}</Row>
            {db.lastError ? (
              <Row label="Último error">
                <span className="break-words font-medium text-rose-600 dark:text-rose-400">{db.lastError}</span>
              </Row>
            ) : null}
          </dl>
        </div>

        <div className="rounded-xl border border-base bg-primary p-3 space-y-2.5 min-w-0">
          <h4 className="flex items-center gap-2 text-sm font-bold text-primary">
            <Network size={15} className="text-violet-600 shrink-0" /> Red local
          </h4>
          <dl className="space-y-1.5">
            <Row label="Estado">{statusPill(hub.running, "Activa", "Inactiva")}</Row>
            <Row label="Dirección">
              {hub.host && hub.port > 0 ? (
                <span className="font-mono break-all">{`${hub.host}:${hub.port}`}</span>
              ) : (
                DASH
              )}
            </Row>
            <Row label="Emparejamiento">
              {pairingActive ? (
                <span className="break-words">
                  <span className="font-mono tracking-wide">{hub.pairingCode}</span>
                  <span className="block text-sm font-medium text-muted">
                    Caduca {formatMoment(pairingExpiresAt)}
                  </span>
                </span>
              ) : (
                "Sin código vigente"
              )}
            </Row>
            {hub.lastError ? (
              <Row label="Último error">
                <span className="break-words font-medium text-rose-600 dark:text-rose-400">{hub.lastError}</span>
              </Row>
            ) : null}
          </dl>
        </div>

        <div className="rounded-xl border border-base bg-primary p-3 space-y-2.5 min-w-0">
          <h4 className="flex items-center gap-2 text-sm font-bold text-primary">
            <RefreshCw size={15} className="text-violet-600 shrink-0" /> Actualizador
          </h4>
          <dl className="space-y-1.5">
            <Row label="Estado">{DESKTOP_UPDATE_STATUS_LABELS[updaterStatus]}</Row>
            <Row label="Versión actual">{displayVersion}</Row>
            {update.state?.version ? <Row label="Versión nueva">{update.state.version}</Row> : null}
            {update.state?.percent ? <Row label="Progreso">{`${update.state.percent} %`}</Row> : null}
            <Row label="Mensaje">
              <span className="break-words font-medium">{updaterMessage}</span>
            </Row>
          </dl>
          <div className="pt-1">
            <button
              type="button"
              onClick={() => void handleCheckUpdates()}
              disabled={checkingUpdates || !update.supported}
              className="w-full h-11 rounded-xl border border-base bg-secondary text-primary text-sm font-semibold flex items-center justify-center gap-1.5 hover:bg-subtle disabled:opacity-50 transition-colors"
            >
              <RefreshCw size={14} className={checkingUpdates ? "animate-spin" : ""} />
              {checkingUpdates ? "Buscando…" : "Buscar actualizaciones"}
            </button>
            {!update.supported && (
              <p className="mt-2 text-sm font-medium leading-5 text-muted">
                Las actualizaciones automáticas no están disponibles en esta instalación.
              </p>
            )}
            {updateFeedback && (
              <p role="status" aria-live="polite" className="mt-2 break-words text-sm font-medium leading-5 text-secondary">
                {updateFeedback}
              </p>
            )}
          </div>
        </div>
      </div>

      {offlineBridge && (
        <div className="rounded-xl border border-base bg-primary p-3 space-y-2.5 min-w-0">
          <h4 className="flex items-center gap-2 text-sm font-bold text-primary">
            <RefreshCw size={15} className="text-violet-600 shrink-0" /> Actualización
          </h4>
          <div className="flex flex-col gap-2 sm:flex-row">
            <button
              type="button"
              onClick={() => void handleOfflineCheck()}
              disabled={offlineBusy !== null}
              className="h-11 flex-1 rounded-xl border border-base bg-secondary text-primary text-sm font-semibold flex items-center justify-center gap-1.5 hover:bg-subtle disabled:opacity-50 transition-colors"
            >
              <RefreshCw size={14} className={offlineBusy === "check" ? "animate-spin" : ""} />
              Buscar actualización ahora
            </button>
            <button
              type="button"
              onClick={() => void handleInstallFile()}
              disabled={offlineBusy !== null}
              className="h-11 flex-1 rounded-xl border border-base bg-secondary text-primary text-sm font-semibold flex items-center justify-center gap-1.5 hover:bg-subtle disabled:opacity-50 transition-colors"
            >
              <FolderOpen size={14} />
              Instalar desde archivo (.exe)
            </button>
          </div>
          <p className="break-words text-sm font-medium leading-5 text-muted">
            {lastUpdateStateText(offlineState ?? update.state)}
          </p>
          <p role="status" aria-live="polite" className="break-words text-sm font-medium leading-5 text-secondary">
            {offlineMessage}
          </p>
        </div>
      )}

      {hubBackupBridge && (
        <div className="rounded-xl border border-base bg-primary p-3 space-y-3 min-w-0">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <h4 className="flex items-center gap-2 text-sm font-bold text-primary">
                <RotateCcw size={15} className="text-violet-600 shrink-0" />
                Rollback y restauración del hub
              </h4>
              <p className="mt-1 text-sm font-medium leading-5 text-muted">
                Respaldos cifrados del hub LAN. Restaurar reemplaza por completo los datos
                actuales de ventas, stock y caja de este equipo.
              </p>
            </div>
            <button
              type="button"
              onClick={() => void loadHubBackups()}
              disabled={hubBackupsBusy}
              className="h-9 px-3 rounded-lg border border-base bg-secondary text-primary text-sm font-semibold flex items-center gap-1.5 hover:bg-subtle disabled:opacity-50 transition-colors"
            >
              <RefreshCw size={13} className={hubBackupsBusy ? "animate-spin" : ""} />
              Actualizar
            </button>
          </div>

          {hubBackupsError && (
            <p
              role="alert"
              className="rounded-lg border border-amber-300 bg-amber-50 p-2 text-sm font-medium leading-5 text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200"
            >
              <AlertTriangle size={14} className="mr-1 inline align-[-2px]" />
              {hubBackupsError}
            </p>
          )}

          {hubBackupsLoaded && !hubBackupsError && hubBackups.length === 0 && (
            <p className="text-sm font-medium leading-5 text-muted">
              Todavía no hay respaldos del hub en este equipo. Se crean al iniciar, al cerrar y
              según la programación de la red local.
            </p>
          )}

          {hubBackups.length > 0 && (
            <ul className="space-y-2" aria-label="Respaldos del hub disponibles">
              {hubBackups.map(entry => {
                const selected = entry.fileName === selectedHubBackup;
                return (
                  <li key={entry.fileName}>
                    <button
                      type="button"
                      aria-pressed={selected}
                      onClick={() => {
                        setSelectedHubBackup(selected ? "" : entry.fileName);
                        setHubRestoreMessage("");
                      }}
                      className={cn(
                        "w-full rounded-lg border p-2.5 text-left transition-colors",
                        selected
                          ? "border-violet-500 bg-violet-50 dark:bg-violet-950/30"
                          : "border-base bg-secondary hover:bg-subtle"
                      )}
                    >
                      <span className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                        <span className="text-sm font-bold text-primary">
                          {formatMoment(entry.createdAt)}
                        </span>
                        <span className="text-sm font-semibold text-secondary">
                          {`${formatSize(entry.sizeBytes)} · ${formatCount(entry.totalRows)} filas · ${formatCount(entry.tableCount)} tablas`}
                        </span>
                      </span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-2">
                        <span className="font-mono text-[11px] leading-5 text-muted break-all">
                          {entry.fileName}
                        </span>
                        {entry.safety && (
                          <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
                            Instantánea de seguridad
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="space-y-2 rounded-xl border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/30">
            <p className="flex items-start gap-2 text-sm font-semibold leading-5 text-amber-900 dark:text-amber-200">
              <ShieldAlert size={16} className="mt-0.5 shrink-0" />
              <span>
                Antes de restaurar se guarda una instantánea del estado actual. Si esa copia
                falla, la restauración se cancela y no se toca nada.
              </span>
            </p>
            <label className="block text-sm font-semibold text-primary">
              Escribe <span className="font-mono">{HUB_RESTORE_CONFIRMATION_WORD}</span> para
              habilitar el botón
              <input
                type="text"
                value={hubRestorePhrase}
                onChange={event => setHubRestorePhrase(event.currentTarget.value)}
                autoComplete="off"
                spellCheck={false}
                aria-label={`Escribe ${HUB_RESTORE_CONFIRMATION_WORD} para confirmar la restauración`}
                className="mt-1 h-11 w-full rounded-lg border border-base bg-primary px-3 font-mono text-sm text-primary outline-none focus:ring-1 focus:ring-violet-500"
              />
            </label>
            <label className="flex items-start gap-2 text-sm font-medium leading-5 text-amber-900 dark:text-amber-200">
              <input
                type="checkbox"
                checked={hubRestoreAck}
                onChange={event => setHubRestoreAck(event.currentTarget.checked)}
                className="mt-1 h-4 w-4 shrink-0 accent-rose-600"
              />
              <span>
                Entiendo que se reemplazan los datos del hub y que el sistema pedirá una
                confirmación final en una ventana nativa.
              </span>
            </label>
            <button
              type="button"
              onClick={() => void handleHubRestore()}
              disabled={!hubRestoreReady}
              className="h-11 w-full rounded-xl bg-rose-600 px-4 text-sm font-semibold text-white flex items-center justify-center gap-1.5 hover:bg-rose-700 disabled:opacity-50 transition-colors"
            >
              <RotateCcw size={14} className={hubRestoring ? "animate-spin" : ""} />
              {hubRestoring
                ? "Restaurando…"
                : selectedHubBackupEntry
                  ? `Restaurar el hub desde ${formatMoment(selectedHubBackupEntry.createdAt)}`
                  : "Restaurar el hub"}
            </button>
            <p
              role="status"
              aria-live="polite"
              className="break-words text-sm font-medium leading-5 text-secondary"
            >
              {hubRestoreMessage}
            </p>
          </div>

          <div className="rounded-xl border border-base bg-secondary p-3 space-y-1.5">
            <p className="flex items-center gap-2 text-sm font-bold text-primary">
              <Download size={15} className="text-violet-600 shrink-0" />
              Volver a una versión anterior de PALMYRA
            </p>
            <p className="text-sm font-medium leading-5 text-muted">
              El actualizador automático no instala versiones anteriores. Para volver atrás,
              descarga el instalador de la versión anterior desde GitHub Releases y ejecútalo a
              mano (o usa «Instalar desde archivo»). El rollback no es automático y no borra la
              base local: haz antes una copia de seguridad.
            </p>
            <a
              href={HUB_RELEASES_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-base bg-primary px-3 text-sm font-semibold text-violet-700 hover:bg-subtle dark:text-violet-300"
            >
              Abrir GitHub Releases
            </a>
          </div>
        </div>
      )}

      {manualReport && (
        <details open className="rounded-xl border border-base bg-primary p-3">
          <summary className="cursor-pointer text-sm font-semibold text-primary">
            Copiar el informe a mano
          </summary>
          <p className="mt-2 text-sm font-medium leading-6 text-muted">
            El portapapeles no está disponible. Selecciona el texto y cópialo con Ctrl+C.
          </p>
          <textarea
            readOnly
            value={manualReport}
            rows={12}
            aria-label="Informe de diagnóstico"
            onFocus={event => event.currentTarget.select()}
            className="mt-2 w-full resize-y rounded-xl border border-base bg-subtle p-3 font-mono text-[11px] leading-5 text-primary outline-none focus:ring-1 focus:ring-violet-500"
          />
        </details>
      )}
    </section>
  );
}
