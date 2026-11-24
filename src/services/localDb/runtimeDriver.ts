import { createLocalDbDriverForRuntime } from "./desktop";
import type { LocalDbDriver } from "./contract";

/**
 * Una sola instancia del almacén local por pestaña.
 *
 * El sincronizador de la nube y la escritura en sombra del estado legado
 * conviven en la misma sesión. Si cada uno abriera su propio driver, en
 * escritorio habría dos colas IPC y en web dos conexiones IndexedDB; compartir
 * una sola evita carreras y mantiene un único journal de cambios.
 */
let memo: Promise<LocalDbDriver> | null = null;

export function getRuntimeDriver(): Promise<LocalDbDriver> {
  if (!memo) {
    memo = createLocalDbDriverForRuntime().catch((error) => {
      // Un fallo de apertura no debe envenenar el resto de la sesión.
      memo = null;
      throw error;
    });
  }
  return memo;
}
