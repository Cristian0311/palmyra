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
import { getOfflineConflictCount, getOfflineQueueCount, getOfflineQueue, refreshOfflineQueueCounts } from "../services/offlineQueue";
import { runWithLoading } from "../lib/busy";
import { PRODUCT_VERSION_LABEL, PRODUCT_VERSION_SHORT } from "../lib/productVersion";
import { ANDROID_APK_DOWNLOAD, APK_PROMO_DISMISSED_KEY, PALMYRA_REMOTE_ORIGIN, REMOTE_APK_DOWNLOAD, getIosBrowserName, isAndroidDevice, isPalmyraApp, isRunningStandalone } from "../lib/install";
import { getNativeAppInfo, startNativeUpdate, type NativeUpdateRequest } from "../lib/nativeApp";
import { useDesktopUpdate } from "../hooks/useDesktopUpdate";
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
const PALMYRA_PWA_INSTALLED_KEY = "palmyra:pwa-installed";
const IOS_INSTALL_HINT_DISMISSED_KEY = "palmyra:ios-install-dismissed";
const IOS_BROWSER = getIosBrowserName();
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
const NATIVE_APP_INFO = getNativeAppInfo();
const NATIVE_OTA_ENABLED = Boolean(NATIVE_APP_INFO?.ota);
// Versión web instalada real: la release descargada por OTA o la que viene
// empaquetada en este build (__APP_VERSION__). NUNCA shellVersion: el versionName
// del APK no es la versión de la app web y comparar contra él hacía que el
// aviso de actualización apareciera o desapareciera sin corresponder.
const INSTALLED_WEB_VERSION = (NATIVE_APP_INFO?.webVersion || "").trim() || __APP_VERSION__;
const OTA_DISMISSED_KEY = "palmyra:ota-dismissed-version";
// "Ocultar"/"Más tarde" silencia solo la fase actual (versión + estado): si la
// descarga termina y queda lista para instalar, el aviso reaparece.
const DESKTOP_UPDATE_DISMISSED_KEY = "palmyra:desktop-update-dismissed";

type OtaPhase = "idle" | "downloading" | "verifying" | "installing" | "reloading" | "error";

const OTA_PHASE_LABELS: Record<OtaPhase, string> = {
  idle: "Lista para descargar",
  downloading: "Descargando actualización",
  verifying: "Verificando paquete",
  installing: "Instalando actualización",
  reloading: "Reiniciando PALMYRA",
  error: "Actualización detenida",
};

function formatOtaSize(received?: number, total?: number) {
  if (!received || received <= 0) return "";
  const receivedMb = (received / (1024 * 1024)).toFixed(1);
  if (!total || total <= 0) return `${receivedMb} MB descargados`;
  return `${receivedMb} de ${(total / (1024 * 1024)).toFixed(1)} MB`;
}

const UPDATE_WATCHDOG_MS = 3 * 60_000;
const UPDATE_PHASE_LABELS: Record<string, string> = {
  checking: "Verificando versión",
  preparing: "Preparando descarga",
  downloading: "Descargando actualización",
  installing: "Preparando instalación",
  "reloading": "Reiniciando PALMYRA",
  "up-to-date": "Todo al día",
};

