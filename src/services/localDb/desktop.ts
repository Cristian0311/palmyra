import { LocalDbError, type LocalDbDriver } from "./contract";
import { createIndexedDbDriver } from "./indexedDbDriver";
import { createMemoryDriver } from "./memoryDriver";
import { createSqliteDriver } from "./sqlite/driver";
import { createIpcSqliteAdapter } from "./sqlite/ipcAdapter";
import { createAndroidSqliteDriver } from "./sqlite/androidAdapter";
import { getDesktopDbBridge } from "../../lib/desktopRuntime";

/**
 * Fábricas del almacén local para la app de escritorio.
 *
 * En Electron la base SQLite vive en el proceso principal y el renderer la usa
 * por IPC; fuera de Electron (PWA, navegador, APK) el llamador debe elegir otro
 * driver. Nada de esto se conecta solo: la app decide cuándo pedirlo.
 */

/** Ruta lógica que el driver guarda en `_meta`; el archivo real lo fija el proceso principal. */
export const DESKTOP_DB_FILE_PATH = "desktop:palmyra.db";

const UNAVAILABLE_MESSAGE =
  "La base SQLite de escritorio no está disponible: la app no corre dentro de PALMYRA de escritorio.";

export interface DesktopSqliteDriverOptions {
  now?: () => string;
}

export function desktopDbAvailable(): boolean {
  return getDesktopDbBridge() !== null;
}

export async function createDesktopSqliteDriver(
  options: DesktopSqliteDriverOptions = {}
): Promise<LocalDbDriver> {
  const bridge = getDesktopDbBridge();
  if (!bridge) {
    throw new LocalDbError("driver_unavailable", UNAVAILABLE_MESSAGE);
  }

  const adapter = createIpcSqliteAdapter(bridge);
  return createSqliteDriver({
    adapter,
    filePath: DESKTOP_DB_FILE_PATH,
    ...(options.now ? { now: options.now } : {})
  });
}

/** Elige el driver disponible: escritorio, Android nativo, IndexedDB o memoria. */
export async function createLocalDbDriverForRuntime(): Promise<LocalDbDriver> {
  if (desktopDbAvailable()) return createDesktopSqliteDriver();

  // El APK expone SQLite por el puente nativo; si aún no está listo se usa
  // IndexedDB en lugar de dejar la app sin almacén.
  try {
    return await createAndroidSqliteDriver();
  } catch {
    // Sin puente nativo (navegador, PWA o Android sin DB): siguiente opción.
  }

  if (typeof globalThis.indexedDB !== "undefined" && globalThis.indexedDB) {
    const driver = createIndexedDbDriver();
    await driver.ready();
    return driver;
  }

  const driver = createMemoryDriver();
  await driver.ready();
  return driver;
}
