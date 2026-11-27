import { useShallow } from 'zustand/react/shallow';
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState, useRef, lazy, Suspense, type ComponentType, type ReactNode } from "react";
import { BrowserRouter as Router, Routes, Route, Navigate, useLocation } from "react-router-dom";
import { canAccessSettingsSection, NOTIFICATIONS_PATH } from './utils/settingsAccess';
import Layout from "./components/Layout";
import PublicUpdateBanner from "./components/PublicUpdateBanner";
import { loadSaaSContext, signOutSaaSAccount } from "./services/saas";
import { getSupabase } from "./lib/supabase";
import { useStore } from "./store/useStore";
import { initMultiDeviceRealtimeSync } from "./services/realtimeSync";
import { initKeyboardViewport } from "./services/keyboardViewport";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { getDevicePerformanceTier, scheduleIdleTask } from "./utils/devicePerformance";
import { flushLocalStateStorage } from "./services/localStateStorage";
import { setPalmyraLocalScope, clearPalmyraLocalScope, getPalmyraLocalScope } from "./services/localScope";
import { getCachedSaaSContext } from "./services/offlineAuthContext";
import { registerCurrentDevice } from "./services/device";
import { touchCurrentDevice } from "./services/security";
import { confirmNativeBoot } from "./lib/nativeApp";
import { currentAppSurface } from "./lib/appSurface";
import { storePlanCode } from "./hooks/usePlanCode";
import InstallRequired from "./components/InstallRequired";
import { LicenseBanner } from "./components/system/LicenseBanner";
import AndroidBackupRuntime from "./components/system/AndroidBackupRuntime";
import NotificationsPermissionPrompt from "./components/NotificationsPermissionPrompt";
import { refreshStoreFromLocalDb } from "./services/localDb/bootHydration";

// Recuperación de chunks perezosos: una PWA con caché vieja puede pedir un
// archivo JS que ya no existe en el servidor. Sin esto, la navegación queda en
// una pantalla vacía. Se reintenta el import una vez y, si vuelve a fallar, se
// recarga una sola vez (protegido por sessionStorage) para reconciliar shell y
// chunks. Nunca se recarga sin conexión: ahí el módulo no puede descargarse.
const LAZY_RETRY_RELOAD_KEY = "palmyra-lazy-retry-reload";