function formatUpdateBytes(bytes?: number, totalBytes?: number) {
  if (!bytes || bytes <= 0) return "";
  const toMb = (value: number) => (value / (1024 * 1024)).toFixed(1);
  if (totalBytes && totalBytes > 0) return `${toMb(bytes)} MB de ${toMb(totalBytes)} MB`;
  if (bytes >= 1024 * 1024) return `${toMb(bytes)} MB descargados`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB descargados`;
}

function compareAppVersions(a: string, b: string) {
  const pa = a.split(/[^0-9]+/).filter(Boolean).map(Number);
  const pb = b.split(/[^0-9]+/).filter(Boolean).map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

function isIosInstallHintDismissed() {
  if (!IOS_BROWSER) return false;
  try { return window.localStorage.getItem(IOS_INSTALL_HINT_DISMISSED_KEY) === "1"; } catch { return false; }
}

function isPALMYRAPWAInstalled() {
  if (typeof window === "undefined") return false;
  // El APK ya es la app instalada: nunca debe ofrecerse la PWA.
  if (IN_PALMYRA_APP) return true;
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
    ? { shell: "border-amber-300/80 bg-amber-50 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300", dot: "bg-amber-500" }
    : state === "syncing"
      ? { shell: "border-violet-300/80 bg-violet-50 text-violet-700 dark:border-violet-900/60 dark:bg-violet-950/40 dark:text-violet-300", dot: "bg-violet-500 animate-pulse" }
      : { shell: "border-emerald-300/80 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300", dot: "bg-emerald-500" };
  // Sin trabajo real no se muestra burbuja: solo el estado, sin números fantasma.
  const badge = conflicts > 0
    ? { text: `!${formatOfflineCount(conflicts)}`, className: "bg-rose-600 text-white" }
    : pending > 0
      ? { text: formatOfflineCount(pending), className: "bg-amber-500 text-white" }
      : null;
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5 rounded-full border py-1 pl-1.5 pr-2 text-[9px] font-black uppercase tracking-wide", tone.shell, className)}>
      <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", tone.dot)} aria-hidden="true" />
      <span className="min-w-0 truncate">{label}</span>
      {badge && (
        <span className={cn("ml-auto inline-flex min-w-[1.15rem] shrink-0 items-center justify-center rounded-full px-1 py-0.5 text-[8px] font-black leading-none tabular-nums", badge.className)}>
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
  const [isApplyingUpdate, setIsApplyingUpdate] = useState(false);
  const [updateProgress, setUpdateProgress] = useState<{ phase: string; percent: number; filesDone?: number; filesTotal?: number; filesSkipped?: number; receivedBytes?: number; totalBytes?: number; version?: string; message?: string } | null>(null);
  const [updateError, setUpdateError] = useState("");
  const [serverVersion, setServerVersion] = useState<string | null>(null);
  const [navigationTargetPath, setNavigationTargetPath] = useState<string | null>(null);
  const navigationTimerRef = useRef<number | null>(null);
  const [saasContext, setSaaSContext] = useState<Awaited<ReturnType<typeof loadSaaSContext>>>(null);
  const [countdownNow, setCountdownNow] = useState(() => Date.now());
  const [showInstallPwa, setShowInstallPwa] = useState(false);
  const [pwaInstallAvailable, setPwaInstallAvailable] = useState(false);
  const [pwaInstalling, setPwaInstalling] = useState(false);
  const [showApkPromo, setShowApkPromo] = useState(false);
  const [apkStandalone, setApkStandalone] = useState(false);
  const [apkUpdateVersion, setApkUpdateVersion] = useState<string | null>(null);
  const [otaUpdate, setOtaUpdate] = useState<NativeUpdateRequest | null>(null);
  const [otaPhase, setOtaPhase] = useState<OtaPhase>("idle");
  const [otaPercent, setOtaPercent] = useState(0);
  const [otaReceived, setOtaReceived] = useState(0);
  const [otaTotal, setOtaTotal] = useState(0);
  const [otaError, setOtaError] = useState("");
  const [desktopUpdateDismissed, setDesktopUpdateDismissed] = useState("");
  const [desktopInstalling, setDesktopInstalling] = useState(false);
  const [showOnlineCatalogInfo, setShowOnlineCatalogInfo] = useState(false);
  const { currentUser, logout, notifications, removeNotification, storeConfig, syncWithSupabase, addNotification, cart, currentBranchId, getCurrentSession } = useStore(useShallow((state) => ({ currentUser: state.currentUser, logout: state.logout, notifications: state.notifications, removeNotification: state.removeNotification, storeConfig: state.storeConfig, syncWithSupabase: state.syncWithSupabase, addNotification: state.addNotification, cart: state.cart, currentBranchId: state.currentBranchId, getCurrentSession: state.getCurrentSession })));
  const location = useLocation();
  const navigate = useNavigate();
  const isPosPage = location.pathname === "/pos";
  const activeWarehouseName = useStore(state => state.branches.find(branch => branch.id === state.currentBranchId)?.name || null);
  useAutoRateSync();
  useLanPresence(activeWarehouseName);
  // Actualización de escritorio (Electron + electron-updater por IPC). Fuera del
  // shell Electron el controlador queda inerte y manda el flujo web/Android.
  const desktopUpdate = useDesktopUpdate();

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
    // En Android el APK nativo es más rápido y confiable que la PWA, incluso si
    // ya existe una PWA instalada: se recomienda el APK al entrar desde la web.
    setApkStandalone(isRunningStandalone());
    let dismissed = false;
    try { dismissed = window.localStorage.getItem(APK_PROMO_DISMISSED_KEY) === '1'; } catch {}
    setShowApkPromo(!dismissed);
  }, [currentUser?.id]);

  const dismissApkPromo = (remember: boolean) => {
    setShowApkPromo(false);
    if (!remember) return;
    try { window.localStorage.setItem(APK_PROMO_DISMISSED_KEY, '1'); } catch {}
  };

  const dismissInstallPrompt = () => {
    setShowInstallPwa(false);
    if (!IOS_BROWSER) return;
    try { window.localStorage.setItem(IOS_INSTALL_HINT_DISMISSED_KEY, "1"); } catch {}
  };

  useEffect(() => {
    if (!currentUser?.id || IS_DESKTOP_SHELL || IN_PALMYRA_APP) {
      setShowInstallPwa(false);
      setPwaInstallAvailable(false);
      return;
    }

    const syncPwaState = () => {
      const installed = isPALMYRAPWAInstalled();
      const available = !installed && Boolean(getDeferredPWAInstallPrompt());
      setPwaInstallAvailable(available);
      setShowInstallPwa(!installed && !isIosInstallHintDismissed());
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

    // Cada refresco hace getUser + varias consultas REST. Con muchas cajas
    // abiertas eso agotaba el límite de Supabase Auth ("request rate limit
    // reached"). 90 s + un mínimo de 30 s entre refrescos basta para enterarse
    // de una aprobación de plan sin castigar la API.
    const refreshContext = async (force = false) => {
      const now = Date.now();
      if (!force && now - lastRefreshAt < 30_000) return;
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
    }, 90_000);

    const handleFocus = () => {
      if (document.visibilityState === 'visible') void refreshContext();
    };
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
      setUpdateProgress(null);
      setUpdateError("");
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
    const onProgress = (event: Event) => {
      const detail = (event as CustomEvent<{ phase: string; percent: number; filesDone?: number; filesTotal?: number; filesSkipped?: number; receivedBytes?: number; totalBytes?: number; version?: string; message?: string }>).detail;
      if (!detail) return;
      setUpdateProgress(detail);
      if (detail.version) setServerVersion(detail.version);
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
    window.addEventListener('palmyra:update-progress', onProgress);
    window.addEventListener('focus', checkPersistedUpdate);
    document.addEventListener('visibilitychange', checkPersistedUpdate);

    return () => {
      window.removeEventListener('palmyra:update-available', onUpdate);
      window.removeEventListener('palmyra:update-progress', onProgress);
      window.removeEventListener('focus', checkPersistedUpdate);
      document.removeEventListener('visibilitychange', checkPersistedUpdate);
    };
  }, []);

  // Dentro del APK la app se actualiza sin instalar otro APK: el servidor
  // publica un paquete web con versión, tamaño y SHA-256. Solo se avisa si la
  // versión publicada es superior a la instalada.
  useEffect(() => {
    if (!IN_PALMYRA_APP || !currentUser?.id) {
      setApkUpdateVersion(null);
      setOtaUpdate(null);
      return;
    }
    let active = true;
    const checkRemoteVersion = async () => {
      try {
        const response = await fetch(`${PALMYRA_REMOTE_ORIGIN}/version.json?ts=${Date.now()}`, { cache: 'no-store' });
        if (!response.ok) return;
        const manifest = await response.json() as {
          version?: string;
          webBundle?: string;
          webBundleSha256?: string;
          webBundleBytes?: number;
        };
        if (!active) return;
        const remote = String(manifest?.version || '').trim();
        // Solo una versión estrictamente superior; igual o menor nunca avisa.
        if (!remote || compareAppVersions(remote, INSTALLED_WEB_VERSION) <= 0) {
          setApkUpdateVersion(null);
          setOtaUpdate(null);
          return;
        }
        let dismissed = "";
        try { dismissed = sessionStorage.getItem(OTA_DISMISSED_KEY) || ""; } catch {}
        if (dismissed === remote) return;

        const bundlePath = String(manifest?.webBundle || '').trim();
        const sha256 = String(manifest?.webBundleSha256 || '').trim();
        const bundleBytes = Number(manifest?.webBundleBytes) || 0;
        const bundleReady = Boolean(bundlePath) && /^[a-f0-9]{64}$/i.test(sha256) && bundleBytes > 0 && bundleBytes <= 300 * 1024 * 1024;
        if (NATIVE_OTA_ENABLED) {
          if (!bundleReady) {
            // Manifiesto desplegado sin paquete OTA válido: NO se ofrece el APK
            // (sería un aviso sin efecto). Se reintenta en el próximo ciclo.
            console.warn('[OTA] version.json no publica un webBundle válido; se omite el aviso hasta el próximo despliegue.');
            setOtaUpdate(null);
            setApkUpdateVersion(null);
            return;
          }
          setOtaUpdate({
            version: remote,
            url: new URL(bundlePath, PALMYRA_REMOTE_ORIGIN).toString(),
            sha256,
            bytes: bundleBytes,
          });
          setApkUpdateVersion(null);
        } else {
          // Instalador antiguo sin OTA: se mantiene la descarga del APK.
          setOtaUpdate(null);
          setApkUpdateVersion(remote);
        }
      } catch {
        // Sin conexión: se reintenta al volver a la app o en el próximo ciclo.
      }
    };
    void checkRemoteVersion();
    const timer = window.setInterval(() => { void checkRemoteVersion(); }, 15 * 60 * 1000);
    const onFocus = () => { void checkRemoteVersion(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [currentUser?.id]);

  // Progreso real del shell Android mientras descarga, verifica e instala.
  useEffect(() => {
    const onProgress = (event: Event) => {
      const detail = (event as CustomEvent<{ phase?: string; percent?: number; receivedBytes?: number; totalBytes?: number }>).detail;
      if (!detail) return;
      const phaseMap: Record<string, OtaPhase> = {
        downloading: "downloading",
        verifying: "verifying",
        applying: "installing",
        reloading: "reloading",
      };
      const nextPhase = detail.phase ? phaseMap[detail.phase] : undefined;
      if (nextPhase) setOtaPhase(nextPhase);
      if (typeof detail.percent === "number") setOtaPercent(Math.min(100, Math.max(0, Math.round(detail.percent))));
      if (typeof detail.receivedBytes === "number") setOtaReceived(detail.receivedBytes);
      if (typeof detail.totalBytes === "number" && detail.totalBytes > 0) setOtaTotal(detail.totalBytes);
      setOtaError("");
    };
    const onInstalled = () => {
      setOtaPhase("reloading");
      setOtaPercent(100);
      // El shell recarga solo; este respaldo cubre un reinicio nativo fallido.
      window.setTimeout(() => window.location.reload(), 4000);
    };
    const onError = (event: Event) => {
      const detail = (event as CustomEvent<{ message?: string }>).detail;
      setOtaPhase("error");
      setOtaError(detail?.message || "No se pudo descargar la actualización. Revisa la conexión e inténtalo de nuevo.");
    };
    window.addEventListener('palmyra:ota-progress', onProgress);
    window.addEventListener('palmyra:ota-installed', onInstalled);
    window.addEventListener('palmyra:ota-error', onError);
    return () => {
      window.removeEventListener('palmyra:ota-progress', onProgress);
      window.removeEventListener('palmyra:ota-installed', onInstalled);
      window.removeEventListener('palmyra:ota-error', onError);
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

  const otaBusy = otaPhase === "downloading" || otaPhase === "verifying" || otaPhase === "installing" || otaPhase === "reloading";

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

  const handleOtaDownload = () => {
    if (!otaUpdate || otaBusy) return;
    const activeSession = currentUser?.id ? getCurrentSession(currentBranchId, currentUser.id) : undefined;
    if (isPosPage && activeSession && cart.length > 0) {
      addNotification('Actualización preparada', 'info', 'Finaliza o limpia la venta actual antes de actualizar PALMYRA. La caja y los datos permanecen protegidos.');
      return;
    }
    if (!navigator.onLine) {
      setOtaPhase('error');
      setOtaError('Sin conexión. Conéctate para descargar la actualización.');
      return;
    }
    setOtaError('');
    setOtaPercent(4);
    setOtaReceived(0);
    setOtaTotal(otaUpdate.bytes || 0);
    // La fase se marca antes de cruzar el puente para que el primer evento de
    // progreso nativo (que llega en milisegundos) no se pierda.
    setOtaPhase('downloading');
    if (!startNativeUpdate(otaUpdate)) {
      setOtaPhase('error');
      setOtaError('Este instalador no permite actualizar desde la app. Descarga el APK más reciente.');
      return;
    }
  };

  // Reintento manual: vuelve a lanzar startUpdate desde cero (el shell borra
  // el archivo parcial y repite la descarga).
  const handleOtaRetry = () => {
    if (!otaUpdate) return;
    setOtaError('');
    setOtaPercent(0);
    setOtaReceived(0);
    setOtaPhase('idle');
    handleOtaDownload();
  };

  const handleOtaLater = () => {
    if (otaBusy) return;
    try { if (otaUpdate) sessionStorage.setItem(OTA_DISMISSED_KEY, otaUpdate.version); } catch {}
    setOtaUpdate(null);
    setOtaPhase('idle');
    setOtaError('');
    setOtaPercent(0);
    setOtaReceived(0);
    setOtaTotal(0);
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

  const handleApplyUpdate = async () => {
    if (isApplyingUpdate) return;
    const activeSession = currentUser?.id ? getCurrentSession(currentBranchId, currentUser.id) : undefined;
    if (isPosPage && activeSession && cart.length > 0) {
      addNotification('Actualización preparada', 'info', 'Finaliza o limpia la venta actual antes de actualizar PALMYRA. La caja y los datos permanecen protegidos.');
      return;
    }
    setUpdateError("");
    setUpdateProgress({ phase: 'preparing', percent: 2, message: 'Preparando la actualización…' });
    setIsApplyingUpdate(true);
    // Vigilante: la UI nunca puede quedarse en "Actualizando" indefinidamente.
    // A los 3 minutos se detiene y se ofrece reintentar. NO se cancela al
    // terminar: si la recarga no ocurre, el botón vuelve a estar disponible.
    const watchdog = window.setTimeout(() => {
      setIsApplyingUpdate(false);
      setUpdateProgress(null);
      setUpdateError('La actualización está tardando demasiado. Revisa tu conexión y pulsa "Actualizar ahora" para reintentar.');
      try { sessionStorage.removeItem('palmyra:update-applying'); } catch {}
      try { localStorage.setItem(PALMYRA_UPDATE_AVAILABLE_KEY, '1'); } catch {}
    }, UPDATE_WATCHDOG_MS);
    try {
      const apply = (window as typeof window & { __palmyraApplyUpdate?: () => Promise<'reloaded' | 'up-to-date'> }).__palmyraApplyUpdate;
      if (apply) {
        const result = await apply();
        if (result === 'up-to-date') {
          window.clearTimeout(watchdog);
          setIsApplyingUpdate(false);
          setUpdateProgress(null);
          setUpdateAvailable(false);
          try { localStorage.removeItem(PALMYRA_UPDATE_AVAILABLE_KEY); } catch {}
          addNotification('PALMYRA está actualizada', 'info', 'Ya tienes la última versión disponible en este dispositivo.');
          return;
        }
        // Instalada: el navegador recargará en breve. Se muestra el estado final
        // por si el usuario alcanza a verlo antes del reinicio.
        setUpdateProgress({ phase: 'reloading', percent: 100, message: 'Actualización instalada. Reiniciando…' });
        return;
      }

      // Último respaldo: si la acción global no estuviera disponible todavía,
      // recargamos directamente. El navegador/PWA conserva los datos locales.
      window.clearTimeout(watchdog);
      try { localStorage.removeItem(PALMYRA_UPDATE_AVAILABLE_KEY); } catch {}
      window.location.reload();
    } catch (error) {
      window.clearTimeout(watchdog);
      console.warn('[PALMYRA] No se pudo aplicar la actualización:', error);
      setIsApplyingUpdate(false);
      setUpdateProgress(null);
      const message = error instanceof Error ? error.message : '';
      setUpdateError(
        /conexión|network|servidor|disponible|confirmar|tardando/i.test(message)
          ? message
          : 'No se pudo completar la actualización. Revisa la conexión y vuelve a intentarlo.'
      );
    }
  };

  const handleLogoutClick = () => {
    const pending = getOfflineQueueCount();
    if (pending > 0 && !window.confirm(
      `Hay ${pending} operación(es) offline sin sincronizar. Quedan guardadas en este dispositivo, pero solo se enviarán al volver a entrar con la misma cuenta CON internet: cerrar sesión bloquea el acceso offline hasta entonces. ¿Cerrar sesión?`
    )) return;
    logout();
  };

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
        // por tipo, actionId, estado, reintento y último error conocido.
        const queueDetails = finalQueue
          .slice(0, 30)
          .map((item: any) => {
            const status = item?.status ? ` [${item.status}]` : '';
            const retry = Number(item?.retryCount) > 0 ? ` · intento ${item.retryCount}` : '';
            const error = item?.lastError || (
              item?.status === 'conflict'
                ? 'Operación en conflicto: requiere revisión.'
                : 'Esta operación sigue pendiente, pero no tiene una causa registrada. Reintenta la sincronización y revisa el Monitor de Logs.'
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
        <div className="fixed inset-x-3 bottom-3 sm:inset-auto sm:right-4 sm:bottom-4 z-[10001]">
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
                  {apkStandalone
                    ? "Estás usando la versión web instalada. El APK oficial abre más rápido, trabaja 100% offline y evita recargas del navegador."
                    : "Estás entrando desde el navegador. Instala el APK oficial de Android para abrir más rápido y trabajar 100% offline, incluso con la PWA ya instalada."}
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

      {showInstallPwa && !showApkPromo && currentUser && (
        <div className="fixed inset-x-3 bottom-3 sm:inset-auto sm:right-4 sm:bottom-4 z-[10000]">
          <div className="w-full sm:w-[min(22rem,calc(100vw-2rem))] rounded-2xl border border-violet-200/80 bg-white/95 dark:bg-slate-900/95 dark:border-violet-900/50 shadow-2xl backdrop-blur-md p-3">
            <div className="flex items-start gap-2.5">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-violet-100 dark:bg-violet-900/40 text-violet-600 dark:text-violet-300">
                <Smartphone className="w-4 h-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[9px] font-black uppercase tracking-[0.11em] text-primary">{IOS_BROWSER ? "Instala PALMYRA en iPhone / iPad" : "Instala PALMYRA"}</p>
                  <button type="button" onClick={dismissInstallPrompt} className="p-1 rounded-lg text-muted hover:bg-subtle" aria-label="Cerrar aviso">
                    <X className="w-3 h-3" />
                  </button>
                </div>
                <p className="mt-1 text-[7px] font-bold leading-4 text-muted">
                  Instala PALMYRA como aplicación para abrirla directamente y trabajar a pantalla completa, incluso con conexión inestable.
                </p>
                {IOS_BROWSER && (
                  <div className="mt-2 rounded-xl bg-violet-50 dark:bg-violet-950/30 border border-violet-100 dark:border-violet-900/40 px-2.5 py-2">
                    {IOS_BROWSER === "Safari" ? (
                      <>
                        <p className="text-[6.5px] font-black uppercase tracking-wider text-violet-700 dark:text-violet-300">Añádela a pantalla de inicio</p>
                        <ol className="mt-1 space-y-1 text-[6.5px] font-bold leading-4 text-muted">
                          <li><b className="text-violet-700 dark:text-violet-300">1.</b> Toca <b>Compartir</b> (el cuadro con la flecha) en Safari.</li>
                          <li><b className="text-violet-700 dark:text-violet-300">2.</b> Elige <b>Añadir a pantalla de inicio</b>.</li>
                          <li><b className="text-violet-700 dark:text-violet-300">3.</b> Pulsa <b>Añadir</b> y abre PALMYRA desde el nuevo icono.</li>
                        </ol>
                      </>
                    ) : (
                      <>
                        <p className="text-[6.5px] font-black uppercase tracking-wider text-violet-700 dark:text-violet-300">Abre esta página en Safari</p>
                        <p className="mt-0.5 text-[6.5px] font-bold leading-4 text-muted">
                          Estás en {IOS_BROWSER}. En iPhone y iPad solo <b>Safari</b> puede instalar la app: abre PALMYRA en Safari y usa <b>Compartir → Añadir a pantalla de inicio</b>.
                        </p>
                      </>
                    )}
                  </div>
                )}
                {!IOS_BROWSER && (pwaInstallAvailable ? (
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
                ))}
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
              aria-label="Abrir menú principal"
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
                                ? "bg-[#6535C5] text-white shadow-sm"
                                : "text-muted hover:bg-subtle hover:text-[#6535C5]"
                            )}
                          >
                            <Icon className={cn(
                              "w-4 h-4 shrink-0 transition-colors",
                              active ? "text-white" : "text-muted group-hover:text-[#6535C5]"
                            )} />
                            {sidebarCollapsed && locked && (
                              <span
                                className="pointer-events-none absolute right-1 top-1 flex h-3 w-3 items-center justify-center rounded-full border border-white bg-[#6535C5] text-white shadow-sm dark:border-slate-900"
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
                    "absolute -right-1 -top-1 inline-flex min-w-[15px] items-center justify-center rounded-full px-1 py-0.5 text-[8px] font-black leading-none tabular-nums text-white",
                    safeConflictOfflineCount > 0 ? "bg-rose-600" : "bg-amber-500"
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
                className={cn("mt-1.5 w-full min-w-0 rounded-lg border px-2 py-1.5 text-left transition-colors hover:border-[#6535C5]/40", getPlanVisual(subscription?.planCode).border, getPlanVisual(subscription?.planCode).soft)}
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

      {(saasContext?.company?.account_status === 'pending_payment' && !!saasContext?.subscription?.graceEndsAt && new Date(saasContext.subscription.graceEndsAt).getTime() <= countdownNow) && location.pathname !== '/subscription' && location.pathname !== '/help' && (
        <div className="fixed inset-0 z-[290] flex items-center justify-center p-4 bg-slate-950/55 backdrop-blur-[3px]">
          <div className="w-full max-w-md rounded-3xl border border-amber-200 bg-white shadow-2xl p-6 text-center">
            <div className="mx-auto w-12 h-12 rounded-2xl bg-amber-100 text-amber-700 flex items-center justify-center"><CreditCard className="w-6 h-6"/></div>
            <p className="mt-4 text-[10px] font-black uppercase tracking-[0.16em] text-amber-700">Periodo de servicio finalizado</p>
            <h3 className="mt-1 text-xl font-black text-slate-900">PALMYRA está en modo lectura</h3>
            <p className="mt-2 text-sm leading-5 text-slate-600">Tus datos, ventas e historial se conservan. Para volver a operar y sincronizar nuevas modificaciones, activa nuevamente tu plan.</p>
            <button type="button" onClick={() => window.location.assign('/subscription')} className="mt-5 w-full h-11 rounded-xl bg-[#6535C5] hover:bg-[#4F249D] text-white text-xs font-black uppercase tracking-wider">Ver planes y activar</button>
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

      {/* Actualización de escritorio (electron-updater): durante la descarga el
          aviso es discreto y no bloquea la caja. */}
      {desktopUpdateProgressVisible && (
        <div
          className="fixed bottom-4 right-4 z-[299] w-[min(92vw,20rem)] rounded-2xl border border-violet-200/80 bg-white p-3.5 shadow-[0_18px_50px_rgba(76,29,149,0.18)] dark:border-violet-900/60 dark:bg-slate-900"
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
        <div className="fixed inset-0 z-[301] flex items-center justify-center px-4 py-6 pointer-events-none bg-slate-950/20 dark:bg-slate-950/50 backdrop-blur-[3px]">
          <div
            className="pointer-events-auto w-full max-w-sm overflow-hidden rounded-[30px] border border-violet-200/70 bg-white shadow-[0_28px_90px_rgba(76,29,149,0.24)] dark:border-violet-900/60 dark:bg-slate-900 dark:shadow-[0_28px_90px_rgba(0,0,0,0.5)]"
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
      {otaUpdate && (
        <div className="fixed inset-0 z-[301] flex items-center justify-center px-4 py-6 pointer-events-none bg-slate-950/20 dark:bg-slate-950/50 backdrop-blur-[3px]">
          <div
            className="pointer-events-auto w-full max-w-sm overflow-hidden rounded-[30px] border border-violet-200/70 bg-white shadow-[0_28px_90px_rgba(76,29,149,0.24)] dark:border-violet-900/60 dark:bg-slate-900 dark:shadow-[0_28px_90px_rgba(0,0,0,0.5)]"
            role="dialog"
            aria-modal="true"
            aria-labelledby="palmyra-ota-title"
          >
            <div className="relative overflow-hidden bg-gradient-to-br from-violet-700 via-indigo-600 to-violet-500 px-5 pb-5 pt-5 text-white sm:px-6">
              <div className="absolute -right-10 -top-12 h-32 w-32 rounded-full bg-white/15 blur-2xl" />
              <div className="absolute -bottom-16 left-12 h-28 w-28 rounded-full bg-fuchsia-300/20 blur-2xl" />
              <div className="relative flex items-center gap-3">
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-white/20 bg-white/15 shadow-lg backdrop-blur-sm">
                  {otaBusy ? <Loader2 className="h-6 w-6 animate-spin" /> : <Download className="h-6 w-6" />}
                </div>
                <div className="min-w-0">
                  <p className="text-[9px] font-black uppercase tracking-[0.18em] text-violet-100">PALMYRA · Actualización</p>
                  <h3 id="palmyra-ota-title" className="mt-1 text-xl font-black tracking-tight">Descargar actualización</h3>
                </div>
              </div>
              <div className="relative mt-4 rounded-2xl border border-white/15 bg-black/10 px-3.5 py-3">
                <p className="text-[10px] font-semibold leading-5 text-violet-50">
                  {otaUpdate.version ? `La versión ${otaUpdate.version}` : APP_VERSION_LABEL} está lista. Se descarga e instala sin salir de la app; tu empresa, ventas e inventario se conservan.
                </p>
              </div>
            </div>
            <div className="border-t border-slate-100 bg-white px-5 py-4 dark:border-slate-800 dark:bg-slate-900 sm:px-6">
              <div className="flex items-center justify-between gap-2.5">
                <span className="text-[8px] font-black uppercase tracking-[0.12em] text-slate-400">Actualización del sistema</span>
                <span className={cn(
                  "inline-flex items-center gap-1 rounded-full px-2 py-1 text-[8px] font-black uppercase tracking-wider",
                  otaPhase === "error"
                    ? "bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300"
                    : otaBusy
                      ? "bg-violet-50 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300"
                      : "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"
                )}>
                  <span className={cn("h-1.5 w-1.5 rounded-full", otaPhase === "error" ? "bg-rose-500" : otaBusy ? "bg-violet-500 animate-pulse" : "bg-emerald-500")} />
                  {otaPhase === "error" ? "Detenida" : otaBusy ? `${otaPercent}%` : "Lista"}
                </span>
              </div>

              {otaBusy && (
                <div className="mt-3 rounded-xl border border-violet-100 bg-violet-50/70 px-3 py-2.5 dark:border-violet-900/60 dark:bg-violet-950/30" aria-live="polite">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[9px] font-black uppercase tracking-[0.1em] text-violet-700 dark:text-violet-300">
                      {OTA_PHASE_LABELS[otaPhase]}
                    </span>
                    <span className="text-[9px] font-black tabular-nums text-violet-700 dark:text-violet-300">{otaPercent}%</span>
                  </div>
                  <div className="mt-2 h-2 overflow-hidden rounded-full bg-violet-100 dark:bg-violet-900/50" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={otaPercent}>
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-violet-600 to-indigo-500 transition-[width] duration-300"
                      style={{ width: `${Math.min(100, Math.max(3, otaPercent))}%` }}
                    />
                  </div>
                  <p className="mt-1.5 text-[8px] font-semibold text-violet-600/80 dark:text-violet-300/80">
                    {otaPhase === "downloading"
                      ? formatOtaSize(otaReceived, otaTotal) || "Conectando con el servidor…"
                      : "No cierres PALMYRA durante la actualización. Tus datos están protegidos."}
                  </p>
                </div>
              )}

              {otaError && (
                <div className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-[9px] font-bold text-red-600 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300" role="alert">
                  {otaError}
                  <a href={REMOTE_APK_DOWNLOAD} download="PALMYRA-Android.apk" className="mt-1.5 block font-black text-violet-700 underline decoration-violet-300 underline-offset-2 dark:text-violet-300">
                    Descargar el APK manualmente
                  </a>
                </div>
              )}

              <div className="mt-3 flex flex-col-reverse gap-2.5 sm:flex-row">
                <button
                  type="button"
                  disabled={otaBusy}
                  onClick={handleOtaLater}
                  className="h-11 flex-1 rounded-xl border border-slate-200 bg-slate-50 px-4 text-[9px] font-black uppercase tracking-[0.08em] text-slate-600 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
                >
                  Más tarde
                </button>
                <button
                  type="button"
                  disabled={otaBusy}
                  onClick={otaPhase === "error" ? handleOtaRetry : handleOtaDownload}
                  className="h-11 flex-1 rounded-xl bg-violet-600 px-4 text-[9px] font-black uppercase tracking-[0.08em] text-white shadow-lg shadow-violet-600/20 transition hover:bg-violet-700 disabled:cursor-wait disabled:opacity-80"
                >
                  {otaBusy
                    ? `${OTA_PHASE_LABELS[otaPhase]}… ${otaPercent}%`
                    : otaPhase === "error"
                      ? "Reintentar descarga"
                      : "Descargar actualización"}
                </button>
              </div>
              <p className="mt-2 text-center text-[8px] font-semibold leading-4 text-slate-400 dark:text-slate-500">
                Solo se descarga una vez la app. Las próximas versiones se instalan aquí mismo.
              </p>
            </div>
          </div>
        </div>
      )}

      {apkUpdateVersion && (
        <div className="fixed inset-0 z-[301] flex items-center justify-center px-4 py-6 pointer-events-none bg-slate-950/20 dark:bg-slate-950/50 backdrop-blur-[3px]">
          <div
            className="pointer-events-auto w-full max-w-sm overflow-hidden rounded-[30px] border border-violet-200/70 bg-white shadow-[0_28px_90px_rgba(76,29,149,0.24)] dark:border-violet-900/60 dark:bg-slate-900 dark:shadow-[0_28px_90px_rgba(0,0,0,0.5)]"
            role="dialog"
            aria-modal="true"
            aria-labelledby="palmyra-apk-update-title"
          >
            <div className="relative overflow-hidden bg-gradient-to-br from-violet-700 via-indigo-600 to-violet-500 px-5 pb-5 pt-5 text-white sm:px-6">
              <div className="absolute -right-10 -top-12 h-32 w-32 rounded-full bg-white/15 blur-2xl" />
              <div className="relative flex items-center gap-3">
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-white/20 bg-white/15 shadow-lg backdrop-blur-sm">
                  <Download className="h-6 w-6" />
                </div>
                <div className="min-w-0">
                  <p className="text-[9px] font-black uppercase tracking-[0.18em] text-violet-100">PALMYRA · Android</p>
                  <h3 id="palmyra-apk-update-title" className="mt-1 text-xl font-black tracking-tight">Nueva versión disponible</h3>
                </div>
              </div>
              <div className="relative mt-4 rounded-2xl border border-white/15 bg-black/10 px-3.5 py-3">
                <p className="text-[10px] font-semibold leading-5 text-violet-50">
                  {apkUpdateVersion ? `La versión ${apkUpdateVersion}` : APP_VERSION_LABEL} ya está lista. Descarga el APK e instálalo encima de esta app: tu empresa, ventas y datos se conservan.
                </p>
              </div>
            </div>
            <div className="border-t border-slate-100 bg-white px-5 py-4 dark:border-slate-800 dark:bg-slate-900 sm:px-6">
              <div className="flex items-center justify-between gap-2.5">
                <span className="text-[8px] font-black uppercase tracking-[0.12em] text-slate-400">Actualización de la app</span>
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-1 text-[8px] font-black uppercase tracking-wider text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                  Lista
                </span>
              </div>
              <div className="mt-3 flex flex-col-reverse gap-2.5 sm:flex-row">
                <button
                  type="button"
                  onClick={() => setApkUpdateVersion(null)}
                  className="h-11 flex-1 rounded-xl border border-slate-200 bg-slate-50 px-4 text-[9px] font-black uppercase tracking-[0.08em] text-slate-600 transition hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
                >
                  Más tarde
                </button>
                <a
                  href={REMOTE_APK_DOWNLOAD}
                  download="PALMYRA-Android.apk"
                  className="h-11 flex-1 rounded-xl bg-violet-600 px-4 text-center text-[9px] font-black uppercase leading-[2.75rem] tracking-[0.08em] text-white shadow-lg shadow-violet-600/20 transition hover:bg-violet-700"
                >
                  Descargar APK
                </a>
              </div>
              <p className="mt-2 text-center text-[8px] font-semibold leading-4 text-slate-400 dark:text-slate-500">
                Al terminar la descarga, abre el archivo y pulsa Instalar para actualizar PALMYRA.
              </p>
            </div>
          </div>
        </div>
      )}

      {updateAvailable && !IN_PALMYRA_APP && !IS_DESKTOP_SHELL && (
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
                  {serverVersion
                    ? `La versión ${serverVersion} está lista. Actualiza ahora para continuar con la experiencia más reciente de PALMYRA.`
                    : 'Una nueva versión del sistema está lista. Actualiza ahora para continuar con la experiencia más reciente de PALMYRA.'}
                </p>
              </div>
            </div>
            <div className="border-t border-slate-100 bg-white px-5 py-4 dark:border-slate-800 dark:bg-slate-900 sm:px-6">
              <div className="flex items-center justify-between gap-2.5">
                <span className="text-[8px] font-black uppercase tracking-[0.12em] text-slate-400">Actualización del sistema</span>
                <span className={cn(
                  "inline-flex items-center gap-1 rounded-full px-2 py-1 text-[8px] font-black uppercase tracking-wider",
                  isApplyingUpdate
                    ? "bg-violet-50 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300"
                    : "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"
                )}>
                  <span className={cn("h-1.5 w-1.5 rounded-full", isApplyingUpdate ? "bg-violet-500 animate-pulse" : "bg-emerald-500")} />
                  {isApplyingUpdate ? `${updateProgress?.percent ?? 0}%` : "Lista"}
                </span>
              </div>

              {isApplyingUpdate && (
                <div className="mt-3 rounded-xl border border-violet-100 bg-violet-50/70 px-3 py-2.5 dark:border-violet-900/60 dark:bg-violet-950/30" aria-live="polite">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[9px] font-black uppercase tracking-[0.1em] text-violet-700 dark:text-violet-300">
                      {UPDATE_PHASE_LABELS[updateProgress?.phase || 'checking'] || "Actualizando"}
                      {updateProgress?.phase === 'downloading' && updateProgress.filesTotal
                        ? ` · ${updateProgress.filesDone ?? 0}/${updateProgress.filesTotal}`
                        : ""}
                    </span>
                    <span className="text-[9px] font-black tabular-nums text-violet-700 dark:text-violet-300">{updateProgress?.percent ?? 0}%</span>
                  </div>
                  <div className="mt-2 h-2 overflow-hidden rounded-full bg-violet-100 dark:bg-violet-900/50" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={updateProgress?.percent ?? 0}>
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-violet-600 to-indigo-500 transition-[width] duration-300"
                      style={{ width: `${Math.min(100, Math.max(3, updateProgress?.percent ?? 3))}%` }}
                    />
                  </div>
                  <p className="mt-1.5 text-[8px] font-semibold text-violet-600/80 dark:text-violet-300/80" aria-live="polite">
                    {updateProgress?.message
                      || formatUpdateBytes(updateProgress?.receivedBytes, updateProgress?.totalBytes)
                      || (updateProgress?.phase === 'preparing'
                        ? 'Preparando la descarga. No cierres PALMYRA.'
                        : 'No cierres PALMYRA durante la actualización. Tus datos están protegidos.')}
                  </p>
                </div>
              )}

              {updateError && (
                <div className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-[9px] font-bold text-red-600 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300" role="alert">
                  {updateError}
                </div>
              )}

              <div className="mt-3 flex flex-col-reverse gap-2.5 sm:flex-row">
                <button
                  type="button"
                  disabled={isApplyingUpdate}
                  onClick={() => {
                    try {
                      const snoozedVersion = serverVersion
                        || window.localStorage.getItem("palmyra:update-version")
                        || "";
                      writeUpdateSnooze(snoozedVersion);
                    } catch {}
                    try { localStorage.removeItem(PALMYRA_UPDATE_AVAILABLE_KEY); } catch {}
                    setUpdateAvailable(false);
                    setUpdateError("");
                    setUpdateProgress(null);
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
                  {isApplyingUpdate ? `Actualizando… ${updateProgress?.percent ?? 0}%` : updateError ? "Reintentar actualización" : "Actualizar ahora"}
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
        <div className={cn("flex-1 min-w-0 h-full flex flex-col scroll-touch keyboard-safe-scroll", isPosPage ? "overflow-hidden p-0" : "overflow-y-auto p-3 sm:p-4 lg:p-6 pb-4 lg:pb-6")}>
          {children}
        </div>
        </main>
    </div>
  );
}
