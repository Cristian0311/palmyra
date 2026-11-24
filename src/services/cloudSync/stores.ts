/**
 * Stores durables del motor de sincronización.
 *
 * `localStorage` es susceptible a cuota llena, modo privado y limpiezas del
 * navegador. Por eso cada escritura se replica en memoria y toda lectura cae a
 * la memoria si el almacenamiento falla: un cursor perdido haría reenviar
 * historial y un presupuesto perdido permitiría subir de más.
 */
import type {
  BudgetSnapshot,
  BudgetStore,
  CursorStore,
  PullCursorState,
  PullCursorStore
} from "./contract";

/** Subconjunto de Storage que usamos; permite inyectar un doble en pruebas. */
export interface CloudStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
  readonly length?: number;
  key?(index: number): string | null;
}

export const DEFAULT_CLOUD_SYNC_NAMESPACE = "palmyra:cloudsync";

/** Retención del presupuesto: el día actual más seis anteriores. */
const BUDGET_RETENTION_DAYS = 7;
const BUDGET_INDEX_SUFFIX = "budget:days";
const DAY_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function createLocalStorageCursorStore(
  namespace: string = DEFAULT_CLOUD_SYNC_NAMESPACE,
  storage?: CloudStorage | null
): CursorStore {
  const target = resolveStorage(storage);
  const fallback = new Map<string, number>();
  const prefix = `${namespace}:cursor:`;

  const keyFor = (companyId: string) => `${prefix}${companyId}`;

  return {
    async load(companyId: string): Promise<number> {
      const key = keyFor(companyId);
      try {
        const raw = target?.getItem(key) ?? null;
        if (raw !== null) {
          const seq = parseCursorDocument(raw);
          fallback.set(key, seq);
          return seq;
        }
      } catch {
        // Lectura bloqueada: se usa lo último que quedó en memoria.
      }
      return fallback.get(key) ?? 0;
    },

    async save(companyId: string, seq: number): Promise<void> {
      const key = keyFor(companyId);
      const value = normalizeSeq(seq);
      fallback.set(key, value);
      try {
        target?.setItem(key, JSON.stringify({ seq: value }));
      } catch {
        // Cuota o privacidad: la memoria conserva el cursor en esta sesión.
      }
    }
  };
}

export function createLocalStorageBudgetStore(
  prefix: string = DEFAULT_CLOUD_SYNC_NAMESPACE,
  storage?: CloudStorage | null
): BudgetStore {
  const target = resolveStorage(storage);
  const fallback = new Map<string, BudgetSnapshot>();
  const dayPrefix = `${prefix}:budget:`;
  const indexKey = `${prefix}:${BUDGET_INDEX_SUFFIX}`;

  const keyFor = (dayKey: string) => `${dayPrefix}${dayKey}`;

  function readIndex(): string[] {
    try {
      const raw = target?.getItem(indexKey) ?? null;
      if (!raw) return [];
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed)
        ? parsed.filter((day): day is string => typeof day === "string" && isDayKey(day))
        : [];
    } catch {
      return [];
    }
  }

  function storedDays(): string[] {
    const days = new Set<string>(readIndex());
    if (!target) return Array.from(days);
    try {
      const length = typeof target.length === "number" ? target.length : 0;
      if (typeof target.key !== "function" || length <= 0) return Array.from(days);
      for (let index = 0; index < length; index += 1) {
        const key = target.key(index);
        if (typeof key !== "string" || !key.startsWith(dayPrefix)) continue;
        const day = key.slice(dayPrefix.length);
        if (isDayKey(day)) days.add(day);
      }
    } catch {
      // Sin enumeración disponible queda el índice propio.
    }
    return Array.from(days);
  }

  function prune(currentDay: string): void {
    if (!isDayKey(currentDay)) return;
    const cutoff = shiftDay(currentDay, -(BUDGET_RETENTION_DAYS - 1));
    if (!cutoff) return;
    const keep: string[] = [currentDay];
    for (const day of storedDays()) {
      if (day === currentDay) continue;
      if (day >= cutoff) {
        keep.push(day);
        continue;
      }
      try {
        target?.removeItem?.(keyFor(day));
      } catch {
        // Si no se puede borrar, el índice igual deja de contarlo.
      }
      fallback.delete(keyFor(day));
    }
    try {
      target?.setItem(indexKey, JSON.stringify(keep.sort()));
    } catch {
      // El índice es una ayuda; su fallo no invalida el guardado principal.
    }
  }

  return {
    async load(dayKey: string): Promise<BudgetSnapshot> {
      const key = keyFor(dayKey);
      try {
        const raw = target?.getItem(key) ?? null;
        if (raw !== null) {
          const snapshot = parseBudgetDocument(raw);
          fallback.set(key, snapshot);
          return { ...snapshot };
        }
      } catch {
        // Se usa el respaldo en memoria.
      }
      const stored = fallback.get(key);
      return stored ? { ...stored } : { requests: 0, lastRequestAt: 0 };
    },

    async save(dayKey: string, value: BudgetSnapshot): Promise<void> {
      const key = keyFor(dayKey);
      const snapshot = normalizeBudget(value);
      fallback.set(key, snapshot);
      try {
        target?.setItem(key, JSON.stringify(snapshot));
      } catch {
        // Cuota o privacidad: el día sigue contabilizado en memoria.
      }
      prune(dayKey);
    }
  };
}

/**
 * Cursor de descarga por empresa: `palmyra:cloudsync:pull:<companyId>`.
 *
 * Guarda `{cursor, updatedAt}`. Un documento corrupto, con fecha imposible o
 * con empresa ajena se degrada a `{cursor: null}`: la siguiente descarga repite
 * una ventana inocua en lugar de saltarse cambios.
 */
