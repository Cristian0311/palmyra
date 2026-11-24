import { invalidEvaluation } from "./contract";
import type { LicenseEvaluation, LicenseMode, LicensePlanCode, LicenseReason, SignedLease } from "./contract";
import { detectClockRollback, effectiveNowMs } from "./clock";

/**
 * Evaluación temporal del lease ya verificado criptográficamente.
 * Es pura (sin WebCrypto): la firma se comprueba antes con verify.ts.
 *
 * Lo que garantiza este módulo (aceptación F3):
 * - Gratis no mira fechas: opera sin internet de forma indefinida.
 * - Plan de pago vencido: gracia operable hasta `offlineUntil` y, después,
 *   solo lectura. Nunca se borra ni se oculta nada.
 * - Topes de ventana offline (35 días en mensual, 200 días en 3/6/12 meses):
 *   se aplican también en el cliente, así que un lease firmado con una ventana
 *   mayor no alarga la operación. El cliente nunca extiende lo emitido.
 * - Lease de otro equipo (huella de clave o `deviceId` conocido) → inválido.
 * - Reloj atrasado: la ventana se congela en la marca de agua y se avisa con
 *   `clockWarning`; quien pasa a solo lectura por esa causa es guard.ts, que
 *   mantiene la marca de manipulación durante toda la sesión.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

const PLAN_CODES: readonly LicensePlanCode[] = ["free", "starter", "growth", "pro"];
const DATE_FIELDS = [
  "paidThrough",
  "issuedAt",
  "notBefore",
  "expiresAt",
  "offlineUntil",
  "serverTimeAnchor"
] as const;

/** Topes de ventana offline por periodo pagado; replican la política del servidor. */
export const OFFLINE_CAP_DAYS = { monthly: 35, extended: 200 } as const;

/**
 * Días máximos de ventana offline contados desde `issuedAt`.
 * Mensual (1 mes): 35 días. Trimestral, semestral y anual: 200 días.
 * Un valor ausente o corrupto cae al tope más estricto.
 */
export function offlineCapDaysForBillingMonths(billingMonths: unknown): number {
  const months =
    typeof billingMonths === "number" && Number.isFinite(billingMonths) ? billingMonths : 0;
  return months <= 1 ? OFFLINE_CAP_DAYS.monthly : OFFLINE_CAP_DAYS.extended;
}

function parseDateMs(value: unknown): number {
  if (typeof value !== "string" || value.trim() === "") return Number.NaN;
  return Date.parse(value);
}

/** Forma válida y fechas parseables; el lease puede venir corrupto de disco. */
function isWellFormedLease(lease: SignedLease): boolean {
  if (!lease || typeof lease !== "object") return false;
  const record = lease as unknown as Record<string, unknown>;
  if (record.v !== 1) return false;
  if (typeof record.signature !== "string" || record.signature.trim() === "") return false;
  if (typeof record.planCode !== "string" || !PLAN_CODES.includes(record.planCode as LicensePlanCode)) {
    return false;
  }
  if (typeof record.devicePubKeyFp !== "string" || record.devicePubKeyFp === "") return false;
  for (const field of ["leaseId", "companyId", "deviceId"] as const) {
    if (typeof record[field] !== "string" || (record[field] as string) === "") return false;
  }
  // De los meses de facturación depende el tope offline: sin un valor válido no
  // se puede decidir la ventana, así que el lease no se evalúa.
  if (
    typeof record.billingMonths !== "number" ||
    !Number.isFinite(record.billingMonths) ||
    record.billingMonths < 0
  ) {
    return false;
  }
  for (const field of DATE_FIELDS) {
    if (!Number.isFinite(parseDateMs(record[field]))) return false;
  }
  if (!Array.isArray(record.featureKeys) || record.featureKeys.some((key) => typeof key !== "string")) {
    return false;
  }
  if (!record.limits || typeof record.limits !== "object" || Array.isArray(record.limits)) return false;
  return true;
}

