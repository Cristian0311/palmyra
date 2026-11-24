import { useCallback, useEffect, useRef, useState } from "react";
import { getSupabase } from "../lib/supabase";
import { PRODUCT_VERSION } from "../lib/productVersion";
import { getOrCreateDeviceFingerprint } from "../services/device";
import { getPalmyraLocalScope } from "../services/localScope";
import { recordRequest } from "../services/requestBudget";
import { getRuntimeDriver } from "../services/localDb/runtimeDriver";
import { decideScheduledBackup } from "../services/localDb/backup/schedule";
import {
  CLOUD_BACKUP_INTERVAL_MS,
  createCloudBackupManager,
  createSupabaseCloudTransport,
  readCloudBackupState,
  type CloudBackupDay,
  type CloudBackupManager,
  type CloudBackupOutcome,
  type CloudBackupState,
  type CloudRestoreInput,
  type CloudRestoreOutcome
} from "../services/localDb/backup/index";

/**
 * Respaldo cifrado en la nube, en segundo plano.
 *
 * Reglas de oro: el POS nunca espera por la nube. El ciclo solo corre si hay
 * sesión (empresa), almacén local y una frase utilizable; si el dispositivo
 * está offline se espera al evento `online`. Una frase escrita por el usuario
 * nunca se guarda. Para que el respaldo diario sea automático sin abrir
 * Configuración, se genera una clave de recuperación por empresa que sí queda
 * en este equipo y se muestra para que el dueño la guarde aparte.
 */

export interface CloudBackupStatus {
  enabled: boolean;
  lastUploadAt: string | null;
  lastBytes: number | null;
  lastError: string | null;
  busy: boolean;
  lastDay: string | null;
  online: boolean;
  lastRestoreAt: string | null;
  lastRestoreResult: "ok" | "failed" | null;
  autoPaused: boolean;
}

export interface UseCloudBackupOptions {
  /** Frase de cifrado SOLO en memoria; sin ella no hay subida automática. */
  passphrase?: string;
  companyId?: string | null;
  deviceId?: string;
  auto?: boolean;
}

export interface UseCloudBackupResult {
  status: CloudBackupStatus;
  days: CloudBackupDay[];
  busy: boolean;
  loadingDays: boolean;
  /** Clave generada en este equipo; el dueño debe guardarla fuera del equipo. */
  recoveryKey: string;
  backupNow: (passphrase?: string) => Promise<CloudBackupOutcome>;
  restore: (input: CloudRestoreInput) => Promise<CloudRestoreOutcome>;
  refreshDays: () => Promise<void>;
  reloadState: () => void;
}

const RECOVERY_KEY_PREFIX = "palmyra:cloud-backup-key:v1:";

/** Clave de la frase automática por empresa; la usa también la migración guiada. */
export function cloudRecoveryKeyStorageKey(companyId: string): string {
  return RECOVERY_KEY_PREFIX + companyId;
}

function generatedRecoveryKey(companyId: string | null): string {
  if (!companyId) return "";
  const storageKey = cloudRecoveryKeyStorageKey(companyId);
  try {
    if (typeof localStorage === "undefined") return "";
    const existing = localStorage.getItem(storageKey);
    if (existing && existing.length >= 8) return existing;
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const value = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    localStorage.setItem(storageKey, value);
    return value;
  } catch {
    return "";
  }
}

function isOnline(): boolean {
  try {
    return typeof navigator === "undefined" || navigator.onLine !== false;
  } catch {
    return true;
  }
}

function emptyStatus(): CloudBackupStatus {
  return {
    enabled: false,
    lastUploadAt: null,
    lastBytes: null,
    lastError: null,
    busy: false,
    lastDay: null,
    online: isOnline(),
    lastRestoreAt: null,
    lastRestoreResult: null,
    autoPaused: true
  };
}

function statusFrom(state: CloudBackupState, enabled: boolean, online: boolean, autoPaused: boolean): CloudBackupStatus {
  return {
    enabled,
    lastUploadAt: state.lastUploadAt,
    lastBytes: state.lastBytes,
    lastError: state.lastError,
    busy: false,
    lastDay: state.lastDay,
    online,
    lastRestoreAt: state.lastRestoreAt,
    lastRestoreResult: state.lastRestoreResult,
    autoPaused
  };
}

