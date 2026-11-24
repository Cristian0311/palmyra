/**
 * Estado local para el diagnóstico exportable y la recuperación guiada.
 *
 * Solo lee estados que ya existen en la aplicación: el puente SQLite del
 * escritorio, el driver del almacén local, las fichas de respaldo y el estado
 * del respaldo en la nube. Nunca abre una base nueva ni escribe nada, y
 * ninguna función lanza: un fallo se devuelve como estado para que el informe
 * lo muestre en lugar de dejar la pantalla en blanco.
 */
import { getDesktopDbBridge } from "../../lib/desktopRuntime";
import { normalizeDbStatus } from "../../hooks/useDesktopRuntimeStatus";
import { getPalmyraLocalScope } from "../localScope";
import { formatStorageBytes } from "../pwaStorageHealth";
import { readCloudBackupState } from "../localDb/backup/cloud";
import { listBackups } from "../localDb/backup/meta";
import { getRuntimeDriver } from "../localDb/runtimeDriver";
import { LOCAL_DB_VERSION } from "../localDb/schema";
import type { LocalDbDriver } from "../localDb/contract";
import type { InstallLastBackupInfo, InstallLocalDbInfo } from "./install";

const MAX_DETAIL = 200;

const DRIVER_LABELS: Record<LocalDbDriver["kind"], string> = {
  sqlite: "SQLite",
  indexeddb: "IndexedDB",
  http: "Red local (HTTP)",
  memory: "Memoria temporal"
};

/** Texto corto y plano: sin saltos de línea ni caracteres de control. */
function clean(value: unknown): string {
  if (typeof value !== "string") return "";
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_DETAIL);
}

function errorText(error: unknown): string {
  if (error instanceof Error) return clean(error.message);
  return clean(error);
}

/** Base local: motor, esquema, tamaño (escritorio) y último error. */
export async function collectLocalDbState(): Promise<InstallLocalDbInfo> {
  const bridge = getDesktopDbBridge();
  if (bridge) {
    try {
      const result = await bridge.invoke({ op: "status" });
      if (!result || result.ok !== true || !("status" in result)) {
        const message = result && result.ok === false && "error" in result ? clean(result.error) : "";
        return {
          state: "error",
          driver: "SQLite (escritorio)",
          schemaVersion: null,
          sizeBytes: null,
          detail: "La base de escritorio no respondió.",
          lastError: message || null
        };
      }
      const status = normalizeDbStatus(result.status);
      return {
        state: status.ready ? "ready" : "error",
        driver: status.driver === "sqljs" ? "SQLite (escritorio)" : "No disponible",
        schemaVersion: status.schemaVersion > 0 ? status.schemaVersion : null,
        sizeBytes: status.sizeBytes > 0 ? status.sizeBytes : null,
        detail: status.ready ? "Base de escritorio abierta." : "La base de escritorio no está lista.",
        lastError: status.lastError || null
      };
    } catch (error) {
      return {
        state: "error",
        driver: "SQLite (escritorio)",
        schemaVersion: null,
        sizeBytes: null,
        detail: "No se pudo consultar la base de escritorio.",
        lastError: errorText(error) || null
      };
    }
  }

  try {
    const driver = await getRuntimeDriver();
    await driver.ready();
    const label = DRIVER_LABELS[driver.kind] ?? "Almacén local";
    return {
      state: "ready",
      driver: label,
      schemaVersion: LOCAL_DB_VERSION,
      sizeBytes: null,
      detail:
        driver.kind === "memory"
          ? "Memoria temporal: los datos no se conservan al cerrar la aplicación."
          : "Base local abierta; el tamaño solo se informa en escritorio.",
      lastError: null
    };
  } catch (error) {
    return {
      state: "error",
      driver: "Sin datos",
      schemaVersion: null,
      sizeBytes: null,
      detail: "No se pudo abrir la base local de este equipo.",
      lastError: errorText(error) || null
    };
  }
}

/**
 * Último respaldo: la ficha local más reciente y, si existe, el estado del
 * respaldo en la nube. Sin respaldos queda `none`; un fallo de subida marca
 * `error` aunque haya una copia local.
 */
export async function collectLastBackupState(): Promise<InstallLastBackupInfo> {
  let at: string | null = null;
  let status: InstallLastBackupInfo["status"] = "none";
  let detail = "";

  try {
    const entries = await listBackups();
    const newest = entries[0];
    const ms = newest ? Date.parse(newest.createdAt) : Number.NaN;
    if (newest && Number.isFinite(ms)) {
      at = new Date(ms).toISOString();
      status = "ok";
      detail = `${newest.totalRows} registros · ${formatStorageBytes(newest.sizeBytes)}`;
    }
  } catch {
    // El listado de fichas es informativo: se sigue con lo que haya en la nube.
  }

  try {
    const companyId = getPalmyraLocalScope()?.companyId;
    if (companyId && typeof localStorage !== "undefined") {
      const cloud = readCloudBackupState(localStorage, companyId);
      if (cloud.lastError) {
        status = "error";
        detail = `${detail ? `${detail} · ` : ""}Copia en la nube con fallo: ${clean(cloud.lastError)}`;
      } else if (cloud.lastUploadAt) {
        const cloudMs = Date.parse(cloud.lastUploadAt);
        if (Number.isFinite(cloudMs) && (!at || cloudMs > Date.parse(at))) {
          at = new Date(cloudMs).toISOString();
        }
        // En esta rama no hay fallo de nube: la copia cuenta como correcta.
        status = "ok";
        detail = `${detail ? `${detail} · ` : ""}Copia en la nube al día`;
      }
    }
  } catch {
    // Sin alcance local no hay estado de nube que sumar.
  }

  if (!at && status !== "error") {
    return { status: "none", at: null, detail: "Sin respaldos registrados en este equipo." };
  }
  return { status, at, detail: detail || "Sin detalle del respaldo." };
}
