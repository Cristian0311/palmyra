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
  Smartphone
} from "lucide-react";
import React, { useState, useEffect, useRef } from "react";
import { cn } from "../lib/utils";
import { loadSaaSContext } from "../services/saas";
import { useStore } from "../store/useStore";
import { getOfflineQueueCount } from "../services/offlineQueue";
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
  { name: "Transferencias", href: "/transfers", icon: ArrowLeftRight, permission: "inventory.manage" },
  { name: "Clientes", href: "/customers", icon: UserCircle, permission: "customers.manage" },
  { name: "Inventario", href: "/inventory", icon: Package, permission: "inventory.manage" },
  { name: "Auditoría", href: "/inventory-audit", icon: ClipboardCheck, permission: "inventory.manage" },
  { name: "Proveedores", href: "/suppliers", icon: Truck, permission: "suppliers.manage" },
  { name: "Bancos", href: "/banks", icon: CreditCard, permission: "settings.manage" },
  { name: "Devoluciones", href: "/returns", icon: RotateCcw, permission: "pos.access" },
  { name: "Reportes", href: "/reports", icon: BarChart, permission: "reports.view" },
  { name: "Configuración", href: "/settings", icon: Settings, permission: "settings.manage" },
  { name: "Equipo", href: "/team", icon: Users, permission: "employees.manage" },
  { name: "Soporte", href: "/help", icon: Headphones, public: true },
  { name: "Plan", href: "/subscription", icon: CreditCard, permission: "settings.manage" },
];

