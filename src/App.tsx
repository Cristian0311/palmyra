import { useShallow } from 'zustand/react/shallow';
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState, lazy, Suspense } from "react";
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
const SaaSOnboarding = lazy(() => import("./pages/SaaSOnboarding"));
const AccountStatus = lazy(() => import("./pages/AccountStatus"));
const Subscription = lazy(() => import("./pages/Subscription"));
const Team = lazy(() => import("./pages/Team"));
const SaaSInvite = lazy(() => import("./pages/SaaSInvite"));
const Suppliers = lazy(() => import("./pages/Suppliers"));
const InventoryAudit = lazy(() => import("./pages/InventoryAudit"));
const Banks = lazy(() => import("./pages/Banks"));
const PlatformAdmin = lazy(() => import("./pages/PlatformAdmin"));

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
    <div className="flex-1 min-h-[50vh] relative" aria-live="polite" aria-busy="true">
      <div className="absolute inset-0 z-[60] flex items-center justify-center pointer-events-none px-4">
        <div className="palmyra-loading-bubble">
          <span className="palmyra-loading-icon" aria-hidden="true">
            <span className="palmyra-loading-spinner" />
          </span>
          <span className="min-w-0">{label}</span>
          <span className="palmyra-loading-dots" aria-hidden="true">•••</span>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const { currentUser, isInitialized, restoreTransactionsFromBackup, currentBranchId } = useStore(useShallow((state) => ({ currentUser: state.currentUser, isInitialized: state.isInitialized, restoreTransactionsFromBackup: state.restoreTransactionsFromBackup, currentBranchId: state.currentBranchId })));
  const [authBootstrapping, setAuthBootstrapping] = useState(true);
  const [accessState, setAccessState] = useState<"loading" | "signed_out" | "needs_onboarding" | "ready" | "blocked">("loading");
  const can = (permission: string) => currentUser?.role === "admin" || currentUser?.permissions?.includes(permission) === true;

  const hydrateAuth = async () => {
    setAuthBootstrapping(true);
    try {
      const ctx = await loadSaaSContext();
      if (!ctx) {
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
        setPalmyraLocalScope(ctx.authUserId, ctx.companyId);
        const { setOfflineQueueScope } = await import("./services/offlineQueue");
        await setOfflineQueueScope();
        useStore.setState({
          currentUser: ctx.user,
          currentBranchId: ctx.warehouseIds[0] || "",
        });
        await useStore.persist.rehydrate();
        if (ctx.warehouseIds[0]) {
          registerCurrentDevice(ctx.companyId, ctx.warehouseIds[0]).catch(error => {
            console.warn("[PALMYRA] No se pudo registrar el dispositivo:", error);
          });
        }
      }

      if (!ctx.companyId) {
        setAccessState(ctx.membershipStatus && ctx.membershipStatus !== "active" ? "blocked" : "needs_onboarding");
      } else if (!ctx.deviceActive) {
        setAccessState("blocked");
      } else if (ctx.company?.account_status === "pending_payment" || ctx.company?.account_status === "suspended") {
        setAccessState("blocked");
      } else {
        setAccessState("ready");
      }
    } catch {
      clearPalmyraLocalScope();
      void import("./services/offlineQueue").then(({ setOfflineQueueScope }) => setOfflineQueueScope()).catch(() => {});
      useStore.setState({ currentUser: null, currentBranchId: "", activeSessionId: null });
      setAccessState("signed_out");
    } finally {
      setAuthBootstrapping(false);
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
    // Precalentar solo la ruta POS en dispositivos que no estén en el perfil
    // de 2 GB. En ultra se evita consumir memoria antes de necesitar el POS.
    return scheduleIdleTask(() => {
      void import("./pages/POS");
    }, 1200, 1600);
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
          <Route path="/platform-admin" element={<PlatformAdmin />} />
          <Route path="/invite" element={<SaaSInvite />} />
          <Route path="/auth" element={accessState === "signed_out" ? <SaaSAuth /> : <Navigate to={accessState === "needs_onboarding" ? "/onboarding" : accessState === "blocked" ? "/account-status" : "/"} replace />} />
          <Route path="/onboarding" element={accessState === "needs_onboarding" ? <SaaSOnboarding /> : <Navigate to={accessState === "signed_out" ? "/auth" : accessState === "blocked" ? "/account-status" : "/"} replace />} />
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
              <Navigate to={accessState === "signed_out" ? "/auth" : accessState === "needs_onboarding" ? "/onboarding" : accessState === "blocked" ? "/account-status" : "/auth"} replace />
            )
          } />
        </Routes>
        </Suspense>
      </Router>
    </ErrorBoundary>
  );
}
