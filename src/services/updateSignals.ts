/**
 * Señales de actualización del sistema (PALMYRA).
 *
 * El servidor de Render anota un build nuevo en `public.system_update_signals`
 * al arrancar (ver la RPC `signal_system_update`). Las apps instaladas escuchan
 * ese INSERT por Realtime y muestran su aviso de actualización en el acto, así
 * que ya no necesitan sondear la red cada pocas horas.
 *
 * Este módulo no tiene efectos al importarse: el canal se abre solo al llamar a
 * `subscribeToUpdateSignals` y la lectura puntual, solo en `readLatestSignal`.
 *
 * La comparación (`isNewerBuild`, `compareVersions`) es pura y se prueba sin
 * red: decide si una señal habla de un build realmente más nuevo que el que
 * corre en este dispositivo.
 */

import { getSupabase } from "../lib/supabase";

/** Tabla (solo lectura para clientes) y canal de Realtime. */
export const UPDATE_SIGNALS_TABLE = "system_update_signals";
export const UPDATE_SIGNALS_CHANNEL_PREFIX = "palmyra-system-update-signals";

/** Fila de señal ya normalizada (todo texto recortado y validado). */
export interface SystemUpdateSignal {
  id?: string;
  version: string;
  build_id: string;
  created_at?: string;
}

interface ParsedVersion {
  core: [number, number, number];
  pre: string[] | null;
}

// v1.2.3, 1.2, 1.2.3-beta.1, con prefijo `v` y metadatos +build.
const VERSION_RE = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Parte una versión semver tolerante; null si no es reconocible. */
export function parseVersion(value: string | null | undefined): ParsedVersion | null {
  const text = typeof value === "string" ? value.trim() : "";
  if (text === "") return null;
  const match = VERSION_RE.exec(text);
  if (!match) return null;
  const core: [number, number, number] = [
    Number(match[1] || 0),
    Number(match[2] || 0),
    Number(match[3] || 0)
  ];
  const pre = typeof match[4] === "string"
    ? match[4].split(".").filter((part) => part !== "")
    : [];
  return { core, pre: pre.length > 0 ? pre : null };
}

function sign(value: number): number {
  if (value > 0) return 1;
  if (value < 0) return -1;
  return 0;
}

/**
 * Compara dos versiones semver: -1 si `a` es anterior, 0 si equivalen, 1 si es
 * posterior. Una versión ilegible cuenta como anterior a cualquier legible (así
 * una señal válida siempre gana frente a un build sin versión útil).
 */