export function createLocalStoragePullCursorStore(
  namespace: string = DEFAULT_CLOUD_SYNC_NAMESPACE,
  storage?: CloudStorage | null
): PullCursorStore {
  const target = resolveStorage(storage);
  const fallback = new Map<string, PullCursorState>();
  const prefix = `${namespace}:pull:`;

  const keyFor = (companyId: string) => `${prefix}${companyId}`;

  return {
    async load(companyId: string): Promise<PullCursorState> {
      const key = keyFor(companyId);
      try {
        const raw = target?.getItem(key) ?? null;
        if (raw !== null) {
          const state = parsePullDocument(raw);
          fallback.set(key, state);
          return { ...state };
        }
      } catch {
        // Lectura bloqueada: se usa lo último que quedó en memoria.
      }
      const stored = fallback.get(key);
      return stored ? { ...stored } : { cursor: null, updatedAt: null };
    },

    async save(companyId: string, state: PullCursorState): Promise<void> {
      const key = keyFor(companyId);
      const value: PullCursorState = {
        cursor: normalizeCursorText(state?.cursor),
        updatedAt: normalizeTimestamp(state?.updatedAt)
      };
      fallback.set(key, value);
      try {
        target?.setItem(key, JSON.stringify(value));
      } catch {
        // Cuota o privacidad: la memoria conserva el cursor en esta sesión.
      }
    }
  };
}

export function createMemoryPullCursorStore(): PullCursorStore {
  const cursors = new Map<string, PullCursorState>();
  return {
    async load(companyId: string): Promise<PullCursorState> {
      const state = cursors.get(companyId);
      return state ? { ...state } : { cursor: null, updatedAt: null };
    },
    async save(companyId: string, state: PullCursorState): Promise<void> {
      cursors.set(companyId, {
        cursor: normalizeCursorText(state?.cursor),
        updatedAt: normalizeTimestamp(state?.updatedAt)
      });
    }
  };
}

/** Versiones en memoria: pruebas y arranques sin almacenamiento disponible. */
export function createMemoryCursorStore(): CursorStore {  const cursors = new Map<string, number>();
  return {
    async load(companyId: string): Promise<number> {
      return cursors.get(companyId) ?? 0;
    },
    async save(companyId: string, seq: number): Promise<void> {
      cursors.set(companyId, normalizeSeq(seq));
    }
  };
}

export function createMemoryBudgetStore(): BudgetStore {
  const days = new Map<string, BudgetSnapshot>();
  return {
    async load(dayKey: string): Promise<BudgetSnapshot> {
      const stored = days.get(dayKey);
      return stored ? { ...stored } : { requests: 0, lastRequestAt: 0 };
    },
    async save(dayKey: string, value: BudgetSnapshot): Promise<void> {
      days.set(dayKey, normalizeBudget(value));
    }
  };
}

function resolveStorage(storage?: CloudStorage | null): CloudStorage | null {
  if (storage !== undefined) return storage;
  try {
    const candidate = (globalThis as { localStorage?: CloudStorage }).localStorage;
    return candidate ?? null;
  } catch {
    // Acceso a localStorage bloqueado por privacidad: solo memoria.
    return null;
  }
}

function parseCursorDocument(raw: string): number {
  try {
    const parsed = JSON.parse(raw) as { seq?: unknown };
    return normalizeSeq(parsed?.seq);
  } catch {
    return 0;
  }
}

/** Documento de descarga: `{cursor, updatedAt}`; corrupto ⇒ cursor nulo. */
function parsePullDocument(raw: string): PullCursorState {
  try {
    const parsed = JSON.parse(raw) as { cursor?: unknown; updatedAt?: unknown };
    return {
      cursor: normalizeCursorText(parsed?.cursor),
      updatedAt: normalizeTimestamp(parsed?.updatedAt)
    };
  } catch {
    return { cursor: null, updatedAt: null };
  }
}

/** Cursor ISO válido o `null`: una fecha imposible no puede ordenar cambios. */
function normalizeCursorText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || !Number.isFinite(Date.parse(text))) return null;
  return text;
}

function normalizeTimestamp(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

function parseBudgetDocument(raw: string): BudgetSnapshot {
  try {
    const parsed = JSON.parse(raw) as { requests?: unknown; lastRequestAt?: unknown };
    return normalizeBudget(parsed);
  } catch {
    return { requests: 0, lastRequestAt: 0 };
  }
}

function normalizeSeq(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return 0;
  const floored = Math.floor(parsed);
  return floored >= 0 ? floored : 0;
}

function normalizeBudget(value: { requests?: unknown; lastRequestAt?: unknown } | null | undefined): BudgetSnapshot {
  return {
    requests: normalizeSeq(value?.requests),
    lastRequestAt: normalizeSeq(value?.lastRequestAt)
  };
}

function isDayKey(value: string): boolean {
  const match = DAY_KEY_PATTERN.exec(value);
  if (!match) return false;
  // Rechaza fechas normalizadas por Date (por ejemplo 2026-02-31).
  return shiftDay(value, 0) === value;
}

/** Desplaza una clave `YYYY-MM-DD`; devuelve null si la fecha no es real. */
function shiftDay(dayKey: string, deltaDays: number): string | null {
  const match = DAY_KEY_PATTERN.exec(dayKey);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const base = Date.UTC(year, month - 1, day) + deltaDays * 86_400_000;
  const date = new Date(base);
  const iso = date.toISOString().slice(0, 10);
  // Al sumar 0, una fecha inexistente se normaliza y deja de coincidir.
  if (deltaDays === 0 && iso !== dayKey) return null;
  return iso;
}
