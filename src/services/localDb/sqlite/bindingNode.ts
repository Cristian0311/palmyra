import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { LocalDbError } from "../contract";
import type { SqliteAdapter, SqlValue } from "./adapter";

/**
 * Binding de SQLite para Node usando el módulo nativo `node:sqlite`.
 *
 * @types/node 22 aún no declara ese módulo, por eso se importa con un
 * especificador dinámico y tipos locales mínimos; así `tsc --noEmit` pasa y el
 * mensaje de error es claro cuando el runtime no lo incluye.
 */

interface NativeStatement {
  run(...params: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  all(...params: SqlValue[]): Record<string, unknown>[];
}

interface NativeDatabase {
  exec(sql: string): void;
  prepare(sql: string): NativeStatement;
  close(): void;
}

interface NativeSqliteModule {
  DatabaseSync: new (path: string) => NativeDatabase;
}

const UNAVAILABLE = "SQLite nativo no disponible en este runtime";
const CACHE_LIMIT = 200;

function ensureDirectory(filePath: string): void {
  if (!filePath || filePath === ":memory:" || filePath.startsWith("file:")) return;
  const directory = dirname(filePath);
  if (directory && directory !== ".") mkdirSync(directory, { recursive: true });
}

export async function createNodeSqliteAdapter(filePath: string): Promise<SqliteAdapter> {
  ensureDirectory(filePath);

  const specifier: string = "node:sqlite";
  let module: NativeSqliteModule;
  try {
    module = (await import(specifier)) as NativeSqliteModule;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error ?? "error desconocido");
    throw new LocalDbError("driver_unavailable", UNAVAILABLE + ": " + detail);
  }
  if (!module || typeof module.DatabaseSync !== "function") {
    throw new LocalDbError("driver_unavailable", UNAVAILABLE);
  }

  const db = new module.DatabaseSync(filePath);

  // Journal WAL para lecturas concurrentes del hub; el resto son ajustes de
  // robustez habituales en un POS que puede apagarse sin cerrar la app.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = OFF");

  const statements = new Map<string, NativeStatement>();
  function prepare(sql: string): NativeStatement {
    const cached = statements.get(sql);
    if (cached) return cached;
    const statement = db.prepare(sql);
    // Cota simple para no crecer sin límite con consultas dinámicas.
    if (statements.size >= CACHE_LIMIT) statements.clear();
    statements.set(sql, statement);
    return statement;
  }

  return {
    exec(sql: string): void {
      db.exec(sql);
    },
    run(sql: string, params?: SqlValue[]): { changes: number } {
      const statement = prepare(sql);
      const result = params && params.length > 0 ? statement.run(...params) : statement.run();
      return { changes: Number(result.changes ?? 0) };
    },
    all<T = Record<string, unknown>>(sql: string, params?: SqlValue[]): T[] {
      const statement = prepare(sql);
      const rows = params && params.length > 0 ? statement.all(...params) : statement.all();
      return rows as T[];
    },
    close(): void {
      statements.clear();
      db.close();
    }
  };
}
