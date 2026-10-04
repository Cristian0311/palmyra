import { useShallow } from 'zustand/react/shallow';
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState, useRef, lazy, Suspense } from "react";
import { BrowserRouter as Router, Routes, Route, Navigate } from "react-router-dom";
import Layout from "./components/Layout";
import { loadSaaSContext } from "./services/saas";
import { getSupabase } from "./lib/supabase";
import { useStore } from "./store/useStore";
import { initMultiDeviceRealtimeSync } from "./services/realtimeSync";
import { initKeyboardViewport } from "./services/keyboardViewport";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { getDevicePerformanceTier, scheduleIdleTask } from "./utils/devicePerformance";
import { flushLocalStateStorage } from "./services/localStateStorage";
import { setPalmyraLocalScope, clearPalmyraLocalScope } from "./services/localScope";
import { registerCurrentDevice } from "./services/device";
import { touchCurrentDevice } from "./services/security";

// Code-splitting de rutas para acelerar inicio en tablets y reducir consumo de memoria
const Dashboard = lazy(() => import("./pages/Dashboard"));
const POS = lazy(() => import("./pages/POS"));
const Inventory = lazy(() => import("./pages/Inventory"));
const Returns = lazy(() => import("./pages/Returns"));
const Settings = lazy(() => import("./pages/Settings"));
const Customers = lazy(() => import("./pages/Customers"));
const Transfers = lazy(() => import("./pages/Transfers"));
const Reports = lazy(() => import("./pages/Reports"));
const SaaSAuth = lazy(() => import("./pages/SaaSAuth"));
const AuthConfirm = lazy(() => import("./pages/AuthConfirm"));
const SaaSOnboarding = lazy(() => import("./pages/SaaSOnboarding"));
const AccountStatus = lazy(() => import("./pages/AccountStatus"));
const Subscription = lazy(() => import("./pages/Subscription"));
const Team = lazy(() => import("./pages/Team"));
const SaaSInvite = lazy(() => import("./pages/SaaSInvite"));
const Suppliers = lazy(() => import("./pages/Suppliers"));
const InventoryAudit = lazy(() => import("./pages/InventoryAudit"));
const Banks = lazy(() => import("./pages/Banks"));
const PlatformAdmin = lazy(() => import("./pages/PlatformAdmin"));
const Security = lazy(() => import("./pages/Security"));
const LandingPage = lazy(() => import("./pages/LandingPage"));

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
    "/invite": "Cargando invitación…",
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
  const hydratePromiseRef = useRef<Promise<void> | null>(null);

  const hydrateAuth = async () => {
    if (hydratePromiseRef.current) return hydratePromiseRef.current;
    const run = (async () => {
      setAuthBootstrapping(true);
    try {
    let lastError: unknown = null;

    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const ctx = await loadSaaSContext(attempt > 0);

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
        if (attempt < 3) {
          await new Promise((resolve) => window.setTimeout(resolve, 350 * (attempt + 1)));
        }
      }
    }

    // Si Auth sigue siendo válida, nunca enviamos al usuario al Landing por un
    // fallo transitorio de contexto. Mostramos recuperación y permitimos reintentar.
    const supabase = getSupabase();
    const { data: userData } = supabase ? await supabase.auth.getUser() : { data: { user: null } };
    if (userData.user) {
      console.error("[PALMYRA] Contexto no disponible después de varios intentos:", lastError);
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
    if (accessState !== "ready" || !currentUser || getDevicePerformanceTier() === "ultra") return;
    // Precalentar las dos rutas principales para que el primer salto al CRM
    // no dependa de una descarga perezosa justo después del login/onboarding.
    if (getDevicePerformanceTier() !== "ultra") {
      return scheduleIdleTask(() => {
        void import("./pages/POS");
        void import("./pages/Dashboard");
      }, 700, 1600);
    }

    return scheduleIdleTask(() => {
      void import("./pages/POS");
    }, 1200, 1600);
  }, [currentUser?.id, accessState]);

  useEffect(() => {
    if (accessState !== "ready" || !currentUser) return;
    let cancelled = false;
    const heartbeat = async () => {
      try {
        const ctx = await loadSaaSContext(true);
        if (cancelled || !ctx?.companyId) return;
        const active = await touchCurrentDevice(ctx.companyId);
        if (!active) {
          await getSupabase()?.auth.signOut();
          return;
        }
      } catch (error) {
        console.warn("[PALMYRA] Device heartbeat failed:", error);
      }
    };
    const timer = window.setInterval(heartbeat, 120000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
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

  if (accessState === "recovering") {
    return (
      <div className="min-h-screen bg-[#F7F5FC] flex items-center justify-center p-5">
        <div className="w-full max-w-md rounded-3xl border border-violet-100 bg-white p-7 text-center shadow-xl">
          <img src="/palmyra-mark-exact.svg" alt="" aria-hidden="true" className="mx-auto h-12 w-12 object-contain" />
          <h1 className="mt-4 text-lg font-black text-[#3B1B6E]">Estamos preparando tu espacio</h1>
          <p className="mt-2 text-xs leading-5 text-slate-500">Tu sesión sigue activa. PALMYRA está verificando empresa, almacén y permisos antes de abrir el sistema.</p>
          <button type="button" onClick={() => void hydrateAuth()} className="mt-5 h-10 rounded-xl bg-[#6535C5] px-5 text-[10px] font-black text-white">Reintentar</button>
        </div>
      </div>
    );
  }
  if (!isInitialized || authBootstrapping) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-rose-500"></div>
      </div>
    );
  }

  return (
    <ErrorBoundary>
      <Router>
        <Suspense fallback={<PageLoading />}>
          <Routes>
          <Route path="/landing" element={<LandingPage />} />
          <Route path="/platform-admin" element={<PlatformAdmin />} />
          <Route path="/security" element={<Security />} />
          <Route path="/invite" element={<SaaSInvite />} />
          <Route path="/auth/confirm" element={<AuthConfirm />} />
          <Route path="/auth" element={accessState === "signed_out" ? <SaaSAuth /> : <Navigate to={accessState === "needs_onboarding" || pendingOnboarding ? "/onboarding" : accessState === "blocked" ? "/account-status" : "/"} replace />} />
          <Route path="/onboarding" element={(accessState === "needs_onboarding" || pendingOnboarding) ? <SaaSOnboarding /> : <Navigate to={accessState === "signed_out" ? "/auth" : accessState === "blocked" ? "/account-status" : "/"} replace />} />
          <Route path="/account-status" element={accessState === "blocked" ? <AccountStatus /> : <Navigate to={accessState === "signed_out" ? "/auth" : accessState === "needs_onboarding" ? "/onboarding" : "/"} replace />} />
          <Route path="/*" element={
            accessState === "ready" && currentUser ? (
              <Layout>
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
                    <Route path="/reports" element={can("reports.view") ? <Reports /> : <Navigate to="/pos" replace />} />
                    <Route path="/settings" element={can("settings.manage") ? <Settings /> : <Navigate to="/pos" replace />} />
                    <Route path="/team" element={can("employees.manage") ? <Team /> : <Navigate to="/pos" replace />} />
                    <Route path="/subscription" element={can("settings.manage") ? <Subscription /> : <Navigate to="/pos" replace />} />
                    <Route path="*" element={<Navigate to="/" replace />} />
                  </Routes>
                </Suspense>
              </Layout>
            ) : (
              <Navigate to={accessState === "signed_out" ? "/landing" : accessState === "needs_onboarding" || pendingOnboarding ? "/onboarding" : accessState === "blocked" ? "/account-status" : "/auth"} replace />
            )
          } />
        </Routes>
        </Suspense>
      </Router>
    </ErrorBoundary>
  );
}
