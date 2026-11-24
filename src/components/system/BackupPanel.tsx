import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  Download,
  HardDrive,
  Lock,
  RefreshCw,
  ShieldCheck,
  Upload
} from "lucide-react";
import { cn } from "../../lib/utils";
import { PRODUCT_VERSION } from "../../lib/productVersion";
import CloudBackupSection from "./CloudBackupSection";
import { getRuntimeDriver } from "../../services/localDb/runtimeDriver";
import {
  isAndroidBackupAvailable,
  pickBackupFromDevice,
  saveBackupToDevice
} from "../../services/localDb/backup/android";
import {
  BackupError,
  BACKUP_DAILY_LIMIT,
  BACKUP_MIN_PASSPHRASE_LENGTH,
  BACKUP_WEEKLY_LIMIT,
  BINARY_SNAPSHOT_MAX_BYTES,
  binaryBackupCapability,
  createBackupResult,
  createBinarySnapshot,
  inspectBackup,
  isSqliteFile,
  listBackups,
  newBackupId,
  pruneBackupMetadata,
  readBinaryBackup,
  restoreBackup,
  restoreBinarySnapshot,
  saveBackupMeta,
  snapshotToBackupBytes,
  validateBinaryRestore,
  type BackupEntry,
  type BinaryBackupSummary
} from "../../services/localDb/backup/index";

/**
 * Respaldo y restauración del almacén local (PC, APK y PWA).
 *
 * El archivo sale cifrado con AES-256-GCM; sin la frase no se puede abrir ni
 * restaurar. La restauración exige verificación previa y confirmación explícita
 * porque reemplaza los datos locales del equipo.
 */
const MIN_PASSPHRASE = BACKUP_MIN_PASSPHRASE_LENGTH;

