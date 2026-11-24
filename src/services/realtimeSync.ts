import { getSupabase } from '../lib/supabase';
import { isBrowserOffline, isTransientNetworkError } from './offlineNetwork';
import { recordRequest } from './requestBudget';

/**
 * Realtime acotado al presupuesto de nube (F6).
 *
 * - Los datos de negocio viajan por el hub LAN (SSE): este módulo ya NO abre
 *   canales de cambio por tabla de negocio ni sondea la nube cada 120 s, ni
 *   refresca todo al recuperar foco o conexión.
 * - La nube solo se escucha para la aprobación de planes del propietario:
 *   `notifications` (ámbito de usuario) y, si la consola lo necesita,
 *   `plan_requests`. Nunca tablas de negocio.
 * - El arranque hace un bootstrap mínimo por tenant (una sola vez) mediante
 *   `bootstrapCloudData()`; si ese export aún no existe, no se cae a un pull
 *   completo, porque el hub LAN ya alimenta la operación.
 */

/** Tabla de notificaciones del propietario (ámbito de usuario). */
export const PLAN_APPROVAL_NOTIFICATION_TABLE = 'notifications';
/** Solicitudes de plan que revisa la consola de plataforma. */
export const PLAN_REQUEST_TABLE = 'plan_requests';

/**
 * Lista blanca de tablas que pueden usar Realtime en la nube. Cualquier tabla
 * de negocio queda fuera a propósito: su tiempo real es el hub LAN.
 */
const CLOUD_REALTIME_TABLES: readonly string[] = [
  PLAN_APPROVAL_NOTIFICATION_TABLE,
  PLAN_REQUEST_TABLE
];

export function realtimeTableSubscriptions(): string[] {
  return [...CLOUD_REALTIME_TABLES];
}

const CLOUD_CHANNEL_PREFIX = 'palmyra-plan-approval-';

let initRefCount = 0;
let bootstrappedTenantKey = '';
let bootstrapInFlight: Promise<boolean> | null = null;
let cleanupRuntime: (() => void) | null = null;

/** Generación de suscripción: invalida callbacks de un canal ya retirado. */
let subscriberGeneration = 0;
let cloudChannel: any = null;

function warnNetworkOnly(message: string, error?: unknown) {
  if (isBrowserOffline() || isTransientNetworkError(error)) return;
  if (error === undefined) console.warn(message);
  else console.warn(message, error);
}

function emitRemoteDataChanged(table: string) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('remote_data_changed', { detail: { table } }));
}

/**
 * Bootstrap mínimo de nube: una vez por tenant/sucursal. Es el único camino de
 * lectura masiva al arrancar; con la app ya abierta no hay sondeos periódicos.
 */
async function runCloudBootstrap(): Promise<boolean> {
  if (isBrowserOffline()) return false;
  let key = '';
  try {
    const { getActiveTenant } = await import('./tenant');
    const tenant = await getActiveTenant();
    if (!tenant.companyId) return false;
    const { useStore } = await import('../store/useStore');
    const branchId = useStore.getState().currentBranchId || '';
    key = tenant.companyId + '|' + branchId;
    if (key === bootstrappedTenantKey) return false;
  } catch (error) {
    warnNetworkOnly('[PALMYRA] No se pudo resolver el tenant para el bootstrap mínimo.', error);
    return false;
  }

  if (bootstrapInFlight) return bootstrapInFlight;

  bootstrapInFlight = (async () => {
    try {
      const module = await import('../store/actions/syncActions');
      const bootstrap = (module as Record<string, unknown>).bootstrapCloudData;
      if (typeof bootstrap !== 'function') {
        // F6-B aún no aterrizó: no hay pull completo de respaldo.
        console.info(
          '[PALMYRA] Bootstrap mínimo en la nube no disponible todavía; ' +
            'la operación sigue por el hub LAN.'
        );
        return false;
      }
      const result = await (bootstrap as () => Promise<unknown>)();
      if (result === false) return false;
      bootstrappedTenantKey = key;
      emitRemoteDataChanged('bootstrap');
      return true;
    } catch (error) {
      warnNetworkOnly('[PALMYRA] Bootstrap mínimo en la nube diferido.', error);
      return false;
    } finally {
      bootstrapInFlight = null;
    }
  })();

  return bootstrapInFlight;
}

/**
 * Refresco manual desde Configuración: vuelve a ejecutar el bootstrap mínimo
 * sin depender de esperas ni de eventos de foco.
 */
export async function refreshRealtimeNow(): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  bootstrappedTenantKey = '';
  return runCloudBootstrap();
}

