/**
 * Interfaz mínima del motor SQLite.
 *
 * El driver del almacén local solo conoce estos cuatro métodos, de modo que se
 * puede sustituir node:sqlite (Node/Electron main) por better-sqlite3 u otro
 * binding sin tocar la lógica de persistencia.
 */

export type SqlValue = string | number | null | Uint8Array;

/**
 * Los adaptadores locales (node:sqlite, Android, sql.js) responden al instante,
 * pero el del renderer de Electron cruza IPC y solo puede responder con una
 * promesa. El driver espera siempre, así que ambos estilos son válidos.
 */
export type MaybePromise<T> = T | Promise<T>;

export interface SqliteAdapter {
  exec(sql: string): MaybePromise<void>;
  run(sql: string, params?: SqlValue[]): MaybePromise<{ changes: number }>;
  all<T = Record<string, unknown>>(sql: string, params?: SqlValue[]): MaybePromise<T[]>;
  close(): MaybePromise<void>;
}
