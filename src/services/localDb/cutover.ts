/**
 * Selección de la fuente de verdad local.
 *
 * Durante la convivencia el JSON legado de Zustand manda y el almacén
 * normalizado solo se espeja ('shadow'). La bandera VITE_LOCAL_DB_SOURCE=local
 * invierte el arranque: el almacén hidrata la store. La bandera se lee una vez
 * al arrancar; no se puede cambiar en caliente porque el corte es deliberado y
 * reversible solo reiniciando la app con otra configuración.
 */

export type LocalDbSourceMode = "shadow" | "local";

export type LocalDbSourceEnv = Record<string, string | undefined>;

const SOURCE_ENV_KEY = "VITE_LOCAL_DB_SOURCE";
const FORCE_ENV_KEY = "VITE_LOCAL_DB_SOURCE_FORCE";

function readEnv(env?: LocalDbSourceEnv): LocalDbSourceEnv {
  if (env) return env;
  try {
    // Bajo Node (pruebas) import.meta.env no existe: se trata como vacío.
    return (import.meta as ImportMeta & { env?: LocalDbSourceEnv }).env ?? {};
  } catch {
    return {};
  }
}

function normalize(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

/** 'shadow' por defecto: sin bandera explícita nada cambia para el usuario. */
export function getLocalDbSourceMode(env?: LocalDbSourceEnv): LocalDbSourceMode {
  return normalize(readEnv(env)[SOURCE_ENV_KEY]) === "local" ? "local" : "shadow";
}

export function isLocalDbSource(env?: LocalDbSourceEnv): boolean {
  return getLocalDbSourceMode(env) === "local";
}

/** Permite hidratar aunque la store ya tenga datos (diagnóstico y soporte). */
export function isLocalDbSourceForced(env?: LocalDbSourceEnv): boolean {
  return normalize(readEnv(env)[FORCE_ENV_KEY]) === "1";
}
