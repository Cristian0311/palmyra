import { CLOCK_ROLLBACK_TOLERANCE_MS } from "./contract";

/**
 * Reloj anti-manipulación del lease. Es puro: no lee ni escribe almacenamiento;
 * quien persiste la marca de agua y la telemetría es la capa de integración.
 *
 * Idea: la marca de agua solo avanza (nunca retrocede). Si el usuario atrasa el
 * reloj del equipo, la evaluación usa la marca y no «recupera» días de licencia.
 * Además del reloj de pared se vigilan dos referencias más fuertes:
 *  - el ancla de hora del servidor firmada dentro del lease (`serverTimeAnchor`),
 *  - el suelo monotónico (`performance.now()`), que no se puede atrasar.
 */

/** Origen de la referencia contra la que se detectó la anomalía. */
export type ClockTamperSource = "watermark" | "server-anchor" | "monotonic";

/** Clase de anomalía de reloj que se reporta en la telemetría local. */
export type ClockTamperKind = "wall-rollback" | "monotonic-regression";

/** Evento de manipulación listo para persistir (sin datos personales). */
export interface ClockTamperDraft {
  kind: ClockTamperKind;
  source: ClockTamperSource;
  /** Magnitud del retroceso detectado en milisegundos. */
  skewMs: number;
  /** Momento (tiempo efectivo) en que se detectó. */
  detectedAtMs: number;
}

/** Normaliza cualquier entrada a milisegundos seguros (0 si no es finito). */
function safeMs(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Tolerancia efectiva: nunca negativa; por defecto los 10 min del contrato. */
function resolveTolerance(value: number | null | undefined): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, value);
  return CLOCK_ROLLBACK_TOLERANCE_MS;
}

/**
 * Siguiente marca de agua: el mayor entre la anterior, el reloj local y la
 * hora del servidor cuando hay respuesta. Nunca disminuye.
 */
export function nextWatermark(input: {
  previousMs?: number | null;
  nowMs: number;
  serverTimeMs?: number | null;
}): number {
  return Math.max(safeMs(input.previousMs), safeMs(input.nowMs), safeMs(input.serverTimeMs));
}

/**
 * true si el reloj local retrocedió más allá de la tolerancia respecto de la
 * última marca conocida. Sin marca previa válida no hay evidencia de retroceso.
 */
export function detectClockRollback(input: {
  previousMs?: number | null;
  nowMs: number;
  toleranceMs?: number;
}): boolean {
  const previous = safeMs(input.previousMs);
  if (previous <= 0) return false;
  return safeMs(input.nowMs) < previous - resolveTolerance(input.toleranceMs);
}

/**
 * Hora efectiva de evaluación: se congela en la marca de agua si el reloj está
 * atrasado, para que la ventana offline no se extienda hacia atrás.
 */
export function effectiveNowMs(input: { nowMs: number; watermarkMs?: number | null }): number {
  return Math.max(safeMs(input.nowMs), safeMs(input.watermarkMs));
}

export interface ClockIntegrityInput {
  /** Marca de agua persistida (la referencia propia del equipo). */
  previousMs?: number | null;
  /** Reloj de pared sin tocar (`Date.now()` o el inyectado). */
  nowMs: number;
  /** Ancla firmada de hora del servidor del lease vigente. */
  serverAnchorMs?: number | null;
  /** Suelo monotónico acumulado (ancla + avance de `performance.now()`). */
  monotonicMs?: number | null;
  toleranceMs?: number;
}

export interface ClockIntegrity {
  /** El reloj quedó más de la tolerancia por debajo de una referencia. */
  tampered: boolean;
  /** Referencia que disparó la detección; null si todo está en orden. */
  source: ClockTamperSource | null;
  /** Referencia más alta que disparó la detección (0 si no hay). */
  referenceMs: number;
  /** Cuánto quedó el reloj por debajo de la referencia (0 si no hay). */
  rollbackMs: number;
  /**
   * Tiempo efectivo endurecido: nunca menor que la marca de agua (y que la
   * referencia cuando hubo manipulación). Con él se calcula la ventana offline,
   * de modo que un reloj atrasado NO extiende `offlineUntil`.
   */
  effectiveMs: number;
  /** Suelo que debe conservar la marca persistida (solo avanza). */
  watermarkMs: number;
  /** El tiempo efectivo no es el del reloj de pared. */
  frozen: boolean;
}

/**
 * Evalúa la integridad del reloj contra todas las referencias disponibles.
 * Regla: con más de 10 min por debajo de la marca de agua (o del ancla del
 * servidor, o del suelo monotónico) se marca `tampered`, se congela el tiempo
 * efectivo en esa referencia y no se reabre ni se alarga la ventana offline.
 */
export function assessClockIntegrity(input: ClockIntegrityInput): ClockIntegrity {
  const nowMs = safeMs(input.nowMs);
  const tolerance = resolveTolerance(input.toleranceMs);
  const watermark = safeMs(input.previousMs);

  const candidates: Array<{ source: ClockTamperSource; ms: number }> = [];
  const anchor = safeMs(input.serverAnchorMs);
  const monotonic = safeMs(input.monotonicMs);
  if (watermark > 0) candidates.push({ source: "watermark", ms: watermark });
  if (anchor > 0) candidates.push({ source: "server-anchor", ms: anchor });
  if (monotonic > 0) candidates.push({ source: "monotonic", ms: monotonic });

  // La referencia que dispara es la más alta que supera la tolerancia.
  const trigger = candidates
    .filter((candidate) => nowMs < candidate.ms - tolerance)
    .sort((left, right) => right.ms - left.ms)[0];

  if (!trigger) {
    return {
      tampered: false,
      source: null,
      referenceMs: 0,
      rollbackMs: 0,
      effectiveMs: Math.max(nowMs, watermark),
      watermarkMs: watermark,
      frozen: watermark > nowMs
    };
  }

  const referenceMs = trigger.ms;
  return {
    tampered: true,
    source: trigger.source,
    referenceMs,
    rollbackMs: referenceMs - nowMs,
    // Congelado en la referencia: ni un milisegundo hacia atrás.
    effectiveMs: Math.max(nowMs, referenceMs),
    // El suelo persistido sube hasta la referencia para que la ventana no crezca.
    watermarkMs: Math.max(watermark, referenceMs),
    frozen: true
  };
}

