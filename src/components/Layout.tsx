import { useShallow } from 'zustand/react/shallow';
import { NavLink, useLocation } from "react-router-dom";
import {
  LayoutDashboard,
  ShoppingCart,
  Package,
  Users, ShieldCheck,
  Store,
  Settings,
  Menu,
  RotateCcw,
  Calculator,
  ArrowLeftRight,
  BarChart,
  UserCircle,
  LogOut,
  Truck,
  ClipboardCheck,
  Wifi,
  WifiOff,
  CloudOff,
  CreditCard,
  FileText,
  Clock,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  Headphones,
  Download,
  Smartphone,
  BookOpen,
  ArrowDownUp
} from "lucide-react";
import React, { useState, useEffect, useRef } from "react";
import { cn } from "../lib/utils";
import { loadSaaSContext } from "../services/saas";
import { useStore } from "../store/useStore";
import { getOfflineQueueCount, getOfflineQueue, waitForOfflineQueueReady } from "../services/offlineQueue";
import { canUsePlanFeature, getPlanVisual, type PlanFeature } from "../services/planAccess";
import { 
  CheckCircle2, 
  AlertTriangle, 
  X, 
  Info, 
  AlertCircle 
} from "lucide-react";

const adminNavItems = [
  { name: "Dashboard", href: "/", icon: LayoutDashboard, permission: "reports.view" },
  { name: "POS", href: "/pos", icon: ShoppingCart, permission: "pos.access" },
  { name: "Transferencias", href: "/transfers", icon: ArrowLeftRight, permission: "inventory.manage", requiredFeature: "transfers" as PlanFeature },
  { name: "Clientes", href: "/customers", icon: UserCircle, permission: "customers.manage", requiredFeature: "customers_suppliers" as PlanFeature },
  { name: "Inventario", href: "/inventory", icon: Package, permission: "inventory.manage" },
  { name: "Auditoría", href: "/inventory-audit", icon: ClipboardCheck, permission: "inventory.manage", requiredFeature: "inventory_audit" as PlanFeature },
  { name: "Proveedores", href: "/suppliers", icon: Truck, permission: "suppliers.manage", requiredFeature: "customers_suppliers" as PlanFeature },
  { name: "Bancos", href: "/banks", icon: CreditCard, permission: "settings.manage", requiredFeature: "banking" as PlanFeature },
  { name: "Garantías y devoluciones", href: "/returns", icon: RotateCcw, permission: "pos.access", requiredFeature: "warranty_returns" as PlanFeature },
  { name: "Reportes", href: "/reports", icon: BarChart, permission: "reports.view" },
  { name: "Configuración", href: "/settings", icon: Settings, permission: "settings.manage" },
  { name: "Equipo", href: "/team", icon: Users, permission: "employees.manage" },
  { name: "Soporte", href: "/help", icon: Headphones, public: true },
  { name: "Plan", href: "/subscription", icon: CreditCard, permission: "settings.manage" },
  { name: "Tasa de cambio", href: "/exchange-rate", icon: ArrowDownUp, public: true },
  { name: "Tutorial", href: "/tutorial", icon: BookOpen, public: true },
  { name: "Catálogo Online", href: "#online-catalog", icon: Store, public: true, comingSoon: true },
];

const APP_VERSION = "PALMYRA";
const cashierNavItems = [
  { name: "Soporte", href: "/help", icon: Headphones, public: true },
  { name: "POS", href: "/pos", icon: ShoppingCart },
];

function getPlanCountdown(target: string | null | undefined, nowMs: number) {
  if (!target) return null;
  const targetMs = new Date(target).getTime();
  const diff = targetMs - nowMs;
  if (!Number.isFinite(targetMs) || !Number.isFinite(diff)) return null;
  if (diff <= 0) return { totalDays: 0, hours: 0, minutes: 0, expired: true };

  const totalMinutes = Math.floor(diff / 60000);
  const minutes = totalMinutes % 60;
  const totalHours = Math.floor(totalMinutes / 60);
  const hours = totalHours % 24;
  const totalDays = Math.floor(totalHours / 24);

  return { totalDays, hours, minutes, expired: false };
}

function formatPlanExpiry(target: string | null | undefined) {
  if (!target) return null;
  const date = new Date(target);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("es-CU", {
    day: "2-digit",
    month: "short",
    year: "numeric"
  });
}
const PALMYRA_PWA_INSTALLED_KEY = "palmyra:pwa-installed";
const PALMYRA_UPDATE_AVAILABLE_KEY = "palmyra:update-available";

function isPALMYRAPWAInstalled() {
  if (typeof window === "undefined") return false;
  const standalone = window.matchMedia?.("(display-mode: standalone)").matches;
  const fullscreen = window.matchMedia?.("(display-mode: fullscreen)").matches;
  const minimalUi = window.matchMedia?.("(display-mode: minimal-ui)").matches;
  const windowControls = window.matchMedia?.("(display-mode: window-controls-overlay)").matches;
  const iosStandalone = Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
  const rememberedInstalled = window.localStorage.getItem(PALMYRA_PWA_INSTALLED_KEY) === "1";
  const installed = Boolean(standalone || fullscreen || minimalUi || windowControls || iosStandalone || rememberedInstalled);

  // If the app is currently running in an installed display mode, remember it
  // so a later browser launch cannot show the install banner again.
  if (installed && !rememberedInstalled) {
    try { window.localStorage.setItem(PALMYRA_PWA_INSTALLED_KEY, "1"); } catch {}
  }

  return installed;
}

function getDeferredPWAInstallPrompt() {
  if (typeof window === "undefined") return null;
  return (window as typeof window & {
    __palmyraInstallPrompt?: Event & {
      prompt?: () => Promise<void>;
      userChoice?: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
    };
  }).__palmyraInstallPrompt || null;
}