export function evaluateLease(input: {
  lease: SignedLease;
  nowMs: number;
  watermarkMs?: number | null;
  devicePublicKeyFp?: string | null;
  /** Identificador de equipo esperado; barrera adicional a la huella. */
  deviceId?: string | null;
  signatureValid?: boolean;
}): LicenseEvaluation {
  const nowMs = Number.isFinite(input.nowMs) ? input.nowMs : 0;
  const evaluatedAt = new Date(nowMs).toISOString();
  const lease = input.lease;

  // 1. Firma explícitamente inválida.
  if (input.signatureValid === false) return invalidEvaluation("invalid-signature", evaluatedAt);

  // 2. Forma rota o fechas no parseables: no se evalúa ninguna ventana.
  if (!isWellFormedLease(lease)) return invalidEvaluation("invalid-lease", evaluatedAt);

  // 3. Reloj: la ventana se congela en la marca de agua si hay retroceso.
  const clockWarning = detectClockRollback({ previousMs: input.watermarkMs, nowMs });
  const effectiveMs = effectiveNowMs({ nowMs, watermarkMs: input.watermarkMs });

  // 4. Ventana efectiva: `offlineUntil` recortado al tope del periodo pagado,
  //    contado desde la emisión. Nunca se alarga lo que el servidor firmó.
  const isPaidPlan = lease.planCode !== "free";
  const issuedMs = Date.parse(lease.issuedAt);
  const signedOfflineMs = Date.parse(lease.offlineUntil);
  const cappedOfflineMs = isPaidPlan
    ? Math.min(signedOfflineMs, issuedMs + offlineCapDaysForBillingMonths(lease.billingMonths) * DAY_MS)
    : signedOfflineMs;
  const offlineUntil = new Date(cappedOfflineMs).toISOString();

  const result = (mode: LicenseMode, readOnly: boolean, reason: LicenseReason): LicenseEvaluation => ({
    mode,
    readOnly,
    reason,
    featureKeys: [...lease.featureKeys],
    limits: { ...lease.limits },
    paidThrough: lease.paidThrough,
    offlineUntil,
    expiresAt: lease.expiresAt,
    evaluatedAt,
    clockWarning
  });

  // 5. Gratis no depende de fechas, de ventana offline ni de vínculo de equipo:
  //    funciona sin internet de forma indefinida.
  if (!isPaidPlan) return result("free", false, "free");

  // 6. Vínculo con el equipo. La huella criptográfica es la referencia; el
  //    `deviceId` solo se contrasta cuando el llamador lo conoce.
  const expectedFp = typeof input.devicePublicKeyFp === "string" ? input.devicePublicKeyFp : "";
  if (expectedFp !== "" && expectedFp !== lease.devicePubKeyFp) {
    return invalidEvaluation("wrong-device", evaluatedAt, clockWarning);
  }
  const expectedDeviceId = typeof input.deviceId === "string" ? input.deviceId : "";
  if (expectedDeviceId !== "" && expectedDeviceId !== lease.deviceId) {
    return invalidEvaluation("wrong-device", evaluatedAt, clockWarning);
  }

  // 7. Todavía no vigente.
  if (effectiveMs < Date.parse(lease.notBefore)) {
    return invalidEvaluation("not-yet-valid", evaluatedAt, clockWarning);
  }

  // 8. Tope absoluto: ni con gracia se opera más allá de expiresAt.
  if (effectiveMs > Date.parse(lease.expiresAt)) return result("expired", true, "expired");

  // 9. Tope de la ventana offline: aunque `paidThrough` sea posterior (pago
  //    adelantado), sin reconectar no se opera más allá del tope del periodo.
  if (effectiveMs > cappedOfflineMs) return result("expired", true, "expired");

  // 10. Pagado y vigente.
  if (effectiveMs <= Date.parse(lease.paidThrough)) return result("active", false, "valid");

  // 11. Gracia: operación completa mientras dure la ventana offline efectiva.
  return result("grace", false, "grace");
}