function formatSize(sizeBytes: number): string {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return "—";
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatMoment(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("es-ES", { dateStyle: "short", timeStyle: "short" });
}

function describeError(error: unknown): string {
  if (error instanceof BackupError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return "No se pudo completar la operación.";
}

/** Nombre del respaldo en Descargas: el listado nativo filtra por este patrón. */
function deviceBackupName(at: Date): string {
  const stamp = at.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
  return `palmyra-backup-${stamp}.bin`;
}

/** Códigos del puente Android traducidos a algo accionable para el cajero. */
function describeAndroidPickError(code: string): string {
  const messages: Record<string, string> = {
    unavailable: "Este equipo no puede restaurar desde Descargas.",
    cancelled: "Se canceló la selección del archivo.",
    timeout: "No llegó ningún archivo. Vuelve a intentarlo.",
    too_large: "El archivo supera el límite de 64 MB.",
    read_failed: "El archivo no se pudo leer completo.",
    incomplete: "El archivo llegó incompleto. Vuelve a intentarlo.",
    picker_unavailable: "No hay un explorador de archivos disponible."
  };
  return messages[code] || "No se pudo abrir el respaldo del dispositivo.";
}

function downloadBytes(bytes: Uint8Array, fileName: string): void {
  const blob = new Blob([bytes as unknown as BlobPart], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // El navegador necesita margen para abrir la descarga antes de revocar.
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// ─── Imagen binaria SQLite (ayudas de conversión) ────────────────────────────
const BASE64_CHUNK = 0x8000;

/** Nombre del sobre cifrado binario; el contenido lo marca `kind`. */
function binaryBackupName(at: Date): string {
  const stamp = at.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
  return `palmyra-imagen-${stamp}.pmybak`;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK));
  }
  return btoa(binary);
}

async function sha256HexOf(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("Este equipo no puede calcular SHA-256 en la interfaz.");
  const digest = await subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Aviso único del llavero del sistema.
 *
 * En Linux sin libsecret/gnome-keyring, Electron puede quedarse en `basic_text`
 * (sin cifrado real): el proceso principal responde `available:false` y la
 * licencia cae a IndexedDB, donde el secreto queda sin cifrar en reposo. No se
 * bloquea la app; solo se avisa una vez por equipo. En Windows/macOS no aplica.
 */
const SECURE_WARNING_KEY = "palmyra-secure-warning-v1";
const LINUX_SECURE_WARNING =
  "Este equipo no tiene llavero del sistema (libsecret/gnome-keyring). La identidad de licencia se guarda en el almacén local sin cifrado en reposo; no compartas este perfil de usuario.";

function readSecureWarningDismissed(): boolean {
  try {
    return window.localStorage.getItem(SECURE_WARNING_KEY) === "1";
  } catch {
    return false;
  }
}


export default function BackupPanel() {
  const [passphrase, setPassphrase] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState<"create" | "restore" | "verify" | "list" | "pick" | null>(null);
  const [notice, setNotice] = useState<{ type: "ok" | "error" | "info"; text: string } | null>(null);
  const [entries, setEntries] = useState<BackupEntry[]>([]);
  const [restoreBytes, setRestoreBytes] = useState<Uint8Array | null>(null);
  const [restoreName, setRestoreName] = useState("");
  const [restorePassphrase, setRestorePassphrase] = useState("");
  const [restoreConfirmed, setRestoreConfirmed] = useState(false);
  const [restorePreview, setRestorePreview] = useState<{
    createdAt: string;
    totalRows: number;
    tables: number;
  } | null>(null);
  const [restored, setRestored] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const capability = useMemo(() => binaryBackupCapability(), []);
  const binaryCapability = capability;
  // Solo dentro del APK: en navegador/escritorio el respaldo sigue siendo una descarga.
  const androidBackup = useMemo(() => isAndroidBackupAvailable(), []);

  // Imagen binaria: base completa del motor, restauración solo con reinicio.
  const [binaryNotice, setBinaryNotice] = useState<{ type: "ok" | "error" | "info"; text: string } | null>(null);
  const [binaryBusy, setBinaryBusy] = useState<"snapshot" | "restore" | null>(null);
  const [binaryPassphrase, setBinaryPassphrase] = useState("");
  const [binaryImage, setBinaryImage] = useState<Uint8Array | null>(null);
  const [binarySummary, setBinarySummary] = useState<BinaryBackupSummary | null>(null);
  const [binaryRestoreName, setBinaryRestoreName] = useState("");
  const [binaryRestoreConfirmed, setBinaryRestoreConfirmed] = useState(false);
  const [binaryRestartPending, setBinaryRestartPending] = useState(false);
  const [secureWarning, setSecureWarning] = useState(false);
  const binaryFileInputRef = useRef<HTMLInputElement | null>(null);

  const refreshList = useCallback(async () => {
    setBusy("list");
    try {
      setEntries(await listBackups());
    } finally {
      setBusy(null);
    }
  }, []);

  useEffect(() => {
    void refreshList();
  }, [refreshList]);

  // Una sola consulta al llavero; nunca bloquea ni impide respaldar.
  useEffect(() => {
    let cancelled = false;
    if (readSecureWarningDismissed()) return () => { cancelled = true; };
    const bridge = (window as {
      palmyraSecureStore?: { status?: () => Promise<unknown> };
    }).palmyraSecureStore;
    if (!bridge || typeof bridge.status !== "function") return () => { cancelled = true; };
    void bridge
      .status()
      .then((raw) => {
        if (cancelled || !raw || typeof raw !== "object") return;
        const status = raw as { available?: unknown; platform?: unknown; fallback?: unknown };
        if (status.available === false && status.platform === "linux" && status.fallback === "indexeddb") {
          setSecureWarning(true);
        }
      })
      .catch(() => {
        // Diagnóstico best-effort: un fallo del puente no afecta al respaldo.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const dismissSecureWarning = () => {
    setSecureWarning(false);
    try {
      window.localStorage.setItem(SECURE_WARNING_KEY, "1");
    } catch {
      // Sin localStorage el aviso reaparece: solo cosmético.
    }
  };

  const passphraseTooShort = passphrase.length < MIN_PASSPHRASE;
  const mismatch = confirmation.length > 0 && confirmation !== passphrase;
  const canCreate = !passphraseTooShort && confirmation === passphrase && busy === null;

  const handleCreate = async () => {
    if (!canCreate) return;
    setBusy("create");
    setNotice(null);
    try {
      const driver = await getRuntimeDriver();
      const result = await createBackupResult({
        driver,
        passphrase,
        meta: { app: "palmyra", version: PRODUCT_VERSION, kind: "manual" }
      });
      // En el APK el archivo queda en Descargas; el listado nativo reconoce
      // este nombre. Si el almacenamiento del equipo falla se conserva la
      // descarga del navegador para no perder el respaldo recién creado.
      const androidName = androidBackup ? deviceBackupName(new Date()) : "";
      let location = "";
      if (androidBackup) {
        const saved = await saveBackupToDevice(result.bytes, androidName);
        if (saved.ok) {
          location = saved.location || `Download/${androidName}`;
        } else {
          downloadBytes(result.bytes, result.summary.fileName);
        }
      } else {
        downloadBytes(result.bytes, result.summary.fileName);
      }
      const entry: BackupEntry = {
        id: newBackupId(Date.now()),
        createdAt: result.summary.createdAt,
        sizeBytes: result.summary.sizeBytes,
        schemaVersion: result.summary.schemaVersion,
        latestSeq: result.summary.latestSeq,
        totalRows: result.summary.totalRows,
        counts: result.summary.counts,
        hash: result.summary.hash,
        fileName: location ? androidName : result.summary.fileName,
        origin: "manual",
        encrypted: true
      };
      try {
        await saveBackupMeta(entry);
        await pruneBackupMetadata(new Date());
      } catch {
        // La descarga ya está hecha; la ficha es solo bookkeeping local.
      }
      setEntries(await listBackups());
      setNotice({
        type: "ok",
        text: `Respaldo creado (${formatSize(result.summary.sizeBytes)}, ${result.summary.totalRows} registros).${
          location ? ` Guardado en ${location}.` : ""
        } Guárdalo en un lugar seguro: sin la frase no se puede abrir.`
      });
    } catch (error) {
      setNotice({ type: "error", text: describeError(error) });
    } finally {
      setBusy(null);
    }
  };

  const acceptRestoreFile = (bytes: Uint8Array, name: string) => {
    setRestoreBytes(bytes);
    setRestoreName(name);
    setNotice({ type: "info", text: `Archivo cargado: ${name}. Escribe la frase y verifica antes de restaurar.` });
  };

  const handleFilePicked = async (file: File | null) => {
    setNotice(null);
    setRestorePreview(null);
    setRestored(false);
    setRestoreBytes(null);
    setRestoreName("");
    if (!file) return;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      acceptRestoreFile(bytes, file.name);
    } catch {
      setNotice({ type: "error", text: "No se pudo leer el archivo seleccionado." });
    }
  };

  // El archivo del dispositivo pasa por el mismo camino verificado que el
  // <input type="file">: inspectBackup/restoreBackup validan frase y contenido.
  const handleDeviceRestore = async () => {
    if (!androidBackup || busy !== null) return;
    setBusy("pick");
    setNotice({ type: "info", text: "Elige el archivo del respaldo en el dispositivo…" });
    setRestorePreview(null);
    setRestored(false);
    setRestoreBytes(null);
    setRestoreName("");
    try {
      const picked = await pickBackupFromDevice();
      if (!picked.ok || !picked.bytes) {
        setNotice({ type: "error", text: describeAndroidPickError(picked.error || "") });
        return;
      }
      acceptRestoreFile(picked.bytes, picked.name || "respaldo.bin");
    } catch {
      setNotice({ type: "error", text: "No se pudo leer el respaldo del dispositivo." });
    } finally {
      setBusy(null);
    }
  };

  const handleVerify = async () => {
    if (!restoreBytes) return;
    setBusy("verify");
    setNotice(null);
    try {
      const preview = await inspectBackup({ bytes: restoreBytes, passphrase: restorePassphrase });
      setRestorePreview({
        createdAt: preview.createdAt,
        totalRows: preview.totalRows,
        tables: Object.values(preview.counts).filter((count) => count > 0).length
      });
      setNotice({
        type: "ok",
        text: `Respaldo verificado: ${preview.totalRows} registros del ${formatMoment(preview.createdAt)}. Nada se ha escrito todavía.`
      });
    } catch (error) {
      setRestorePreview(null);
      setNotice({ type: "error", text: describeError(error) });
    } finally {
      setBusy(null);
    }
  };

  const handleRestore = async () => {
    if (!restoreBytes || !restoreConfirmed || restorePassphrase.length < MIN_PASSPHRASE) return;
    setBusy("restore");
    setNotice(null);
    try {
      const driver = await getRuntimeDriver();
      const report = await restoreBackup({
        bytes: restoreBytes,
        passphrase: restorePassphrase,
        driver,
        mutation: { origin_device: "restauracion-local" }
      });
      setRestored(true);
      setRestorePreview(null);
      setRestoreBytes(null);
      setRestoreName("");
      setRestoreConfirmed(false);
      setRestorePassphrase("");
      if (fileInputRef.current) fileInputRef.current.value = "";
      setNotice({
        type: "ok",
        text: `Restauración aplicada: ${report.written} registros escritos y ${report.removed} descartados. Reinicia PALMYRA para recargar la interfaz con los datos restaurados.`
      });
      await refreshList();
    } catch (error) {
      setNotice({ type: "error", text: describeError(error) });
    } finally {
      setBusy(null);
    }
  };

  const handleBinarySnapshot = async () => {
    if (!binaryCapability.available) return;
    if (binaryPassphrase.length < MIN_PASSPHRASE) {
      setBinaryNotice({
        type: "error",
        text: `Escribe una frase de al menos ${MIN_PASSPHRASE} caracteres para cifrar la imagen binaria.`
      });
      return;
    }
    setBinaryBusy("snapshot");
    setBinaryNotice(null);
    try {
      const driver = await getRuntimeDriver();
      const snapshot = await createBinarySnapshot({ driver });
      if (snapshot.ok !== true) {
        const failure = snapshot as { busy?: boolean; error: string };
        setBinaryNotice({ type: failure.busy ? "info" : "error", text: failure.error });
        return;
      }
      const backup = await snapshotToBackupBytes({
        snapshot,
        passphrase: binaryPassphrase,
        meta: { appVersion: PRODUCT_VERSION }
      });
      downloadBytes(backup.bytes, backup.summary.fileName || binaryBackupName(new Date()));
      setBinarySummary(backup.summary);
      setBinaryImage(null);
      setBinaryNotice({
        type: "ok",
        text: `Imagen binaria cifrada exportada (${formatSize(backup.summary.size)}, ${backup.summary.fileName}). Versión ${backup.summary.appVersion}, journal ${backup.summary.latestSeq}. Guárdala con su frase.`
      });
    } catch (error) {
      setBinaryNotice({ type: "error", text: describeError(error) });
    } finally {
      setBinaryBusy(null);
    }
  };

  const handleBinaryFilePicked = async (file: File | null) => {
    setBinaryNotice(null);
    setBinaryRestartPending(false);
    setBinaryImage(null);
    setBinarySummary(null);
    setBinaryRestoreName("");
    setBinaryRestoreConfirmed(false);
    if (!file) return;
    if (file.size > BINARY_SNAPSHOT_MAX_BYTES) {
      setBinaryNotice({ type: "error", text: "La imagen supera el límite de 200 MB." });
      return;
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (isSqliteFile(bytes)) {
        const check = validateBinaryRestore(bytes);
        if (!check.ok) {
          setBinaryNotice({ type: "error", text: check.error || "La imagen no es válida." });
          return;
        }
        const sha256 = await sha256HexOf(bytes);
        setBinaryImage(bytes);
        setBinaryRestoreName(file.name);
        setBinarySummary({
          kind: "sqlite-binary",
          createdAt: new Date().toISOString(),
          size: bytes.length,
          sha256,
          latestSeq: 0,
          appVersion: PRODUCT_VERSION,
          schemaVersion: 0,
          iterations: 0,
          fileName: file.name
        });
        setBinaryNotice({
          type: "info",
          text: `Imagen SQLite sin cifrar cargada: ${file.name} (${formatSize(bytes.length)}). Restaurarla reemplaza la base local y exige reiniciar PALMYRA.`
        });
        return;
      }
      if (binaryPassphrase.length < MIN_PASSPHRASE) {
        setBinaryNotice({
          type: "error",
          text: `El archivo no es una imagen SQLite plano. Escribe la frase del respaldo binario para descifrarlo.`
        });
        return;
      }
      const backup = await readBinaryBackup({ bytes, passphrase: binaryPassphrase });
      setBinaryImage(backup.image);
      setBinaryRestoreName(file.name);
      setBinarySummary(backup.summary);
      setBinaryNotice({
        type: "info",
        text: `Respaldo binario verificado: ${formatSize(backup.summary.size)} de la versión ${backup.summary.appVersion}. Restaurarlo reemplaza la base local y exige reiniciar PALMYRA.`
      });
    } catch (error) {
      setBinaryNotice({ type: "error", text: describeError(error) });
    }
  };

  const handleBinaryRestore = async () => {
    if (!binaryImage || !binaryRestoreConfirmed || binaryBusy !== null) return;
    setBinaryBusy("restore");
    setBinaryNotice(null);
    try {
      const check = validateBinaryRestore(binaryImage);
      if (!check.ok) {
        setBinaryNotice({ type: "error", text: check.error || "La imagen no es válida." });
        return;
      }
      const expectedSha256 = await sha256HexOf(binaryImage);
      const result = await restoreBinarySnapshot({
        bytesBase64: bytesToBase64(binaryImage),
        expectedSha256
      });
      if (result.ok !== true) {
        const failure = result as { busy?: boolean; error: string };
        setBinaryNotice({ type: failure.busy ? "info" : "error", text: failure.error });
        return;
      }
      setBinaryRestartPending(true);
      setBinaryImage(null);
      setBinaryRestoreName("");
      setBinaryRestoreConfirmed(false);
      if (binaryFileInputRef.current) binaryFileInputRef.current.value = "";
      setBinaryNotice({
        type: "ok",
        text: `Imagen restaurada (${formatSize(result.size)}, journal ${result.latestSeq}). REINICIO OBLIGATORIO: cierra y vuelve a abrir PALMYRA para que la caja y la nube lean la base restaurada.`
      });
    } catch (error) {
      setBinaryNotice({ type: "error", text: describeError(error) });
    } finally {
      setBinaryBusy(null);
    }
  };

  return (
    <section className="rounded-2xl border border-base bg-secondary p-3 shadow-sm sm:p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-base font-bold text-primary">
            <ShieldCheck size={18} className="text-violet-600" />
            Respaldo cifrado del almacén local
          </h3>
          <p className="mt-1 text-sm font-medium leading-6 text-muted">
            Exporta todos los datos de este equipo (ventas, inventario, caja, cola de sincronización…) en un
            archivo cifrado con AES-256-GCM. Sin la frase no se puede abrir ni restaurar.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refreshList()}
          disabled={busy !== null}
          className="flex h-11 items-center gap-1.5 rounded-xl border border-base bg-primary px-3 text-sm font-semibold text-primary transition-colors hover:bg-subtle disabled:opacity-50"
        >
          <RefreshCw size={15} className={cn(busy === "list" && "animate-spin")} /> Actualizar lista
        </button>
      </div>

      {notice && (
        <p
          role="status"
          aria-live="polite"
          className={cn(
            "mt-3 rounded-xl border p-3 text-sm font-medium leading-6",
            notice.type === "ok" && "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900/40 dark:bg-emerald-950/20 dark:text-emerald-200",
            notice.type === "error" && "border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-900/40 dark:bg-rose-950/20 dark:text-rose-200",
            notice.type === "info" && "border-violet-200 bg-violet-50 text-violet-800 dark:border-violet-900/40 dark:bg-violet-950/20 dark:text-violet-200"
          )}
        >
          {notice.text}
        </p>
      )}

      {secureWarning && (
        <div
          role="status"
          className="mt-3 flex flex-wrap items-start justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm font-medium leading-6 text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/20 dark:text-amber-200"
        >
          <p className="min-w-0 flex-1">{LINUX_SECURE_WARNING}</p>
          <button
            type="button"
            onClick={dismissSecureWarning}
            className="rounded-lg border border-amber-300 px-2 py-1 text-xs font-semibold text-amber-900 hover:bg-amber-100 dark:border-amber-900/50 dark:text-amber-200"
          >
            Entendido
          </button>
        </div>
      )}

      <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
        {/* Crear respaldo */}
        <div className="space-y-2.5 rounded-xl border border-base bg-primary p-3">
          <p className="flex items-center gap-2 text-sm font-bold text-primary">
            <Download size={15} className="text-violet-600" /> Crear respaldo
          </p>
          <label className="block space-y-1">
            <span className="text-sm font-semibold text-muted">Frase de cifrado (mínimo {MIN_PASSPHRASE} caracteres)</span>
            <input
              type="password"
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
              autoComplete="new-password"
              className="w-full rounded-xl border border-base bg-secondary px-3 py-2.5 text-sm font-semibold text-primary outline-none focus:ring-1 focus:ring-violet-500"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-sm font-semibold text-muted">Confirmar frase</span>
            <input
              type="password"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              autoComplete="new-password"
              className="w-full rounded-xl border border-base bg-secondary px-3 py-2.5 text-sm font-semibold text-primary outline-none focus:ring-1 focus:ring-violet-500"
            />
          </label>
          <p className={cn("text-sm font-medium", mismatch ? "text-rose-600 dark:text-rose-400" : "text-muted")}>
            {mismatch
              ? "Las frases no coinciden."
              : `Guarda la frase por separado: si se pierde, el archivo no se puede recuperar. La app no la almacena.`}
          </p>
          <button
            type="button"
            onClick={() => void handleCreate()}
            disabled={!canCreate}
            className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-violet-600 text-sm font-semibold text-white transition-colors hover:bg-violet-700 disabled:opacity-50"
          >
            <Lock size={15} />
            {busy === "create" ? "Cifrando y descargando…" : "Crear respaldo y descargar"}
          </button>
        </div>

        {/* Restaurar */}
        <div className="space-y-2.5 rounded-xl border border-base bg-primary p-3">
          <p className="flex items-center gap-2 text-sm font-bold text-primary">
            <Upload size={15} className="text-violet-600" /> Restaurar respaldo
          </p>
          <label className="flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-base bg-secondary px-3 py-2.5 text-sm font-semibold text-primary transition-colors hover:bg-subtle">
            <Database size={15} />
            <span className="truncate">{restoreName || "Elegir archivo .pmybak"}</span>
            <input
              ref={fileInputRef}
              type="file"
              accept=".pmybak,application/octet-stream,application/json"
              className="sr-only"
              onChange={(event) => {
                const file = event.target.files?.[0] ?? null;
                void handleFilePicked(file);
              }}
            />
          </label>
          {androidBackup && (
            <button
              type="button"
              onClick={() => void handleDeviceRestore()}
              disabled={busy !== null}
              className="flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-base bg-secondary text-sm font-semibold text-primary transition-colors hover:bg-subtle disabled:opacity-50"
            >
              <HardDrive size={15} />
              {busy === "pick" ? "Esperando el archivo…" : "Restaurar desde el dispositivo"}
            </button>
          )}
          <label className="block space-y-1">
            <span className="text-sm font-semibold text-muted">Frase del respaldo</span>
            <input
              type="password"
              value={restorePassphrase}
              onChange={(event) => setRestorePassphrase(event.target.value)}
              autoComplete="current-password"
              className="w-full rounded-xl border border-base bg-secondary px-3 py-2.5 text-sm font-semibold text-primary outline-none focus:ring-1 focus:ring-violet-500"
            />
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <button
              type="button"
              onClick={() => void handleVerify()}
              disabled={!restoreBytes || restorePassphrase.length < MIN_PASSPHRASE || busy !== null}
              className="flex h-11 flex-1 items-center justify-center gap-2 rounded-xl border border-base text-sm font-semibold text-primary transition-colors hover:bg-subtle disabled:opacity-50"
            >
              <ShieldCheck size={15} />
              {busy === "verify" ? "Verificando…" : "Verificar archivo"}
            </button>
          </div>
          {restorePreview && (
            <div className="rounded-xl border border-amber-200 bg-amber-50/70 p-3 text-sm font-medium leading-6 text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/20 dark:text-amber-200">
              Se reemplazarán los datos locales con el respaldo del <strong>{formatMoment(restorePreview.createdAt)}</strong>:{" "}
              {restorePreview.totalRows} registros en {restorePreview.tables} tablas con datos. Los cambios hechos después
              de esa fecha se pierden en este equipo (la nube conserva su copia).
            </div>
          )}
          <label className={cn("flex items-start gap-2.5 rounded-xl border p-3", restoreConfirmed ? "border-rose-300 bg-rose-50/60 dark:border-rose-900/50 dark:bg-rose-950/20" : "border-base bg-secondary")}>
            <input
              type="checkbox"
              checked={restoreConfirmed}
              onChange={(event) => setRestoreConfirmed(event.target.checked)}
              className="mt-0.5 h-4 w-4 accent-rose-600"
            />
            <span className="min-w-0 text-sm font-medium leading-5 text-primary">
              Entiendo que esta acción reemplaza los datos locales y que deberé reiniciar PALMYRA al terminar.
            </span>
          </label>
          <button
            type="button"
            onClick={() => void handleRestore()}
            disabled={!restoreBytes || !restoreConfirmed || restorePassphrase.length < MIN_PASSPHRASE || busy !== null}
            className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-rose-600 text-sm font-semibold text-white transition-colors hover:bg-rose-700 disabled:opacity-40"
          >
            <AlertTriangle size={15} />
            {busy === "restore" ? "Restaurando…" : "Restaurar ahora"}
          </button>
          {restored && (
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-emerald-300 bg-emerald-50 text-sm font-semibold text-emerald-800 transition-colors hover:bg-emerald-100 dark:border-emerald-900/40 dark:bg-emerald-950/20 dark:text-emerald-200"
            >
              <CheckCircle2 size={15} /> Reiniciar PALMYRA ahora
            </button>
          )}
        </div>
      </div>

      {/* Imagen binaria del motor SQLite: solo se ofrece dentro de Electron. */}
      {binaryCapability.available && (
        <div className="mt-3 rounded-xl border border-base bg-primary p-3">
          <p className="flex items-center gap-2 text-sm font-bold text-primary">
            <HardDrive size={15} className="text-violet-600" /> Respaldo binario (solo escritorio)
          </p>
          <p className="mt-1 text-sm font-medium leading-6 text-muted">
            Copia exacta del archivo SQLite del proceso principal, cifrada con AES-256-GCM. Recupera el equipo tal
            cual, pero restaurarla reemplaza la base local y obliga a reiniciar PALMYRA.
          </p>
          <label className="mt-3 block space-y-1">
            <span className="text-sm font-semibold text-muted">
              Frase del respaldo binario (mínimo {MIN_PASSPHRASE} caracteres)
            </span>
            <input
              type="password"
              value={binaryPassphrase}
              onChange={(event) => setBinaryPassphrase(event.target.value)}
              autoComplete="new-password"
              className="w-full rounded-xl border border-base bg-secondary px-3 py-2.5 text-sm font-semibold text-primary outline-none focus:ring-1 focus:ring-violet-500"
            />
          </label>
          <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
            <div className="space-y-2 rounded-xl border border-base bg-secondary p-3">
              <button
                type="button"
                onClick={() => void handleBinarySnapshot()}
                disabled={binaryBusy !== null || binaryPassphrase.length < MIN_PASSPHRASE}
                className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-violet-600 text-sm font-semibold text-white transition-colors hover:bg-violet-700 disabled:opacity-50"
              >
                <Download size={15} />
                {binaryBusy === "snapshot" ? "Cifrando imagen…" : "Respaldo binario"}
              </button>
              <p className="text-sm font-medium leading-6 text-muted">
                Exporta el archivo SQLite completo y lo cifra con la frase. Úsalo para clonar el equipo o
                recuperarlo ante una base dañada.
              </p>
              {binarySummary && (
                <p className="rounded-xl border border-base bg-primary p-2 text-sm font-medium leading-5 text-secondary">
                  Tamaño: <strong>{formatSize(binarySummary.size)}</strong>
                  <br />
                  Versión: <strong>{binarySummary.appVersion}</strong>
                  {binarySummary.latestSeq > 0 ? (
                    <>
                      {" · "}journal: <strong>{binarySummary.latestSeq}</strong>
                    </>
                  ) : null}
                  <br />
                  SHA-256: <span className="break-all font-mono text-xs">{binarySummary.sha256}</span>
                </p>
              )}
            </div>
            <div className="space-y-2 rounded-xl border border-base bg-secondary p-3">
              <label className="flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-base bg-primary px-3 py-2.5 text-sm font-semibold text-primary transition-colors hover:bg-subtle">
                <Database size={15} />
                <span className="truncate">{binaryRestoreName || "Elegir imagen .pmybak o .sqlite"}</span>
                <input
                  ref={binaryFileInputRef}
                  type="file"
                  accept=".pmybak,.sqlite,.db,application/octet-stream,application/x-sqlite3"
                  className="sr-only"
                  onChange={(event) => {
                    const file = event.target.files?.[0] ?? null;
                    void handleBinaryFilePicked(file);
                  }}
                />
              </label>
              <label
                className={cn(
                  "flex items-start gap-2.5 rounded-xl border p-3",
                  binaryRestoreConfirmed
                    ? "border-rose-300 bg-rose-50/60 dark:border-rose-900/50 dark:bg-rose-950/20"
                    : "border-base bg-primary"
                )}
              >
                <input
                  type="checkbox"
                  checked={binaryRestoreConfirmed}
                  onChange={(event) => setBinaryRestoreConfirmed(event.target.checked)}
                  className="mt-0.5 h-4 w-4 accent-rose-600"
                />
                <span className="min-w-0 text-sm font-medium leading-5 text-primary">
                  Entiendo que reemplaza toda la base local, que debo detener la red local (hub LAN) y que el
                  reinicio de PALMYRA es obligatorio.
                </span>
              </label>
              <button
                type="button"
                onClick={() => void handleBinaryRestore()}
                disabled={!binaryImage || !binaryRestoreConfirmed || binaryBusy !== null}
                className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-rose-600 text-sm font-semibold text-white transition-colors hover:bg-rose-700 disabled:opacity-40"
              >
                <AlertTriangle size={15} />
                {binaryBusy === "restore" ? "Restaurando imagen…" : "Restaurar imagen binaria"}
              </button>
              {binaryRestartPending && (
                <button
                  type="button"
                  onClick={() => window.location.reload()}
                  className="flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-emerald-300 bg-emerald-50 text-sm font-semibold text-emerald-800 transition-colors hover:bg-emerald-100 dark:border-emerald-900/40 dark:bg-emerald-950/20 dark:text-emerald-200"
                >
                  <CheckCircle2 size={15} /> Reiniciar PALMYRA ahora (obligatorio)
                </button>
              )}
            </div>
          </div>
          {binaryNotice && (
            <p
              role="status"
              aria-live="polite"
              className={cn(
                "mt-2 rounded-xl border p-2.5 text-sm font-medium leading-6",
                binaryNotice.type === "ok" && "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900/40 dark:bg-emerald-950/20 dark:text-emerald-200",
                binaryNotice.type === "error" && "border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-900/40 dark:bg-rose-950/20 dark:text-rose-200",
                binaryNotice.type === "info" && "border-violet-200 bg-violet-50 text-violet-800 dark:border-violet-900/40 dark:bg-violet-950/20 dark:text-violet-200"
              )}
            >
              {binaryNotice.text}
            </p>
          )}
        </div>
      )}

      {/* Copia fuera del sitio: opcional, nunca bloquea la caja. */}
      <CloudBackupSection />

      <div className="mt-4 space-y-2">
        <p className="text-sm font-bold text-primary">Respaldos registrados en este equipo</p>
        {entries.length === 0 ? (
          <p className="rounded-xl border border-base bg-primary p-3 text-sm font-medium text-muted">
            Aún no hay respaldos. El primero que crees aparecerá aquí con su fecha y tamaño.
          </p>
        ) : (
          <ul className="divide-y divide-base overflow-hidden rounded-xl border border-base bg-primary">
            {entries.map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 p-3">
                <span className="min-w-0 truncate text-sm font-semibold text-primary">
                  {formatMoment(entry.createdAt)}
                  <span className="ml-2 text-sm font-medium text-muted">{entry.fileName || "respaldo"}</span>
                </span>
                <span className="flex items-center gap-3 text-sm font-semibold text-secondary">
                  <span>{entry.totalRows} registros</span>
                  <span className="rounded-full bg-violet-100 px-2 py-0.5 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300">
                    {formatSize(entry.sizeBytes)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-sm font-medium leading-6 text-muted">
          Se conservan automáticamente los {BACKUP_DAILY_LIMIT} respaldos diarios más recientes y los{" "}
          {BACKUP_WEEKLY_LIMIT} semanales; la ficha se borra, nunca el archivo que ya descargaste.
        </p>
      </div>
    </section>
  );
}