export default function Layout({ children }: { children: React.ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [pendingOfflineCount, setPendingOfflineCount] = useState(getOfflineQueueCount());
  const [isSyncingOffline, setIsSyncingOffline] = useState(false);
  const [expandedNotificationId, setExpandedNotificationId] = useState<string | null>(null);
  const [isNavigating, setIsNavigating] = useState(false);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [isApplyingUpdate, setIsApplyingUpdate] = useState(false);
  const [navigationTargetPath, setNavigationTargetPath] = useState<string | null>(null);
  const navigationTimerRef = useRef<number | null>(null);
  const [saasContext, setSaaSContext] = useState<Awaited<ReturnType<typeof loadSaaSContext>>>(null);
  const [companySwitching, setCompanySwitching] = useState(false);
  const [countdownNow, setCountdownNow] = useState(() => Date.now());
  const [showInstallPwa, setShowInstallPwa] = useState(false);
  const [pwaInstallAvailable, setPwaInstallAvailable] = useState(false);
  const [pwaInstalling, setPwaInstalling] = useState(false);
  const [showOnlineCatalogInfo, setShowOnlineCatalogInfo] = useState(false);
  const { currentUser, logout, notifications, removeNotification, storeConfig, syncWithSupabase, addNotification, cart, currentBranchId, getCurrentSession } = useStore(useShallow((state) => ({ currentUser: state.currentUser, logout: state.logout, notifications: state.notifications, removeNotification: state.removeNotification, storeConfig: state.storeConfig, syncWithSupabase: state.syncWithSupabase, addNotification: state.addNotification, cart: state.cart, currentBranchId: state.currentBranchId, getCurrentSession: state.getCurrentSession })));
  const location = useLocation();
  const isPosPage = location.pathname === "/pos";


  useEffect(() => {
    if (!currentUser?.id) {
      setShowInstallPwa(false);
      return;
    }

    const syncPwaState = () => {
      const installed = isPALMYRAPWAInstalled();
      const available = !installed && Boolean(getDeferredPWAInstallPrompt());
      setPwaInstallAvailable(available);
      setShowInstallPwa(!installed);
      if (installed) {
        delete (window as typeof window & { __palmyraInstallPrompt?: unknown }).__palmyraInstallPrompt;
      }
    };

    syncPwaState();
    const onInstallAvailable = () => syncPwaState();
    const onInstalled = () => {
      setPwaInstallAvailable(false);
      setShowInstallPwa(false);
    };
    window.addEventListener("palmyra:pwa-install-available", onInstallAvailable);
    window.addEventListener("palmyra:pwa-installed", onInstalled);
    const timer = window.setTimeout(syncPwaState, 900);

    return () => {
      window.removeEventListener("palmyra:pwa-install-available", onInstallAvailable);
      window.removeEventListener("palmyra:pwa-installed", onInstalled);
      window.clearTimeout(timer);
    };
  }, [currentUser?.id]);
  useEffect(() => {
    const timer = window.setInterval(() => setCountdownNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let active = true;

    const refreshContext = async () => {
      try {
        const ctx = await loadSaaSContext(true);
        if (active) setSaaSContext(ctx);
      } catch {
        // La interfaz continúa con el último contexto válido. App.tsx mantiene
        // la hidratación principal de acceso y reintentará si fuese necesario.
      }
    };

    void refreshContext();

    // Una aprobación/rechazo del plan puede ocurrir desde la administración
    // de PALMYRA mientras el usuario ya tiene el CRM abierto. Refrescamos el
    // contexto periódicamente para que el plan y el contador cambien sin exigir
    // cerrar sesión ni recargar manualmente.
    const timer = window.setInterval(() => {
      void refreshContext();
    }, 30_000);

    const handleFocus = () => void refreshContext();
    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleFocus);

    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleFocus);
    };
  }, [currentUser?.id]);

  const loadingLabelByPath: Record<string, string> = {
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
    "/help": "Cargando Centro de atención…",
  };

  const startNavigationFeedback = (targetPath: string) => {
    if (targetPath === location.pathname) return;
    if (navigationTimerRef.current !== null) {
      window.clearTimeout(navigationTimerRef.current);
    }
    // Guardamos la ruta destino por separado de location.pathname. Así el
    // texto siempre corresponde al botón que el trabajador acaba de tocar.
    setNavigationTargetPath(targetPath);
    setIsNavigating(true);
    // Seguro de salida por si una navegación queda interrumpida.
    navigationTimerRef.current = window.setTimeout(() => {
      setIsNavigating(false);
      setNavigationTargetPath(null);
      navigationTimerRef.current = null;
    }, 1400);
  };

  useEffect(() => {
    return () => {
      if (navigationTimerRef.current !== null) {
        window.clearTimeout(navigationTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const onUpdate = () => setUpdateAvailable(true);
    const checkPersistedUpdate = () => {
      try {
        if (window.localStorage.getItem(PALMYRA_UPDATE_AVAILABLE_KEY) === '1') {
          setUpdateAvailable(true);
        }
      } catch {}
    };

    // El SW puede encontrar la actualización antes de que esta vista exista.
    // Revisamos la marca persistente al montar, al volver al primer plano y al
    // cambiar de pestaña, tanto en navegador como en PWA instalada.
    checkPersistedUpdate();
    window.addEventListener('palmyra:update-available', onUpdate);
    window.addEventListener('focus', checkPersistedUpdate);
    document.addEventListener('visibilitychange', checkPersistedUpdate);

    return () => {
      window.removeEventListener('palmyra:update-available', onUpdate);
      window.removeEventListener('focus', checkPersistedUpdate);
      document.removeEventListener('visibilitychange', checkPersistedUpdate);
    };
  }, []);

  useEffect(() => {
    // Solo cerramos la indicación después de confirmar que ya estamos en la
    // ruta que el usuario solicitó. La mantenemos visible un instante para
    // que también se perciba en navegaciones rápidas.
    if (!navigationTargetPath || navigationTargetPath !== location.pathname) return;
    const timer = window.setTimeout(() => {
      setIsNavigating(false);
      setNavigationTargetPath(null);
      if (navigationTimerRef.current !== null) {
        window.clearTimeout(navigationTimerRef.current);
        navigationTimerRef.current = null;
      }
    }, 450);
    return () => window.clearTimeout(timer);
  }, [location.pathname, navigationTargetPath]);

  // Efecto para el Modo Oscuro (Mejorado para Miopía: contraste suave)
  useEffect(() => {
    if (storeConfig.darkMode) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [storeConfig.darkMode]);

  useEffect(() => {
    const updateCount = () => setPendingOfflineCount(getOfflineQueueCount());
    const handleOnline = () => {
      setIsOnline(true);
      updateCount();
    };
    const handleOffline = () => {
      setIsOnline(false);
      updateCount();
    };
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    window.addEventListener('offline_queue_updated', updateCount);
    const handleStorageWarning = () => {
      addNotification('Almacenamiento local casi lleno', 'warning', 'PALMYRA detectó poco espacio disponible. No borres los datos del sitio mientras haya ventas offline pendientes. Sincroniza primero.');
    };
    window.addEventListener('palmyra:storage-warning', handleStorageWarning);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('offline_queue_updated', updateCount);
      window.removeEventListener('palmyra:storage-warning', handleStorageWarning);
    };
  }, []);

  const handleApplyUpdate = async () => {
    if (isApplyingUpdate) return;
    const activeSession = currentUser?.id ? getCurrentSession(currentBranchId, currentUser.id) : undefined;
    if (isPosPage && activeSession && cart.length > 0) {
      addNotification('Actualización preparada', 'info', 'Finaliza o limpia la venta actual antes de actualizar PALMYRA. La caja y los datos permanecen protegidos.');
      return;
    }
    setIsApplyingUpdate(true);
    try {
      const apply = (window as typeof window & { __palmyraApplyUpdate?: () => Promise<void> }).__palmyraApplyUpdate;
      if (apply) {
        await apply();
        return;
      }

      // Último respaldo: si la acción global no estuviera disponible todavía,
      // recargamos directamente. El navegador/PWA conserva los datos locales.
      try { localStorage.removeItem(PALMYRA_UPDATE_AVAILABLE_KEY); } catch {}
      window.location.reload();
    } catch (error) {
      console.warn('[PALMYRA] No se pudo aplicar la actualización:', error);
      setIsApplyingUpdate(false);
    }
  };

  const handleManualSync = async () => {
    if (!isOnline || isSyncingOffline) return;
    setIsSyncingOffline(true);
    try {
      const { processOfflineQueue } = await import("../services/offlineSync");
      // Primero vaciamos la cola durable. El motor ya realiza una comprobación
      // de conectividad con reintentos, por lo que una microcaída de Starlink no
      // convierte una operación local en pérdida de datos.
      let res = await processOfflineQueue();

      // El pull completo de Supabase puede fallar aunque la conexión ya haya
      // vuelto. Reintentamos únicamente los fallos transitorios; no repetimos
      // ciegamente errores de permisos/datos.
      let cloudResult = await syncWithSupabase();
      for (let attempt = 1; attempt < 3 && cloudResult?.success === false; attempt++) {
        const message = String(cloudResult?.message || '');
        const transient = /network|fetch|failed|timeout|timed out|gateway|connection|503|502|504|temporarily|unavailable/i.test(message);
        if (!transient) break;
        await new Promise(resolve => setTimeout(resolve, 700 * attempt));
        cloudResult = await syncWithSupabase();
      }

      // Si el primer replay encontró un fallo de red, vuelve a intentarlo
      // después del pull/reintento en lugar de dejar la cola esperando hasta el
      // siguiente intervalo automático.
      if (res.failed > 0 && res.errors?.some((e: any) => /network|timeout|fetch|connection|supabase no está accesible/i.test(String(e?.message || '')))) {
        await new Promise(resolve => setTimeout(resolve, 700));
        const retryRes = await processOfflineQueue();
        res = {
          processed: res.processed + retryRes.processed,
          failed: retryRes.failed,
          remaining: retryRes.remaining,
          conflicts: retryRes.conflicts,
          errors: [...(res.errors || []), ...(retryRes.errors || [])]
        };
      }
      // The cloud refresh can surface/requeue operations that failed during the
      // pull/push cycle. Always read the durable queue again before declaring
      // synchronization complete; the first result is only a snapshot.
      // La cola debe estar completamente hidratada antes de diagnosticar el
      // resultado final. Esto evita que una carrera entre IndexedDB y la
      // sincronización produzca el aviso engañoso "sin detalle".
      await waitForOfflineQueueReady();
      const finalQueue = getOfflineQueue();
      const finalPendingCount = finalQueue.filter((item: any) => item?.status !== 'conflict').length;
      setPendingOfflineCount(finalPendingCount);
      if (finalPendingCount > 0 || cloudResult?.success === false) {
        // Nunca ocultar la causa: cada operación pendiente debe quedar trazable
        // por tipo, actionId, estado, reintento y último error conocido.
        const queueDetails = finalQueue
          .slice(0, 30)
          .map((item: any) => {
            const status = item?.status ? ` [${item.status}]` : '';
            const retry = Number(item?.retryCount) > 0 ? ` · intento ${item.retryCount}` : '';
            const error = item?.lastError || (
              item?.status === 'conflict'
                ? 'Operación en conflicto: requiere revisión.'
                : 'Sin error registrado; probablemente bloqueada por una dependencia pendiente.'
            );
            return `${item?.type || 'operación'} · ${item?.actionId || item?.id || 'sin-id'}${status}${retry}: ${error}`;
          });
        const detailLines = [
          `Resultado de esta sincronización: ${res.processed} procesadas, ${res.failed} fallidas, ${res.remaining} restantes.`,
          ...(res.errors || []).map(e => `${e.type} · ${e.actionId}: ${e.message}`),
          ...(cloudResult?.errors || []).map((e: string) => `Nube: ${e}`),
          cloudResult?.success === false && cloudResult?.message ? `Sincronización nube: ${cloudResult.message}` : '',
          ...queueDetails
        ].filter(Boolean);
        addNotification(
          `Sincronización incompleta: quedan ${finalPendingCount} operaciones pendientes.`,
          'warning',
          detailLines.join('\\n') || `La cola reporta ${finalPendingCount} operaciones pendientes, pero no devolvió ningún detalle. Abre Configuración > Monitor de Logs para revisar el evento técnico.`
        );
      } else {
        addNotification("Sincronización con la nube completada con éxito", 'success');
      }
    } catch (error: any) {
      // Nunca ocultar una excepción real. La cola durable permanece intacta;
      // mostramos el detalle para poder diagnosticar el punto exacto sin borrar
      // operaciones pendientes.
      const detail = [
        error?.message || String(error || 'Error desconocido'),
        error?.code ? `Código: ${error.code}` : '',
        error?.status ? `HTTP: ${error.status}` : '',
        error?.details ? `Detalle: ${error.details}` : '',
        error?.hint ? `Ayuda: ${error.hint}` : ''
      ].filter(Boolean).join(' · ');
      addNotification(
        "Error al sincronizar con Supabase",
        'error',
        `${detail || 'La sincronización lanzó una excepción sin detalle.'}\nLas operaciones locales permanecen protegidas y se reintentará automáticamente cuando la conexión esté estable.`
      );
    } finally {
      setIsSyncingOffline(false);
    }
  };

  useEffect(() => {
    const handleOpenSidebar = () => setSidebarOpen(true);
    window.addEventListener("palmyra:open-sidebar", handleOpenSidebar);
    return () => window.removeEventListener("palmyra:open-sidebar", handleOpenSidebar);
  }, []);

  // El POS conserva el sidebar compacto pero con nombres visibles.
  // El usuario puede minimizarlo manualmente cuando necesite más espacio.
  const navItems =
    currentUser?.role === "admin"
      ? adminNavItems
      : adminNavItems.filter(item => Boolean(item.public) || currentUser?.permissions?.includes(item.permission) || item.href === "/pos");

  const visibleNavItems = navItems.length > 0 ? navItems : cashierNavItems;
  const currentPlanCode = saasContext?.subscription?.planCode || "";
  const isPlanLocked = (item: { requiredFeature?: PlanFeature }) => Boolean(item.requiredFeature && !canUsePlanFeature(currentPlanCode, item.requiredFeature));
  const getRequiredPlanCode = (feature?: PlanFeature) => feature === 'advanced_analytics' || feature === 'excel_exports' || feature === 'ai_dashboard' || feature === 'warranty_returns' || feature === 'abc_analysis' || feature === 'labels' ? 'pro' : feature ? 'growth' : '';

  const navSections = currentUser?.role === "admin"
    ? [
        { label: "Operación", hrefs: ["/", "/pos", "/transfers", "/returns"] },
        { label: "Gestión", hrefs: ["/customers", "/inventory", "/inventory-audit", "/suppliers", "#online-catalog"] },
        { label: "Finanzas", hrefs: ["/banks", "/reports"] },
        { label: "Administración", hrefs: ["/settings", "/team", "/help", "/subscription", "/tutorial", "/exchange-rate"] },
      ].map(section => ({
        ...section,
        items: visibleNavItems.filter(item => section.hrefs.includes(item.href)),
      })).filter(section => section.items.length > 0)
    : [{ label: "", hrefs: [], items: visibleNavItems }];

  return (
    <div className="h-[100dvh] w-full min-h-[100dvh] max-h-[100dvh] overflow-hidden bg-primary text-primary flex flex-col lg:flex-row relative overscroll-none transition-colors duration-200">

      {showInstallPwa && currentUser && (
        <div className="fixed inset-x-3 bottom-3 sm:inset-auto sm:right-4 sm:bottom-4 z-[10000]">
          <div className="w-full sm:w-[min(22rem,calc(100vw-2rem))] rounded-2xl border border-violet-200/80 bg-white/95 dark:bg-slate-900/95 dark:border-violet-900/50 shadow-2xl backdrop-blur-md p-3">
            <div className="flex items-start gap-2.5">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-violet-100 dark:bg-violet-900/40 text-violet-600 dark:text-violet-300">
                <Smartphone className="w-4 h-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[9px] font-black uppercase tracking-[0.11em] text-primary">Instala PALMYRA</p>
                  <button type="button" onClick={() => setShowInstallPwa(false)} className="p-1 rounded-lg text-muted hover:bg-subtle" aria-label="Cerrar aviso">
                    <X className="w-3 h-3" />
                  </button>
                </div>
                <p className="mt-1 text-[7px] font-bold leading-4 text-muted">
                  Instala PALMYRA como aplicación para abrirla directamente y trabajar a pantalla completa, incluso con conexión inestable.
                </p>
                {pwaInstallAvailable ? (
                  <button
                    type="button"
                    disabled={pwaInstalling}
                    onClick={async () => {
                      const prompt = getDeferredPWAInstallPrompt();
                      if (!prompt?.prompt) return;
                      setPwaInstalling(true);
                      try {
                        await prompt.prompt();
                        const choice = await prompt.userChoice;
                        if (choice?.outcome === "accepted") {
                          try { window.localStorage.setItem(PALMYRA_PWA_INSTALLED_KEY, "1"); } catch {}
                          delete (window as typeof window & { __palmyraInstallPrompt?: unknown }).__palmyraInstallPrompt;
                          setPwaInstallAvailable(false);
                          setShowInstallPwa(false);
                        }
                      } finally {
                        setPwaInstalling(false);
                      }
                    }}
                    className="mt-2 w-full h-8 rounded-xl bg-violet-600 text-white text-[8px] font-black uppercase tracking-[0.08em] flex items-center justify-center gap-1.5 hover:bg-violet-700 disabled:opacity-60"
                  >
                    <Download className="w-3 h-3" />
                    {pwaInstalling ? "Instalando…" : "Instalar PALMYRA"}
                  </button>
                ) : (
                  <div className="mt-2 rounded-xl bg-violet-50 dark:bg-violet-950/30 border border-violet-100 dark:border-violet-900/40 px-2.5 py-2">
                    <p className="text-[6.5px] font-black uppercase tracking-wider text-violet-700 dark:text-violet-300">Instalación manual</p>
                    <p className="mt-0.5 text-[6.5px] font-bold leading-4 text-muted">
                      Abre el menú del navegador y elige <b>Instalar aplicación</b> o <b>Añadir a pantalla de inicio</b>.
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Sistema de Notificaciones Globales */}
      <div className="fixed top-4 right-4 z-[9999] flex flex-col gap-2 pointer-events-none">
        {notifications.map((n) => (
          <div 
            key={n.id} 
            className={cn(
              "pointer-events-auto w-[calc(100vw-2rem)] max-w-sm min-w-0 p-4 rounded-2xl shadow-2xl border flex items-center gap-3 animate-in slide-in-from-right-4 duration-300",
              n.type === 'success' ? "bg-emerald-50 border-emerald-100 text-emerald-800" :
              n.type === 'error' ? "bg-rose-50 border-rose-100 text-rose-800" :
              n.type === 'warning' ? "bg-amber-50 border-amber-100 text-amber-800" :
              "bg-rose-50 border-rose-100 text-rose-800"
            )}
          >
            <div className="shrink-0">
              {n.type === 'success' && <CheckCircle2 className="w-5 h-5 text-emerald-500" />}
              {n.type === 'error' && <AlertCircle className="w-5 h-5 text-rose-500" />}
              {n.type === 'warning' && <AlertTriangle className="w-5 h-5 text-amber-500" />}
              {n.type === 'info' && <Info className="w-5 h-5 text-rose-500" />}
            </div>
            <button
              type="button"
              onClick={() => n.details && setExpandedNotificationId(expandedNotificationId === n.id ? null : n.id)}
              className={cn("flex-1 text-left text-[11px] font-black uppercase tracking-tight leading-tight", n.details && "cursor-pointer")}
              title={n.details ? "Presiona para ver el detalle del error" : undefined}
            >
              <span>{n.message}</span>
              {n.details && <span className="block mt-1 text-[9px] opacity-70 normal-case tracking-normal">Presiona para ver el detalle</span>}
              {n.details && expandedNotificationId === n.id && (
                <span className="block mt-2 p-2 rounded-lg bg-black/5 whitespace-pre-wrap break-words font-mono text-[10px] normal-case tracking-normal max-h-48 overflow-auto">{n.details}</span>
              )}
            </button>
            <button 
              onClick={() => removeNotification(n.id)}
              className="shrink-0 p-1 hover:bg-black/5 rounded-full transition-colors"
              aria-label="Cerrar notificación"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
      </div>
      {/* Mobile / tablet top bar */}
      {(
        <div className="lg:hidden bg-white text-slate-700 p-2.5 flex justify-between items-center shadow-sm border-b border-violet-100 shrink-0">
          <div className="flex items-center gap-2 min-w-0"><img src="/palmyra-logo-exact.svg" alt="PALMYRA" className="w-[160px] h-[40px] object-contain object-left" /><span className="rounded-full bg-violet-50 px-1.5 py-1 text-[7px] font-black text-violet-700 tracking-wider shrink-0">{APP_VERSION}</span></div><div className={cn("flex items-center gap-1.5 px-2 py-1.5 rounded-xl border text-[8px] font-black uppercase tracking-wider", isOnline ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-700")} title="Estado de conexión">{isOnline ? <Wifi className="w-3 h-3 shrink-0" /> : <WifiOff className="w-3 h-3 shrink-0" />}<span>{isOnline ? (pendingOfflineCount > 0 ? pendingOfflineCount+" pendientes" : "Online") : "Offline"}</span></div>
          <div className="flex items-center gap-1.5 shrink-0"><button data-palmy-menu-toggle type="button" onClick={() => setSidebarOpen(!sidebarOpen)} className="p-2 rounded-xl hover:bg-slate-100 transition" aria-label="Abrir menú principal" title="Abrir menú principal" aria-expanded={sidebarOpen}>
            <Menu className="w-3.5 h-3.5" />
          </button></div>
        </div>
      )}

      <aside
        data-palmy-sidebar="true"
        className={cn(
          "bg-secondary border-r border-base transition-all duration-300 ease-in-out flex flex-col h-full shrink-0 shadow-sm",
          // Mobile: off-canvas drawer with fixed overlay
          "fixed inset-y-0 left-0 z-50 w-[68vw] max-w-[210px] overflow-hidden",
          sidebarOpen ? "translate-x-0" : "-translate-x-full",
          // Desktop (lg+): relative in-flow column, NEVER covers or overlaps the right content
          "lg:relative lg:inset-auto lg:z-auto lg:translate-x-0",
          sidebarCollapsed ? "lg:w-11" : "lg:w-[11.5rem]"
        )}
      >
        {/* Header with Collapse toggle */}
        <div className={cn("p-2 shrink-0 flex items-center justify-between gap-1.5 border-b border-subtle", sidebarCollapsed && "lg:p-2 lg:justify-center")}>
          <div className={cn("flex items-center gap-1 min-w-0 flex-1 pr-0", sidebarCollapsed && "lg:hidden")}>
            <img
              src="/palmyra-logo-exact.svg"
              alt="PALMYRA"
              className="w-[84px] h-[23px] max-w-[calc(100%-2rem)] object-contain object-left"
            />
            <span className="shrink-0 rounded-full bg-subtle px-1.5 py-1 text-[6px] font-black text-primary tracking-tight leading-none">{APP_VERSION}</span>
          </div>

          <div className={cn("hidden items-center justify-center", sidebarCollapsed && "lg:flex")}>
            <img
              src="/palmyra-mark-exact.svg"
              alt="PALMYRA"
              className="w-8 h-8 object-contain"
            />
          </div>
          
          <button
            type="button"
            onClick={() => setSidebarOpen(false)}
            className="lg:hidden p-2 rounded-xl text-muted hover:bg-subtle hover:text-primary transition-colors"
            aria-label="Cerrar menú"
            title="Cerrar menú"
          >
            <X className="w-5 h-5" />
          </button>

          <button 
            data-palmy-sidebar-collapse
            type="button"
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            className="hidden lg:flex shrink-0 p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors"
            title={sidebarCollapsed ? "Expandir menú" : "Minimizar menú"}
          >
            {sidebarCollapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
          </button>
        </div>

        <nav className="flex-1 min-h-0 px-1.5 py-2 overflow-y-auto custom-scrollbar">
          {navSections.map((section, sectionIndex) => (
            <div key={section.label || `section-${sectionIndex}`} className={cn(sectionIndex > 0 && !sidebarCollapsed ? "mt-3" : "")}>
              {!sidebarCollapsed && section.label && (
                <div className="px-2 pb-1 text-[7px] font-black uppercase tracking-[0.18em] text-muted/70">
                  {section.label}
                </div>
              )}
              <div className="space-y-0.5">
                {section.items.map((item) => {
                  const Icon = item.icon;
                  return (
                    <NavLink
                      key={item.name}
                      to={item.href}
                      onClick={(event) => {
                        if ((item as any).comingSoon) {
                          event.preventDefault();
                          setShowOnlineCatalogInfo(true);
                          setSidebarOpen(false);
                          return;
                        }
                        setSidebarOpen(false);
                        startNavigationFeedback(item.href);
                      }}
                      title={sidebarCollapsed ? item.name : undefined}
                    >
                      {({ isActive }) => (
                        <div
                          className={cn(
                            "flex items-center rounded-lg transition-colors duration-150 group min-w-0",
                            sidebarCollapsed ? "justify-center p-2 my-0.5" : "gap-2 px-2.5 py-2.5",
                            isActive && !(item as any).comingSoon
                              ? "bg-rose-600 text-white shadow-sm"
                              : "text-muted hover:bg-subtle hover:text-primary"
                          )}
                        >
                          <Icon className={cn(
                            "w-4 h-4 shrink-0 transition-colors",
                            isActive && !(item as any).comingSoon ? "text-white" : "text-muted group-hover:text-rose-600"
                          )} />
                          {!sidebarCollapsed && (
                            <span className="min-w-0 flex-1 font-black text-[10px] uppercase tracking-[-0.005em] leading-[1.2] whitespace-normal break-words">
                              {item.name}
                            </span>
                          )}
                          {!sidebarCollapsed && isPlanLocked(item as { requiredFeature?: PlanFeature }) && (() => {
                            const requiredCode = getRequiredPlanCode((item as { requiredFeature?: PlanFeature }).requiredFeature);
                            const visual = getPlanVisual(requiredCode);
                            return (
                              <span className={cn("shrink-0 rounded-full px-1 py-0.5 text-[5px] font-black uppercase tracking-tight border", visual.badge)}>
                                {requiredCode === "pro" ? "Ciudadela" : "Caravana"}
                              </span>
                            );
                          })()}
                          {!sidebarCollapsed && (item as any).comingSoon && (
                            <span className="shrink-0 rounded-full bg-rose-50 px-1 py-0.5 text-[5px] font-black uppercase tracking-tight text-rose-700 border border-rose-200">
                              Próximamente
                            </span>
                          )}
                        </div>
                      )}
                    </NavLink>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        <div className={cn(
          "shrink-0 min-w-0 overflow-hidden p-1.5 bg-secondary border-t border-subtle",
          sidebarCollapsed && "lg:p-1.5"
        )}>
          {!sidebarCollapsed && (
            <button
              type="button"
              onClick={handleManualSync}
              disabled={isSyncingOffline || !isOnline}
              className={cn(
                "w-full h-7 flex items-center justify-between gap-1.5 px-2 rounded-lg text-[7px] font-black uppercase tracking-wider transition-colors border mb-1.5",
                !isOnline
                  ? "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20"
                  : pendingOfflineCount > 0
                  ? "bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20 hover:bg-rose-500/20"
                  : "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20"
              )}
              title={pendingOfflineCount > 0 ? "Sincronizar datos pendientes" : undefined}
            >
              <span className="flex items-center gap-1.5 min-w-0 truncate">
                {isSyncingOffline ? (
                  <RefreshCw className="w-3 h-3 animate-spin shrink-0" />
                ) : isOnline ? (
                  <Wifi className="w-3 h-3 shrink-0" />
                ) : (
                  <WifiOff className="w-3 h-3 shrink-0" />
                )}
                <span className="truncate">
                  {!isOnline ? "Offline" : (pendingOfflineCount > 0 ? (isSyncingOffline ? "Subiendo…" : "Sincronizar") : "Online")}
                </span>
              </span>
              {pendingOfflineCount > 0 && (
                <span className="shrink-0 px-1 rounded-full text-[6px] font-black bg-amber-500 text-white">
                  {pendingOfflineCount}
                </span>
              )}
            </button>
          )}

          <div className="flex items-center gap-1.5 min-w-0">
            <div className="w-6 h-6 rounded-full bg-subtle border border-base flex items-center justify-center text-primary font-black text-[9px] uppercase shrink-0">
              {currentUser?.name?.charAt(0) || "P"}
            </div>
            {!sidebarCollapsed && (
              <div className="min-w-0 flex-1">
                <p className="text-[7.5px] font-black text-primary uppercase leading-tight truncate">
                  {currentUser?.name || "Usuario"}
                </p>
                <p className="text-[6px] text-muted uppercase tracking-tight font-bold truncate">
                  {currentUser?.role === "admin" ? "Administrador" : (currentUser?.role || "Empleado")}
                </p>
              </div>
            )}
            <button
              type="button"
              onClick={logout}
              className={cn(
                "shrink-0 rounded-lg transition-colors text-muted hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/50",
                sidebarCollapsed ? "p-1.5" : "p-1"
              )}
              title="Cerrar sesión"
              aria-label="Cerrar sesión"
            >
              <LogOut className="w-3.5 h-3.5" />
            </button>
          </div>

          {!sidebarCollapsed && (() => {
            const subscription = saasContext?.subscription;
            const baseTarget = subscription?.status === "trialing"
              ? subscription?.trialEndsAt
              : subscription?.currentPeriodEnd;
            const baseTargetMs = baseTarget ? new Date(baseTarget).getTime() : NaN;
            const graceTarget = subscription?.graceEndsAt || null;
            const effectiveTarget = Number.isFinite(baseTargetMs) && baseTargetMs <= countdownNow && graceTarget
              ? graceTarget
              : baseTarget;
            const planEndsAt = effectiveTarget || subscription?.trialEndsAt || subscription?.currentPeriodEnd || null;
            const countdown = getPlanCountdown(planEndsAt, countdownNow);
            const expiryLabel = formatPlanExpiry(planEndsAt);
            if (!subscription || (!countdown && !expiryLabel)) return null;

            const statusLabel = subscription.status === "trialing"
              ? "PRUEBA"
              : subscription.status === "active"
                ? "ACTIVO"
                : subscription.status.replace(/_/g, " ").toUpperCase();
            const timeLabel = countdown?.expired
              ? "Vencido"
              : countdown
                ? countdown.totalDays > 0
                  ? `${countdown.totalDays} día${countdown.totalDays === 1 ? "" : "s"} · ${String(countdown.hours).padStart(2, "0")} h`
                  : `${String(countdown.hours).padStart(2, "0")} h · ${String(countdown.minutes).padStart(2, "0")} min`
                : "Sin contador";

            return (
              <div className={cn("mt-1.5 min-w-0 rounded-xl border px-2.5 py-2", getPlanVisual(subscription?.planCode).border, getPlanVisual(subscription?.planCode).soft)}>
                <div className="flex items-center gap-1.5 min-w-0">
                  <div className={cn("w-6 h-6 rounded-lg flex items-center justify-center shrink-0", getPlanVisual(subscription?.planCode).soft)}>
                    <CreditCard className={cn("w-3 h-3", getPlanVisual(subscription?.planCode).text)} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <p className={cn("min-w-0 flex-1 truncate text-[7px] font-black uppercase tracking-[0.11em]", getPlanVisual(subscription?.planCode).text)}>{subscription.planName || "Plan PALMYRA"}</p>
                      <span className={cn("shrink-0 rounded-full px-1.5 py-0.5 text-[5.5px] font-black uppercase tracking-wider", countdown?.expired ? "bg-rose-100 text-rose-700" : "bg-emerald-100 text-emerald-700")}>{statusLabel}</span>
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[6.5px] font-bold leading-tight">
                      <span className="text-primary">Vence {expiryLabel || "—"}</span>
                      <span className={cn("tabular-nums", countdown?.expired ? "text-rose-600 font-black" : getPlanVisual(subscription?.planCode).text)}>{timeLabel}</span>
                    </div>
                  </div>
                </div>
              </div>
            );
          })()}    </div>

      </aside>

      {(saasContext?.company?.account_status === 'pending_payment' && !!saasContext?.subscription?.graceEndsAt && new Date(saasContext.subscription.graceEndsAt).getTime() <= countdownNow) && location.pathname !== '/subscription' && location.pathname !== '/help' && (
        <div className="fixed inset-0 z-[290] flex items-center justify-center p-4 bg-slate-950/55 backdrop-blur-[3px]">
          <div className="w-full max-w-md rounded-3xl border border-amber-200 bg-white shadow-2xl p-6 text-center">
            <div className="mx-auto w-12 h-12 rounded-2xl bg-amber-100 text-amber-700 flex items-center justify-center"><CreditCard className="w-6 h-6"/></div>
            <p className="mt-4 text-[10px] font-black uppercase tracking-[0.16em] text-amber-700">Periodo de servicio finalizado</p>
            <h3 className="mt-1 text-xl font-black text-slate-900">PALMYRA está en modo lectura</h3>
            <p className="mt-2 text-sm leading-5 text-slate-600">Tus datos, ventas e historial se conservan. Para volver a operar y sincronizar nuevas modificaciones, activa nuevamente tu plan.</p>
            <button type="button" onClick={() => window.location.assign('/subscription')} className="mt-5 w-full h-11 rounded-xl bg-indigo-600 text-white text-xs font-black uppercase tracking-wider">Ver planes y activar</button>
          </div>
        </div>
      )}

      {(() => {
        const subscription = saasContext?.subscription;
        const baseTarget = subscription?.status === 'trialing' ? subscription?.trialEndsAt : subscription?.currentPeriodEnd;
        const baseExpired = !!baseTarget && new Date(baseTarget).getTime() <= countdownNow;
        const graceEnds = subscription?.graceEndsAt ? new Date(subscription.graceEndsAt).getTime() : NaN;
        const inGrace = baseExpired && Number.isFinite(graceEnds) && graceEnds > countdownNow;
        if (!inGrace || location.pathname === '/subscription' || location.pathname === '/help') return null;
        return (
          <div className="fixed top-3 left-1/2 -translate-x-1/2 z-[275] w-[min(92vw,34rem)] rounded-2xl border border-amber-200 bg-amber-50 px-3.5 py-3 shadow-xl">
            <div className="flex items-start gap-2.5">
              <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
              <div className="min-w-0">
                <p className="text-[9px] font-black uppercase tracking-wider text-amber-800">Período de gracia activo</p>
                <p className="mt-0.5 text-[10px] font-bold leading-4 text-amber-700">
                  Tu plan terminó, pero PALMYRA mantiene el acceso durante el período de gracia de 2 días. Renueva antes de que finalice para continuar operando.
                </p>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Main Content */}
      {updateAvailable && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center px-4 py-6 pointer-events-none bg-slate-950/20 dark:bg-slate-950/50 backdrop-blur-[3px]">
          <div
            className="pointer-events-auto w-full max-w-sm overflow-hidden rounded-[30px] border border-violet-200/70 bg-white shadow-[0_28px_90px_rgba(76,29,149,0.24)] dark:border-violet-900/60 dark:bg-slate-900 dark:shadow-[0_28px_90px_rgba(0,0,0,0.5)]"
            role="dialog"
            aria-modal="true"
            aria-labelledby="palmyra-update-title"
          >
            <div className="relative overflow-hidden bg-gradient-to-br from-violet-700 via-indigo-600 to-violet-500 px-5 pb-5 pt-5 text-white sm:px-6">
              <div className="absolute -right-10 -top-12 h-32 w-32 rounded-full bg-white/15 blur-2xl" />
              <div className="absolute -bottom-16 left-12 h-28 w-28 rounded-full bg-fuchsia-300/20 blur-2xl" />
              <div className="relative flex items-center gap-3">
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-white/20 bg-white/15 shadow-lg backdrop-blur-sm">
                  <RefreshCw className={cn("h-6 w-6", isApplyingUpdate && "animate-spin")} />
                </div>
                <div className="min-w-0">
                  <p className="text-[9px] font-black uppercase tracking-[0.18em] text-violet-100">PALMYRA · Sistema</p>
                  <h3 id="palmyra-update-title" className="mt-1 text-xl font-black tracking-tight">Hay una nueva actualización</h3>
                </div>
              </div>
              <div className="relative mt-4 rounded-2xl border border-white/15 bg-black/10 px-3.5 py-3">
                <p className="text-[10px] font-semibold leading-5 text-violet-50">
                  Una nueva versión del sistema está lista. Actualiza ahora para continuar con la experiencia más reciente de PALMYRA.
                </p>
              </div>
            </div>
            <div className="border-t border-slate-100 bg-white px-5 py-4 dark:border-slate-800 dark:bg-slate-900 sm:px-6">
              <div className="flex items-center justify-between gap-2.5">
                <span className="text-[8px] font-black uppercase tracking-[0.12em] text-slate-400">Actualización del sistema</span>
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-1 text-[8px] font-black uppercase tracking-wider text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> Lista
                </span>
              </div>
              <div className="mt-3 flex flex-col-reverse gap-2.5 sm:flex-row">
                <button
                  type="button"
                  disabled={isApplyingUpdate}
                  onClick={() => {
                    try { localStorage.removeItem(PALMYRA_UPDATE_AVAILABLE_KEY); } catch {}
                    setUpdateAvailable(false);
                  }}
                  className="h-11 flex-1 rounded-xl border border-slate-200 bg-slate-50 px-4 text-[9px] font-black uppercase tracking-[0.08em] text-slate-600 transition hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
                >
                  Ahora no
                </button>
                <button
                  type="button"
                  disabled={isApplyingUpdate}
                  onClick={handleApplyUpdate}
                  className="h-11 flex-1 rounded-xl bg-violet-600 px-4 text-[9px] font-black uppercase tracking-[0.08em] text-white shadow-lg shadow-violet-600/20 transition hover:bg-violet-700 disabled:cursor-wait disabled:opacity-70"
                >
                  {isApplyingUpdate ? "Actualizando…" : "Actualizar ahora"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <main className="flex-1 min-w-0 overflow-hidden flex flex-col relative h-full">
        {/* Indicador de navegación centrado dentro del área principal/POS.
            Usa la ruta destino para no mostrar el nombre de otra sección. */}
        {isNavigating && (
          <div className="absolute inset-0 z-[60] flex items-center justify-center pointer-events-none px-4" aria-live="polite" aria-busy="true">
            <div className="palmyra-loading-bubble">
              <span className="palmyra-loading-icon" aria-hidden="true">
                <span className="palmyra-loading-spinner" />
              </span>
              <span className="min-w-0">{loadingLabelByPath[navigationTargetPath || location.pathname] || "Cargando sección…"}</span>
              <span className="palmyra-loading-dots" aria-hidden="true">•••</span>
            </div>
          </div>
        )}
        {showOnlineCatalogInfo && (
        <div className="fixed inset-0 z-[310] flex items-center justify-center p-4 bg-slate-950/45 backdrop-blur-sm" onClick={() => setShowOnlineCatalogInfo(false)}>
          <div className="w-full max-w-md rounded-3xl border border-violet-200 bg-white shadow-2xl p-6" onClick={e => e.stopPropagation()}>
            <div className="w-12 h-12 rounded-2xl bg-violet-100 text-violet-700 flex items-center justify-center"><Store className="w-6 h-6"/></div>
            <p className="mt-4 text-[10px] font-black uppercase tracking-[0.18em] text-violet-600">Catálogo Online · Próximamente</p>
            <h3 className="mt-1 text-xl font-black text-slate-900">Una nueva forma de vender en línea</h3>
            <p className="mt-3 text-sm leading-6 text-slate-600">Esta página será desarrollada en un futuro para que puedas publicar productos, mostrar precios, recibir solicitudes y presentar tu catálogo empresarial desde PALMYRA.</p>
            <div className="mt-4 rounded-2xl bg-violet-50 border border-violet-100 p-3 text-xs font-bold text-violet-800">Cuando el Catálogo Online esté disponible, el acceso requerirá el plan <b>Ciudadela</b>.</div>
            <button type="button" onClick={() => setShowOnlineCatalogInfo(false)} className="mt-5 w-full h-11 rounded-xl bg-violet-600 text-white text-xs font-black uppercase">Entendido</button>
          </div>
        </div>
      )}

      {/* Overlay for mobile sidebar */}
        {sidebarOpen && (
          <div
            className="fixed inset-0 bg-black/60 z-40 lg:hidden"
            onClick={() => setSidebarOpen(false)}
          />
        )}
        <div className={cn("flex-1 min-w-0 h-full flex flex-col scroll-touch keyboard-safe-scroll", isPosPage ? "overflow-hidden p-0" : "overflow-y-auto p-3 sm:p-4 lg:p-6 pb-20 lg:pb-12")}>
          {children}
        </div>
        </main>
    </div>
  );
}
