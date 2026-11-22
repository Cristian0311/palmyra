import type { CashRegisterSession } from '../../../types';

const TURN_LABEL_PREFIX = 'Turno-';
/** Etiqueta de último recurso: nunca se muestra el UUID de la sesión. */
const TURN_LABEL_FALLBACK = 'Turno';

export type TurnLabelMap = ReadonlyMap<string, string | number>;

/** Número de turno confirmado por el servidor, o null si aún no existe. */
export function persistedTurnNumber(session: Pick<CashRegisterSession, 'turnNumber'>): number | null {
  const value = Number(session.turnNumber);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : null;
}

function openedAtTime(session: CashRegisterSession): number {
  const value = Date.parse(session.openedAt || session.closedAt || '');
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

/** Orden cronológico estable: los turnos sin fecha van al final y desempatan por id. */
export function compareSessionsChronologically(a: CashRegisterSession, b: CashRegisterSession): number {
  const timeA = openedAtTime(a);
  const timeB = openedAtTime(b);
  if (timeA !== timeB) return timeA - timeB;
  return String(a.id).localeCompare(String(b.id));
}

/**
 * Etiqueta visible de cada sesión. Usa el turno persistido cuando existe; si el
 * turno aún no se confirmó (offline) se deriva una posición secuencial 1-based
 * en orden cronológico, evitando colisionar con turnos ya persistidos.
 */
export function buildSessionTurnLabelMap(sessions: CashRegisterSession[]): Map<string, string> {
  const labels = new Map<string, string>();
  const reserved = new Set<number>();
  sessions.forEach(session => {
    const persisted = persistedTurnNumber(session);
    if (persisted !== null) reserved.add(persisted);
  });

  [...sessions].sort(compareSessionsChronologically).forEach((session, index) => {
    const persisted = persistedTurnNumber(session);
    if (persisted !== null) {
      labels.set(session.id, `${TURN_LABEL_PREFIX}${persisted}`);
      return;
    }
    let sequential = index + 1;
    while (reserved.has(sequential)) sequential += 1;
    reserved.add(sequential);
    labels.set(session.id, `${TURN_LABEL_PREFIX}${sequential}`);
  });

  return labels;
}

/** Etiqueta para una sesión suelta; nunca devuelve el id/UUID de la sesión. */
export function getSessionTurnLabel(session: CashRegisterSession, labels?: TurnLabelMap): string {
  const mapped = labels?.get(session.id);
  if (mapped !== undefined && String(mapped).trim()) return String(mapped);
  const persisted = persistedTurnNumber(session);
  return persisted !== null ? `${TURN_LABEL_PREFIX}${persisted}` : TURN_LABEL_FALLBACK;
}
