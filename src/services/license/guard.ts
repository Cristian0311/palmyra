import {
  assessClockIntegrity,
  clockTamperDraft,
  type ClockIntegrity
} from "./clock";
import { loadWatermark, recordClockTamperEvent, type LicenseKeyValueStore } from "./storage";

/**
 * Guarda de solo lectura por licencia.
 *
 * Es deliberadamente independiente del DOM y de Supabase: cualquier escritura
 * local (por ejemplo la cola offline) puede comprobar aquí, sin esperar a que
 * React monte nada ni a que haya red.
 *
 * Endurecimiento de reloj: además del modo decidido por la evaluación, la
 * guarda mantiene una marca de «reloj manipulado». Una manipulación nunca
 * habilita escrituras aunque la evaluación se haya hecho con una hora falsa.
 * Nunca se borra nada: solo se pasa a solo lectura (con exportación permitida).
 */

export const LICENSE_READ_ONLY_MESSAGE =
  "Tu suscripción venció: la app está en solo lectura. Renueva para seguir vendiendo. Tus datos no se borran.";

export const LICENSE_CLOCK_TAMPERED_MESSAGE =
  "El reloj del equipo retrocedió respecto de la hora verificada. La app queda en solo lectura hasta reconectar y sincronizar la hora. Tus datos no se borran: puedes exportarlos.";

/** Códigos de la guarda; el histórico `license_read_only` se conserva. */
export type LicenseReadOnlyCode = "license_read_only" | "license_clock_tampered";

export class LicenseReadOnlyError extends Error {
  readonly code: LicenseReadOnlyCode = "license_read_only";

  constructor(message: string = LICENSE_READ_ONLY_MESSAGE) {
    super(message);
    this.name = "LicenseReadOnlyError";
  }
}

/** Error específico de reloj manipulado (sigue siendo un LicenseReadOnlyError). */
export class LicenseClockTamperError extends LicenseReadOnlyError {
  readonly code = "license_clock_tampered" as const;

  constructor(message: string = LICENSE_CLOCK_TAMPERED_MESSAGE) {
    super(message);
    this.name = "LicenseClockTamperError";
  }
}

/** Estado persistente de la decisión de licencia (vencida, inválida, ...). */
let readOnly = false;
/** Manipulación de reloj detectada en la sesión; bloquea escrituras por sí sola. */
let clockTampered = false;
let clockTamperReason: string | null = null;

const listeners = new Set<(readOnly: boolean) => void>();

/** Solo lectura efectiva = decisión de licencia o reloj manipulado. */
function effectiveReadOnly(): boolean {
  return readOnly || clockTampered;
}

function notify(previous: boolean): void {
  const next = effectiveReadOnly();
  if (next === previous) return;
  for (const listener of [...listeners]) {
    try {
      listener(next);
    } catch {
      // Un suscriptor roto no debe impedir que el resto conozca el cambio.
    }
  }
}

/** Cambia el modo global; no notifica si el valor efectivo no cambió. */
export function setLicenseReadOnly(next: boolean): void {
  const previous = effectiveReadOnly();
  readOnly = Boolean(next);
  notify(previous);
}

/** El modo efectivo incluye la manipulación de reloj. */
export function isLicenseReadOnly(): boolean {
  return effectiveReadOnly();
}

/**
 * Marca o limpia la manipulación de reloj. Al marcarla la app pasa a solo
 * lectura de inmediato, aunque la última evaluación dijera «escribible».
 */
export function setLicenseClockTampered(next: boolean, reason?: string | null): void {
  const previous = effectiveReadOnly();
  const value = Boolean(next);
  if (value === clockTampered) {
    clockTamperReason = value ? (reason ?? clockTamperReason) : null;
    return;
  }
  clockTampered = value;
  clockTamperReason = value ? (reason ?? LICENSE_CLOCK_TAMPERED_MESSAGE) : null;
  notify(previous);
}

export function isLicenseClockTampered(): boolean {
  return clockTampered;
}

/** Motivo legible de la última manipulación detectada (null si no hay). */
export function getLicenseClockTamperReason(): string | null {
  return clockTamperReason;
}

/** Limpia la marca de manipulación tras reconectar y resincronizar la hora. */
export function clearLicenseClockTamper(): void {
  setLicenseClockTampered(false);
}

