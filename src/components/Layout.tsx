import { useShallow } from 'zustand/react/shallow';
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import {
  LayoutDashboard,
  ShoppingCart,
  Package,
  Users,
  Store,
  Settings,
  Menu,
  ShieldCheck,
  ArrowLeftRight,
  BarChart,
  Contact,
  LogOut,
  Truck,
  ClipboardCheck,
  CreditCard,
  FileText,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  Headphones,
  Download,
  Smartphone,
  BookOpen,
  CircleDollarSign,
  Landmark,
  Sparkles,
  Lock
} from "lucide-react";
import React, { useState, useEffect, useRef } from "react";
import { cn } from "../lib/utils";
import { loadSaaSContext } from "../services/saas";
import { useStore } from "../store/useStore";
import { PalmyraWordmark } from "./PalmyraWordmark";
import { SocialLinks } from "./SocialLinks";
import { LicenseReadOnlyBanner } from "./LicenseReadOnlyBanner";
import { getOfflineConflictCount, getOfflineQueueCount, getOfflineQueue, refreshOfflineQueueCounts } from "../services/offlineQueue";
import { describeQueueItemFailure, describeOfflineQueueType, describeSyncFailure } from "../services/offline/syncContract";
import { runWithLoading } from "../lib/busy";
import { PRODUCT_VERSION_LABEL, PRODUCT_VERSION_SHORT } from "../lib/productVersion";
import { ANDROID_APK_DOWNLOAD, APK_PROMO_DISMISSED_KEY, isAndroidDevice, isPalmyraApp } from "../lib/install";
import { useAppUpdateRuntime } from "../hooks/useAppUpdateRuntime";
import { useDesktopUpdate } from "../hooks/useDesktopUpdate";
import { useCloudSync } from "../hooks/useCloudSync";
import { useLegacyShadowSync } from "../hooks/useLegacyShadowSync";
import { useCloudBackup } from "../hooks/useCloudBackup";
import { DESKTOP_UPDATE_STATUS_LABELS } from "../lib/desktopUpdate";
import { useAutoRateSync } from "../hooks/useAutoRateSync";
import { useLanPresence } from "../hooks/useLanPresence";
import { canUsePlanFeature, getPlanDisplayName, getPlanVisual, type PlanFeature } from "../services/planAccess";
import { 
  CheckCircle2, 
  AlertTriangle, 
  X, 
  Info, 
  AlertCircle,
  Loader2
} from "lucide-react";

const adminNavItems = [
  { name: "Dashboard", href: "/", icon: LayoutDashboard, permission: "reports.view" },
  { name: "POS", href: "/pos", icon: ShoppingCart, permission: "pos.access" },
  { name: "Transferencias", href: "/transfers", icon: ArrowLeftRight, permission: "inventory.manage", requiredFeature: "transfers" as PlanFeature },
  { name: "Clientes", href: "/customers", icon: Contact, permission: "customers.manage", requiredFeature: "customers_suppliers" as PlanFeature },
  { name: "Cotizaciones", href: "/quotes", icon: FileText, permission: "pos.access" },
  { name: "Inventario", href: "/inventory", icon: Package, permission: "inventory.manage" },
  { name: "Auditoría", href: "/inventory-audit", icon: ClipboardCheck, permission: "inventory.manage", requiredFeature: "inventory_audit" as PlanFeature },
  { name: "Proveedores", href: "/suppliers", icon: Truck, permission: "suppliers.manage", requiredFeature: "customers_suppliers" as PlanFeature },
  { name: "Bancos", href: "/banks", icon: Landmark, permission: "settings.manage", requiredFeature: "banking" as PlanFeature },
  { name: "Garantías y devoluciones", href: "/returns", icon: ShieldCheck, permission: "pos.access", requiredFeature: "warranty_returns" as PlanFeature },
  { name: "Reportes", href: "/reports", icon: BarChart, permission: "reports.view" },
  { name: "Configuración", href: "/settings", icon: Settings, public: true },
  { name: "Equipo", href: "/team", icon: Users, permission: "employees.manage" },
  { name: "Soporte", href: "/help-center", icon: Headphones, public: true },
  { name: "Plan", href: "/subscription", icon: Sparkles, permission: "settings.manage" },
  { name: "Tasa de cambio", href: "/exchange-rate", icon: CircleDollarSign, public: true },
  { name: "Tutorial", href: "/tutorial", icon: BookOpen, public: true },
];