const APP_VERSION = "V 1.0.0";

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
function isPALMYRAPWAInstalled() {
  if (typeof window === "undefined") return false;
  const standalone = window.matchMedia?.("(display-mode: standalone)").matches;
  const fullscreen = window.matchMedia?.("(display-mode: fullscreen)").matches;
  const iosStandalone = Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
  return Boolean(standalone || fullscreen || iosStandalone);
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
  const [navigationTargetPath, setNavigationTargetPath] = useState<string | null>(null);
  const navigationTimerRef = useRef<number | null>(null);
  const [saasContext, setSaaSContext] = useState<Awaited<ReturnType<typeof loadSaaSContext>>>(null);
  const [companySwitching, setCompanySwitching] = useState(false);
  const [countdownNow, setCountdownNow] = useState(() => Date.now());
  const [showInstallPwa, setShowInstallPwa] = useState(false);
  const [pwaInstallAvailable, setPwaInstallAvailable] = useState(false);
  const [pwaInstalling, setPwaInstalling] = useState(false);
  const { currentUser, logout, notifications, removeNotification, storeConfig, syncWithSupabase, addNotification } = useStore(useShallow((state) => ({ currentUser: state.currentUser, logout: state.logout, notifications: state.notifications, removeNotification: state.removeNotification, storeConfig: state.storeConfig, syncWithSupabase: state.syncWithSupabase, addNotification: state.addNotification })));
  const location = useLocation();
  const isPosPage = location.pathname === "/pos";


  useEffect(() => {
    if (!currentUser?.id) {
      setShowInstallPwa(false);
      return;
    }

    const syncPwaState = () => {
      const installed = isPALMYRAPWAInstalled();
      const available = Boolean(getDeferredPWAInstallPrompt());
      setPwaInstallAvailable(available);
      setShowInstallPwa(!installed);
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
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('offline_queue_updated', updateCount);
    };
  }, []);

  const handleManualSync = async () => {
    if (!isOnline || isSyncingOffline) return;
    setIsSyncingOffline(true);
    try {
      const { processOfflineQueue } = await import("../services/offlineSync");
      const res = await processOfflineQueue();
      const cloudResult = await syncWithSupabase();
      // The cloud refresh can surface/requeue operations that failed during the
      // pull/push cycle. Always read the durable queue again before declaring
      // synchronization complete; the first result is only a snapshot.
      const finalPendingCount = getOfflineQueueCount();
      setPendingOfflineCount(finalPendingCount);
      if (finalPendingCount > 0 || cloudResult?.success === false) {
        addNotification(`Sincronización incompleta: quedan ${finalPendingCount} operaciones pendientes.`, 'warning', [
          ...(res.errors || []).map(e => `${e.type} · ${e.actionId}: ${e.message}`),
          ...(cloudResult?.errors || []).map((e: string) => `Nube: ${e}`),
          cloudResult?.success === false && cloudResult?.message ? `Sincronización nube: ${cloudResult.message}` : ''
        ].filter(Boolean).join('\\n') || 'No se recibió un detalle específico. Abre Configuración y revisa el registro de sincronización.');
      } else {
        addNotification("Sincronización con la nube completada con éxito", 'success');
      }
    } catch {
      addNotification("Error al sincronizar con Supabase", 'error', 'La sincronización lanzó una excepción antes de completar el proceso. Revisa la conexión y vuelve a intentarlo.');
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

  const navSections = currentUser?.role === "admin"
    ? [
        { label: "Operación", hrefs: ["/", "/pos", "/transfers", "/returns"] },
        { label: "Gestión", hrefs: ["/customers", "/inventory", "/inventory-audit", "/suppliers"] },
        { label: "Finanzas", hrefs: ["/banks", "/reports"] },
        { label: "Administración", hrefs: ["/settings", "/team", "/help", "/subscription"] },
      ].map(section => ({
        ...section,
        items: visibleNavItems.filter(item => section.hrefs.includes(item.href)),
      })).filter(section => section.items.length > 0)
    : [{ label: "", hrefs: [], items: visibleNavItems }];

  return (
    <div className="h-[100dvh] w-full min-h-[100dvh] max-h-[100dvh] overflow-hidden bg-primary text-primary flex flex-col lg:flex-row relative overscroll-none transition-colors duration-200">

      {!isPosPage && showInstallPwa && currentUser && (
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
                <button
                  type="button"
                  disabled={pwaInstalling}
                  onClick={async () => {
                    const prompt = getDeferredPWAInstallPrompt();
                    if (!prompt?.prompt) {
                      setShowInstallPwa(false);
                      return;
                    }
                    setPwaInstalling(true);
                    try {
                      await prompt.prompt();
                      const choice = await prompt.userChoice;
                      if (choice?.outcome === "accepted") setShowInstallPwa(false);
                    } finally {
                      setPwaInstalling(false);
                    }
                  }}
                  className="mt-2 w-full h-8 rounded-xl bg-violet-600 text-white text-[8px] font-black uppercase tracking-[0.08em] flex items-center justify-center gap-1.5 hover:bg-violet-700 disabled:opacity-60"
                >
                  <Download className="w-3 h-3" />
                  {pwaInstalling ? "Instalando…" : pwaInstallAvailable ? "Instalar PALMYRA" : "Cómo instalar"}
                </button>
                {!pwaInstallAvailable && (
                  <p className="mt-1.5 text-[6.5px] font-bold leading-4 text-muted">
                    En algunos navegadores: abre el menú del navegador y elige <b>Instalar aplicación</b> o <b>Añadir a pantalla de inicio</b>.
                  </p>
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
          sidebarCollapsed ? "lg:w-11" : "lg:w-[10.25rem]"
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
            <div key={section.label || `section-${sectionIndex}`} className={cn(sectionIndex > 0 && !sidebarCollapsed ? "mt-2.5" : "")}>
              {!sidebarCollapsed && section.label && (
                <div className="px-2 pb-1 text-[6px] font-black uppercase tracking-[0.18em] text-muted/70">
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
                      onClick={() => {
                        setSidebarOpen(false);
                        startNavigationFeedback(item.href);
                      }}
                      title={sidebarCollapsed ? item.name : undefined}
                    >
                      {({ isActive }) => (
                        <div
                          className={cn(
                            "flex items-center rounded-lg transition-colors duration-150 group min-w-0",
                            sidebarCollapsed ? "justify-center p-2 my-0.5" : "gap-1.5 px-2 py-1.5",
                            isActive
                              ? "bg-rose-600 text-white shadow-sm"
                              : "text-muted hover:bg-subtle hover:text-primary"
                          )}
                        >
                          <Icon className={cn(
                            "w-3.5 h-3.5 shrink-0 transition-colors",
                            isActive ? "text-white" : "text-muted group-hover:text-rose-600"
                          )} />
                          {!sidebarCollapsed && (
                            <span className="min-w-0 flex-1 font-black text-[8px] uppercase tracking-[-0.01em] leading-[1.1] whitespace-normal break-words">
                              {item.name}
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
            const planTarget = subscription?.status === "trialing"
              ? subscription?.trialEndsAt
              : subscription?.currentPeriodEnd;
            const planEndsAt = planTarget || subscription?.trialEndsAt || subscription?.currentPeriodEnd || null;
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
              <div className="mt-1.5 min-w-0 rounded-xl border border-violet-200/70 dark:border-violet-900/30 bg-gradient-to-br from-violet-50 to-white dark:from-violet-950/30 dark:to-slate-900 px-2.5 py-2">
                <div className="flex items-center gap-1.5 min-w-0">
                  <div className="w-6 h-6 rounded-lg bg-violet-100 dark:bg-violet-900/40 flex items-center justify-center shrink-0">
                    <CreditCard className="w-3 h-3 text-violet-600 dark:text-violet-300" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <p className="min-w-0 flex-1 truncate text-[7px] font-black uppercase tracking-[0.11em] text-violet-600 dark:text-violet-400">{subscription.planName || "Plan PALMYRA"}</p>
                      <span className={cn("shrink-0 rounded-full px-1.5 py-0.5 text-[5.5px] font-black uppercase tracking-wider", countdown?.expired ? "bg-rose-100 text-rose-700" : "bg-emerald-100 text-emerald-700")}>{statusLabel}</span>
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[6.5px] font-bold leading-tight">
                      <span className="text-primary">Vence {expiryLabel || "—"}</span>
                      <span className={cn("tabular-nums", countdown?.expired ? "text-rose-600 font-black" : "text-violet-700 dark:text-violet-300")}>{timeLabel}</span>
                    </div>
                  </div>
                </div>
              </div>
            );
          })()}    </div>

      </aside>

      {/* Main Content */}
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
