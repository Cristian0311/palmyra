import { useCallback, useEffect, useRef, useState } from "react";
import {
  emptyDbStatus,
  emptyHubStatus,
  getDesktopDbBridge,
  getDesktopHubBridge,
  isDesktopRuntime,
  type DesktopDbStatus,
  type DesktopHubStatus
} from "../lib/desktopRuntime";

export type DesktopRuntimeStatus = {
  /** false en navegador, PWA y APK: el diagnóstico queda inerte. */
  available: boolean;
  db: DesktopDbStatus;
  hub: DesktopHubStatus;
  refreshing: boolean;
  refresh: () => Promise<void>;
};

const REFRESH_MS = 20_000;
const MAX_TEXT = 300;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readText(value: unknown, max = MAX_TEXT): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function readCount(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return readText(error.message);
  return readText(error);
}

/** El puente puede devolver una instantánea parcial: se valida campo a campo. */
export function normalizeDbStatus(value: unknown): DesktopDbStatus {
  const raw = asRecord(value);
  if (!raw) return emptyDbStatus();
  return {
    ready: raw.ready === true,
    driver: raw.driver === "sqljs" ? "sqljs" : "unavailable",
    filePath: readText(raw.filePath, 500),
    sizeBytes: readCount(raw.sizeBytes),
    schemaVersion: readCount(raw.schemaVersion),
    lastWriteAt: readCount(raw.lastWriteAt),
    lastError: readText(raw.lastError)
  };
}

export function normalizeHubStatus(value: unknown): DesktopHubStatus {
  const raw = asRecord(value);
  if (!raw) return emptyHubStatus();
  return {
    enabled: raw.enabled === true,
    running: raw.running === true,
    host: readText(raw.host, 120),
    port: readCount(raw.port),
    companyId: readText(raw.companyId, 80),
    pairingCode: readText(raw.pairingCode, 40),
    pairingExpiresAt: readText(raw.pairingExpiresAt, 40),
    lastError: readText(raw.lastError),
    tlsEnabled: raw.tlsEnabled === true,
    tlsFingerprint: readText(raw.tlsFingerprint, 64)
  };
}

async function readDbStatus(): Promise<DesktopDbStatus> {
  const bridge = getDesktopDbBridge();
  if (!bridge) return emptyDbStatus();
  try {
    const result = await bridge.invoke({ op: "status" });
    if (!result) return emptyDbStatus();
    if (result.ok) {
      return "status" in result ? normalizeDbStatus(result.status) : emptyDbStatus();
    }
    return "error" in result ? emptyDbStatus(readText(result.error)) : emptyDbStatus();
  } catch (error) {
    return emptyDbStatus(errorText(error));
  }
}

async function readHubStatus(): Promise<DesktopHubStatus> {
  const bridge = getDesktopHubBridge();
  if (!bridge) return emptyHubStatus();
  try {
    const result = await bridge.status();
    if (!result) return emptyHubStatus();
    if (result.ok && "status" in result) return normalizeHubStatus(result.status);
    return "error" in result ? emptyHubStatus(readText(result.error)) : emptyHubStatus();
  } catch (error) {
    return emptyHubStatus(errorText(error));
  }
}

/**
 * Estado real del runtime de escritorio (base local y hub LAN).
 *
 * Solo consulta cuando el preload expuso algún puente. El sondeo de 20 s se
 * repite al volver al foco para que el dueño vea el estado actual al mirar la
 * ventana, sin mantener tráfico IPC con la pestaña oculta.
 */
export function useDesktopRuntimeStatus(): DesktopRuntimeStatus {
  const [available] = useState(() => isDesktopRuntime());
  const [db, setDb] = useState<DesktopDbStatus>(() => emptyDbStatus());
  const [hub, setHub] = useState<DesktopHubStatus>(() => emptyHubStatus());
  const [refreshing, setRefreshing] = useState(false);
  const aliveRef = useRef(true);
  const inFlightRef = useRef(false);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!available || inFlightRef.current) return;
    inFlightRef.current = true;
    setRefreshing(true);
    try {
      const [nextDb, nextHub] = await Promise.all([readDbStatus(), readHubStatus()]);
      if (aliveRef.current) {
        setDb(nextDb);
        setHub(nextHub);
      }
    } finally {
      inFlightRef.current = false;
      if (aliveRef.current) setRefreshing(false);
    }
  }, [available]);

  useEffect(() => {
    if (!available) return;
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, REFRESH_MS);
    const onFocus = () => {
      void refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [available, refresh]);

  return { available, db, hub, refreshing, refresh };
}
