import { CLOCK_ROLLBACK_TOLERANCE_MS, type SignedLease } from "./contract";
import { evaluateLease } from "./evaluate";
import { nextWatermark } from "./clock";
import { fingerprintFromPublicJwk, createDeviceKey, type DeviceKey } from "./deviceKey";
import {
  loadDeviceKey,
  saveDeviceKey,
  loadLease,
  saveLease,
  loadWatermark,
  saveWatermark,
  createIndexedDbLicenseStore,
  type LicenseKeyValueStore
} from "./storage";
import { importVerifyKey, verifyLeaseForDevice } from "./verify";
import { applyLicenseClockGuard, setLicenseReadOnly } from "./guard";
import { recordRequest } from "../requestBudget";
import { createLicensePublicKeyResolver } from "./activation";
import { checkLeaseRevocation, resolveRevocationBaseUrl } from "./revocation";
import {
  drainClockTelemetry,
  type ClockTamperTelemetryClient
} from "./telemetry";

/**
 * Runtime que convierte un lease firmado en el estado real de la aplicación.
 * Ver comentario de políticas en `runRefresh` antes de cambiar el orden de las
 * comprobaciones: el objetivo es no bloquear nunca por dudas.
 */

export type LicensePublicMode =
  | "unmanaged"
  | "free"
  | "active"
  | "grace"
  | "expired"
  | "invalid"
  | "revoked"
  | "loading";

/** Mensaje único de una licencia revocada por el proveedor. */
export const LICENSE_REVOKED_MESSAGE =
  "Tu licencia fue revocada. Contacta al proveedor.";

export interface LicenseSnapshot {
  mode: LicensePublicMode;
  readOnly: boolean;
  planCode?: string;
  paidThrough?: string;
  offlineUntil?: string;
  expiresAt?: string;
  reason: string;
  /** Texto listo para mostrar cuando el estado lo exige (p. ej. revocada). */
  message?: string;
  clockWarning: boolean;
  lastCheckedAt: number;
  keyConfigured: boolean;
  leasePresent: boolean;
}

export type LicenseFetch = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Forma mínima de Supabase que necesita el runtime. Se declara aquí para no
 * acoplar la lógica de licencia al cliente completo ni a su versión.
 */
export interface LicenseRuntimeClient {
  auth: {
    getSession(): Promise<{ data: { session: unknown } | null; error?: unknown }>;
  };
  functions: {
    invoke(
      name: string,
      options: { body: Record<string, unknown> }
    ): Promise<{ data: unknown; error: unknown }>;
  };
  /** Opcional: solo lo usa la telemetría de reloj. */
  from?(table: string): {
    insert(rows: unknown[]): PromiseLike<{ error?: unknown }>;
  };
  /** URL del proyecto Supabase; permite derivar la base de `revoke-lease`. */
  supabaseUrl?: string;
}

export interface LicenseRuntimeOptions {
  store?: LicenseKeyValueStore;
  fetchImpl?: LicenseFetch;
  now?: () => number;
  getClient?: () => LicenseRuntimeClient | null;
  /** Aísla el identificador de dispositivo persistido (pruebas, varias apps). */
  storageKeyPrefix?: string;
  /** Base de las Edge Functions para `revoke-lease`; por defecto, el entorno. */
  revokeBaseUrl?: string;
  /** Vigencia de la caché de revocación por leaseId. */
  revocationTtlMs?: number;
}

export interface LicenseRuntime {
  start(input?: { companyId?: string }): Promise<LicenseSnapshot>;
  refresh(input?: { companyId?: string }): Promise<LicenseSnapshot>;
  subscribe(listener: (snapshot: LicenseSnapshot) => void): () => void;
  getSnapshot(): LicenseSnapshot;
  dispose(): void;
}

const DEVICE_ID_STORAGE_PREFIX = "palmyra_license_device_id";
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** Renueva cuando falten menos de 24 h para el tope absoluto del lease. */
const RENEW_BEFORE_MS = DAY_MS;
/** Un lease con más de 12 h de antigüedad se renueva al volver a tener sesión. */
const LEASE_MAX_AGE_MS = 12 * HOUR_MS;
/** Evita martillar issue-lease mientras el servidor responda con error. */
const RENEW_RETRY_MS = 10 * 60 * 1000;

const LOADING_SNAPSHOT: LicenseSnapshot = {
  mode: "loading",
  readOnly: false,
  reason: "loading",
  clockWarning: false,
  lastCheckedAt: 0,
  keyConfigured: false,
  leasePresent: false
};

