import { CLOCK_ROLLBACK_TOLERANCE_MS, type SignedLease } from "./contract";
import { evaluateLease } from "./evaluate";
import { nextWatermark } from "./clock";
import { fingerprintFromPublicJwk, createDeviceKey, type DeviceKey } from "./deviceKey";
import {
  loadDeviceKey,
  saveDeviceKey,
  readStoredLease,
  saveLease,
  loadWatermark,
  saveWatermark,
  loadPinnedPublicKey,
  savePinnedPublicKey,
  loadStoredDeviceFingerprint,
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
  /**
   * El lease guardado se verificó y evaluó sin respuesta de la nube en este
   * arranque. Es el estado normal del POS offline: NO es un error.
   */
  offlineVerified: boolean;
  /**
   * Este equipo nunca recibió un lease (primera vez). Distinto de
   * `offlineVerified`: aquí la activación todavía está pendiente.
   */
  pendingActivation: boolean;
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
  leasePresent: false,
  offlineVerified: false,
  pendingActivation: false
};

/**
 * La licencia local se evalúa siempre; la red solo confirma. Con el navegador
 * declarando «sin conexión» no se intenta activar ni renovar.
 */
function isOnline(): boolean {
  try {
    return typeof navigator === "undefined" || navigator.onLine !== false;
  } catch {
    return true;
  }
}

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
  // pestañas ni entre pruebas con respuestas de red distintas. La clave se
  // ancla en el almacén para poder verificar el lease sin conexión.
  const publicKeyResolver = createLicensePublicKeyResolver({
    fetchImpl,
    loadPinned: () => loadPinnedPublicKey(store),
    savePinned: (jwk) => savePinnedPublicKey(store, jwk)
  });

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
      leasePresent: false,
      offlineVerified: false,
      pendingActivation: false
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
      leasePresent: true,
      offlineVerified: false,
      pendingActivation: false
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
    /** Renovar aunque el lease no esté por vencer (identidad reparada). */
    force?: boolean;
  }): Promise<SignedLease | null> {
    // Sin conexión no se intenta activar: el arranque nunca espera a la red.
    if (!isOnline()) return null;
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
    if (input?.companyId && input.companyId !== companyId) {
      // Otra empresa en la misma pestaña: nada evaluado antes (plan, lease,
      // reintentos) puede reutilizarse para la nueva, ni siquiera como último
      // estado válido.
      companyId = input.companyId;
      lastValid = null;
      lastValidRawReadOnly = false;
      currentLeaseId = null;
      lastRenewAttemptAt = 0;
      completed = false;
      snapshot = LOADING_SNAPSHOT;
    }

    // 1) Clave de verificacion: build -> anclada de un arranque anterior -> red.
    //    El anclaje permite evaluar el lease guardado sin conexion, que es el
    //    caso normal al reabrir la app (offline-first).
    const keyResult = await resolvePublicKey();
    if (keyResult.status === "error") {
      if (completed) return snapshot;
      return publishUnmanaged(atMs, "network-error", false);
    }
    if (keyResult.status === "missing") {
      return publishUnmanaged(atMs, "license-key-missing", false);
    }

    const activeCompany = companyId;
    if (!activeCompany) return publishUnmanaged(atMs, "no-company", true);

    let verifyKey: CryptoKey;
    try {
      verifyKey = await importVerifyKey(keyResult.key.jwk);
    } catch {
      // Un fallo local transitorio no degrada una licencia ya evaluada.
      if (completed) return snapshot;
      return publishUnmanaged(atMs, "verify-key-import-failed", true);
    }

    // 2) Lease y marca de agua guardados: lectura local, sin red. La lectura
    //    distingue «no hay lease» (primera activación) de «no se pudo leer» y de
    //    «está alterado»: solo la primera puede avisar «sin verificar».
    let lease: SignedLease | null;
    let watermarkMs: number | null;
    let leaseStatus: "ok" | "missing" | "invalid" | "unreadable" = "missing";
    try {
      const stored = await readStoredLease(store, activeCompany);
      lease = stored.lease;
      leaseStatus = stored.status;
      watermarkMs = await loadWatermark(store, activeCompany);
    } catch {
      lease = null;
      leaseStatus = "unreadable";
      watermarkMs = null;
    }

    if (leaseStatus === "unreadable") {
      // Fallo de lectura del disco: el lease puede seguir guardado. No se sale a
      // la red a emitir otro encima ni se publica `lease-missing`; se conserva
      // la última evaluación buena y se reintenta en el siguiente refresco.
      if (lastValid) {
        return publish({ ...lastValid, lastCheckedAt: atMs }, lastValidRawReadOnly);
      }
      if (completed) return snapshot;
      return publishUnmanaged(atMs, "storage-error", true);
    }
    currentLeaseId = lease ? lease.leaseId : null;

    // 3) Identidad del equipo. La huella previa distingue un equipo nuevo (no
    //    hubo lease nunca) de una identidad perdida/regenerada (el lease
    //    emitido deja de valer y hay que volver a activar con red).
    let previousFingerprint: string | null = null;
    try {
      previousFingerprint = await loadStoredDeviceFingerprint(store);
    } catch {
      previousFingerprint = null;
    }

    let identity: { devicePublicKeySpki: ArrayBuffer; fingerprint: string };
    try {
      identity = await ensureDeviceIdentity();
    } catch {
      // Sin WebCrypto o con el almacén ilegible no se puede verificar. Nunca se
      // bloquea ni se degrada una evaluación ya buena por eso, y `loadDeviceKey`
      // tampoco habrá creado una identidad nueva encima de la guardada.
      if (lastValid) {
        return publish({ ...lastValid, lastCheckedAt: atMs }, lastValidRawReadOnly);
      }
      if (completed) return snapshot;
      return publishUnmanaged(atMs, "device-key-unavailable", true);
    }
    const identityRotated =
      typeof previousFingerprint === "string" && previousFingerprint !== identity.fingerprint;

    const verifyWith = async (
      candidate: SignedLease,
      key: CryptoKey
    ): Promise<Awaited<ReturnType<typeof verifyLeaseForDevice>>> => {
      try {
        return await verifyLeaseForDevice(candidate, {
          verifyKey: key,
          devicePublicKeySpki: identity.devicePublicKeySpki
        });
      } catch {
        return { ok: false as const, reason: "invalid-lease" as const };
      }
    };

    let verification = lease ? await verifyWith(lease, verifyKey) : null;

    // Una clave anclada puede haber rotado: si la firma falla se comprueba la
    // red una sola vez. Ni el lease ni la evaluacion ya validada se tocan aqui.
    if (
      lease &&
      verification &&
      !verification.ok &&
      keyResult.key.source === "pinned" &&
      isOnline()
    ) {
      const refreshedKey = await publicKeyResolver.refresh();
      if (refreshedKey.status === "found") {
        try {
          verifyKey = await importVerifyKey(refreshedKey.key.jwk);
          verification = await verifyWith(lease, verifyKey);
        } catch {
          // La verificacion fallida se conserva: nunca se relaja la firma.
        }
      }
    }

    // La guarda de reloj se aplica en toda evaluacion, incluso sin lease: una
    // hora retrocedida no debe habilitar escrituras ni alargar la ventana.
    const applyClockGuard = async (
      evaluationReadOnly: boolean,
      serverAnchorMs?: number | null,
      offlineUntilMs?: number | null
    ) => {
      try {
        return await applyLicenseClockGuard(store, {
          companyId: activeCompany,
          nowMs: atMs,
          evaluationReadOnly,
          serverAnchorMs: serverAnchorMs ?? null,
          offlineUntilMs
        });
      } catch {
        return null;
      }
    };

    const evaluateAndPublish = async (args: {
      lease: SignedLease;
      watermarkMs: number | null;
      offlineVerified: boolean;
    }): Promise<LicenseSnapshot> => {
      const evaluation = evaluateLease({
        lease: args.lease,
        nowMs: atMs,
        watermarkMs: args.watermarkMs,
        devicePublicKeyFp: identity.fingerprint,
        signatureValid: true
      });

      const anchorMs = Date.parse(args.lease.serverTimeAnchor);
      const offlineUntilRaw = Date.parse(evaluation.offlineUntil);
      const clock = await applyClockGuard(
        evaluation.readOnly,
        Number.isFinite(anchorMs) ? anchorMs : null,
        Number.isFinite(offlineUntilRaw) ? offlineUntilRaw : null
      );
      const tampered = Boolean(clock?.tampered);

      const advanced = nextWatermark({
        previousMs: args.watermarkMs,
        nowMs: atMs,
        serverTimeMs: Number.isFinite(anchorMs) ? anchorMs : null
      });
      try {
        // Solo avanza: si el reloj local retrocede, la ventana no se reabre.
        await saveWatermark(store, activeCompany, advanced);
      } catch {
        // La marca en memoria de esta sesion sigue protegiendo el calculo.
      }

      const next: LicenseSnapshot = {
        mode: evaluation.mode,
        readOnly: evaluation.readOnly || tampered,
        planCode: args.lease.planCode,
        paidThrough: evaluation.paidThrough,
        offlineUntil: evaluation.offlineUntil,
        expiresAt: evaluation.expiresAt,
        reason: tampered && !evaluation.readOnly ? "clock-tampered" : evaluation.reason,
        clockWarning: evaluation.clockWarning || tampered,
        lastCheckedAt: atMs,
        keyConfigured: true,
        leasePresent: true,
        offlineVerified: args.offlineVerified,
        pendingActivation: false
      };
      lastValid = next;
      lastValidRawReadOnly = evaluation.readOnly;
      currentLeaseId = args.lease.leaseId;
      return publish(next, evaluation.readOnly);
    };

    // 4) Primera publicacion: solo con lo que hay en disco. Nunca espera a la red.
    if (!lease) {
      if (leaseStatus === "invalid") {
        // El registro existe pero no es un lease utilizable (alterado o
        // truncado): NO es una primera activación, así que no se anuncia «sin
        // verificar». Sin bloquear; la renovación con red lo repara.
        publish(
          {
            mode: "invalid",
            readOnly: false,
            reason: "invalid-lease",
            clockWarning: false,
            lastCheckedAt: atMs,
            keyConfigured: true,
            leasePresent: true,
            offlineVerified: false,
            pendingActivation: false
          },
          false
        );
      } else {
        // Primera vez en el equipo (no es un fallo de red): se puede operar y la
        // activacion se reintenta sola cuando haya conexion.
        const clock = await applyClockGuard(false);
        const tampered = Boolean(clock?.tampered);
        publish(
          {
            mode: "unmanaged",
            readOnly: tampered,
            reason: tampered ? "clock-tampered" : "lease-missing",
            clockWarning: tampered,
            lastCheckedAt: atMs,
            keyConfigured: true,
            leasePresent: false,
            offlineVerified: false,
            pendingActivation: true
          },
          false
        );
      }
    } else if (verification && !verification.ok) {
      const failureReason = "reason" in verification ? verification.reason : "invalid-lease";
      const reason =
        identityRotated && failureReason === "wrong-device" ? "device-key-rotated" : failureReason;
      const anchorMs = Date.parse(lease.serverTimeAnchor);
      const clock = await applyClockGuard(false, Number.isFinite(anchorMs) ? anchorMs : null);
      const tampered = Boolean(clock?.tampered);
      if (lastValid) {
        publish(
          {
            ...lastValid,
            readOnly: lastValidRawReadOnly || tampered,
            clockWarning: lastValid.clockWarning || tampered,
            reason: tampered && !lastValidRawReadOnly ? "clock-tampered" : lastValid.reason,
            lastCheckedAt: atMs
          },
          lastValidRawReadOnly
        );
      } else {
        publish(
          {
            mode: "invalid",
            readOnly: tampered,
            reason: tampered ? "clock-tampered" : reason,
            clockWarning: tampered,
            lastCheckedAt: atMs,
            keyConfigured: true,
            leasePresent: true,
            offlineVerified: false,
            pendingActivation: false
          },
          false
        );
      }
    } else {
      await evaluateAndPublish({ lease, watermarkMs, offlineVerified: true });
    }

    // 5) Fase de red (mejor esfuerzo, despues de publicar): revocacion y
    //    renovacion. Cualquier fallo conserva el lease guardado y su evaluacion.
    if (!isOnline()) return snapshot;

    if (lease && verification?.ok && (await leaseIsRevoked(lease))) {
      return publishRevoked(lease, atMs);
    }

    const needsIdentityRepair = identityRotated || Boolean(verification && !verification.ok);
    const renewed = await maybeRenew({
      lease,
      verifyKey,
      deviceFp: identity.fingerprint,
      deviceSpki: identity.devicePublicKeySpki,
      activeCompany,
      atMs,
      force: needsIdentityRepair
    });
    if (!renewed) return snapshot;

    // Un lease solo se adopta si su firma y su vinculo con el equipo verifican.
    const renewedVerification = await verifyWith(renewed, verifyKey);
    if (!renewedVerification.ok) return snapshot;
    currentLeaseId = renewed.leaseId;

    // Reparacion de una marca de agua envenenada: si el reloj del equipo estuvo
    // adelantado y luego se corrigio, la marca queda en el futuro y bloquearia
    // para siempre. Un lease nuevo y firmado es una referencia fiable.
    const renewedAnchor = Date.parse(renewed.serverTimeAnchor);
    if (
      Number.isFinite(renewedAnchor) &&
      watermarkMs !== null &&
      renewedAnchor < watermarkMs - CLOCK_ROLLBACK_TOLERANCE_MS
    ) {
      try {
        await saveWatermark(store, activeCompany, renewedAnchor);
        watermarkMs = renewedAnchor;
      } catch {
        // Si no se puede persistir, la guarda sigue protegiendo la ventana.
      }
    }

    // Un lease recien emitido tambien puede llegar ya revocado.
    if (await leaseIsRevoked(renewed)) return publishRevoked(renewed, atMs);

    return evaluateAndPublish({ lease: renewed, watermarkMs, offlineVerified: false });
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