/**
 * Convierte una detección en un borrador de telemetría. Devuelve null si no hay
 * manipulación. No incluye identificadores de empresa, equipo ni lease: solo la
 * clase de anomalía, el origen y la magnitud, para poder enviarlo al reconectar.
 */
export function clockTamperDraft(
  integrity: ClockIntegrity,
  detectedAtMs?: number | null
): ClockTamperDraft | null {
  if (!integrity.tampered || !integrity.source) return null;
  return {
    kind: integrity.source === "monotonic" ? "monotonic-regression" : "wall-rollback",
    source: integrity.source,
    skewMs: Math.max(0, Math.round(integrity.rollbackMs)),
    detectedAtMs: safeMs(detectedAtMs) || Math.max(integrity.effectiveMs, integrity.referenceMs)
  };
}

/* ------------------------------------------------------------------ */
/* Acumulador monotónico                                              */
/* ------------------------------------------------------------------ */

export interface MonotonicClockOptions {
  /**
   * Fuente de `performance.now()`. Inyectable en pruebas; `null` desactiva el
   * acumulador (por ejemplo en entornos sin `performance`).
   */
  performanceNow?: (() => number | null) | null;
  /** Reloj de pared para el ancla (por defecto `Date.now`). */
  wallNow?: () => number;
  /** Ancla inicial de pared; por defecto la primera lectura del reloj. */
  initialWallMs?: number;
}

export interface MonotonicClock {
  /** false si no hay `performance.now()` disponible. */
  readonly available: boolean;
  /** Avance acumulado; nunca disminuye, aunque la fuente retroceda. */
  elapsedMs(): number;
  /** Suelo del tiempo real: ancla + avance acumulado. */
  floorMs(): number;
  /** Estimación de pared monótona: nunca menor que la última devuelta. */
  nowMs(): number;
  /** Veces que la fuente monotónica retrocedió (evidencia de manipulación). */
  regressions(): number;
  /** Magnitud total (ms) de esos retrocesos. */
  regressionMs(): number;
  /** Reancla tras una resincronización o una suspensión larga. */
  rebase(wallMs?: number | null): void;
  snapshot(): {
    available: boolean;
    anchorWallMs: number;
    elapsedMs: number;
    floorMs: number;
  };
}

/**
 * Acumulador monotónico sobre `performance.now()`.
 *
 * El avance se acumula sumando solo deltas positivos, así que un
 * `performance.now()` que retrocede (suspensión, cambio de origen de tiempo,
 * inyección maliciosa) nunca reduce el suelo. Ese suelo es una cota inferior
 * fiable del tiempo transcurrido: si el reloj de pared cae por debajo, hay
 * manipulación, no deriva normal.
 */
export function createMonotonicClock(options: MonotonicClockOptions = {}): MonotonicClock {
  const wallNow = options.wallNow ?? (() => Date.now());
  const perfNow =
    options.performanceNow !== undefined
      ? options.performanceNow
      : typeof performance !== "undefined" && typeof performance.now === "function"
        ? () => performance.now()
        : null;
  const available = typeof perfNow === "function";

  function readPerf(): number | null {
    if (!available || !perfNow) return null;
    try {
      const value = perfNow();
      return typeof value === "number" && Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  }

  function readWall(): number {
    try {
      return safeMs(wallNow());
    } catch {
      return 0;
    }
  }

  let anchorWallMs = safeMs(options.initialWallMs ?? readWall());
  let elapsed = 0;
  let lastRawPerf = readPerf();
  let lastWallMs = anchorWallMs;
  let regressionCount = 0;
  let regressionTotalMs = 0;

  function advance(): number {
    const raw = readPerf();
    if (raw === null) return elapsed;
    if (lastRawPerf === null) {
      lastRawPerf = raw;
      return elapsed;
    }
    const delta = raw - lastRawPerf;
    if (delta >= 0) {
      elapsed += delta;
    } else {
      // La fuente retrocedió: se anota y se mantiene el acumulado intacto.
      regressionCount += 1;
      regressionTotalMs += -delta;
    }
    lastRawPerf = raw;
    return elapsed;
  }

  return {
    available,
    elapsedMs() {
      return advance();
    },
    floorMs() {
      return anchorWallMs + advance();
    },
    nowMs() {
      // Nunca retrocede: si la pared cae, se conserva la última lectura.
      lastWallMs = Math.max(lastWallMs, anchorWallMs + advance(), readWall());
      return lastWallMs;
    },
    regressions() {
      return regressionCount;
    },
    regressionMs() {
      return regressionTotalMs;
    },
    rebase(wallMs?: number | null) {
      anchorWallMs = safeMs(wallMs) || readWall() || anchorWallMs;
      elapsed = 0;
      lastRawPerf = readPerf();
      lastWallMs = anchorWallMs;
    },
    snapshot() {
      return {
        available,
        anchorWallMs,
        elapsedMs: elapsed,
        floorMs: anchorWallMs + elapsed
      };
    }
  };
}