// Etiqueta visible acordada con el dueño. La versión real del build sigue
// siendo __APP_VERSION__ y es la que comparan el detector de actualizaciones
// y el shell nativo. Los avisos de actualización NUNCA deben usar esta
// etiqueta: muestran la versión detectada en el manifiesto (1.3.x).
const APP_VERSION_LABEL = PRODUCT_VERSION_LABEL;
const APP_VERSION_SHORT = PRODUCT_VERSION_SHORT;
const cashierNavItems = [
  { name: "Configuración", href: "/settings", icon: Settings, public: true },
  { name: "Soporte", href: "/help-center", icon: Headphones, public: true },
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
const PALMYRA_UPDATE_AVAILABLE_KEY = "palmyra:update-available";
// "Ahora no" silencia esa versión concreta durante un rato. Sin esto, el
// chequeo periódico (60 s) volvería a abrir el aviso que el usuario cerró.
const PALMYRA_UPDATE_SNOOZE_KEY = "palmyra:update-snoozed";
const UPDATE_SNOOZE_TTL_MS = 30 * 60_000;

type UpdateSnooze = { version: string; at: number };

function readUpdateSnooze(): UpdateSnooze | null {
  try {
    const raw = window.sessionStorage.getItem(PALMYRA_UPDATE_SNOOZE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<UpdateSnooze>;
    if (typeof parsed?.at !== "number") return null;
    if (Date.now() - parsed.at > UPDATE_SNOOZE_TTL_MS) return null;
    return { version: String(parsed.version || "__unknown__"), at: parsed.at };
  } catch {
    return null;
  }
}

function isUpdateSnoozed(version: string) {
  const snoozed = readUpdateSnooze();
  if (!snoozed) return false;
  return snoozed.version === (version || "__unknown__");
}

function writeUpdateSnooze(version: string) {
  try {
    window.sessionStorage.setItem(
      PALMYRA_UPDATE_SNOOZE_KEY,
      JSON.stringify({ version: version || "__unknown__", at: Date.now() } satisfies UpdateSnooze)
    );
  } catch {}
}
const IS_DESKTOP_SHELL = typeof navigator !== "undefined" && /\bElectron\//i.test(navigator.userAgent);
const IN_PALMYRA_APP = isPalmyraApp();
// "Ocultar"/"Más tarde" silencia solo la fase actual (versión + estado): si la
// descarga termina y queda lista para instalar, el aviso reaparece.
const DESKTOP_UPDATE_DISMISSED_KEY = "palmyra:desktop-update-dismissed";

const SIDEBAR_COLLAPSED_KEY = "palmyra:sidebar-collapsed";

function readSidebarCollapsed() {
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

type OfflineIndicatorState = "online" | "offline" | "syncing";

function formatOfflineCount(value: number): string {
  return value > 99 ? "99+" : String(value);
}

function offlineStatusSpeech(state: OfflineIndicatorState, pending: number, conflicts: number): string {
  const backlog = conflicts > 0
    ? `${conflicts} operación(es) en conflicto y ${pending} pendiente(s).`
    : pending > 0
      ? `${pending} operación(es) pendientes de sincronizar.`
      : "No hay operaciones pendientes.";
  if (state === "offline") return `Sin conexión. ${backlog}`;
  if (state === "syncing") return `Sincronizando con la nube. ${backlog}`;
  return `En línea. ${backlog}`;
}

function offlineStatusTitle(state: OfflineIndicatorState, pending: number, conflicts: number): string {
  if (state === "offline") return "Sin conexión: sigues trabajando y se sincroniza al volver el wifi";
  if (state === "syncing") return "Sincronizando operaciones con la nube…";
  if (conflicts > 0) return `${conflicts} operación(es) en conflicto. Revisa Configuración > Conectividad.`;
  if (pending > 0) return `${pending} operación(es) pendientes de sincronizar`;
  return "Conectado a la nube. Todo sincronizado";
}

function OfflineStatusPill({
  state,
  pending,
  conflicts,
  className
}: {
  state: OfflineIndicatorState;
  pending: number;
  conflicts: number;
  className?: string;
}) {
  const label = state === "offline" ? "Offline" : state === "syncing" ? "Sincronizando" : "Online";
  const tone = state === "offline"
    ? { shell: "border-[color-mix(in_srgb,var(--warning)_40%,transparent)] bg-[color-mix(in_srgb,var(--warning)_12%,var(--bg-secondary))] text-[var(--warning)]", dot: "bg-[var(--warning)]" }
    : state === "syncing"
      ? { shell: "border-[color-mix(in_srgb,var(--primary)_40%,transparent)] bg-[color-mix(in_srgb,var(--primary)_12%,var(--bg-secondary))] text-[var(--primary)]", dot: "bg-[var(--primary)] animate-pulse" }
      : { shell: "border-[color-mix(in_srgb,var(--success)_40%,transparent)] bg-[color-mix(in_srgb,var(--success)_12%,var(--bg-secondary))] text-[var(--success)]", dot: "bg-[var(--success)]" };
  // Sin trabajo real no se muestra burbuja: solo el estado, sin números fantasma.
  const badge = conflicts > 0
    ? { text: `!${formatOfflineCount(conflicts)}`, className: "palmyra-badge palmyra-badge-danger" }
    : pending > 0
      ? { text: formatOfflineCount(pending), className: "palmyra-badge palmyra-badge-warning" }
      : null;
  return (
    <span className={cn("palmyra-pill min-w-0 border uppercase tracking-wide", tone.shell, className)}>
      <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", tone.dot)} aria-hidden="true" />
      <span className="min-w-0 truncate">{label}</span>
      {badge && (
        <span className={cn("ml-auto shrink-0 tabular-nums", badge.className)}>
          {badge.text}
        </span>
      )}
    </span>
  );
}

export default function Layout({ children }: { children: React.ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarCollapsed);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [pendingOfflineCount, setPendingOfflineCount] = useState(getOfflineQueueCount());
  const [conflictOfflineCount, setConflictOfflineCount] = useState(getOfflineConflictCount());
  const [isSyncingOffline, setIsSyncingOffline] = useState(false);
  const [expandedNotificationId, setExpandedNotificationId] = useState<string | null>(null);
  const [isNavigating, setIsNavigating] = useState(false);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [serverVersion, setServerVersion] = useState<string | null>(null);
  const [navigationTargetPath, setNavigationTargetPath] = useState<string | null>(null);
  const navigationTimerRef = useRef<number | null>(null);
  const [saasContext, setSaaSContext] = useState<Awaited<ReturnType<typeof loadSaaSContext>>>(null);
  const [countdownNow, setCountdownNow] = useState(() => Date.now());
  const [showApkPromo, setShowApkPromo] = useState(false);
  const [desktopUpdateDismissed, setDesktopUpdateDismissed] = useState("");
  const [desktopInstalling, setDesktopInstalling] = useState(false);
  const [showOnlineCatalogInfo, setShowOnlineCatalogInfo] = useState(false);
  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false);
  const [logoutConfirmPendingCount, setLogoutConfirmPendingCount] = useState(0);
  const { currentUser, logout, notifications, removeNotification, storeConfig, syncWithSupabase, addNotification, cart, currentBranchId, getCurrentSession } = useStore(useShallow((state) => ({ currentUser: state.currentUser, logout: state.logout, notifications: state.notifications, removeNotification: state.removeNotification, storeConfig: state.storeConfig, syncWithSupabase: state.syncWithSupabase, addNotification: state.addNotification, cart: state.cart, currentBranchId: state.currentBranchId, getCurrentSession: state.getCurrentSession })));
  const location = useLocation();
  const navigate = useNavigate();
  const isPosPage = location.pathname === "/pos";
  const activeWarehouseName = useStore(state => state.branches.find(branch => branch.id === state.currentBranchId)?.name || null);
  useAutoRateSync();
  useLanPresence(activeWarehouseName);
  // Subida por cursores del journal local; en la web de registro queda inerte.
  useCloudSync();
  // Reflejo del JSON legado en el almacén normalizado (SQLite/IndexedDB).
  useLegacyShadowSync();
  // Respaldo cifrado diario en la nube; sin sesión o internet queda inerte.
  useCloudBackup();
  // Actualización de escritorio (Electron + electron-updater por IPC). Fuera del
  // shell Electron el controlador queda inerte y manda el flujo web/Android.
  const desktopUpdate = useDesktopUpdate();
  // Manifiesto firmado: runtime único compartido con el Centro de actualizaciones.
  const { state: updateState, dismiss: dismissUpdateVersion, isDismissed: isUpdateDismissed } =
    useAppUpdateRuntime();

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, sidebarCollapsed ? "1" : "0");
    } catch {}
  }, [sidebarCollapsed]);

  useEffect(() => {
    // El descarte sobrevive a recargas internas de la ventana, pero no a un
    // reinicio: si la actualización sigue pendiente, se vuelve a avisar.
    try { setDesktopUpdateDismissed(window.sessionStorage.getItem(DESKTOP_UPDATE_DISMISSED_KEY) || ""); } catch {}
  }, []);


  useEffect(() => {
    if (!currentUser?.id || IS_DESKTOP_SHELL || IN_PALMYRA_APP || !isAndroidDevice()) {
      setShowApkPromo(false);
      return;
    }
    // En Android el APK nativo es la única forma de operar: se recomienda al
    // entrar desde la web (por ejemplo, al gestionar el plan).
    let dismissed = false;
    try { dismissed = window.localStorage.getItem(APK_PROMO_DISMISSED_KEY) === '1'; } catch {}
    setShowApkPromo(!dismissed);
  }, [currentUser?.id]);

  const dismissApkPromo = (remember: boolean) => {
    setShowApkPromo(false);
    if (!remember) return;
    try { window.localStorage.setItem(APK_PROMO_DISMISSED_KEY, '1'); } catch {}
  };

  useEffect(() => {
    // El contador del plan se muestra en días/horas/minutos: un tick de 1 s
    // re-renderizaba todo el shell cada segundo en equipos lentos. 30 s basta,
    // y con la pestaña oculta no se actualiza.
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") setCountdownNow(Date.now());
    }, 30_000);
    const onVisibility = () => {
      if (document.visibilityState === "visible") setCountdownNow(Date.now());
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  useEffect(() => {
    let active = true;
    let lastRefreshAt = 0;

    // Cada refresco hace getUser + varias consultas REST. El contexto cambia
    // por aprobación de plan o cambios de empresa: con 12 h, al enfocar y al
    // recuperar internet sobra, y se evita castigar la API de Supabase.
    const refreshContext = async (force = false) => {
      if (!active) return;
      if (typeof navigator !== 'undefined' && !navigator.onLine) return;
      const now = Date.now();
      if (!force && now - lastRefreshAt < 15 * 60 * 1000) return;
      lastRefreshAt = now;
      try {
        const ctx = await loadSaaSContext(true);
        if (active) setSaaSContext(ctx);
      } catch {
        // La interfaz continúa con el último contexto válido. App.tsx mantiene
        // la hidratación principal de acceso y reintentará si fuese necesario.
      }
    };

    void refreshContext(true);

    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refreshContext();
    }, 12 * 60 * 60 * 1000);

    const handleFocus = () => {
      if (document.visibilityState === 'visible') void refreshContext();
    };
    const handleOnline = () => {
      if (document.visibilityState === 'visible') void refreshContext(true);
    };
    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleFocus);
    window.addEventListener("online", handleOnline);

    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleFocus);
      window.removeEventListener("online", handleOnline);
    };
  }, [currentUser?.id]);

  const loadingLabelByPath: Record<string, string> = {
    "/": "Cargando Dashboard…",
    "/pos": "Cargando Punto de Venta…",
    "/inventory": "Cargando Inventario…",
    "/inventory-audit": "Cargando Auditoría de Stock…",
    "/transfers": "Cargando Transferencias…",
    "/customers": "Cargando Clientes…",
  "/quotes": "Cargando Cotizaciones…",
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
    // En el shell de escritorio la ÚNICA actualización válida es la de
    // electron-updater (IPC). El aviso PWA del servidor local queda apagado
    // aquí para que nunca aparezcan dos avisos de actualización.
    if (IS_DESKTOP_SHELL) {
      setUpdateAvailable(false);
      return;
    }

    const onUpdate = (event: Event) => {
      const detail = (event as CustomEvent<{ version?: string }>).detail;
      let version = detail?.version || "";
      if (!version) {
        try { version = window.localStorage.getItem("palmyra:update-version") || ""; } catch {}
      }
      // El usuario ya dijo "Ahora no" a esta misma versión.
      if (isUpdateSnoozed(version)) return;
      setUpdateAvailable(true);
      if (version) setServerVersion(version);
    };
    const checkPersistedUpdate = () => {
      try {
        if (window.localStorage.getItem(PALMYRA_UPDATE_AVAILABLE_KEY) === '1') {
          const version = window.localStorage.getItem("palmyra:update-version") || "";
          if (isUpdateSnoozed(version)) return;
          setUpdateAvailable(true);
          if (version) setServerVersion(version);
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
    let active = true;
    const updateCount = () => {
      if (!active) return;
      setPendingOfflineCount(getOfflineQueueCount());
      setConflictOfflineCount(getOfflineConflictCount());
    };
    // El contador en memoria puede quedar viejo: otra pestaña drenó la cola con
    // el Web Lock, se cambió de empresa o una sincronización terminó sin emitir
    // el evento. Releemos siempre desde IndexedDB (fuente de verdad).
    const refreshCount = async () => {
      try {
        const counts = await refreshOfflineQueueCounts();
        if (!active) return;
        setPendingOfflineCount(counts.pending);
        setConflictOfflineCount(counts.conflicts);
      } catch {
        updateCount();
      }
    };
    const handleOnline = () => {
      setIsOnline(true);
      updateCount();
      void refreshCount();
    };
    const handleOffline = () => {
      setIsOnline(false);
      updateCount();
      void refreshCount();
    };
    const handleQueueUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ pendingCount?: number; count?: number; conflictCount?: number; origin?: string }>).detail;
      if (detail && typeof detail.pendingCount === 'number') {
        setPendingOfflineCount(detail.pendingCount);
        setConflictOfflineCount(typeof detail.conflictCount === 'number' ? detail.conflictCount : 0);
      } else {
        updateCount();
      }
      // 'refresh' ya viene validado contra IndexedDB: no se repite la lectura
      // (evitaría un bucle de eventos). Solo una mutación local pide confirmar.
      if (detail?.origin === 'refresh') return;
      // Confirma contra el almacén durable; así también se limpia el aviso si
      // la operación ya no existe (por ejemplo, la drenó otra ventana).
      window.setTimeout(() => { void refreshCount(); }, 200);
    };
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') void refreshCount();
    };
    const handleStorageWarning = () => {
      addNotification('Almacenamiento local casi lleno', 'warning', 'PALMYRA detectó poco espacio disponible. No borres los datos del sitio mientras haya ventas offline pendientes. Sincroniza primero.');
    };

    // Recomputar al montar (la hidratación de IndexedDB puede terminar después).
    updateCount();
    void refreshCount();

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    window.addEventListener('offline_queue_updated', handleQueueUpdated);
    window.addEventListener('focus', handleVisibility);
    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('palmyra:storage-warning', handleStorageWarning);
    // Intervalo acotado: mientras haya conexión comprobamos la cola durable
    // para que el indicador nunca quede con un número viejo.
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if (!navigator.onLine) return;
      void refreshCount();
    }, 30_000);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('offline_queue_updated', handleQueueUpdated);
      window.removeEventListener('focus', handleVisibility);
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('palmyra:storage-warning', handleStorageWarning);
    };
  }, [addNotification]);

  // ─── Actualización de escritorio (electron-updater por IPC) ───
  // Solo existe dentro del shell Electron; en navegador/APK queda inerte.
  const desktopUpdateState = IS_DESKTOP_SHELL ? desktopUpdate.state : null;
  const desktopUpdateStatus = desktopUpdateState?.status ?? "idle";
  const desktopUpdateVersion = desktopUpdateState?.version || desktopUpdateState?.currentVersion || "";
  const desktopUpdatePercent = Math.min(100, Math.max(0, Math.round(desktopUpdateState?.percent ?? 0)));
  const desktopUpdateReady = desktopUpdateStatus === "downloaded";
  const desktopUpdateFailed = desktopUpdateStatus === "error";
  // Fase actual descartada por el usuario (versión + estado). Una fase nueva,
  // por ejemplo "descargada", vuelve a mostrar el aviso.
  const desktopUpdateDismissKey = `${desktopUpdateVersion}|${desktopUpdateStatus}`;
  const desktopUpdateIsDismissed = desktopUpdateDismissed === desktopUpdateDismissKey;
  const desktopUpdateProgressVisible =
    Boolean(desktopUpdateState) &&
    !desktopUpdateReady &&
    !desktopUpdateIsDismissed &&
    (desktopUpdateStatus === "available" || desktopUpdateStatus === "downloading" || desktopUpdateFailed);
  const desktopUpdateReadyVisible = Boolean(desktopUpdateState) && desktopUpdateReady && !desktopUpdateIsDismissed;

  // El aviso de cola solo existe si hay trabajo real: pendientes o conflictos.
  // Con 0/0 no se renderiza ninguna burbuja, para no sugerir una cola fantasma.
  const safePendingOfflineCount = Number.isFinite(pendingOfflineCount) ? Math.max(0, Math.trunc(pendingOfflineCount)) : 0;
  const safeConflictOfflineCount = Number.isFinite(conflictOfflineCount) ? Math.max(0, Math.trunc(conflictOfflineCount)) : 0;
  const hasQueueBacklog = safePendingOfflineCount > 0 || safeConflictOfflineCount > 0;
  const offlineIndicatorState: OfflineIndicatorState = !isOnline ? "offline" : isSyncingOffline ? "syncing" : "online";
  const offlineStatusSpeechText = offlineStatusSpeech(offlineIndicatorState, safePendingOfflineCount, safeConflictOfflineCount);
  const offlineStatusTitleText = offlineStatusTitle(offlineIndicatorState, safePendingOfflineCount, safeConflictOfflineCount);

  // ─── Aviso unificado de actualización (APK, PC y PWA) ───
  // El runtime del manifiesto firmado publica "available" con la versión nueva
  // en las tres superficies por igual (sin depender de sesión de Supabase); en
  // web/PWA se suma la marca legada del service worker. La burbuja nunca
  // bloquea el POS y su acción principal abre Configuración → Sistema, donde se
  // comprueba y se aplica la actualización.
  const runtimeUpdateVersion = updateState.phase === "available" ? updateState.result?.version || "" : "";
  const runtimeUpdateDismissed = runtimeUpdateVersion !== "" && isUpdateDismissed(runtimeUpdateVersion);
  const webUpdateVersion = (() => {
    if (IN_PALMYRA_APP || IS_DESKTOP_SHELL || !updateAvailable) return "";
    const version = serverVersion || (() => {
      try { return window.localStorage.getItem("palmyra:update-version") || ""; } catch { return ""; }
    })();
    return isUpdateSnoozed(version) ? "" : version;
  })();
  const entryUpdateVersion = runtimeUpdateVersion !== "" && !runtimeUpdateDismissed ? runtimeUpdateVersion : webUpdateVersion;
  // En escritorio la burbuja cede cuando electron-updater ya ofrece su propia
  // acción ("Reiniciar e instalar"); en la propia pestaña Sistema no se duplica.
  const entryUpdateVisible =
    entryUpdateVersion !== "" &&
    !(IS_DESKTOP_SHELL && desktopUpdateReadyVisible) &&
    !(location.pathname === "/settings" && new URLSearchParams(location.search).get("section") === "system");

  const handleEntryUpdateGo = () => {
    navigate("/settings?section=system");
  };

  const handleEntryUpdateDismiss = () => {
    // Se silencian las dos fuentes: la burbuja no debe reaparecer por la otra vía.
    if (runtimeUpdateVersion !== "" && !runtimeUpdateDismissed) {
      dismissUpdateVersion(runtimeUpdateVersion);
    }
    if (webUpdateVersion !== "") {
      try { writeUpdateSnooze(webUpdateVersion); } catch {}
    }
    try { localStorage.removeItem(PALMYRA_UPDATE_AVAILABLE_KEY); } catch {}
    setUpdateAvailable(false);
    setServerVersion(null);
  };

  // Ocultar el aviso de escritorio sin frenar la descarga: el Setup se sigue
  // bajando en segundo plano y se aplicará al cerrar PALMYRA.
  const handleDesktopUpdateLater = () => {
    if (desktopInstalling) return;
    try { window.sessionStorage.setItem(DESKTOP_UPDATE_DISMISSED_KEY, desktopUpdateDismissKey); } catch {}
    setDesktopUpdateDismissed(desktopUpdateDismissKey);
  };

  const handleDesktopUpdateRetry = () => {
    void desktopUpdate.retry();
  };

  const handleDesktopUpdateInstall = async () => {
    if (desktopInstalling) return;
    // Igual que el OTA Android: nunca reiniciar en medio de una venta.
    const activeSession = currentUser?.id ? getCurrentSession(currentBranchId, currentUser.id) : undefined;
    if (isPosPage && activeSession && cart.length > 0) {
      addNotification(
        'Actualización preparada',
        'info',
        'Finaliza o limpia la venta actual antes de reiniciar PALMYRA. La caja y los datos permanecen protegidos.'
      );
      return;
    }
    setDesktopInstalling(true);
    const result = await desktopUpdate.install();
    if (result.ok) {
      // La app se reinicia sola con la versión nueva. Si el instalador no
      // llegara a arrancar, el botón no puede quedar bloqueado para siempre.
      window.setTimeout(() => {
        setDesktopInstalling(false);
        addNotification(
          'Actualización pendiente',
          'info',
          'Cierra y vuelve a abrir PALMYRA para aplicar la actualización ya descargada.'
        );
      }, 90_000);
      return;
    }
    setDesktopInstalling(false);
    addNotification(
      'No se pudo aplicar la actualización',
      'error',
      result.error || 'Cierra y vuelve a abrir PALMYRA para aplicar la actualización descargada.'
    );
  };

  const handleLogoutClick = () => {
    const pending = getOfflineQueueCount();
    if (pending > 0) {
      setLogoutConfirmPendingCount(pending);
      setLogoutConfirmOpen(true);
      return;
    }
    logout();
  };

  useEffect(() => {
    if (!logoutConfirmOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setLogoutConfirmOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [logoutConfirmOpen]);

  const handleManualSync = async () => {
    if (!isOnline || isSyncingOffline) return;
    setIsSyncingOffline(true);
    await runWithLoading('Sincronizando con la nube…', async () => {
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
      // processOfflineQueue ya espera la hidratación durable antes de procesar.
      // El diagnóstico no depende de otra exportación del módulo de cola para
      // evitar incompatibilidades entre chunks PWA de distintas versiones.
      const finalQueue = getOfflineQueue();
      const finalPendingCount = finalQueue.filter((item: any) => item?.status !== 'conflict').length;
      setPendingOfflineCount(finalPendingCount);
      setConflictOfflineCount(finalQueue.filter((item: any) => item?.status === 'conflict').length);
      if (finalPendingCount > 0 || cloudResult?.success === false) {
        // Nunca ocultar la causa: cada operación pendiente debe quedar trazable
        // por tipo, referencia, estado, reintentos y causa legible. La causa se
        // lee del contrato persistido (`failureReason`/`failureCode`/`failureAt`)
        // y, si una versión anterior dejó el elemento sin ella, se nombra igual
        // el tipo de operación, los reintentos y el último error conocido —
        // nunca un callejón sin salida. Ver offline/syncContract.ts.
        const queueDetails = finalQueue
          .slice(0, 30)
          .map((item: any) => describeQueueItemFailure(item));
        const permanentConflicts = finalQueue.filter((item: any) => item?.status === 'conflict');
        const detailLines = [
          `Resultado de esta sincronización: ${res.processed} procesadas, ${res.failed} fallidas, ${res.remaining} restantes.`,
          ...(res.errors || []).map(e => `${describeOfflineQueueType(e.type)} · ${e.actionId}: ${describeSyncFailure(e.message, e.type)}`),
          ...(cloudResult?.errors || []).map((e: string) => `Nube: ${e}`),
          cloudResult?.success === false && cloudResult?.message ? `Sincronización nube: ${cloudResult.message}` : '',
          ...queueDetails,
          permanentConflicts.length > 0
            ? `${permanentConflicts.length} operación(es) rechazadas de forma definitiva: no se volverán a reintentar. Repítelas en el almacén correcto o elimínalas desde Configuración > Monitor de Logs.`
            : ''
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
      // La cola pudo drenarse sin que este componente recibiera el evento
      // (o con pendientes que ya no existen). Relee la fuente durable.
      void refreshOfflineQueueCounts().then((counts) => {
        setPendingOfflineCount(counts.pending);
        setConflictOfflineCount(counts.conflicts);
      }).catch(() => {});
    }
    });
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

  const baseNavItems = navItems.length > 0 ? navItems : cashierNavItems;
  const visibleNavItems = baseNavItems.filter(
    (item, index, items) => items.findIndex((candidate) => candidate.href === item.href) === index
  );
  const currentPlanCode = saasContext?.subscription?.planCode || "";
  // Sin plan cargado (perfil en tránsito) no hay bloqueos: evita pintar el badge de plan
  // sobre todas las secciones durante el primer render.
  const isPlanLocked = (item: { requiredFeature?: PlanFeature }) => Boolean(currentPlanCode && item.requiredFeature && !canUsePlanFeature(currentPlanCode, item.requiredFeature));
  const getRequiredPlanCode = (feature?: PlanFeature) => feature === 'advanced_analytics' || feature === 'excel_exports' || feature === 'ai_dashboard' || feature === 'warranty_returns' || feature === 'abc_analysis' || feature === 'labels' ? 'pro' : feature ? 'growth' : '';

  const navSectionDefinitions = currentUser?.role === "admin"
    ? [
        { label: "Operación", hrefs: ["/", "/pos", "/quotes", "/transfers", "/returns"] },
        { label: "Gestión", hrefs: ["/customers", "/inventory", "/inventory-audit", "/suppliers"] },
        { label: "Finanzas", hrefs: ["/banks", "/reports"] },
        { label: "Administración", hrefs: ["/settings", "/team", "/help-center", "/subscription", "/tutorial", "/exchange-rate"] },
      ]
    : [{ label: "", hrefs: visibleNavItems.map((item) => item.href) }];
  const assignedNavHrefs = new Set<string>();
  const navSections = navSectionDefinitions.map((section) => ({
    ...section,
    items: visibleNavItems.filter((item) => {
      if (!section.hrefs.includes(item.href) || assignedNavHrefs.has(item.href)) return false;
      assignedNavHrefs.add(item.href);
      return true;
    }),
  })).filter((section) => section.items.length > 0);

  return (
    <div className="h-[100dvh] w-full min-h-[100dvh] max-h-[100dvh] overflow-hidden bg-primary text-primary flex flex-col lg:flex-row relative overscroll-none transition-colors duration-200">
      <span className="sr-only" aria-live="polite">{offlineStatusSpeechText}</span>

      {showApkPromo && currentUser && (
        <div className="fixed inset-x-3 bottom-3 sm:inset-auto sm:right-4 sm:bottom-4 z-[var(--z-toast)]">
          <div className="w-full sm:w-[min(23rem,calc(100vw-2rem))] rounded-2xl border border-emerald-200/80 bg-white/95 dark:bg-slate-900/95 dark:border-emerald-900/50 shadow-2xl backdrop-blur-md p-3">
            <div className="flex items-start gap-2.5">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300">
                <Smartphone className="w-4 h-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[9px] font-black uppercase tracking-[0.11em] text-primary"> Mejor en Android con el APK</p>
                  <button type="button" onClick={() => dismissApkPromo(false)} className="p-1 rounded-lg text-muted hover:bg-subtle" aria-label="Cerrar aviso">
                    <X className="w-3 h-3" />
                  </button>
                </div>
                <p className="mt-1 text-[7.5px] font-bold leading-4 text-muted">
                  Estás entrando desde el navegador. La operación solo funciona en la app instalada: descarga el APK
                  oficial de Android para abrir más rápido y trabajar 100% offline.
                </p>
                <div className="mt-2 flex flex-col sm:flex-row gap-1.5">
                  <a
                    href={ANDROID_APK_DOWNLOAD}
                    download
                    onClick={() => dismissApkPromo(true)}
                    className="h-9 flex-1 rounded-xl bg-emerald-600 text-white text-[8px] font-black uppercase tracking-[0.08em] flex items-center justify-center gap-1.5 hover:bg-emerald-700"
                  >
                    <Download className="w-3 h-3" /> Descargar APK
                  </a>
                  <button
                    type="button"
                    onClick={() => dismissApkPromo(false)}
                    className="h-9 px-3 rounded-xl border border-base bg-primary text-[8px] font-black uppercase tracking-[0.08em] text-muted hover:bg-subtle"
                  >
                    Más tarde
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => dismissApkPromo(true)}
                  className="mt-1.5 w-full text-[7px] font-bold uppercase tracking-wider text-muted/80 hover:text-primary"
                >
                  No volver a mostrar
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Sistema de Notificaciones Globales */}
      <div className="fixed top-4 right-4 z-[var(--z-toast)] flex flex-col gap-2 pointer-events-none" aria-live="polite">
        {notifications.map((n) => (
          <div 
            key={n.id} 
            className={cn(
              "pointer-events-auto w-[calc(100vw-2rem)] max-w-sm min-w-0 p-4 rounded-2xl shadow-2xl border flex items-center gap-3 animate-in slide-in-from-right-4 duration-300",
              n.type === 'success' ? "bg-emerald-50 border-emerald-100 text-emerald-800" :
              n.type === 'error' ? "bg-rose-50 border-rose-100 text-rose-800" :
              n.type === 'warning' ? "bg-amber-50 border-amber-100 text-amber-800" :
              n.type === 'loading' ? "bg-violet-50 border-violet-100 text-violet-800 dark:bg-violet-950/40 dark:border-violet-900/50 dark:text-violet-200" :
              "bg-rose-50 border-rose-100 text-rose-800"
            )}
          >
            <div className="shrink-0">
              {n.type === 'success' && <CheckCircle2 className="w-5 h-5 text-emerald-500" />}
              {n.type === 'error' && <AlertCircle className="w-5 h-5 text-rose-500" />}
              {n.type === 'warning' && <AlertTriangle className="w-5 h-5 text-amber-500" />}
              {n.type === 'info' && <Info className="w-5 h-5 text-rose-500" />}
              {n.type === 'loading' && <Loader2 className="w-5 h-5 animate-spin text-violet-600 dark:text-violet-300" />}
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
        <div className="lg:hidden flex min-w-0 shrink-0 items-center justify-between gap-1.5 border-b border-base bg-secondary px-2 py-1.5 text-primary shadow-sm">
          <div className="flex min-w-0 items-center gap-1.5">
            <PalmyraWordmark className="h-[26px] w-[clamp(84px,30vw,128px)] shrink-0" />
            <span className="hidden shrink-0 rounded-full bg-violet-50 px-1.5 py-0.5 text-[8px] font-black tracking-tight text-violet-700 min-[480px]:inline-flex">
              {APP_VERSION_SHORT}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <div title={offlineStatusTitleText}>
              <OfflineStatusPill
                state={offlineIndicatorState}
                pending={safePendingOfflineCount}
                conflicts={safeConflictOfflineCount}
              />
            </div>
            <button
              data-palmy-menu-toggle
              type="button"
              onClick={() => setSidebarOpen(!sidebarOpen)}
              className="flex h-9 w-9 items-center justify-center rounded-lg transition hover:bg-slate-100 dark:hover:bg-slate-800"
              aria-label={sidebarOpen ? "Cerrar menú principal" : "Abrir menú principal"}
              title="Abrir menú principal"
              aria-expanded={sidebarOpen}
            >
              <Menu className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      <aside
        data-palmy-sidebar="true"
        aria-label="Menú principal"
        role={sidebarOpen ? "dialog" : undefined}
        aria-modal={sidebarOpen ? true : undefined}
        className={cn(
          "bg-secondary border-r border-base transition-all duration-300 ease-in-out flex flex-col h-full shrink-0 shadow-sm",
          // Mobile: off-canvas drawer with fixed overlay
          "fixed inset-y-0 left-0 z-50 w-[72vw] max-w-[232px] overflow-hidden",
          sidebarOpen ? "translate-x-0" : "-translate-x-full",
          // Desktop (lg+): relative in-flow column, NEVER covers or overlaps the right content
          "lg:relative lg:inset-auto lg:z-auto lg:translate-x-0",
          sidebarCollapsed
            ? "lg:w-14"
            : "lg:w-48 xl:w-[13rem] 2xl:w-56"
        )}
      >
        {/* Header with Collapse toggle */}
        <div className={cn(
          "p-2 shrink-0 border-b border-subtle",
          sidebarCollapsed
            ? "flex items-center justify-between gap-1.5 lg:flex-col lg:justify-center lg:gap-1 lg:p-1.5"
            : "flex items-center justify-between gap-1.5"
        )}>
          <div className={cn("flex items-center gap-1 min-w-0 flex-1 pr-0", sidebarCollapsed && "lg:hidden")}>
            <PalmyraWordmark className="w-[84px] h-[23px] max-w-[calc(100%-2rem)] shrink-0" />
            <span className="hidden shrink-0 rounded-full bg-subtle px-1.5 py-1 text-[8px] font-black text-primary tracking-tight leading-none xl:inline-flex">{APP_VERSION_LABEL}</span>
          </div>

          <div className={cn("hidden items-center justify-center", sidebarCollapsed && "lg:flex")}>
            <img
              src="/palmyra-mark-exact.svg"
              alt="PALMYRA"
              className="h-7 w-7 object-contain"
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
            className={cn(
              "hidden lg:flex shrink-0 items-center justify-center rounded-lg text-muted hover:text-primary hover:bg-subtle transition-colors",
              sidebarCollapsed ? "h-6 w-6" : "p-1.5"
            )}
            title={sidebarCollapsed ? "Expandir menú" : "Minimizar menú"}
            aria-label={sidebarCollapsed ? "Expandir menú" : "Minimizar menú"}
          >
            {sidebarCollapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
          </button>
        </div>

        <nav className="flex-1 min-h-0 px-1.5 py-2 overflow-y-auto custom-scrollbar">
          {navSections.map((section, sectionIndex) => (
            <div key={section.label || `section-${sectionIndex}`} className={cn(sectionIndex > 0 && !sidebarCollapsed ? "mt-2" : "")}>
              {!sidebarCollapsed && section.label && (
                <div className="px-2 pb-0.5 text-[7px] font-black uppercase tracking-[0.18em] text-muted/70">
                  {section.label}
                </div>
              )}
              <div className="space-y-0.5">
                {section.items.map((item) => {
                  const Icon = item.icon;
                  const locked = isPlanLocked(item as { requiredFeature?: PlanFeature });
                  const requiredCode = getRequiredPlanCode((item as { requiredFeature?: PlanFeature }).requiredFeature);
                  const requiredPlanName = getPlanDisplayName(requiredCode);
                  const planVisual = getPlanVisual(requiredCode);
                  const comingSoon = Boolean((item as any).comingSoon);
                  return (
                    <NavLink
                      key={item.href}
                      to={item.href}
                      aria-current={location.pathname === item.href ? "page" : undefined}
                      onClick={(event) => {
                        if (comingSoon) {
                          event.preventDefault();
                          setShowOnlineCatalogInfo(true);
                          setSidebarOpen(false);
                          return;
                        }
                        setSidebarOpen(false);
                        startNavigationFeedback(item.href);
                      }}
                      title={sidebarCollapsed ? (locked ? `${item.name} · Requiere plan ${requiredPlanName}` : item.name) : undefined}
                    >
                      {({ isActive }) => {
                        const active = isActive && !comingSoon;
                        return (
                          <div
                            className={cn(
                              "group relative flex min-w-0 items-center rounded-lg transition-colors duration-150",
                              sidebarCollapsed ? "justify-center p-2 my-0.5" : "gap-2 px-2.5 py-1.5",
                              active
                                ? "bg-[var(--primary)] text-white shadow-sm"
                                : "text-muted hover:bg-subtle hover:text-[var(--primary)]"
                            )}
                          >
                            <Icon className={cn(
                              "w-4 h-4 shrink-0 transition-colors",
                              active ? "text-white" : "text-muted group-hover:text-[var(--primary)]"
                            )} />
                            {sidebarCollapsed && locked && (
                              <span
                                className="pointer-events-none absolute right-1 top-1 flex h-3 w-3 items-center justify-center rounded-full border border-white bg-[var(--primary)] text-white shadow-sm dark:border-slate-900"
                                title={`Requiere plan ${requiredPlanName}`}
                              >
                                <Lock className="h-2 w-2" aria-hidden="true" />
                              </span>
                            )}
                            {!sidebarCollapsed && (
                              <span className="flex min-w-0 flex-1 items-center gap-1.5">
                                <span
                                  className="min-w-0 flex-1 truncate font-black text-[10px] uppercase tracking-[-0.005em] leading-[1.2]"
                                  title={item.name}
                                >
                                  {item.name}
                                </span>
                                {locked && (
                                  <span
                                    className={cn(
                                      "inline-flex shrink-0 items-center gap-0.5 rounded-full border px-1.5 py-[1px] text-[7px] font-black uppercase leading-tight tracking-tight",
                                      active ? "border-white/30 bg-white/15 text-white" : planVisual.badge
                                    )}
                                    title={`Requiere plan ${requiredPlanName}`}
                                  >
                                    <Lock className="h-2 w-2 shrink-0" aria-hidden="true" />
                                    {requiredPlanName}
                                  </span>
                                )}
                                {!locked && comingSoon && (
                                  <span className="inline-flex shrink-0 rounded-full border border-rose-200 bg-rose-50 px-1.5 py-[1px] text-[7px] font-black uppercase leading-tight tracking-tight text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-300">
                                    Próximamente
                                  </span>
                                )}
                              </span>
                            )}
                          </div>
                        );
                      }}
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
          {sidebarCollapsed ? (
            <button
              type="button"
              onClick={handleManualSync}
              disabled={isSyncingOffline || !isOnline}
              className={cn(
                "relative mx-auto mb-1.5 flex h-8 w-8 items-center justify-center rounded-full border transition-colors disabled:opacity-70",
                !isOnline
                  ? "border-amber-300/80 bg-amber-50 dark:border-amber-900/60 dark:bg-amber-950/40"
                  : isSyncingOffline
                  ? "border-violet-300/80 bg-violet-50 dark:border-violet-900/60 dark:bg-violet-950/40"
                  : "border-emerald-300/80 bg-emerald-50 dark:border-emerald-900/60 dark:bg-emerald-950/40"
              )}
              title={offlineStatusTitleText}
              aria-label={`${offlineStatusTitleText}.${isOnline && hasQueueBacklog ? " Pulsa para sincronizar." : ""}`}
            >
              <span
                className={cn(
                  "h-2 w-2 rounded-full",
                  !isOnline ? "bg-amber-500" : isSyncingOffline ? "bg-violet-500 animate-pulse" : "bg-emerald-500"
                )}
                aria-hidden="true"
              />
              {hasQueueBacklog && (
                <span
                  className={cn(
                    "palmyra-badge absolute -right-1 -top-1 tabular-nums",
                    safeConflictOfflineCount > 0 ? "palmyra-badge-danger" : "palmyra-badge-warning"
                  )}
                >
                  {safeConflictOfflineCount > 0
                    ? `!${formatOfflineCount(safeConflictOfflineCount)}`
                    : formatOfflineCount(safePendingOfflineCount)}
                </span>
              )}
            </button>
          ) : (
            <button
              type="button"
              onClick={handleManualSync}
              disabled={isSyncingOffline || !isOnline}
              className="mb-1.5 flex w-full min-w-0 items-center rounded-full text-left transition-opacity hover:opacity-90 disabled:opacity-70"
              title={offlineStatusTitleText}
              aria-label={`${offlineStatusTitleText}.${isOnline && hasQueueBacklog ? " Pulsa para sincronizar." : ""}`}
            >
              <OfflineStatusPill
                state={offlineIndicatorState}
                pending={safePendingOfflineCount}
                conflicts={safeConflictOfflineCount}
                className="w-full"
              />
            </button>
          )}

          <div className={cn(
            "flex items-center gap-1.5 min-w-0",
            sidebarCollapsed && "lg:flex-col lg:gap-1"
          )}>
            <div
              className="w-6 h-6 rounded-full bg-subtle border border-base flex items-center justify-center text-primary font-black text-[9px] uppercase shrink-0"
              title={sidebarCollapsed ? (currentUser?.name || "Usuario") : undefined}
            >
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
              onClick={handleLogoutClick}
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
              <button
                type="button"
                onClick={() => navigate("/subscription")}
                title="Ver mi plan"
                className={cn("mt-1.5 w-full min-w-0 rounded-lg border px-2 py-1.5 text-left transition-colors hover:border-[var(--primary)]/40", getPlanVisual(subscription?.planCode).border, getPlanVisual(subscription?.planCode).soft)}
              >
                <div className="flex items-center gap-1.5 min-w-0">
                  <div className={cn("w-5 h-5 rounded-md flex items-center justify-center shrink-0", getPlanVisual(subscription?.planCode).soft)}>
                    <Sparkles className={cn("h-2.5 w-2.5", getPlanVisual(subscription?.planCode).text)} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1 min-w-0">
                      <p className={cn("min-w-0 flex-1 truncate text-[7px] font-black uppercase leading-tight tracking-[0.09em]", getPlanVisual(subscription?.planCode).text)}>{subscription.planName || "Plan PALMYRA"}</p>
                      <span className={cn("shrink-0 rounded-full px-1 py-px text-[6.5px] font-black uppercase leading-none tracking-wide", countdown?.expired ? "bg-rose-100 text-rose-700" : "bg-emerald-100 text-emerald-700")}>{statusLabel}</span>
                    </div>
                    <div className="mt-1 flex items-center justify-between gap-1.5 text-[6.5px] font-bold leading-none">
                      <span className="truncate text-primary">Vence {expiryLabel || "—"}</span>
                      <span className={cn("shrink-0 tabular-nums", countdown?.expired ? "text-rose-600 font-black" : getPlanVisual(subscription?.planCode).text)}>{timeLabel}</span>
                    </div>
                  </div>
                </div>
              </button>
            );
          })()}
          {!sidebarCollapsed && <SocialLinks variant="sidebar" />}
          </div>

      </aside>

      <LicenseReadOnlyBanner />

      {(saasContext?.company?.account_status === 'pending_payment' && !!saasContext?.subscription?.graceEndsAt && new Date(saasContext.subscription.graceEndsAt).getTime() <= countdownNow) && location.pathname !== '/subscription' && location.pathname !== '/help' && (
        <div className="palmyra-overlay z-[var(--z-tooltip)] flex items-center justify-center p-4">
          <div className="palmyra-modal-panel w-full max-w-md p-6 text-center">
            <div className="mx-auto w-12 h-12 rounded-2xl bg-amber-100 text-amber-700 flex items-center justify-center"><CreditCard className="w-6 h-6"/></div>
            <p className="mt-4 text-[10px] font-black uppercase tracking-[0.16em] text-amber-700">Periodo de servicio finalizado</p>
            <h3 className="mt-1 text-xl font-black text-slate-900">PALMYRA está en modo lectura</h3>
            <p className="mt-2 text-sm leading-5 text-slate-600">Tus datos, ventas e historial se conservan. Para volver a operar y sincronizar nuevas modificaciones, activa nuevamente tu plan.</p>
            <button type="button" onClick={() => window.location.assign('/subscription')} className="mt-5 w-full h-11 rounded-xl bg-[var(--primary)] hover:bg-[var(--primary-hover)] text-white text-xs font-black uppercase tracking-wider">Ver planes y activar</button>
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
          <div className="fixed top-3 left-1/2 -translate-x-1/2 z-[var(--z-tooltip)] w-[min(92vw,34rem)] rounded-2xl border border-amber-200 bg-amber-50 px-3.5 py-3 shadow-xl">
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

      {/* Actualización de escritorio (electron-updater): durante la descarga el
          aviso es discreto y no bloquea la caja. */}
      {desktopUpdateProgressVisible && (
        <div
          className="fixed bottom-4 right-4 z-[var(--z-tooltip)] w-[min(92vw,20rem)] rounded-2xl border border-violet-200/80 bg-[var(--bg-secondary)] p-3.5 shadow-[0_18px_50px_rgba(76,29,149,0.18)] dark:border-violet-900/60"
          role="status"
          aria-live="polite"
        >
          <div className="flex items-start gap-2.5">
            <div className={cn(
              "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border",
              desktopUpdateFailed
                ? "border-rose-200 bg-rose-50 text-rose-600 dark:border-rose-900/50 dark:bg-rose-950/30 dark:text-rose-300"
                : "border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-900/60 dark:bg-violet-950/40 dark:text-violet-300"
            )}>
              {desktopUpdateFailed ? <AlertTriangle className="h-4 w-4" /> : <Loader2 className="h-4 w-4 animate-spin" />}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[9px] font-black uppercase tracking-[0.14em] text-violet-700 dark:text-violet-300">
                {DESKTOP_UPDATE_STATUS_LABELS[desktopUpdateStatus]}
              </p>
              <p className="mt-1 text-[10px] font-semibold leading-4 text-slate-600 dark:text-slate-300">
                {desktopUpdateFailed
                  ? desktopUpdateState?.error || "No se pudo descargar la actualización. Se reintentará automáticamente."
                  : `${desktopUpdateVersion ? `Versión ${desktopUpdateVersion}` : APP_VERSION_LABEL} · se descarga sola, sin interrumpir la caja.`}
              </p>
              {!desktopUpdateFailed && (
                <div
                  className="mt-2 h-1.5 overflow-hidden rounded-full bg-violet-100 dark:bg-violet-900/50"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={desktopUpdatePercent}
                >
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-violet-600 to-indigo-500 transition-[width] duration-300"
                    style={{ width: `${Math.min(100, Math.max(3, desktopUpdatePercent))}%` }}
                  />
                </div>
              )}
              <div className="mt-2 flex items-center justify-between gap-2">
                <span className="text-[8px] font-black tabular-nums text-violet-600 dark:text-violet-300">
                  {desktopUpdateFailed ? "" : `${desktopUpdatePercent}%`}
                </span>
                <div className="flex items-center gap-2">
                  {desktopUpdateFailed && (
                    <button
                      type="button"
                      onClick={handleDesktopUpdateRetry}
                      className="rounded-lg bg-violet-600 px-2.5 py-1.5 text-[8px] font-black uppercase tracking-[0.08em] text-white transition hover:bg-violet-700"
                    >
                      Reintentar
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={handleDesktopUpdateLater}
                    className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-[8px] font-black uppercase tracking-[0.08em] text-slate-600 transition hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
                  >
                    Ocultar
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* La actualización de escritorio ya está descargada: el usuario decide
          cuándo reiniciar (autoInstallOnAppQuit la aplica al cerrar). */}
      {desktopUpdateReadyVisible && (
        <div className="fixed inset-0 z-[var(--z-tooltip)] flex items-center justify-center px-4 py-6 pointer-events-none bg-[rgb(27_16_48/0.22)] dark:bg-[rgb(6_3_12/0.5)] backdrop-blur-[3px]">
          <div
            className="pointer-events-auto w-full max-w-sm overflow-hidden rounded-[30px] border border-violet-200/70 bg-[var(--bg-secondary)] shadow-[0_28px_90px_rgba(76,29,149,0.24)] dark:border-violet-900/60 dark:shadow-[0_28px_90px_rgba(0,0,0,0.5)]"
            role="dialog"
            aria-modal="true"
            aria-labelledby="palmyra-desktop-update-title"
          >
            <div className="relative overflow-hidden bg-gradient-to-br from-violet-700 via-indigo-600 to-violet-500 px-5 pb-5 pt-5 text-white sm:px-6">
              <div className="absolute -right-10 -top-12 h-32 w-32 rounded-full bg-white/15 blur-2xl" />
              <div className="absolute -bottom-16 left-12 h-28 w-28 rounded-full bg-fuchsia-300/20 blur-2xl" />
              <div className="relative flex items-center gap-3">
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-white/20 bg-white/15 shadow-lg backdrop-blur-sm">
                  {desktopInstalling ? <Loader2 className="h-6 w-6 animate-spin" /> : <Download className="h-6 w-6" />}
                </div>
                <div className="min-w-0">
                  <p className="text-[9px] font-black uppercase tracking-[0.18em] text-violet-100">PALMYRA POS · Escritorio</p>
                  <h3 id="palmyra-desktop-update-title" className="mt-1 text-xl font-black tracking-tight">Actualización lista</h3>
                </div>
              </div>
              <div className="relative mt-4 rounded-2xl border border-white/15 bg-black/10 px-3.5 py-3">
                <p className="text-[10px] font-semibold leading-5 text-violet-50">
                  {desktopUpdateVersion ? `La versión ${desktopUpdateVersion}` : APP_VERSION_LABEL} ya está descargada. Reinicia PALMYRA para aplicarla; tu empresa, ventas e inventario se conservan.
                </p>
              </div>
            </div>
            <div className="border-t border-slate-100 bg-white px-5 py-4 dark:border-slate-800 dark:bg-slate-900 sm:px-6">
              <div className="flex items-center justify-between gap-2.5">
                <span className="text-[8px] font-black uppercase tracking-[0.12em] text-slate-400">Actualización del sistema</span>
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-1 text-[8px] font-black uppercase tracking-wider text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                  {desktopInstalling ? "Reiniciando" : DESKTOP_UPDATE_STATUS_LABELS.downloaded}
                </span>
              </div>
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-violet-100 dark:bg-violet-900/50" aria-hidden="true">
                <div className="h-full w-full rounded-full bg-gradient-to-r from-violet-600 to-indigo-500" />
              </div>
              <p className="mt-2 text-[8px] font-semibold leading-4 text-slate-500 dark:text-slate-400">
                No se descarga nada más: ya está en este equipo. Si prefieres no reiniciar ahora, se aplicará sola la próxima vez que cierres PALMYRA.
              </p>
              <div className="mt-3 flex flex-col-reverse gap-2.5 sm:flex-row">
                <button
                  type="button"
                  disabled={desktopInstalling}
                  onClick={handleDesktopUpdateLater}
                  className="h-11 flex-1 rounded-xl border border-slate-200 bg-slate-50 px-4 text-[9px] font-black uppercase tracking-[0.08em] text-slate-600 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
                >
                  Más tarde
                </button>
                <button
                  type="button"
                  disabled={desktopInstalling}
                  onClick={() => { void handleDesktopUpdateInstall(); }}
                  className="h-11 flex-1 rounded-xl bg-violet-600 px-4 text-[9px] font-black uppercase tracking-[0.08em] text-white shadow-lg shadow-violet-600/20 transition hover:bg-violet-700 disabled:cursor-wait disabled:opacity-70"
                >
                  {desktopInstalling ? "Reiniciando…" : "Reiniciar e instalar"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Main Content */}
      {/* Aviso unificado de actualización al entrar (APK, PC y PWA).
          Burbuja no bloqueante: la caja sigue utilizable y la actualización
          se comprueba y aplica desde Configuración → Sistema. */}
      {entryUpdateVisible && (
        <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[var(--z-tooltip)] flex justify-center px-3 pb-3 sm:px-4 sm:pb-4">
          <div
            className="pointer-events-auto w-full max-w-md overflow-hidden rounded-2xl border border-violet-200/80 bg-white/95 shadow-[0_18px_50px_rgba(76,29,149,0.24)] backdrop-blur dark:border-violet-900/60 dark:bg-slate-900/95"
            role="status"
            aria-live="polite"
          >
            <div className="flex items-start gap-3 px-4 pt-4 sm:px-5">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-violet-100 text-violet-700 dark:bg-violet-950/60 dark:text-violet-300">
                <RefreshCw className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[9px] font-black uppercase tracking-[0.18em] text-violet-600 dark:text-violet-300">
                  PALMYRA · Actualización
                </p>
                <p className="mt-1 text-[12px] font-bold leading-5 text-slate-700 dark:text-slate-200">
                  {entryUpdateVersion
                    ? `La versión ${entryUpdateVersion} está lista. Actualiza ahora para continuar con la experiencia más reciente de PALMYRA.`
                    : 'Una nueva versión del sistema está lista. Actualiza ahora para continuar con la experiencia más reciente de PALMYRA.'}
                </p>
                <p className="mt-1.5 text-[10px] font-semibold leading-4 text-slate-400 dark:text-slate-500">
                  La actualización se comprueba y se aplica desde Configuración → Sistema.
                </p>
              </div>
              <button
                type="button"
                onClick={handleEntryUpdateDismiss}
                aria-label="Cerrar aviso de actualización"
                className="shrink-0 rounded-full p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600 dark:text-slate-500 dark:hover:bg-slate-800 dark:hover:text-slate-300"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="mt-3 flex flex-col-reverse gap-2 border-t border-slate-100 px-4 py-3 sm:flex-row sm:items-center sm:px-5 dark:border-slate-800">
              <button
                type="button"
                onClick={handleEntryUpdateDismiss}
                className="h-10 flex-1 rounded-xl border border-slate-200 bg-slate-50 px-4 text-[9px] font-black uppercase tracking-[0.08em] text-slate-600 transition hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
              >
                Ahora no
              </button>
              <button
                type="button"
                onClick={handleEntryUpdateGo}
                className="h-10 flex-1 rounded-xl bg-violet-600 px-4 text-[9px] font-black uppercase tracking-[0.08em] text-white shadow-lg shadow-violet-600/20 transition hover:bg-violet-700"
              >
                Actualizar ahora
              </button>
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
        <div className="palmyra-overlay z-[var(--z-modal)] flex items-center justify-center p-4" onClick={() => setShowOnlineCatalogInfo(false)}>
          <div className="palmyra-modal-panel w-full max-w-md p-6" onClick={e => e.stopPropagation()}>
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
        <div
          aria-hidden={sidebarOpen || undefined}
          className={cn("flex-1 min-w-0 h-full flex flex-col scroll-touch keyboard-safe-scroll", isPosPage ? "overflow-hidden p-0" : "overflow-y-auto p-3 sm:p-4 lg:p-6 pb-4 lg:pb-6")}
        >
          {children}
        </div>
        </main>

        {logoutConfirmOpen && (
          <div
            className="palmyra-overlay z-[var(--z-confirm)] flex items-center justify-center p-4"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="palmyra-logout-confirm-title"
            onClick={() => setLogoutConfirmOpen(false)}
          >
            <div
              className="palmyra-modal-panel palmyra-mobile-modal w-full max-w-md p-5"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="flex items-start gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[color-mix(in_srgb,var(--warning)_12%,transparent)] text-[var(--warning)]">
                  <LogOut className="h-5 w-5" aria-hidden="true" />
                </span>
                <div className="min-w-0">
                  <h3 id="palmyra-logout-confirm-title" className="text-base font-black leading-tight text-primary">
                    Cerrar sesión con operaciones pendientes
                  </h3>
                  <p className="mt-1 text-xs font-medium leading-5 text-secondary">
                    Hay {logoutConfirmPendingCount} operación(es) offline sin sincronizar. Quedan guardadas en este dispositivo, pero solo se enviarán al volver a entrar con la misma cuenta CON internet: cerrar sesión bloquea el acceso offline hasta entonces. ¿Cerrar sesión?
                  </p>
                </div>
              </div>
              <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <button
                  type="button"
                  onClick={() => setLogoutConfirmOpen(false)}
                  className="h-11 rounded-xl border border-base bg-subtle px-4 text-xs font-black uppercase tracking-wider text-primary hover:opacity-90"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={() => { setLogoutConfirmOpen(false); logout(); }}
                  className="h-11 rounded-xl bg-[var(--primary)] px-4 text-xs font-black uppercase tracking-wider text-white hover:bg-[var(--primary-hover)]"
                >
                  Cerrar sesión
                </button>
              </div>
            </div>
          </div>
        )}
    </div>
  );
}