export function subscribeReadOnly(listener: (readOnly: boolean) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Lanza LicenseReadOnlyError (o LicenseClockTamperError) si la licencia está
 * vencida o el reloj fue manipulado. Las escrituras que venden o mueven datos
 * llaman a esto antes de tocar el almacenamiento.
 */
export function assertLicenseWritable(): void {
  if (clockTampered) throw new LicenseClockTamperError();
  if (readOnly) throw new LicenseReadOnlyError();
}

/* ------------------------------------------------------------------ */
/* Qué bloquea y qué no                                               */
/* ------------------------------------------------------------------ */

/**
 * Operaciones que distingue la guarda. La licencia solo puede frenar la
 * escritura de negocio: consultar, exportar y respaldar/restaurar se permiten
 * siempre, también con el plan vencido (los datos nunca quedan encerrados).
 */
export type LicenseOperation = "read" | "export" | "backup" | "restore" | "write";

export function isLicenseOperationAllowed(operation: LicenseOperation): boolean {
  if (operation === "write") return !effectiveReadOnly();
  return true;
}

/** Código y mensaje accionable del bloqueo vigente; null si se puede escribir. */
export function getLicenseWriteBlock(): { code: LicenseReadOnlyCode; message: string } | null {
  if (clockTampered) {
    return {
      code: "license_clock_tampered",
      message: clockTamperReason || LICENSE_CLOCK_TAMPERED_MESSAGE
    };
  }
  if (readOnly) return { code: "license_read_only", message: LICENSE_READ_ONLY_MESSAGE };
  return null;
}

/* ------------------------------------------------------------------ */
/* Paso a solo lectura con tiempo efectivo endurecido                  */
/* ------------------------------------------------------------------ */

export interface LicenseTimeGateInput {
  /** Valor de solo lectura ya calculado por la evaluación (con tiempo efectivo). */
  evaluationReadOnly?: boolean;
  /** Reloj de pared sin tocar en esta comprobación. */
  nowMs: number;
  /** Marca de agua persistida del equipo. */
  watermarkMs?: number | null;
  /** Ancla de hora del servidor firmada en el lease. */
  serverAnchorMs?: number | null;
  /** Suelo monotónico (ancla + avance de `performance.now()`). */
  monotonicMs?: number | null;
  toleranceMs?: number;
}

export interface LicenseTimeGateResult extends ClockIntegrity {
  /** Solo lectura efectiva tras aplicar la guarda. */
  readOnly: boolean;
  /** Ventana offline restante usando el tiempo efectivo (nunca se alarga). */
  offlineRemainingMs?: number;
}

/**
 * Aplica la guarda usando el tiempo efectivo endurecido. Si el reloj retrocedió
 * más de la tolerancia, la manipulación se marca y el modo pasa a solo lectura
 * aunque `evaluationReadOnly` sea false: una manipulación no habilita escrituras.
 */
export function applyLicenseTimeGate(input: LicenseTimeGateInput): LicenseTimeGateResult {
  const integrity = assessClockIntegrity({
    previousMs: input.watermarkMs,
    nowMs: input.nowMs,
    serverAnchorMs: input.serverAnchorMs,
    monotonicMs: input.monotonicMs,
    toleranceMs: input.toleranceMs
  });
  // Primero la manipulación: así `setLicenseReadOnly(false)` no la borra.
  setLicenseClockTampered(integrity.tampered, integrity.tampered ? LICENSE_CLOCK_TAMPERED_MESSAGE : null);
  // La marca de evaluación se guarda aparte: al limpiar la manipulación (tras
  // resincronizar la hora) vuelve a mandar el modo decidido por la licencia.
  setLicenseReadOnly(Boolean(input.evaluationReadOnly));
  return { ...integrity, readOnly: effectiveReadOnly() };
}

/**
 * Variante con almacén: lee la marca de agua persistida, aplica la guarda y, si
 * hubo manipulación, deja el evento acotado para enviarlo al reconectar.
 * Devuelve siempre un resultado; nunca lanza ni modifica lease ni datos.
 */
export async function applyLicenseClockGuard(
  store: LicenseKeyValueStore,
  input: {
    companyId: string;
    nowMs: number;
    evaluationReadOnly?: boolean;
    serverAnchorMs?: number | null;
    monotonicMs?: number | null;
    toleranceMs?: number;
    /** Tope absoluto del lease para informar la ventana restante efectiva. */
    offlineUntilMs?: number | null;
  }
): Promise<LicenseTimeGateResult> {
  let watermarkMs: number | null = null;
  try {
    watermarkMs = await loadWatermark(store, input.companyId);
  } catch {
    watermarkMs = null;
  }

  const result = applyLicenseTimeGate({
    evaluationReadOnly: input.evaluationReadOnly,
    nowMs: input.nowMs,
    watermarkMs,
    serverAnchorMs: input.serverAnchorMs,
    monotonicMs: input.monotonicMs,
    toleranceMs: input.toleranceMs
  });

  const draft = clockTamperDraft(result, result.effectiveMs);
  if (draft) await recordClockTamperEvent(store, draft);

  const offlineUntilMs = input.offlineUntilMs;
  return {
    ...result,
    offlineRemainingMs:
      typeof offlineUntilMs === "number" && Number.isFinite(offlineUntilMs)
        ? Math.max(0, offlineUntilMs - result.effectiveMs)
        : undefined
  };
}