function readDeviceId(prefix: string): string {
  const fallback = "dispositivo-local";
  if (typeof localStorage === "undefined") return fallback;
  const key = `${DEVICE_ID_STORAGE_PREFIX}__${prefix || "default"}`;
  try {
    const existing = localStorage.getItem(key);
    if (existing && /^[\w.:-]{1,128}$/.test(existing)) return existing;
    const generated = `dev-${crypto.randomUUID()}`;
    localStorage.setItem(key, generated);
    return generated;
  } catch {
    return fallback;
  }
}

export function createLicenseRuntime(options: LicenseRuntimeOptions = {}): LicenseRuntime {
  const store = options.store ?? createIndexedDbLicenseStore();
  const fetchImpl: LicenseFetch =
    options.fetchImpl ?? ((input, init) => fetch(input, init));
  const now = options.now ?? (() => Date.now());
  const getClient = options.getClient ?? (() => null);
  const storageKeyPrefix = options.storageKeyPrefix ?? "";
  // Un resolver por runtime: la caché de la clave pública no se comparte entre
  // pestañas ni entre pruebas con respuestas de red distintas.
  const publicKeyResolver = createLicensePublicKeyResolver({ fetchImpl });

  const listeners = new Set<(snapshot: LicenseSnapshot) => void>();
  let snapshot: LicenseSnapshot = LOADING_SNAPSHOT;
  let inFlight: Promise<LicenseSnapshot> | null = null;
  let companyId: string | null = null;
  let currentLeaseId: string | null = null;
  let lastValid: LicenseSnapshot | null = null;
  /** Solo lectura decidido por la evaluación, sin la marca de reloj. */
  let lastValidRawReadOnly = false;
  let lastRenewAttemptAt = 0;
  let completed = false;
  let disposed = false;

  // `rawReadOnly` es la decisión de licencia sin la marca de reloj: así limpiar
  // la manipulación tras resincronizar la hora no deja la app bloqueada.
  function publish(next: LicenseSnapshot, rawReadOnly: boolean = next.readOnly): LicenseSnapshot {
    snapshot = next;
    completed = true;
    setLicenseReadOnly(rawReadOnly);
    for (const listener of [...listeners]) {
      try {
        listener(snapshot);
      } catch {
        // Un suscriptor roto no debe romper la evaluación de licencia.
      }
    }
    return snapshot;
  }

  function publishUnmanaged(atMs: number, reason: string, keyConfigured: boolean): LicenseSnapshot {
    return publish({
      mode: "unmanaged",
      readOnly: false,
      reason,
      clockWarning: false,
      lastCheckedAt: atMs,
      keyConfigured,
      leasePresent: false
    });
  }

  function resolvePublicKey() {
    return publicKeyResolver.resolve();
  }

  /**
   * Publica el estado de licencia revocada. La decisión de solo lectura es
   * "cruda" (no depende de la marca de reloj), así `publish(snapshot, true)`
   * mantiene el anti-tamper sin que una resincronización la borre.
   */
  function publishRevoked(lease: SignedLease, atMs: number): LicenseSnapshot {
    const next: LicenseSnapshot = {
      mode: "revoked",
      readOnly: true,
      planCode: lease.planCode,
      paidThrough: lease.paidThrough,
      offlineUntil: lease.offlineUntil,
      expiresAt: lease.expiresAt,
      reason: "lease-revoked",
      message: LICENSE_REVOKED_MESSAGE,
      clockWarning: false,
      lastCheckedAt: atMs,
      keyConfigured: true,
      leasePresent: true
    };
    lastValid = next;
    lastValidRawReadOnly = true;
    currentLeaseId = lease.leaseId;
    return publish(next, true);
  }

  /** Base de `revoke-lease`: opción, entorno o URL del cliente Supabase. */
  function revocationBaseUrl(): string | null {
    if (typeof options.revokeBaseUrl === "string" && options.revokeBaseUrl.trim()) {
      return resolveRevocationBaseUrl(options.revokeBaseUrl);
    }
    const fromEnv = resolveRevocationBaseUrl(null);
    if (fromEnv) return fromEnv;
    let client: LicenseRuntimeClient | null = null;
    try {
      client = getClient();
    } catch {
      client = null;
    }
    const url = client?.supabaseUrl;
    if (typeof url === "string" && url.trim()) {
      return `${url.trim().replace(/\/+$/, "")}/functions/v1`;
    }
    return null;
  }

  async function leaseIsRevoked(lease: SignedLease | null): Promise<boolean> {
    if (!lease) return false;
    try {
      const result = await checkLeaseRevocation(lease, {
        fetchImpl,
        baseUrl: revocationBaseUrl(),
        now,
        ttlMs: options.revocationTtlMs
      });
      return result.revoked;
    } catch {
      // La revocación nunca puede romper la evaluación: falla abierto.
      return false;
    }
  }

  async function ensureDeviceIdentity(): Promise<{
    devicePublicKeySpki: ArrayBuffer;
    fingerprint: string;
  }> {
    let device: DeviceKey | null = await loadDeviceKey(store);
    if (!device) {
      const created = await createDeviceKey();
      await saveDeviceKey(store, created);
      device = created;
    }
    // La huella se recalcula desde la pública guardada: si el registro fue
    // alterado, el lease de este equipo deja de coincidir.
    const fingerprint = await fingerprintFromPublicJwk(device.publicJwk);
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      device.publicJwk,
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["verify"]
    );
    const devicePublicKeySpki = await crypto.subtle.exportKey("spki", publicKey);
    return { devicePublicKeySpki, fingerprint };
  }

  async function maybeRenew(args: {
    lease: SignedLease | null;
    verifyKey: CryptoKey;
    deviceFp: string;
    deviceSpki: ArrayBuffer;
    activeCompany: string;
    atMs: number;
  }): Promise<SignedLease | null> {
    let client: LicenseRuntimeClient | null = null;
    try {
      client = getClient();
    } catch {
      return null;
    }
    if (!client) return null;

    let session: unknown = null;
    try {
      const result = await client.auth.getSession();
      session = result?.data?.session ?? null;
    } catch {
      return null;
    }
    if (!session) return null;

    const expiresMs = args.lease ? Date.parse(args.lease.expiresAt) : Number.NaN;
    const issuedMs = args.lease ? Date.parse(args.lease.issuedAt) : Number.NaN;
    const needsRenewal =
      !args.lease ||
      (Number.isFinite(expiresMs) && expiresMs - args.atMs < RENEW_BEFORE_MS) ||
      (Number.isFinite(issuedMs) && args.atMs - issuedMs > LEASE_MAX_AGE_MS);
    if (!needsRenewal) return null;
    if (args.atMs - lastRenewAttemptAt < RENEW_RETRY_MS) return null;
    lastRenewAttemptAt = args.atMs;

    try {
      const startedAt = Date.now();
      const { data, error } = await client.functions.invoke("issue-lease", {
        body: {
          deviceId: readDeviceId(storageKeyPrefix),
          devicePubKeyFp: args.deviceFp,
          companyId: args.activeCompany
        }
      });
      // F6: la renovación de lease es una solicitud de nube contabilizada
      // (cada 12 h); el panel de presupuesto la muestra como `license/lease`.
      recordRequest("license/lease", { ms: Date.now() - startedAt, ok: !error });
      if (error) return null;
      const candidate = (data as { lease?: SignedLease } | null)?.lease;
      if (!candidate) return null;
      // Nunca se persiste un lease sin comprobar firma y vínculo con el equipo.
      const verification = await verifyLeaseForDevice(candidate, {
        verifyKey: args.verifyKey,
        devicePublicKeySpki: args.deviceSpki
      });
      if (!verification.ok) return null;
      await saveLease(store, candidate, args.activeCompany);
      return candidate;
    } catch {
      // Un fallo de red al renovar conserva el lease actual y su evaluación.
      return null;
    }
  }

  /**
   * Política anti-bloqueo, una regla por línea:
   * - Clave configurada + lease verificado y vencido -> readOnly true.
   * - Clave configurada + sin lease -> NO bloquear (unmanaged): una instalación
   *   nueva debe poder sincronizar por primera vez antes de tener licencia.
   * - Lease no verificable (firma o vínculo de equipo) -> NO bloquear esa sesión
   *   (invalid) y mostrar aviso; si ya hubo una evaluación válida, se conserva.
   * - Error de red (clave, renovación, almacenamiento) -> se conserva el último
   *   snapshot; un fallo de red nunca activa solo lectura.
   */
  async function runRefresh(input?: { companyId?: string }): Promise<LicenseSnapshot> {
    if (disposed) return snapshot;
    const atMs = now();
    if (input?.companyId) companyId = input.companyId;

    const keyResult = await resolvePublicKey();
    if (keyResult.status === "error") {
      if (completed) return snapshot;
      return publishUnmanaged(atMs, "network-error", false);
    }
    if (keyResult.status === "missing") {
      return publishUnmanaged(atMs, "license-key-missing", false);
    }
    const key = keyResult.key;

    const activeCompany = companyId;
    if (!activeCompany) return publishUnmanaged(atMs, "no-company", true);

    let verifyKey: CryptoKey;
    try {
      verifyKey = await importVerifyKey(key.jwk);
    } catch {
      return publishUnmanaged(atMs, "verify-key-import-failed", true);
    }

    let identity: { devicePublicKeySpki: ArrayBuffer; fingerprint: string };
    try {
      identity = await ensureDeviceIdentity();
    } catch {
      // Sin WebCrypto/IndexedDB no se puede verificar: nunca se bloquea por eso.
      return publishUnmanaged(atMs, "device-key-unavailable", true);
    }

    let lease: SignedLease | null;
    let watermarkMs: number | null;
    try {
      lease = await loadLease(store, activeCompany);
      watermarkMs = await loadWatermark(store, activeCompany);
    } catch {
      if (completed) return snapshot;
      return publishUnmanaged(atMs, "storage-error", true);
    }
    currentLeaseId = lease ? lease.leaseId : null;

    // Verificación temprana del lease guardado para poder aplicar revocación
    // solo sobre un lease auténtico: una firma rota no puede forzar solo
    // lectura. El resultado se reutiliza más abajo si no hubo renovación.
    let storedVerification: Awaited<ReturnType<typeof verifyLeaseForDevice>> | null = null;
    if (lease) {
      try {
        storedVerification = await verifyLeaseForDevice(lease, {
          verifyKey,
          devicePublicKeySpki: identity.devicePublicKeySpki
        });
      } catch {
        storedVerification = { ok: false as const, reason: "invalid-lease" as const };
      }
      if (storedVerification.ok && (await leaseIsRevoked(lease))) {
        return publishRevoked(lease, atMs);
      }
    }

    const renewed = await maybeRenew({
      lease,
      verifyKey,
      deviceFp: identity.fingerprint,
      deviceSpki: identity.devicePublicKeySpki,
      activeCompany,
      atMs
    });
    if (renewed) {
      lease = renewed;
      currentLeaseId = renewed.leaseId;
      // Un lease recién emitido también puede llegar ya revocado.
      if (await leaseIsRevoked(renewed)) return publishRevoked(renewed, atMs);
    }

    const anchorRaw = lease ? Date.parse(lease.serverTimeAnchor) : Number.NaN;
    const serverAnchorMs = Number.isFinite(anchorRaw) ? anchorRaw : null;

    // Reparación de una marca de agua envenenada: si el reloj del equipo estuvo
    // adelantado y luego se corrigió, la marca queda en el futuro y bloquearía
    // para siempre. Un lease recién emitido y firmado por el servidor es una
    // referencia de hora fiable y puede bajar la marca a su ancla.
    if (
      renewed &&
      serverAnchorMs !== null &&
      watermarkMs !== null &&
      serverAnchorMs < watermarkMs - CLOCK_ROLLBACK_TOLERANCE_MS
    ) {
      try {
        await saveWatermark(store, activeCompany, serverAnchorMs);
        watermarkMs = serverAnchorMs;
      } catch {
        // Si no se puede persistir, la guarda sigue protegiendo la ventana.
      }
    }

    // La guarda de reloj se aplica en toda evaluación, incluso sin lease: una
    // hora retrocedida no debe habilitar escrituras ni alargar la ventana.
    const applyClockGuard = async (evaluationReadOnly: boolean, offlineUntilMs?: number | null) => {
      try {
        return await applyLicenseClockGuard(store, {
          companyId: activeCompany,
          nowMs: atMs,
          evaluationReadOnly,
          serverAnchorMs,
          offlineUntilMs
        });
      } catch {
        return null;
      }
    };

    if (!lease) {
      const clock = await applyClockGuard(false);
      const tampered = Boolean(clock?.tampered);
      return publish(
        {
          mode: "unmanaged",
          readOnly: tampered,
          reason: tampered ? "clock-tampered" : "lease-missing",
          clockWarning: tampered,
          lastCheckedAt: atMs,
          keyConfigured: true,
          leasePresent: false
        },
        false
      );
    }

    let verification: Awaited<ReturnType<typeof verifyLeaseForDevice>>;
    if (!renewed && storedVerification) {
      verification = storedVerification;
    } else {
      try {
        verification = await verifyLeaseForDevice(lease, {
          verifyKey,
          devicePublicKeySpki: identity.devicePublicKeySpki
        });
      } catch {
        verification = { ok: false as const, reason: "invalid-lease" as const };
      }
    }

    if (!verification.ok) {
      const failureReason = "reason" in verification ? verification.reason : "invalid-lease";
      const clock = await applyClockGuard(false);
      const tampered = Boolean(clock?.tampered);
      if (lastValid) {
        return publish(
          {
            ...lastValid,
            readOnly: lastValidRawReadOnly || tampered,
            clockWarning: lastValid.clockWarning || tampered,
            reason: tampered && !lastValidRawReadOnly ? "clock-tampered" : lastValid.reason,
            lastCheckedAt: atMs
          },
          lastValidRawReadOnly
        );
      }
      return publish(
        {
          mode: "invalid",
          readOnly: tampered,
          reason: tampered ? "clock-tampered" : failureReason,
          clockWarning: tampered,
          lastCheckedAt: atMs,
          keyConfigured: true,
          leasePresent: true
        },
        false
      );
    }

    const evaluation = evaluateLease({
      lease,
      nowMs: atMs,
      watermarkMs,
      devicePublicKeyFp: identity.fingerprint,
      signatureValid: true
    });

    const anchorMs = Date.parse(lease.serverTimeAnchor);
    const offlineUntilRaw = Date.parse(evaluation.offlineUntil);
    const clock = await applyClockGuard(
      evaluation.readOnly,
      Number.isFinite(offlineUntilRaw) ? offlineUntilRaw : null
    );
    const tampered = Boolean(clock?.tampered);

    const advanced = nextWatermark({
      previousMs: watermarkMs,
      nowMs: atMs,
      serverTimeMs: Number.isFinite(anchorMs) ? anchorMs : null
    });
    try {
      // Solo avanza: si el reloj local retrocede, la ventana no se reabre.
      await saveWatermark(store, activeCompany, advanced);
    } catch {
      // La marca en memoria de esta sesión sigue protegiendo el cálculo.
    }

    const next: LicenseSnapshot = {
      mode: evaluation.mode,
      readOnly: evaluation.readOnly || tampered,
      planCode: lease.planCode,
      paidThrough: evaluation.paidThrough,
      offlineUntil: evaluation.offlineUntil,
      expiresAt: evaluation.expiresAt,
      reason: tampered && !evaluation.readOnly ? "clock-tampered" : evaluation.reason,
      clockWarning: evaluation.clockWarning || tampered,
      lastCheckedAt: atMs,
      keyConfigured: true,
      leasePresent: true
    };
    lastValid = next;
    lastValidRawReadOnly = evaluation.readOnly;
    currentLeaseId = lease.leaseId;
    return publish(next, evaluation.readOnly);
  }

  /**
   * Envía la telemetría de reloj pendiente cuando hay cliente Supabase. Es
   * best-effort y acotada: nunca cambia el snapshot ni bloquea la licencia.
   */
  async function drainTelemetryBestEffort(): Promise<void> {
    let client: LicenseRuntimeClient | null = null;
    try {
      client = getClient();
    } catch {
      client = null;
    }
    if (!client || !companyId) return;
    try {
      await drainClockTelemetry({
        store,
        client: client as unknown as ClockTamperTelemetryClient,
        companyId,
        deviceId: readDeviceId(storageKeyPrefix),
        leaseId: currentLeaseId
      });
    } catch {
      // La telemetría jamás puede romper el refresco de licencia.
    }
  }

  function refresh(input?: { companyId?: string }): Promise<LicenseSnapshot> {
    if (disposed) return Promise.resolve(snapshot);
    if (inFlight) {
      if (input?.companyId) companyId = input.companyId;
      return inFlight;
    }
    inFlight = runRefresh(input)
      .then(async (result) => {
        await drainTelemetryBestEffort();
        return result;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  return {
    start(input) {
      return refresh(input);
    },
    refresh,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot() {
      return snapshot;
    },
    dispose() {
      disposed = true;
      listeners.clear();
    }
  };
}