export function compareVersions(a: string | null | undefined, b: string | null | undefined): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left && !right) return 0;
  if (!left) return -1;
  if (!right) return 1;

  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] !== right.core[index]) {
      return sign(left.core[index] - right.core[index]);
    }
  }

  // Una versión estable es posterior a cualquiera de sus pre-releases.
  if (!left.pre && !right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;

  const length = Math.max(left.pre.length, right.pre.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.pre[index];
    const rightPart = right.pre[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) {
      return sign(Number(leftPart) - Number(rightPart));
    }
    // Un identificador numérico precede a uno alfanumérico (regla semver).
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

/**
 * ¿La señal describe un build más nuevo que el de este dispositivo?
 *
 *   - Versión de la señal mayor → sí.
 *   - Versión menor → no (una señal atrasada no debe avisar).
 *   - Misma versión y `build_id` distinto → sí (redespliegue del mismo número,
 *     habitual en Render).
 *   - Build local desconocido → no: sin referencia no se puede afirmar que el
 *     build de la señal sea distinto; la comprobación normal fijará la marca.
 */
export function isNewerBuild(
  signal: Pick<SystemUpdateSignal, "version" | "build_id"> | null | undefined,
  currentBuildId: string | null | undefined,
  currentVersion: string | null | undefined
): boolean {
  if (!signal || typeof signal !== "object") return false;
  const version = typeof signal.version === "string" ? signal.version.trim() : "";
  const build = typeof signal.build_id === "string" ? signal.build_id.trim() : "";
  if (build === "") return false;

  if (version !== "") {
    const order = compareVersions(version, currentVersion);
    if (order > 0) return true;
    if (order < 0) return false;
  }

  const current = typeof currentBuildId === "string" ? currentBuildId.trim() : "";
  return current !== "" && current !== build;
}

/** Normaliza una fila/`payload.new` de Realtime; null si no es una señal útil. */
export function normalizeSignalRow(row: unknown): SystemUpdateSignal | null {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const record = row as Record<string, unknown>;
  const version = typeof record.version === "string" ? record.version.trim() : "";
  const buildId = typeof record.build_id === "string" ? record.build_id.trim() : "";
  if (version === "" || buildId === "") return null;
  const signal: SystemUpdateSignal = { version, build_id: buildId };
  const id = typeof record.id === "string" ? record.id.trim() : "";
  if (id !== "") signal.id = id;
  const createdAt = typeof record.created_at === "string" ? record.created_at.trim() : "";
  if (createdAt !== "") signal.created_at = createdAt;
  return signal;
}

// Los canales de Realtime deben tener nombre único: un remontaje rápido no
// debe reutilizar el canal que todavía se está cerrando.
let channelSequence = 0;

/**
 * Escucha los INSERT de señales. Devuelve la baja; sin Supabase configurado
 * devuelve una función vacía (la app sigue funcionando sin canal).
 */
export function subscribeToUpdateSignals(
  onSignal: (signal: SystemUpdateSignal) => void
): () => void {
  if (typeof onSignal !== "function") return () => undefined;
  // Sin cliente (o con almacenamiento bloqueado) la app sigue sin canal.
  let supabase: ReturnType<typeof getSupabase>;
  try {
    supabase = getSupabase();
  } catch {
    return () => undefined;
  }
  if (!supabase) return () => undefined;

  channelSequence += 1;
  const channel = supabase.channel(`${UPDATE_SIGNALS_CHANNEL_PREFIX}-${channelSequence}`);
  let closed = false;

  const config = {
    event: "INSERT",
    schema: "public",
    table: UPDATE_SIGNALS_TABLE
  } as never;

  // El callback se registra antes de subscribe(): añadirlo después lanza.
  channel.on("postgres_changes", config, (payload: { new?: unknown }) => {
    if (closed) return;
    const signal = normalizeSignalRow(payload ? payload.new : null);
    if (!signal) return;
    try {
      onSignal(signal);
    } catch {
      // Un consumidor roto no debe cerrar el canal.
    }
  });

  // Realtime caído (sin red, WebSocket bloqueado) no debe romper el arranque:
  // la lectura puntual de `readLatestSignal` cubre el aviso.
  try {
    channel.subscribe();
  } catch {
    closed = true;
    void Promise.resolve(supabase.removeChannel(channel)).catch(() => undefined);
    return () => undefined;
  }

  return () => {
    if (closed) return;
    closed = true;
    void Promise.resolve(supabase.removeChannel(channel)).catch(() => undefined);
  };
}

/**
 * Lectura puntual de la última señal. Se usa al montar y al recuperar la red:
 * un INSERT ocurrido con la app suspendida no llega por Realtime, y esta única
 * fila basta para no perder el aviso. Nunca lanza.
 */
export async function readLatestSignal(): Promise<SystemUpdateSignal | null> {
  try {
    const supabase = getSupabase();
    if (!supabase) return null;
    const { data, error } = await supabase
      .from(UPDATE_SIGNALS_TABLE)
      .select("id, version, build_id, created_at")
      .order("created_at", { ascending: false })
      .limit(1);
    if (error || !Array.isArray(data) || data.length === 0) return null;
    return normalizeSignalRow(data[0]);
  } catch {
    return null;
  }
}