export function useCloudBackup(options: UseCloudBackupOptions = {}): UseCloudBackupResult {
  const explicitCompanyId = options.companyId;
  const explicitDeviceId = options.deviceId;

  const [companyId] = useState<string | null>(() => {
    if (explicitCompanyId !== undefined) return explicitCompanyId || null;
    try {
      return getPalmyraLocalScope()?.companyId ?? null;
    } catch {
      return null;
    }
  });

  const [deviceId] = useState<string>(() => {
    if (explicitDeviceId) return explicitDeviceId;
    try {
      return getOrCreateDeviceFingerprint() || "equipo-local";
    } catch {
      return "equipo-local";
    }
  });

  const [status, setStatus] = useState<CloudBackupStatus>(emptyStatus);
  const [days, setDays] = useState<CloudBackupDay[]>([]);
  const [busy, setBusy] = useState(false);
  const [loadingDays, setLoadingDays] = useState(false);
  const [recoveryKey] = useState(() => generatedRecoveryKey(companyId));

  const passphraseRef = useRef(options.passphrase || recoveryKey);
  useEffect(() => {
    passphraseRef.current = options.passphrase || recoveryKey;
  }, [options.passphrase, recoveryKey]);

  const managerRef = useRef<CloudBackupManager | null>(null);
  const managerKeyRef = useRef("");
  const runningRef = useRef(false);

  const manager = useCallback((): CloudBackupManager => {
    const key = `${companyId ?? ""}::${deviceId}`;
    if (managerRef.current && managerKeyRef.current === key) return managerRef.current;
    let transport = null;
    try {
      const supabase = getSupabase();
      transport = supabase ? createSupabaseCloudTransport(supabase) : null;
    } catch {
      transport = null;
    }
    const created = createCloudBackupManager({
      companyId,
      deviceId,
      transport,
      getDriver: getRuntimeDriver,
      storage: typeof localStorage === "undefined" ? null : localStorage,
      isOnline,
      recordRequest,
      tool: `PALMYRA POS ${PRODUCT_VERSION}`
    });
    managerRef.current = created;
    managerKeyRef.current = key;
    return created;
  }, [companyId, deviceId]);

  const reloadState = useCallback(() => {
    const online = isOnline();
    if (!companyId) {
      setStatus({ ...emptyStatus(), online });
      return;
    }
    const state = readCloudBackupState(typeof localStorage === "undefined" ? null : localStorage, companyId);
    const hasSupabase = Boolean(getSupabase());
    setStatus(statusFrom(state, hasSupabase && Boolean(companyId), online, !passphraseRef.current));
  }, [companyId]);

  const refreshDays = useCallback(async () => {
    if (!companyId) {
      setDays([]);
      return;
    }
    setLoadingDays(true);
    try {
      setDays(await manager().listCloudBackups());
    } finally {
      setLoadingDays(false);
    }
  }, [companyId, manager]);

  useEffect(() => {
    reloadState();
    void refreshDays();
  }, [reloadState, refreshDays]);

  const applyOutcome = useCallback((outcome: CloudBackupOutcome) => {
    reloadState();
    if (outcome.ok && !outcome.skipped) {
      void refreshDays();
    }
  }, [reloadState, refreshDays]);

  const backupNow = useCallback(
    async (passphrase?: string): Promise<CloudBackupOutcome> => {
      const phrase = passphrase ?? passphraseRef.current;
      if (!phrase) {
        return { ok: false, reason: "disabled", error: "Escribe la frase del respaldo para subirlo." };
      }
      setBusy(true);
      setStatus((current) => ({ ...current, busy: true }));
      try {
        const outcome = await manager().backupNow(phrase);
        applyOutcome(outcome);
        return outcome;
      } catch {
        // El gerente nunca lanza; esto es una red de seguridad de la interfaz.
        return { ok: false, error: "No se pudo respaldar en la nube." };
      } finally {
        setBusy(false);
        setStatus((current) => ({ ...current, busy: false }));
      }
    },
    [applyOutcome, manager]
  );

  const restore = useCallback(
    async (input: CloudRestoreInput): Promise<CloudRestoreOutcome> => {
      setBusy(true);
      setStatus((current) => ({ ...current, busy: true }));
      try {
        const outcome = await manager().restoreCloudBackup(input);
        reloadState();
        return outcome;
      } catch {
        return { ok: false, error: "No se pudo restaurar desde la nube." };
      } finally {
        setBusy(false);
        setStatus((current) => ({ ...current, busy: false }));
      }
    },
    [manager, reloadState]
  );

  const auto = options.auto !== false;
  // Solo se activa al llegar al mínimo del formato; así no se intenta subir con
  // una frase a medio escribir (cada tecla no dispara un ciclo). Sin frase del
  // usuario se usa la clave generada de este equipo.
  const passphraseReady = (options.passphrase ?? recoveryKey).length >= 8;

  useEffect(() => {
    if (!companyId || !auto || !passphraseReady) return;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const tick = async () => {
      if (cancelled || runningRef.current) return;
      if (!isOnline()) {
        if (!cancelled) reloadState();
        return;
      }
      if (!passphraseRef.current || passphraseRef.current.length < 8) {
        if (!cancelled) reloadState();
        return;
      }
      const state = readCloudBackupState(
        typeof localStorage === "undefined" ? null : localStorage,
        companyId
      );
      const decision = decideScheduledBackup({
        lastBackupAt: state.lastUploadAt,
        now: new Date()
      });
      if (!decision.due) {
        if (!cancelled) reloadState();
        return;
      }
      runningRef.current = true;
      try {
        const outcome = await manager().backupNow(passphraseRef.current);
        if (!cancelled) applyOutcome(outcome);
      } finally {
        runningRef.current = false;
      }
    };

    void tick();
    // Comprobar cada 24 h basta: la decisión real la toma `decideScheduledBackup`.
    timer = setInterval(() => void tick(), CLOUD_BACKUP_INTERVAL_MS);

    const onOnline = () => {
      void tick();
    };
    const onOffline = () => {
      if (!cancelled) reloadState();
    };
    if (typeof window !== "undefined") {
      window.addEventListener("online", onOnline);
      window.addEventListener("offline", onOffline);
    }

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      if (typeof window !== "undefined") {
        window.removeEventListener("online", onOnline);
        window.removeEventListener("offline", onOffline);
      }
    };
    // `passphraseReady` entra como dependencia: al completar la frase se
    // reintenta de inmediato, sin reaccionar a cada tecla.
  }, [companyId, auto, manager, applyOutcome, reloadState, passphraseReady]);

  return {
    status,
    days,
    busy,
    loadingDays,
    recoveryKey,
    backupNow,
    restore,
    refreshDays,
    reloadState
  };
}