/**
 * Un filtro de tenant nunca debe aplicarse a tablas compartidas. `currencies`
 * es la única compartida y hoy no participa en Realtime, pero la guarda evita
 * que un futuro canal compartido quede silenciado por un filtro inexistente.
 */
function tenantScopedFilter(table: string, companyId: string | null | undefined): string | undefined {
  if (!companyId) return undefined;
  if (table !== 'currencies') return 'company_id=eq.' + companyId;
  return undefined;
}

export interface PlanApprovalRealtimeOptions {
  companyId?: string | null;
  userId?: string | null;
  /** Se llama con cada fila escuchada; la consola decide si recarga. */
  onChange?: (info: { table: string; event: string }) => void;
}

/**
 * Canal de nube para la consola: SOLO aprobación de planes. La suscripción se
 * cierra al desmontar la consola; no hay sondeos en segundo plano.
 */
export function subscribePlanApprovalRealtime(options: PlanApprovalRealtimeOptions = {}): () => void {
  const supabase = getSupabase();
  if (!supabase || isBrowserOffline()) return () => {};

  subscriberGeneration += 1;
  const generation = subscriberGeneration;
  const topic = CLOUD_CHANNEL_PREFIX + (options.companyId || options.userId || 'platform');
  const startedAt = Date.now();
  const channel = supabase.channel(topic);

  // Cada callback se registra antes de subscribe(): añadirlos después lanza.
  for (const table of realtimeTableSubscriptions()) {
    // `any` mantiene la configuración compatible con todas las versiones del
    // cliente de Realtime (el filtro solo existe en algunas).
    const config: any = { event: '*', schema: 'public', table };
    // `notifications` es del usuario; `plan_requests` es global para plataforma.
    if (table === PLAN_APPROVAL_NOTIFICATION_TABLE) {
      const filter = options.userId
        ? 'user_id=eq.' + options.userId
        : tenantScopedFilter(table, options.companyId);
      if (filter) config.filter = filter;
    }
    channel.on('postgres_changes', config, (payload: any) => {
      if (generation !== subscriberGeneration) return;
      try {
        options.onChange?.({
          table: String(payload?.table || table),
          event: String(payload?.eventType || payload?.event || 'unknown')
        });
      } catch {
        // Un manejador roto no debe cerrar el canal.
      }
    });
  }

  let closed = false;
  channel.subscribe((status: string) => {
    if (generation !== subscriberGeneration) return;
    if (status === 'SUBSCRIBED') {
      recordRequest('realtime/notifications', { ms: Date.now() - startedAt, ok: true });
    } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
      recordRequest('realtime/notifications', { ms: Date.now() - startedAt, ok: false });
      warnNetworkOnly('[PALMYRA] Realtime de aprobación de planes: ' + status);
    } else if (status === 'CLOSED' && cloudChannel === channel) {
      cloudChannel = null;
    }
  });

  cloudChannel = channel;

  return () => {
    if (closed) return;
    closed = true;
    subscriberGeneration += 1;
    if (cloudChannel === channel) cloudChannel = null;
    void Promise.resolve(supabase.removeChannel(channel)).catch(() => undefined);
  };
}

/**
 * Arranque del motor. No abre canales de negocio ni temporizadores: solo
 * ejecuta el bootstrap mínimo una vez y lo reintenta al volver la conexión
 * si aún no se completó.
 */
export function initMultiDeviceRealtimeSync(): () => void {
  if (typeof window === 'undefined') return () => {};
  initRefCount += 1;

  if (initRefCount === 1) {
    const onOnline = () => {
      void runCloudBootstrap();
    };
    const onOffline = () => {
      // Sin conexión no hay nada que escuchar en la nube; el hub LAN sigue.
      if (cloudChannel) {
        subscriberGeneration += 1;
        cloudChannel = null;
      }
    };

    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    void runCloudBootstrap();

    cleanupRuntime = () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      subscriberGeneration += 1;
      cloudChannel = null;
      bootstrappedTenantKey = '';
      bootstrapInFlight = null;
    };
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    initRefCount = Math.max(0, initRefCount - 1);
    if (initRefCount === 0 && cleanupRuntime) {
      const cleanup = cleanupRuntime;
      cleanupRuntime = null;
      cleanup();
    }
  };
}

/** Solo para pruebas: expone el estado interno sin cambiar el contrato público. */
export const __realtimeInternals = {
  getInitRefCount: () => initRefCount,
  getBootstrappedTenantKey: () => bootstrappedTenantKey,
  getSubscriberGeneration: () => subscriberGeneration
};
