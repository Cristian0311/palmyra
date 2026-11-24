/**
 * Retención de respaldos: 7 diarios + 4 semanales.
 *
 * La política es pura y determinista (recibe `now`) para poder probarla sin
 * reloj real. Los respaldos se agrupan por día UTC y por semana ISO-8601:
 * se conserva el más reciente de cada uno de los últimos 7 días y, de lo que
 * quede fuera de esos días, el más reciente de cada una de las últimas 4
 * semanas. Todo lo demás es descartable.
 */

export const BACKUP_DAILY_LIMIT = 7;
export const BACKUP_WEEKLY_LIMIT = 4;

export interface BackupRetentionEntry {
  id: string;
  /** Fecha de creación en ISO-8601. */
  createdAt: string;
}

export interface BackupRetentionPlan<T extends BackupRetentionEntry> {
  keep: T[];
  remove: T[];
}

export interface BackupRetentionOptions {
  dailyLimit?: number;
  weeklyLimit?: number;
}

function toMs(value: Date | string | number): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  return Date.parse(value);
}

function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Semana ISO-8601 (lunes a domingo) de una fecha en milisegundos. */
function weekKey(ms: number): string {
  const date = new Date(ms);
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const weekday = target.getUTCDay() || 7;
  // Se desplaza al jueves de la misma semana: su año decide el año ISO.
  target.setUTCDate(target.getUTCDate() + 4 - weekday);
  const yearStart = Date.UTC(target.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((target.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/**
 * Decide qué respaldos conservar. `now` solo documenta la ventana; entradas con
 * fecha inválida se descartan porque no se pueden ordenar ni envejecer.
 */
export function pruneBackups<T extends BackupRetentionEntry>(
  entries: T[],
  now: Date | string | number = new Date(),
  options: BackupRetentionOptions = {}
): BackupRetentionPlan<T> {
  const dailyLimit = Math.max(0, Math.trunc(options.dailyLimit ?? BACKUP_DAILY_LIMIT));
  const weeklyLimit = Math.max(0, Math.trunc(options.weeklyLimit ?? BACKUP_WEEKLY_LIMIT));
  const nowMs = toMs(now);
  const reference = Number.isFinite(nowMs) ? nowMs : Date.now();

  const valid: Array<{ entry: T; ms: number }> = [];
  const invalid: T[] = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const ms = entry && typeof entry.createdAt === "string" ? Date.parse(entry.createdAt) : NaN;
    // Sin fecha válida no se puede rotar; una fecha muy futura (reloj errado)
    // tampoco debe ocupar un cupo de la ventana diaria.
    if (!Number.isFinite(ms) || ms > reference + 86_400_000) {
      invalid.push(entry);
      continue;
    }
    valid.push({ entry, ms });
  }

  valid.sort((a, b) => b.ms - a.ms || String(b.entry.id).localeCompare(String(a.entry.id)));

  const keep = new Set<T>();
  const days = new Set<string>();
  const weeks = new Set<string>();

  for (const candidate of valid) {
    if (days.size >= dailyLimit) break;
    const key = dayKey(candidate.ms);
    if (days.has(key)) continue;
    days.add(key);
    keep.add(candidate.entry);
  }

  for (const candidate of valid) {
    if (weeks.size >= weeklyLimit) break;
    if (keep.has(candidate.entry)) continue;
    const key = weekKey(candidate.ms);
    if (weeks.has(key)) continue;
    weeks.add(key);
    keep.add(candidate.entry);
  }

  return {
    keep: valid.filter((candidate) => keep.has(candidate.entry)).map((candidate) => candidate.entry),
    remove: [
      ...valid.filter((candidate) => !keep.has(candidate.entry)).map((candidate) => candidate.entry),
      ...invalid
    ]
  };
}