function guardedChunkReload() {
  if (typeof window === "undefined") return false;
  if (typeof navigator !== "undefined" && !navigator.onLine) return false;
  try {
    const last = Number(window.sessionStorage.getItem(LAZY_RETRY_RELOAD_KEY) || "0");
    if (last && Date.now() - last < 60000) return false;
    window.sessionStorage.setItem(LAZY_RETRY_RELOAD_KEY, String(Date.now()));
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}

function lazyWithRetry<T extends ComponentType<any>>(factory: () => Promise<{ default: T }>) {
  return lazy(async () => {
    try {
      return await factory();
    } catch (firstError) {
      console.warn("[PALMYRA] Sección no cargada; reintentando una vez…", firstError);
    }
    await new Promise((resolve) => window.setTimeout(resolve, 300));
    try {
      return await factory();
    } catch (retryError) {
      console.error("[PALMYRA] La sección sigue sin cargar tras reintentar.", retryError);
      if (guardedChunkReload()) {
        // Se está recargando: mantener el fallback de Suspense mientras el
        // navegador descarta esta página.
        await new Promise((resolve) => window.setTimeout(resolve, 1500));
      }
      throw retryError;
    }
  });
}

// Code-splitting de rutas para acelerar inicio en tablets y reducir consumo de memoria
const Dashboard = lazyWithRetry(() => import("./pages/Dashboard"));
const POS = lazyWithRetry(() => import("./pages/POS"));
const Inventory = lazyWithRetry(() => import("./pages/Inventory"));
const Returns = lazyWithRetry(() => import("./pages/Returns"));
const Settings = lazyWithRetry(() => import("./pages/Settings"));
const Customers = lazyWithRetry(() => import("./pages/Customers"));
const Quotes = lazyWithRetry(() => import("./pages/Quotes"));
const Transfers = lazyWithRetry(() => import("./pages/Transfers"));
const Reports = lazyWithRetry(() => import("./pages/Reports"));
const SaaSAuth = lazyWithRetry(() => import("./pages/SaaSAuth"));
const AuthConfirm = lazyWithRetry(() => import("./pages/AuthConfirm"));
const SaaSOnboarding = lazyWithRetry(() => import("./pages/SaaSOnboarding"));
const AccountStatus = lazyWithRetry(() => import("./pages/AccountStatus"));
const Subscription = lazyWithRetry(() => import("./pages/Subscription"));
const Team = lazyWithRetry(() => import("./pages/Team"));
const SaaSInvite = lazyWithRetry(() => import("./pages/SaaSInvite"));
const DeviceAccess = lazyWithRetry(() => import("./pages/DeviceAccess"));
const Suppliers = lazyWithRetry(() => import("./pages/Suppliers"));
const InventoryAudit = lazyWithRetry(() => import("./pages/InventoryAudit"));
const Banks = lazyWithRetry(() => import("./pages/Banks"));
const PlatformAdmin = lazyWithRetry(() => import("./pages/PlatformAdmin"));
const HelpCenter = lazyWithRetry(() => import("./pages/HelpCenter"));
const Tutorial = lazyWithRetry(() => import("./pages/Tutorial"));
const ExchangeRate = lazyWithRetry(() => import("./pages/ExchangeRate"));

// La web solo registra, cobra el plan y entrega la descarga. La caja y el resto
// de la operación viven en la app instalada (Windows o APK). `currentAppSurface()`
// distingue esas superficies de la pestaña web y de la PWA, que ya no se ofrece.
// `VITE_ALLOW_WEB_POS=true` sigue siendo el escape temporal para soporte y pruebas.
const APP_SURFACE = currentAppSurface();
const WEB_ALLOW_POS = String(import.meta.env.VITE_ALLOW_WEB_POS || "").toLowerCase() === "true";

function WebOperatingGate({ children }: { children: ReactNode }) {
  const location = useLocation();
  // La suscripción sí debe funcionar en web: es donde se paga y renueva el plan.
  if (location.pathname.startsWith("/subscription")) return <>{children}</>;
  // Solo las apps instaladas (escritorio y APK) y el desarrollo local abren la
  // operación. La PWA dejó de ofrecerse y la pestaña web queda cerrada para
  // todas las cuentas: se instala la app o el APK. No hay enlaces de retorno al
  // software desde la pantalla de bloqueo.
  if (APP_SURFACE === "desktop" || APP_SURFACE === "android-app" || APP_SURFACE === "dev" || WEB_ALLOW_POS) return <>{children}</>;
  return <Navigate to="/download" replace />;
}
function SettingsRoute() {
  const user = useStore(state => state.currentUser);
  const location = useLocation();
  const section = new URLSearchParams(location.search).get('section');
  return canAccessSettingsSection(user, section)
    ? <Settings />
    : <Navigate to={user ? NOTIFICATIONS_PATH : '/pos'} replace />;
}
const LandingPage = lazyWithRetry(() => import("./pages/LandingPage"));

function AuthGateScreen({ onRetry, onUseForm }: { onRetry: () => void; onUseForm: () => void }) {
  return (
    <main className="min-h-[100dvh] bg-[#F7F5FC] flex items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-3xl border border-violet-100 bg-white p-6 text-center shadow-xl">
        <img src="/palmyra-mark-exact.svg" alt="" aria-hidden="true" className="mx-auto h-11 w-11 object-contain" />
        <h1 className="mt-3 text-lg font-black text-[#3B1B78]">Verificando tu sesión</h1>
        <p className="mt-2 text-xs leading-5 text-slate-500" role="status">
          Estamos comprobando si ya tienes una sesión activa. Puedes entrar igualmente; la comprobación termina sola.
        </p>
        <button type="button" onClick={onUseForm} className="mt-4 h-11 w-full rounded-xl bg-[#5B2DBA] text-xs font-black text-white active:scale-[.98]">
          Entrar ahora
        </button>
        <button type="button" onClick={onRetry} className="mt-2 h-10 w-full rounded-xl border border-violet-200 bg-white text-[10px] font-black text-[#5B2DBA] active:scale-[.98]">
          Reintentar verificación
        </button>
        <a href="/landing" className="mt-3 block text-[10px] font-black uppercase tracking-wider text-slate-400">Volver al inicio</a>
      </div>
    </main>
  );
}

function PageLoading() {
  const location = window.location.pathname;
  const labels: Record<string, string> = {
    "/": "Cargando Dashboard…",
    "/pos": "Cargando Punto de Venta…",
    "/inventory": "Cargando Inventario…",
    "/inventory-audit": "Cargando Auditoría de Stock…",
    "/transfers": "Cargando Transferencias…",
    "/customers": "Cargando Clientes…",
    "/suppliers": "Cargando Proveedores…",
    "/banks": "Cargando Cuentas Bancarias…",
    "/returns": "Cargando Devoluciones…",
    "/reports": "Cargando Reportes…",
    "/settings": "Cargando Configuración…",
    "/team": "Cargando equipo…",
    "/help": "Cargando Centro de atención…",
    "/exchange-rate": "Cargando tasa de cambio…",
    "/help-center": "Cargando Centro de atención…",
    "/invite": "Cargando invitación…",
    "/auth": "Cargando acceso…",
    "/auth/confirm": "Confirmando tu cuenta…",
    "/landing": "Cargando PALMYRA…",
  };
  const label = labels[location] || "Cargando sección…";

  return (
    <div className="min-h-[50vh] w-full flex items-center justify-center px-5" aria-live="polite" aria-busy="true">
      <div className="flex w-full max-w-sm flex-col items-center justify-center rounded-2xl border border-violet-100 bg-white p-6 text-center shadow-sm">
        <img src="/palmyra-mark-exact.svg" alt="" aria-hidden="true" className="mb-3 h-10 w-10 object-contain" />
        <div className="palmyra-loading-spinner" aria-hidden="true" />
        <p className="mt-3 text-[10px] font-black uppercase tracking-[.08em] text-[#4C1D95]">{label}</p>
      </div>
    </div>
  );
}

export default function App() {
  const { currentUser, isInitialized, restoreTransactionsFromBackup, currentBranchId } = useStore(useShallow((state) => ({ currentUser: state.currentUser, isInitialized: state.isInitialized, restoreTransactionsFromBackup: state.restoreTransactionsFromBackup, currentBranchId: state.currentBranchId })));
  const [authBootstrapping, setAuthBootstrapping] = useState(true);
  const [accessState, setAccessState] = useState<"loading" | "signed_out" | "needs_onboarding" | "ready" | "blocked" | "recovering">("loading");
  const can = (permission: string) => currentUser?.role === "admin" || currentUser?.permissions?.includes(permission) === true;
  const pendingOnboarding = typeof sessionStorage !== "undefined" && sessionStorage.getItem("palmyra_pending_onboarding") === "1";
  // El enlace de recuperación abre una sesión temporal. Sin esta excepción,
  // la ruta /auth redirigía al sistema antes de mostrar el formulario de
  // nueva contraseña y la recuperación quedaba a medias.
  const recoveringPassword = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("recovery") === "1";
  const [accessError, setAccessError] = useState("");
  // La verificación de sesión (Supabase getSession) puede quedarse bloqueada por
  // el lock de auth. /auth nunca debe esperar indefinidamente: si no hay usuario
  // persistido se abre el formulario de inmediato y, en cualquier caso, a los
  // 4 segundos se libera el acceso manualmente.
  const [authGateOpen, setAuthGateOpen] = useState(false);
  const hydratePromiseRef = useRef<Promise<void> | null>(null);

  // En el APK, confirmar arranque permite que el shell descarte una
  // actualización defectuosa y vuelva a la versión anterior si esta no abre.
  useEffect(() => { confirmNativeBoot(); }, []);

  useEffect(() => {
    if (authGateOpen || accessState !== "loading") return;
    if (!currentUser?.id) {
      setAuthGateOpen(true);
      return;
    }
    const timer = window.setTimeout(() => setAuthGateOpen(true), 4000);
    return () => window.clearTimeout(timer);
  }, [accessState, currentUser?.id, authGateOpen]);

  const hydrateAuth = async () => {
    if (hydratePromiseRef.current) return hydratePromiseRef.current;
    const run = (async () => {
      setAuthBootstrapping(true);
      setAccessError("");
    try {
    let lastError: unknown = null;

    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const ctx = await Promise.race([
          loadSaaSContext(attempt > 0),
          new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error("Tiempo de espera agotado verificando la conexión. Se intentará abrir la sesión local.")), 5000))
        ]);

        if (!ctx) {
          const supabase = getSupabase();
          const { data: userData } = supabase ? await supabase.auth.getUser() : { data: { user: null } };
          if (userData.user) {
            throw new Error("La sesión existe, pero el contexto de PALMYRA todavía no está disponible.");
          }
          useStore.setState({ currentUser: null, currentBranchId: "", activeSessionId: null });
          setAccessState("signed_out");
          return;
        }

        if (!ctx.companyId) {
          clearPalmyraLocalScope();
          void import("./services/offlineQueue").then(({ setOfflineQueueScope }) => setOfflineQueueScope()).catch(() => {});
          useStore.setState({
            currentUser: ctx.user,
            currentBranchId: "",
            activeSessionId: null,
            cart: []
          });
        } else {
          if (typeof sessionStorage !== "undefined") {
            sessionStorage.removeItem("palmyra_pending_onboarding");
          }
          try {
            setPalmyraLocalScope(ctx.authUserId, ctx.companyId);
          } catch (error) {
            console.warn("[PALMYRA] No se pudo guardar el alcance local; continuamos con la sesión cloud.", error);
          }
          // Copia del plan contratado, ligada al alcance empresa/usuario recién
          // validado. Las puertas de funciones (Excel en Inventario y Reportes)
          // la usan cuando más adelante `loadSaaSContext` falla —sesión caducada,
          // backend sin suscripción o arranque offline— y dejaría el botón del
          // cliente con aspecto deshabilitado teniendo el plan pagado.
          storePlanCode(ctx.subscription?.planCode ?? null);
          useStore.setState({
            currentUser: ctx.user,
            currentBranchId: ctx.warehouseIds[0] || "",
          });

          // La entrada al CRM depende solo del contexto seguro de Supabase.
          // Offline/IndexedDB, persistencia y registro del dispositivo son
          // inicialización secundaria y nunca deben bloquear el acceso.
          void (async () => {
            try {
              const { setOfflineQueueScope } = await import("./services/offlineQueue");
              await setOfflineQueueScope();
            } catch (error) {
              console.warn("[PALMYRA] Inicialización de cola offline diferida:", error);
            }
            try {
              await useStore.persist.rehydrate();
              // El contexto cloud es la fuente de verdad para identidad y alcance.
              // La caché local no puede sustituir al usuario/almacén recién validados.
              useStore.setState({
                currentUser: ctx.user,
                currentBranchId: ctx.warehouseIds[0] || "",
              });
            } catch (error) {
              console.warn("[PALMYRA] Rehidratación del estado local diferida:", error);
            }
            if (ctx.warehouseIds[0]) {
              try {
                await registerCurrentDevice(ctx.companyId!, ctx.warehouseIds[0]);
              } catch (error) {
                console.warn("[PALMYRA] Registro de dispositivo diferido:", error);
              }
            }
          })();
        }

        if (!ctx.companyId) {
          setAccessState(ctx.membershipStatus && ctx.membershipStatus !== "active" ? "blocked" : "needs_onboarding");
        } else if (ctx.company?.account_status === "pending_payment" || ctx.company?.account_status === "suspended") {
          setAccessState("blocked");
        } else {
          setAccessState("ready");
        }
        return;
      } catch (error) {
        lastError = error;
        console.warn(`[PALMYRA] Fallo de hidratación (${attempt + 1}/4):`, error);

        // El indicador navigator.onLine no es fiable: Android puede informar
        // conexión aunque el router no tenga salida a Internet. Si la sesión
        // cloud tarda o falla, abrir el último contexto SaaS verificado y
        // mantener la operación local; la sincronización se reanudará online.
        const localScope = getPalmyraLocalScope();
        const cachedContext = localScope?.userId ? getCachedSaaSContext(localScope.userId) : null;
        if (cachedContext?.companyId && cachedContext.warehouseIds?.[0]) {
          try {
            await useStore.persist.rehydrate();
            useStore.setState({
              currentUser: cachedContext.user,
              currentBranchId: cachedContext.warehouseIds[0],
            });
            setAccessState("ready");
            console.info("[PALMYRA] Sesión local verificada: se abrió el espacio offline.");
            return;
          } catch (cacheError) {
            console.warn("[PALMYRA] No se pudo hidratar el espacio local cacheado:", cacheError);
          }
        }
        if (attempt < 3) {
          await new Promise((resolve) => window.setTimeout(resolve, 350 * (attempt + 1)));
        }
      }
    }

    // Una PWA instalada debe poder abrir el último espacio válido aunque
    // el teléfono arranque sin conexión. La identidad/alcance local se usan
    // únicamente para continuidad offline; al volver la conexión, el contexto
    // seguro de Supabase vuelve a ser la fuente de verdad.
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      try {
        await useStore.persist.rehydrate();
        const localState = useStore.getState();
        if (localState.currentUser?.id && localState.currentBranchId && localState.branches?.some(b => b.id === localState.currentBranchId)) {
          setAccessState("ready");
          return;
        }
      } catch (offlineError) {
        console.warn("[PALMYRA] No se pudo recuperar la sesión local para arranque offline:", offlineError);
      }
    }

    // Si Auth sigue siendo válida, nunca enviamos al usuario al Landing por un
    // fallo transitorio de contexto. Mostramos recuperación y permitimos reintentar.
    const supabase = getSupabase();
    const { data: userData } = supabase ? await supabase.auth.getUser() : { data: { user: null } };
    if (userData.user) {
      console.error("[PALMYRA] Contexto no disponible después de varios intentos:", lastError);
      setAccessError(lastError instanceof Error ? lastError.message : "No se pudo verificar la empresa, el almacén o los permisos.");
      setAccessState("recovering");
      return;
    }

    clearPalmyraLocalScope();
    void import("./services/offlineQueue").then(({ setOfflineQueueScope }) => setOfflineQueueScope()).catch(() => {});
    useStore.setState({ currentUser: null, currentBranchId: "", activeSessionId: null });
    setAccessState("signed_out");
    } finally {
      // La hidratación no puede bloquear la interfaz indefinidamente.
      // Tanto si hay sesión válida como si no, liberamos el boot de Auth.
      setAuthBootstrapping(false);
    }
    })();
    hydratePromiseRef.current = run;
    try {
      await run;
    } finally {
      if (hydratePromiseRef.current === run) hydratePromiseRef.current = null;
    }
  };
  useEffect(() => {
    let active = true;
    const boot = async () => {
      if (!active) return;
      await hydrateAuth();
    };
    void boot();

    const supabase = getSupabase();
    if (!supabase) return () => { active = false; };

    const { data: authSubscription } = supabase.auth.onAuthStateChange((event) => {
      if (!active) return;
      if (event === "SIGNED_OUT") {
        // Un cierre de sesión intencional borra la caché antes de emitir el
        // evento (signOutSaaSAccount). Si el contexto verificado sigue ahí y el
        // equipo está sin conexión, este SIGNED_OUT viene de una renovación de
        // token fallida: conservar el espacio local evita expulsar al usuario
        // y arriesgar operaciones en curso.
        const localScope = getPalmyraLocalScope();
        const cachedContext = localScope?.userId ? getCachedSaaSContext(localScope.userId) : null;
        if (typeof navigator !== "undefined" && !navigator.onLine && cachedContext?.companyId && cachedContext.warehouseIds?.[0]) {
          console.info("[PALMYRA] SIGNED_OUT sin conexión; se conserva la sesión local verificada.");
          useStore.setState({
            currentUser: cachedContext.user,
            currentBranchId: cachedContext.warehouseIds[0],
          });
          useStore.getState().addNotification?.(
            "Sin conexión: sigues trabajando con la sesión local verificada. Al reconectar se validará tu acceso.",
            "warning",
          );
          setAccessState("ready");
          return;
        }
        clearPalmyraLocalScope();
        void import("./services/offlineQueue").then(({ setOfflineQueueScope }) => setOfflineQueueScope()).catch(() => {});
        useStore.setState({ currentUser: null, currentBranchId: "", activeSessionId: null, cart: [] });
        setAccessState("signed_out");
        return;
      }
      if (event === "SIGNED_IN" || event === "TOKEN_REFRESHED" || event === "USER_UPDATED") {
        window.setTimeout(() => { void hydrateAuth(); }, 0);
      }
    });

    return () => {
      active = false;
      authSubscription.subscription.unsubscribe();
    };
  }, []);


  useEffect(() => {
    // Si existe una sesión local válida, abre inmediatamente la interfaz
    // cacheada mientras la identidad cloud se verifica en segundo plano.
    // Evita la pantalla blanca/loader de arranque en dispositivos lentos.
    if (isInitialized && currentUser?.id && currentBranchId && accessState === "loading") {
      setAccessState("ready");
    }
  }, [isInitialized, currentUser?.id, currentBranchId, accessState]);

  useEffect(() => {
    if (!isInitialized) return;
    let active = true;

    const recoverOfflineSales = async () => {
      try {
        const { getOfflineQueue, waitForOfflineQueueReady } = await import("./services/offlineQueue");
        await waitForOfflineQueueReady();
        if (!active) return;

        const queue = getOfflineQueue();
        const voidIds = new Set(
          queue
            .filter(item => item.type === 'void_transaction' && item.status !== 'conflict')
            .map(item => String(item.data?.id || item.actionId))
        );
        const pendingSales = queue
          .filter(item =>
            item.type === 'transaction' &&
            item.status !== 'conflict' &&
            item.data?.id &&
            !voidIds.has(String(item.data.id))
          )
          .map(item => item.data)
          .filter(Boolean);

        if (pendingSales.length > 0) {
          useStore.setState(state => {
            const existingIds = new Set((state.transactions || []).map(tx => String(tx.id)));
            const missing = pendingSales.filter(tx => !existingIds.has(String(tx.id)));
            return missing.length
              ? { transactions: [...missing, ...(state.transactions || [])] }
              : state;
          });
          await flushLocalStateStorage();
        }

        // Mantener también la recuperación legacy ya existente.
        if (active) restoreTransactionsFromBackup();
      } catch (error) {
        console.warn("[App] No se pudieron recuperar ventas pendientes del outbox offline:", error);
        if (active) restoreTransactionsFromBackup();
      }
    };

    void recoverOfflineSales();
    return () => { active = false; };
  }, [isInitialized, restoreTransactionsFromBackup]);

  useEffect(() => {
    return initKeyboardViewport();
  }, []);

  useEffect(() => {
    if (accessState !== "ready" || !currentUser) return;
    // Precalentar las dos rutas principales para que el primer salto al CRM
    // no dependa de una descarga perezosa justo después del login/onboarding.
    // En equipos de gama muy baja no se precarga nada: cada kB cuenta.
    if (getDevicePerformanceTier() === "ultra") return;

    return scheduleIdleTask(() => {
      void import("./pages/POS");
      void import("./pages/Dashboard");
    }, 700, 1600);
  }, [currentUser?.id, accessState]);

  useEffect(() => {
    if (accessState !== "ready" || !currentUser) return;
    let cancelled = false;
    let lastCheckAt = 0;

    // Revalidar sesión y dispositivo cada 12 h, al volver a la app o al
    // recuperar internet. Antes era cada 2 min: con varias cajas abiertas eso
    // agotaba el rate limit de Supabase Auth sin aportar seguridad real.
    const verifySession = async (force = false) => {
      if (cancelled) return;
      if (document.visibilityState !== "visible") return;
      if (typeof navigator !== "undefined" && !navigator.onLine) return;
      const now = Date.now();
      if (!force && now - lastCheckAt < 15 * 60 * 1000) return;
      lastCheckAt = now;
      try {
        const ctx = await loadSaaSContext(true);
        if (cancelled || !ctx?.companyId) return;
        const active = await touchCurrentDevice(ctx.companyId);
        if (!active) {
          await signOutSaaSAccount();
        }
      } catch (error) {
        console.warn("[PALMYRA] Device heartbeat failed:", error);
      }
    };

    const timer = window.setInterval(() => { void verifySession(); }, 12 * 60 * 60 * 1000);
    const onFocus = () => { void verifySession(); };
    const onOnline = () => { void verifySession(true); };
    window.addEventListener("focus", onFocus);
    window.addEventListener("online", onOnline);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("online", onOnline);
    };
  }, [currentUser?.id, accessState]);

  useEffect(() => {
    if (accessState !== "ready" || !currentUser) return;

    // El login activa los motores. El replay offline es un módulo pesado y se
    // carga solo después de autenticar, mientras que la cola durable ligera ya
    // está disponible para el store desde el arranque.
    let active = true;
    let cleanupOfflineWatcher = () => {};

    import("./services/offlineSync")
      .then(({ initOfflineSyncWatcher }) => {
        if (active) cleanupOfflineWatcher = initOfflineSyncWatcher();
      })
      .catch((error) => {
        console.error("[App] No se pudo cargar el motor de sincronización offline:", error);
      });

    const cleanupRealtimeSync = initMultiDeviceRealtimeSync();
    return () => {
      active = false;
      cleanupOfflineWatcher();
      cleanupRealtimeSync();
    };
  }, [currentUser?.id, currentBranchId, accessState]);

  // Red local: si este equipo quedó vinculado a un hub LAN, replica su journal
  // mientras haya sesión iniciada. El bucle observa la sesión del hub por
  // dentro (emparejar/desvincular desde Configuración) y se detiene aquí al
  // cerrar sesión, sin dejar stream ni temporizadores vivos.
  useEffect(() => {
    if (accessState !== "ready" || !currentUser?.id) return;
    let active = true;
    let stop: (() => void) | null = null;
    void (async () => {
      try {
        const { LAN_HUB_ENABLED } = await import("./services/lanHub/protocol");
        // Producto solo Wi-Fi/cloud: el hub LAN queda apagado y no se abre el bucle.
        if (!LAN_HUB_ENABLED) return;
        const { startHubClientLoop } = await import("./services/lanHub/clientLoop");
        if (!active) return;
        const handle = startHubClientLoop({
          onChanges: (result) => {
            if (result.applied === 0 && result.deleted === 0) return;
            console.info(
              `[PALMYRA] Hub LAN (${result.source}): ${result.applied} altas, ` +
                `${result.deleted} bajas, cursor ${result.cursor}.`
            );
            // El bucle ya escribió en el almacén normalizado; la UI sigue
            // leyendo el JSON legado, así que se proyecta el diff a la store
            // (con debounce interno: varias páginas = un solo render). Las
            // bajas también cuentan: el puente solo borra lápidas explícitas.
            if (result.applied + result.deleted > 0) {
              const companyId = getPalmyraLocalScope()?.companyId;
              if (companyId) {
                void refreshStoreFromLocalDb(companyId, { reason: "hub-lan" });
              }
            }
          }
        });
        stop = () => handle.stop();
      } catch (error) {
        console.warn("[PALMYRA] No se pudo iniciar el bucle del hub LAN:", error);
      }
    })();
    return () => {
      active = false;
      stop?.();
    };
  }, [currentUser?.id, accessState]);

  // Al volver a primer plano se proyecta una vez lo que el hub haya podido
  // dejar en el almacén con la pestaña en segundo plano (el canal SSE puede
  // haberse pausado y el refresco tiene debounce propio).
  useEffect(() => {
    if (accessState !== "ready" || !currentUser?.id) return;
    const onVisibility = () => {
      if (typeof document === "undefined" || document.visibilityState !== "visible") return;
      const companyId = getPalmyraLocalScope()?.companyId;
      if (companyId) void refreshStoreFromLocalDb(companyId, { reason: "visibilidad" });
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [currentUser?.id, accessState]);

  // La landing es pública: debe abrir aunque la verificación de sesión siga en
  // curso. Sin esto, quien no ha iniciado sesión veía el login (o un loader)
  // antes de poder evaluar el producto y descargar las apps.
  // La pantalla de descarga tampoco debe esperar la verificación de sesión: es
  // la salida de todo acceso web y no necesita datos del usuario para pintarse.
  const isLandingPath = typeof window !== "undefined" && /^\/(landing|download)\/?$/i.test(window.location.pathname);
  // El flujo de acceso (/auth y /auth/confirm) es público por definición. Ni el
  // splash de arranque ni la tarjeta de "recovering" deben taparlo: si la
  // verificación de sesión se cuelga, el usuario quedaría viendo un loader
  // infinito después de pulsar «Entrar» o «Crear cuenta».
  const isAuthFlowPath = typeof window !== "undefined" && /^\/auth(\/confirm)?\/?$/i.test(window.location.pathname);
  const authRouteOpen =
    recoveringPassword ||
    accessState === "signed_out" ||
    accessState === "recovering" ||
    (accessState === "loading" && authGateOpen);

  const earlyLanding = (
    <ErrorBoundary>
      <Router>
        <Suspense fallback={<PageLoading />}>
          {/* Shell público: mientras la verificación de sesión está en curso, el
              landing debe poder navegar a /auth sin depender de que App vuelva a
              renderizarse (App está por encima del Router). */}
          <Routes>
            <Route path="/landing" element={<LandingPage signedIn={Boolean(currentUser?.id)} />} />
            <Route path="/download" element={<InstallRequired />} />
            <Route path="/auth" element={<SaaSAuth />} />
            <Route path="/auth/confirm" element={<AuthConfirm />} />
            <Route path="*" element={<Navigate to="/landing" replace />} />
          </Routes>
        </Suspense>
        {/* El aviso de actualización también debe verse sin sesión. */}
        <PublicUpdateBanner signedIn={Boolean(currentUser?.id)} />
      </Router>
    </ErrorBoundary>
  );
  if (isLandingPath && accessState !== "ready") {
    return earlyLanding;
  }

  if (accessState === "recovering" && !isAuthFlowPath) {
    return (
      <div className="min-h-screen bg-[#F7F5FC] flex items-center justify-center p-5">
        <div className="w-full max-w-md rounded-3xl border border-violet-100 bg-white p-7 text-center shadow-xl">
          <img src="/palmyra-mark-exact.svg" alt="" aria-hidden="true" className="mx-auto h-12 w-12 object-contain" />
          <h1 className="mt-4 text-lg font-black text-[#3B1B6E]">Estamos preparando tu espacio</h1>
          <p className="mt-2 text-xs leading-5 text-slate-500">Tu sesión sigue activa. PALMYRA está verificando empresa, almacén y permisos antes de abrir el sistema.</p>
          {accessError ? <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-[10px] font-semibold leading-4 text-amber-700">{accessError}</p> : null}
          <button type="button" onClick={() => void hydrateAuth()} className="mt-5 h-10 rounded-xl bg-[#6535C5] px-5 text-[10px] font-black text-white">Reintentar</button>
        </div>
      </div>
    );
  }
  if (!isAuthFlowPath && (!isInitialized || (authBootstrapping && !currentUser?.id))) {
    return (
      <div className="min-h-screen bg-[#F7F5FC] flex items-center justify-center">
        <div className="palmyra-loading-bubble">Preparando PALMYRA… <span className="palmyra-loading-dots">•••</span></div>
      </div>
    );
  }

  // Con un usuario persistido, el router se monta antes de que la verificación
  // cloud termine. Redirigir en "loading" destruía los enlaces profundos
  // (p. ej. /pos o /reports abrían siempre el dashboard): esperamos aquí.
  if (!isAuthFlowPath && accessState === "loading") {
    return (
      <div className="min-h-screen bg-[#F7F5FC] flex items-center justify-center">
        <div className="palmyra-loading-bubble">Preparando PALMYRA… <span className="palmyra-loading-dots">•••</span></div>
      </div>
    );
  }

  return (
    <ErrorBoundary>
      <Router>
        <Suspense fallback={<PageLoading />}>
          <Routes>
          <Route path="/landing" element={<LandingPage signedIn={Boolean(currentUser?.id)} />} />
          <Route path="/download" element={<InstallRequired />} />
          <Route path="/platform-admin" element={<PlatformAdmin />} />
          <Route path="/security" element={<Navigate to="/help-center?section=security" replace />} />
          <Route path="/invite" element={<SaaSInvite />} />
          <Route path="/device-access" element={<DeviceAccess />} />
          <Route path="/auth/confirm" element={<AuthConfirm />} />
          <Route path="/auth" element={
            authRouteOpen
              ? <SaaSAuth />
              : accessState === "loading"
                // Solo se llega aquí con un usuario persistido y la verificación
                // aún en curso. Es una espera acotada (4 s) con salida manual,
                // nunca un splash sin fin.
                ? <AuthGateScreen onRetry={() => void hydrateAuth()} onUseForm={() => setAuthGateOpen(true)} />
                : <Navigate to={accessState === "needs_onboarding" || pendingOnboarding ? "/onboarding" : accessState === "blocked" ? "/account-status" : "/"} replace />
          } />
          <Route path="/onboarding" element={(accessState === "needs_onboarding" || pendingOnboarding) ? <SaaSOnboarding /> : <Navigate to={accessState === "signed_out" ? "/auth" : accessState === "blocked" ? "/account-status" : "/"} replace />} />
          <Route path="/account-status" element={accessState === "blocked" ? <AccountStatus /> : <Navigate to={accessState === "signed_out" ? "/auth" : accessState === "needs_onboarding" ? "/onboarding" : "/"} replace />} />
          <Route path="/*" element={
            accessState === "ready" && currentUser ? (
              <WebOperatingGate>
              <Layout>
                {/* Aislamiento por sección: un fallo de render de una página
                    muestra una tarjeta recuperable y no desmonta la navegación. */}
                <ErrorBoundary variant="content">
                <Suspense fallback={<PageLoading />}>
                  <Routes>
                    <Route path="/" element={can("reports.view") ? <Dashboard /> : <Navigate to="/pos" replace />} />
                    <Route path="/pos" element={<POS />} />
                    <Route path="/transfers" element={can("inventory.manage") ? <Transfers /> : <Navigate to="/pos" replace />} />
                    <Route path="/inventory" element={can("inventory.manage") ? <Inventory /> : <Navigate to="/pos" replace />} />
                    <Route path="/inventory-audit" element={can("inventory.manage") ? <InventoryAudit /> : <Navigate to="/pos" replace />} />
                    <Route path="/suppliers" element={can("suppliers.manage") ? <Suppliers /> : <Navigate to="/pos" replace />} />
                    <Route path="/banks" element={can("settings.manage") ? <Banks /> : <Navigate to="/pos" replace />} />
                    <Route path="/returns" element={can("pos.access") ? <Returns /> : <Navigate to="/pos" replace />} />
                    <Route path="/customers" element={can("customers.manage") ? <Customers /> : <Navigate to="/pos" replace />} />
<Route path="/quotes" element={can("pos.access") ? <Quotes /> : <Navigate to="/pos" replace />} />
                    <Route path="/reports" element={can("reports.view") ? <Reports /> : <Navigate to="/pos" replace />} />
                    <Route path="/settings" element={<SettingsRoute />} />
                    <Route path="/team" element={can("employees.manage") ? <Team /> : <Navigate to="/pos" replace />} />
                    <Route path="/subscription" element={can("settings.manage") ? <Subscription /> : <Navigate to="/pos" replace />} />
                    <Route path="/help" element={<Navigate to="/help-center" replace />} />
                    <Route path="/help-center" element={<HelpCenter />} />
                    <Route path="/tutorial" element={<Tutorial />} />
                    <Route path="/exchange-rate" element={<ExchangeRate />} />
                    <Route path="/notifications" element={<Navigate to={NOTIFICATIONS_PATH} replace />} />
                    <Route path="*" element={<Navigate to="/" replace />} />
                  </Routes>
                </Suspense>
                </ErrorBoundary>
              </Layout>
              {/* Respaldo periódico en la tablet: se monta una sola vez y no
                  pinta nada; en APK crea el respaldo cada 24 h. */}
              <AndroidBackupRuntime />
              {/* Aviso discreto de licencia (gracia, vencimiento próximo, reloj).
                  El de solo lectura vive en Layout; aquí no se duplica. */}
              <LicenseBanner />
              {/* Permiso de notificaciones al entrar: tarjeta descartable que nunca
                  bloquea la app y no se repite si ya fue denegado o descartado. */}
              <NotificationsPermissionPrompt />
              </WebOperatingGate>
            ) : (
              <Navigate to={accessState === "signed_out" || !currentUser ? "/landing" : accessState === "needs_onboarding" || pendingOnboarding ? "/onboarding" : accessState === "blocked" ? "/account-status" : "/landing"} replace />
            )
          } />
        </Routes>
        </Suspense>
        {/* Visible en landing/auth; se oculta solo cuando Layout ya lo muestra. */}
        <PublicUpdateBanner signedIn={Boolean(currentUser?.id)} />
      </Router>
    </ErrorBoundary>
  );
}
