import { useCallback, useEffect, useState } from "react";
import { Bell, BellRing, CheckCheck, ChevronDown, RefreshCw, Smartphone, Clock3, ShieldAlert, Laugh, AlertTriangle, Package, WifiOff } from "lucide-react";
import { getSupabase } from "../lib/supabase";
import { loadSaaSContext } from "../services/saas";
import { SettingsSectionHeader } from "../components/settings/SettingsSectionHeader";
import { ToastHost, useToastStack } from "../components/ui/toast";
import {
  collectOperationalLocalNotices,
  installLocalNoticeBridge,
  listLocalNotices,
  markAllLocalNoticesRead,
  markLocalNoticeRead,
  type LocalCenterNotice,
} from "../services/notifications/localCenter";
import { useStore } from "../store/useStore";
import { cn } from "../lib/utils";

type Notice = {
  id: string;
  kind: string;
  title: string;
  body: string;
  read_at: string | null;
  created_at: string;
  user_id?: string | null;
};

type Preferences = {
  push_enabled: boolean;
  critical_push_enabled: boolean;
  routine_summary_enabled: boolean;
  routine_summary_time: string;
  quiet_hours_enabled: boolean;
  quiet_hours_start: string;
  quiet_hours_end: string;
  timezone: string;
  humour_enabled: boolean;
  exchange_currency_alerts_enabled: boolean;
  exchange_currency_codes: string[];
  exchange_bitcoin_alerts_enabled: boolean;
  exchange_alert_mode: "percent" | "absolute";
  exchange_alert_min_change_pct: number;
  exchange_alert_min_change_abs: number;
};
type RateOption = { code: string; name: string };
const DEFAULT_RATE_OPTIONS: RateOption[] = [
  { code: "USD", name: "Dólar estadounidense (Efectivo)" },
  { code: "EUR", name: "Euro (Efectivo)" },
  { code: "MLC", name: "Moneda libremente convertible (MLC)" },
  { code: "USDT", name: "Tether (USDT · TRC-20)" },
  { code: "BTC", name: "Bitcoin (BTC)" },
  { code: "ZELLE", name: "Zelle · pagos en USD" },
  { code: "CLA", name: "Tarjeta Clásica (USD)" },
];
const CRYPTO_PREFIX = /^(BTC|ETH|BNB|TRX|USDT|USDC|LTC|DOGE|SOL|XRP|TON|ADA|BCH|DOT|AVAX|SHIB|LINK|XMR|MATIC|POL)/;
function normalizedRateCode(value: unknown) {
  const code = String(value || "").toUpperCase().trim().replace(/[-_\s]/g, "");
  return code === "ECU" ? "EUR" : code;
}
function isCryptoRate(code: string) {
  return CRYPTO_PREFIX.test(normalizedRateCode(code));
}
function numericRate(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim().replace(/\s/g, "").replace(",", "."));
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (value && typeof value === "object") {
    const nested = value as Record<string, unknown>;
    for (const key of ["value", "rate", "valor", "tasa", "median", "mediana", "price", "precio"]) {
      if (nested[key] !== undefined && nested[key] !== value) {
        const parsed = numericRate(nested[key]);
        if (parsed !== null) return parsed;
      }
    }
  }
  return null;
}
function getRateOptions(data: unknown): RateOption[] {
  let list: any = data;
  const containers = ["tasas", "rates", "data", "result", "exchangeRates", "exchange_rates", "cotizaciones"];
  for (let depth = 0; depth < 5 && list && typeof list === "object" && !Array.isArray(list); depth++) {
    const looksLikeRate = ["rate", "value", "valor", "tasa", "median", "mediana", "buy", "compra", "sell", "venta"].some((key) => list[key] !== undefined);
    if (looksLikeRate) break;
    const next = containers.find((key) => list[key] !== undefined && list[key] !== null);
    if (!next) break;
    list = list[next];
  }
  const entries: Array<[string, any]> = Array.isArray(list)
    ? list.map((item: any, index: number) => [String(index), item])
    : list && typeof list === "object" ? Object.entries(list) : [];
  const found = new Map<string, RateOption>();
  for (const [fallback, raw] of entries) {
    const code = normalizedRateCode(raw && typeof raw === "object"
      ? raw.code ?? raw.currency ?? raw.moneda ?? raw.symbol ?? raw.codigo ?? fallback
      : fallback);
    if (!code || isCryptoRate(code)) continue;
    const hasValue = typeof raw === "object" && raw !== null
      ? ["rate","value","valor","tasa","tasa_referencia","reference","median","mediana","trm","promedio","price","precio","last","rate_mid","buy","compra","sell","venta"]
          .some((key) => numericRate(raw[key]) !== null)
      : numericRate(raw) !== null;
    if (!hasValue) continue;
    const name = raw && typeof raw === "object"
      ? String(raw.name ?? raw.nombre ?? raw.description ?? raw.descripcion ?? DEFAULT_RATE_OPTIONS.find((option) => option.code === code)?.name ?? code)
      : (DEFAULT_RATE_OPTIONS.find((option) => option.code === code)?.name ?? code);
    found.set(code, { code, name });
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name, "es"));
}

const defaults: Preferences = {
  push_enabled: true,
  critical_push_enabled: true,
  routine_summary_enabled: true,
  routine_summary_time: "08:15",
  quiet_hours_enabled: true,
  quiet_hours_start: "22:00",
  quiet_hours_end: "08:00",
  timezone: "America/Havana",
  humour_enabled: true,
  exchange_currency_alerts_enabled: false,
  exchange_currency_codes: ["USD", "EUR", "MLC"],
  exchange_bitcoin_alerts_enabled: false,
  exchange_alert_mode: "percent",
  exchange_alert_min_change_pct: 0,
  exchange_alert_min_change_abs: 0,
};

function decodeVapidKey(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const raw = atob(padded);
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

function kindLabel(kind: string) {
  const key = kind.toLowerCase();
  if (key.includes("exchange_rate") || key.includes("currency")) return "Tasa de cambio";
  if (key.includes("test")) return "Prueba";
  if (key.includes("error") || key.includes("critical")) return "Crítica";
  if (key.includes("warning") || key.includes("alert")) return "Aviso";
  if (key.includes("success") || key.includes("sale")) return "Todo bien";
  return "Información";
}

// Última copia del historial en la nube: el centro no queda vacío sin conexión.
const CLOUD_CACHE_KEY = "palmyra:notices-cache:v1";
type CloudCache = { notices: Notice[]; prefs: Preferences; at: number };

function readCloudCache(): CloudCache | null {
  try {
    const raw = localStorage.getItem(CLOUD_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CloudCache;
    return parsed && Array.isArray(parsed.notices) ? parsed : null;
  } catch {
    return null;
  }
}

function writeCloudCache(notices: Notice[], prefs: Preferences): void {
  try {
    localStorage.setItem(CLOUD_CACHE_KEY, JSON.stringify({ notices, prefs, at: Date.now() }));
  } catch {
    // Sin cuota o sin permisos: el historial simplemente no se cachea.
  }
}

export default function Notifications() {
  const [companyId, setCompanyId] = useState("");
  const [userId, setUserId] = useState("");
  const [notices, setNotices] = useState<Notice[]>([]);
  const [prefs, setPrefs] = useState<Preferences>(defaults);
  const [loading, setLoading] = useState(true);
  const [needsAccount, setNeedsAccount] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [testBusy, setTestBusy] = useState(false);
  const [markingAll, setMarkingAll] = useState(false);
  const [view, setView] = useState<"history" | "prefs">("history");
  const [filter, setFilter] = useState<"all" | "unread" | "rates">("all");
  const { toasts, push: pushToast, dismiss: dismissToast } = useToastStack();
  const [localNotices, setLocalNotices] = useState<LocalCenterNotice[]>([]);
  const [error, setError] = useState("");
  const [pushDeviceStatus, setPushDeviceStatus] = useState<"checking" | "unsupported" | "missing_key" | "permission_denied" | "registered" | "not_registered">("checking");
  const [rateOptions, setRateOptions] = useState<RateOption[]>(DEFAULT_RATE_OPTIONS);
  const vapidPublicKey = import.meta.env.VITE_VAPID_PUBLIC_KEY || "";

  const checkPushStatus = useCallback(async () => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
      setPushDeviceStatus("unsupported");
      return;
    }
    if (Notification.permission === "denied") {
      setPushDeviceStatus("permission_denied");
      return;
    }
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        // A browser subscription may exist locally after the server disabled
        // an expired endpoint. Confirm the server-side row before claiming the
        // device can receive push. When offline, we can only report local state.
        if (!companyId || !userId || typeof navigator !== "undefined" && !navigator.onLine) {
          setPushDeviceStatus("registered");
          return;
        }
        const supabase = getSupabase();
        if (!supabase) {
          setPushDeviceStatus("registered");
          return;
        }
        const { data: serverSubscription, error: serverCheckError } = await supabase
          .from("push_subscriptions")
          .select("enabled")
          .eq("company_id", companyId)
          .eq("user_id", userId)
          .eq("endpoint", subscription.endpoint)
          .maybeSingle();
        if (!serverCheckError) {
          setPushDeviceStatus(serverSubscription?.enabled === true ? "registered" : "not_registered");
        } else {
          // A transient network error is not proof the endpoint was disabled.
          setPushDeviceStatus("registered");
        }
      } else {
        setPushDeviceStatus(vapidPublicKey ? "not_registered" : "missing_key");
      }
    } catch {
      setPushDeviceStatus(vapidPublicKey ? "not_registered" : "missing_key");
    }
  }, [vapidPublicKey, companyId, userId]);

  useEffect(() => { void checkPushStatus(); }, [checkPushStatus]);

  useEffect(() => {
    const controller = new AbortController();
    const loadRateOptions = async () => {
      try {
        const response = await fetch("/api/exchange-rates", { cache: "no-store", signal: controller.signal, headers: { Accept: "application/json" } });
        if (!response.ok) return;
        const payload = await response.json();
        const options = getRateOptions(payload?.data);
        if (options.length && !controller.signal.aborted) setRateOptions(options);
      } catch {
        // Keep the curated choices visible if the rates source is temporarily unavailable.
      }
    };
    void loadRateOptions();
    return () => controller.abort();
  }, []);

  const pushStatusLabel = ({
    checking: "Comprobando dispositivo…",
    unsupported: "Navegador no compatible",
    missing_key: "Falta configuración push",
    permission_denied: "Permiso bloqueado",
    registered: "Este móvil está registrado",
    not_registered: "Este móvil no está registrado",
  } as const)[pushDeviceStatus];

  const pushStatusDetail = ({
    checking: "Estamos comprobando el permiso del navegador y si este móvil ya está registrado.",
    unsupported: typeof navigator !== "undefined" && /\bElectron\//i.test(navigator.userAgent)
      ? "En la app de escritorio los avisos se muestran dentro de PALMYRA. Para recibirlos en el móvil, abre PALMYRA en Chrome (Android) desde el teléfono y activa el push allí."
      : "Abre PALMYRA con Chrome en Android o con un navegador compatible con notificaciones push.",
    missing_key: "El despliegue no está exponiendo la clave pública VAPID. El historial funciona, pero no se puede registrar el móvil hasta corregir esa configuración.",
    permission_denied: "El navegador bloqueó los avisos. En los ajustes de Android/Chrome, permite las notificaciones para palmyracrm.onrender.com y vuelve a probar.",
    registered: "Hay una suscripción push guardada en este navegador. Usa «Enviar prueba» para comprobar la entrega real al dispositivo.",
    not_registered: "Pulsa «Activar notificaciones push» y acepta el permiso cuando el navegador lo solicite.",
  } as const)[pushDeviceStatus];

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    const supabase = getSupabase();
    try {
      if (!supabase) throw new Error("No hay conexión con el servicio de PALMYRA. Revisa tu conexión y vuelve a intentarlo.");
      const [ctxResult, authResult] = await Promise.all([loadSaaSContext(true), supabase.auth.getUser()]);
      const cid = ctxResult?.companyId || "";
      const uid = authResult.data.user?.id || "";
      if (!cid || !uid) {
        setNeedsAccount(true);
        return;
      }
      setNeedsAccount(false);
      setCompanyId(cid);
      setUserId(uid);

      const [noticeResult, readResult, prefResult] = await Promise.all([
        supabase.from("notifications").select("id,kind,title,body,read_at,created_at,user_id")
          .eq("company_id", cid).or(`user_id.eq.${uid},user_id.is.null`)
          .order("created_at", { ascending: false }).limit(50),
        supabase.from("notification_reads").select("notification_id,read_at").eq("company_id", cid).eq("user_id", uid),
        supabase.from("notification_preferences").select("*").eq("company_id", cid).eq("user_id", uid).maybeSingle(),
      ]);
      if (noticeResult.error) throw noticeResult.error;
      if (readResult.error) throw readResult.error;
      if (prefResult.error) throw prefResult.error;
      const readById = new Map((readResult.data || []).map((receipt) => [receipt.notification_id, receipt.read_at]));
      const mappedNotices = ((noticeResult.data || []) as Notice[]).map((notice) => ({
        ...notice,
        read_at: notice.user_id === null ? (readById.get(notice.id) || null) : notice.read_at,
      }));
      setNotices(mappedNotices);
      let nextPrefs: Preferences = defaults;
      if (prefResult.data) {
        nextPrefs = {
          push_enabled: prefResult.data.push_enabled,
          critical_push_enabled: prefResult.data.critical_push_enabled,
          routine_summary_enabled: prefResult.data.routine_summary_enabled,
          routine_summary_time: String(prefResult.data.routine_summary_time || "08:15").slice(0, 5),
          quiet_hours_enabled: prefResult.data.quiet_hours_enabled,
          quiet_hours_start: String(prefResult.data.quiet_hours_start || "22:00").slice(0, 5),
          quiet_hours_end: String(prefResult.data.quiet_hours_end || "08:00").slice(0, 5),
          timezone: prefResult.data.timezone || "America/Havana",
          humour_enabled: prefResult.data.humour_enabled,
          exchange_currency_alerts_enabled: prefResult.data.exchange_currency_alerts_enabled ?? false,
          exchange_currency_codes: Array.isArray(prefResult.data.exchange_currency_codes) ? prefResult.data.exchange_currency_codes.map((code: unknown) => normalizedRateCode(code)) : defaults.exchange_currency_codes,
          exchange_bitcoin_alerts_enabled: prefResult.data.exchange_bitcoin_alerts_enabled ?? false,
          exchange_alert_mode: prefResult.data.exchange_alert_mode === "absolute" ? "absolute" : "percent",
          exchange_alert_min_change_pct: Number(prefResult.data.exchange_alert_min_change_pct ?? 0),
          exchange_alert_min_change_abs: Number(prefResult.data.exchange_alert_min_change_abs ?? 0),
        };
        setPrefs(nextPrefs);
      }
      writeCloudCache(mappedNotices, nextPrefs);
    } catch (e: any) {
      if (typeof navigator !== "undefined" && !navigator.onLine) {
        setNeedsAccount(false);
        const cached = readCloudCache();
        if (cached && cached.notices.length) {
          setNotices(cached.notices);
          setPrefs(cached.prefs);
          setError("Sin conexión: se muestra la última copia guardada en este dispositivo. El historial se actualizará al reconectar.");
        } else {
          setError("Sin conexión: el historial y las preferencias se actualizarán cuando vuelvas a estar en línea.");
        }
        return;
      }
      setError("No se pudieron cargar las notificaciones. Revisa tu conexión y vuelve a intentarlo.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // Avisos locales del dispositivo: recolecta stock bajo, cierres de turno y
  // actualizaciones pendientes desde el almacén local y los mantiene vivos
  // aunque no haya conexión. El puente re-colecta con cada señal relevante.
  useEffect(() => {
    setLocalNotices(listLocalNotices());
    collectOperationalLocalNotices(useStore.getState());
    setLocalNotices(listLocalNotices());
    const cleanup = installLocalNoticeBridge(() => {
      collectOperationalLocalNotices(useStore.getState());
      setLocalNotices(listLocalNotices());
    });
    return cleanup;
  }, []);

  const markLocalRead = (id: string) => {
    markLocalNoticeRead(id);
    setLocalNotices(listLocalNotices());
  };

  const markAllLocalRead = () => {
    markAllLocalNoticesRead();
    setLocalNotices(listLocalNotices());
  };

  // Live updates: new notices appear without pressing refresh. Realtime is
  // optional; if the table is not published the page keeps working manually.
  useEffect(() => {
    const supabase = getSupabase();
    if (!supabase || !companyId || !userId) return;
    const channel = supabase
      .channel(`palmyra-notifications-${companyId}-${userId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "notifications", filter: `company_id=eq.${companyId}` },
        (payload) => {
          const row = payload.new as Notice;
          if (row.user_id && row.user_id !== userId) return;
          setNotices((items) => [row, ...items.filter((item) => item.id !== row.id)].slice(0, 50));
        },
      )
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [companyId, userId]);

  const savePrefs = async () => {
    const supabase = getSupabase();
    if (!supabase || !companyId || !userId) return;
    setError("");
    if (prefs.exchange_currency_alerts_enabled && prefs.exchange_currency_codes.length === 0) {
      setError("Activa las alertas de divisas solo después de seleccionar al menos una moneda.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const { error: saveError } = await supabase.from("notification_preferences").upsert({
        company_id: companyId,
        user_id: userId,
        ...prefs,
        updated_at: new Date().toISOString(),
      }, { onConflict: "company_id,user_id" });
      if (saveError) throw saveError;
      pushToast("success", "Preferencias guardadas.");
    } catch (e: any) {
      setError("No se pudieron guardar las preferencias. Revisa tu conexión y vuelve a intentarlo.");
    } finally {
      setSaving(false);
    }
  };

  const markRead = async (notice: Notice) => {
    if (notice.read_at || !userId) return;
    const supabase = getSupabase();
    if (!supabase) return;
    const readAt = new Date().toISOString();
    const result = notice.user_id === userId
      ? await supabase.from("notifications").update({ read_at: readAt }).eq("id", notice.id).eq("user_id", userId)
      : await supabase.from("notification_reads").upsert(
          { notification_id: notice.id, company_id: companyId, user_id: userId, read_at: readAt },
          { onConflict: "notification_id,user_id" },
        );
    if (result.error) {
      setError(result.error.message);
      return;
    }
    setNotices((items) => items.map((item) => item.id === notice.id ? { ...item, read_at: readAt } : item));
  };

  const markAllRead = async () => {
    const supabase = getSupabase();
    if (!supabase || !userId) return;
    const pending = notices.filter((notice) => !notice.read_at && (notice.user_id === userId || notice.user_id === null));
    if (!pending.length) return;
    setMarkingAll(true);
    setError("");
    const readAt = new Date().toISOString();
    try {
      const ownIds = pending.filter((notice) => notice.user_id === userId).map((notice) => notice.id);
      if (ownIds.length) {
        const { error: ownError } = await supabase.from("notifications").update({ read_at: readAt }).in("id", ownIds).eq("user_id", userId);
        if (ownError) throw ownError;
      }
      const shared = pending.filter((notice) => notice.user_id === null);
      if (shared.length) {
        const { error: sharedError } = await supabase.from("notification_reads").upsert(
          shared.map((notice) => ({ notification_id: notice.id, company_id: companyId, user_id: userId, read_at: readAt })),
          { onConflict: "notification_id,user_id" },
        );
        if (sharedError) throw sharedError;
      }
      setNotices((items) => items.map((item) => pending.some((notice) => notice.id === item.id) ? { ...item, read_at: readAt } : item));
      pushToast("success", "Todos los avisos quedaron como leídos.");
    } catch (e: any) {
      setError(e?.message || "No se pudieron marcar los avisos como leídos.");
    } finally {
      setMarkingAll(false);
    }
  };

  const enablePush = async () => {
    setError("");
    setPushBusy(true);
    try {
      if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
        throw new Error("Este navegador no admite notificaciones push. Prueba desde Chrome e instala PALMYRA como aplicación.");
      }
      if (!vapidPublicKey) {
        throw new Error("Las notificaciones push todavía no están disponibles en esta instalación. Revisa el historial dentro de PALMYRA mientras tanto.");
      }
      if (Notification.permission === "denied") {
        throw new Error("El navegador bloqueó las notificaciones. Actívalas en los permisos del sitio y vuelve aquí.");
      }
      const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
      if (permission !== "granted") throw new Error("No se concedió permiso para mostrar notificaciones.");
      const registration = await navigator.serviceWorker.ready;
      const supabase = getSupabase();
      if (!supabase) throw new Error("No hay conexión con el servicio de PALMYRA. Revisa tu conexión y vuelve a intentarlo.");
      let subscription = await registration.pushManager.getSubscription();

      if (subscription && companyId && userId) {
        const { data: serverSubscription, error: serverCheckError } = await supabase
          .from("push_subscriptions")
          .select("enabled")
          .eq("company_id", companyId)
          .eq("user_id", userId)
          .eq("endpoint", subscription.endpoint)
          .maybeSingle();

        if (serverCheckError) {
          // Do not re-enable a potentially expired endpoint if the server state
          // cannot be verified. The user can safely retry when connectivity is back.
          throw new Error("No se pudo comprobar el estado de la suscripción push. Revisa la conexión y vuelve a intentarlo.");
        }

        // If the server has no active row for this browser endpoint, it may
        // have expired (HTTP 404/410). Remove the stale browser subscription
        // and obtain a fresh endpoint rather than re-enabling the dead one.
        if (serverSubscription?.enabled !== true) {
          try {
            await subscription.unsubscribe();
            // Do not reuse this endpoint, even if the browser reports that the
            // unsubscribe operation was already completed. Always request a
            // fresh subscription rather than re-enabling an endpoint the server
            // previously disabled after a provider 404/410 response.
            subscription = null;
          } catch (unsubscribeError) {
            console.warn("[PALMYRA] No se pudo retirar la suscripción push antigua:", unsubscribeError);
            throw new Error("No se pudo renovar la suscripción push antigua. En los permisos del navegador, elimina la suscripción de PALMYRA y vuelve a activarla.");
          }
        }
      }

      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: decodeVapidKey(vapidPublicKey)
        });
      }

      const json = subscription.toJSON();
      const keys = json.keys;
      if (!json.endpoint || !keys?.p256dh || !keys?.auth) throw new Error("El navegador no devolvió una suscripción push válida.");
      const { error: saveError } = await supabase.from("push_subscriptions").upsert({
        company_id: companyId,
        user_id: userId,
        endpoint: json.endpoint,
        p256dh: keys.p256dh,
        auth_secret: keys.auth,
        user_agent: navigator.userAgent,
        enabled: true,
        last_seen_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, { onConflict: "endpoint" });
      if (saveError) throw saveError;
      const { error: prefError } = await supabase.from("notification_preferences").upsert({
        company_id: companyId,
        user_id: userId,
        ...prefs,
        push_enabled: true,
        updated_at: new Date().toISOString(),
      }, { onConflict: "company_id,user_id" });
      if (prefError) throw prefError;
      setPrefs((p) => ({ ...p, push_enabled: true }));
      setPushDeviceStatus("registered");
      pushToast("success", "Dispositivo registrado. PALMYRA puede enviarte avisos a este móvil.");
    } catch (e: any) {
      setError("No se pudo activar el push. Revisa los permisos del navegador y vuelve a intentarlo.");
    } finally {
      setPushBusy(false);
    }
  };

  const sendTestNotification = async () => {
    const supabase = getSupabase();
    if (!supabase || !companyId) return;
    setTestBusy(true);
    setError("");
    try {
      let notificationId: string | null = null;
      const { data: rpcId, error: testError } = await supabase.rpc("create_my_notification_test", { p_company_id: companyId });
      if (testError) {
        // El RPC de prueba puede no estar desplegado en la base; la fila directa
        // produce el mismo resultado (historial + disparo de push al propio usuario).
        const missingFunction = /(could not find the function|PGRST202|does not exist)/i.test(String(testError?.message || testError?.hint || ""));
        if (!missingFunction) throw testError;
        const { data: inserted, error: insertError } = await supabase
          .from("notifications")
          .insert({
            company_id: companyId,
            user_id: userId || null,
            kind: "test",
            title: "Prueba de notificaciones",
            body: "Si recibes este aviso en el móvil, el push ya está funcionando.",
          })
          .select("id")
          .single();
        if (insertError) throw insertError;
        notificationId = inserted?.id ? String(inserted.id) : null;
      } else {
        notificationId = rpcId != null ? String(rpcId) : null;
      }
      if (notificationId) {
        setNotices((items) => [{
          id: notificationId as string,
          kind: "test",
          title: "Prueba de notificaciones",
          body: "Si recibes este aviso en el móvil, el push ya está funcionando.",
          read_at: null,
          created_at: new Date().toISOString(),
          user_id: userId,
        }, ...items.filter((item) => item.id !== notificationId)].slice(0, 50));
      }
      pushToast("success", "Prueba creada. El envío al móvil puede tardar unos segundos.");
    } catch (e: any) {
      setError(e?.message || "No se pudo crear la notificación de prueba.");
    } finally {
      setTestBusy(false);
    }
  };

  const update = <K extends keyof Preferences,>(key: K, value: Preferences[K]) => setPrefs((current) => ({ ...current, [key]: value }));
  const unread = notices.filter((notice) => !notice.read_at).length;
  const localUnread = localNotices.filter((notice) => !notice.read_at).length;
  const totalUnread = unread + localUnread;
  const filteredNotices = notices.filter((notice) => {
    if (filter === "unread") return !notice.read_at;
    if (filter === "rates") return /exchange|currency|rate/i.test(notice.kind);
    return true;
  });
  const filterChips = [
    { id: "all", label: "Todos", count: notices.length },
    { id: "unread", label: "Sin leer", count: unread },
    { id: "rates", label: "Tasas", count: notices.filter((notice) => /exchange|currency|rate/i.test(notice.kind)).length },
  ] as const;

  return (
    <div className="w-full min-w-0 space-y-4 pb-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <span className="shrink-0 rounded-xl bg-violet-50 p-2.5 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300">
            <BellRing size={18} />
          </span>
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h2 className="text-xl font-bold leading-tight text-primary">Notificaciones</h2>
              {totalUnread > 0 && <span className="palmyra-badge palmyra-badge-info">{totalUnread > 99 ? "99+" : totalUnread} sin leer</span>}
            </div>
            <p className="text-sm font-medium text-secondary">Tus avisos y la forma en que quieres recibirlos.</p>
          </div>
        </div>
        <button
          type="button"
          title="Actualizar historial y preferencias"
          onClick={() => void refresh()}
          disabled={loading}
          className="flex h-11 w-full shrink-0 items-center justify-center gap-2 rounded-xl border border-base bg-secondary px-4 text-sm font-semibold text-primary transition-colors hover:bg-subtle disabled:opacity-50 sm:w-auto"
        >
          <RefreshCw size={15} className={loading ? "animate-spin" : ""} /> Actualizar
        </button>
      </header>

      <div role="tablist" aria-label="Vistas de notificaciones" className="grid grid-cols-2 gap-1 rounded-2xl border border-base bg-secondary p-1 sm:flex sm:w-fit">
        <button
          type="button"
          role="tab"
          aria-selected={view === "history"}
          onClick={() => setView("history")}
          className={cn(
            "flex h-11 items-center justify-center gap-1.5 rounded-xl px-4 text-sm font-semibold transition-colors",
            view === "history" ? "bg-violet-600 text-white shadow-sm" : "text-secondary hover:bg-subtle hover:text-primary",
          )}
        >
          Historial
          {unread > 0 && <span className={cn("inline-flex min-w-[18px] shrink-0 items-center justify-center rounded-full px-1.5 py-0.5 text-xs font-bold leading-none tabular-nums", view === "history" ? "bg-white/20 text-white" : "bg-violet-600 text-white")}>{unread > 99 ? "99+" : unread}</span>}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === "prefs"}
          onClick={() => setView("prefs")}
          className={cn(
            "flex h-11 items-center justify-center gap-1.5 rounded-xl px-4 text-sm font-semibold transition-colors",
            view === "prefs" ? "bg-violet-600 text-white shadow-sm" : "text-secondary hover:bg-subtle hover:text-primary",
          )}
        >
          Preferencias
        </button>
      </div>

      {error && <div role="alert" className="palmyra-toast palmyra-toast-warning"><AlertTriangle size={15} className="shrink-0" /><span className="min-w-0 flex-1 break-words">{error}</span></div>}
      {needsAccount && !error && (
        <div role="status" className="break-words rounded-xl border border-violet-200 bg-violet-50/70 p-3 text-sm font-medium leading-6 text-violet-900 dark:border-violet-900/50 dark:bg-violet-950/20 dark:text-violet-200">
          El historial y las preferencias se guardan en tu cuenta PALMYRA. Inicia sesión con tu empresa para verlos y recibir avisos en el móvil; el modo local no envía notificaciones push.
        </div>
      )}

      {view === "history" && (
        <section className="min-w-0 space-y-3">
          <div className="flex min-w-0 flex-col gap-2 rounded-2xl border border-base bg-secondary p-2 sm:flex-row sm:items-center sm:justify-between">
            <div role="group" aria-label="Filtrar avisos" className="flex min-w-0 flex-wrap gap-1">
              {filterChips.map((chip) => (
                <button
                  key={chip.id}
                  type="button"
                  aria-pressed={filter === chip.id}
                  onClick={() => setFilter(chip.id)}
                  className={cn(
                    "inline-flex h-11 items-center gap-1.5 rounded-xl px-3 text-sm font-semibold transition-colors",
                    filter === chip.id ? "bg-violet-600 text-white shadow-sm" : "text-secondary hover:bg-subtle hover:text-primary",
                  )}
                >
                  {chip.label}
                  <span className={cn("rounded-full px-1.5 py-0.5 text-xs font-bold tabular-nums", filter === chip.id ? "bg-white/20 text-white" : "bg-subtle text-muted")}>{chip.count}</span>
                </button>
              ))}
            </div>
            <button
              type="button"
              title="Marcar todos los avisos pendientes como leídos"
              onClick={() => void markAllRead()}
              disabled={markingAll || unread === 0}
              className="flex h-11 shrink-0 items-center justify-center gap-2 rounded-xl border border-base bg-primary px-3 text-sm font-semibold text-primary transition-colors hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-50"
            >
              <CheckCheck size={15} /> {markingAll ? "Marcando…" : "Marcar todo leído"}
            </button>
          </div>

          {loading ? (
            <div className="rounded-xl border border-base bg-secondary p-6 text-center text-sm font-medium text-muted"><RefreshCw size={16} className="mr-1.5 inline animate-spin" />Cargando avisos…</div>
          ) : filteredNotices.length === 0 ? (
            <div className="rounded-xl border border-dashed border-base bg-secondary p-6 text-center">
              <Bell size={26} className="mx-auto text-muted" />
              <p className="mt-2 text-sm font-bold text-primary">{notices.length === 0 ? "Todavía no hay avisos" : "No hay avisos con este filtro"}</p>
              <p className="mt-1 text-sm font-medium text-muted">{notices.length === 0 ? "Los avisos nuevos aparecerán aquí." : "Cambia el filtro para ver el historial completo."}</p>
            </div>
          ) : (
            <div className="grid min-w-0 gap-2 xl:grid-cols-2">
              {filteredNotices.map((notice) => (
                <article key={notice.id} className={cn("min-w-0 rounded-xl border p-3", notice.read_at ? "border-base bg-secondary" : "border-violet-200 bg-violet-50/70 dark:border-violet-900 dark:bg-violet-950/20")}>
                  <div className="flex min-w-0 items-start gap-2.5">
                    <div className={cn("shrink-0 rounded-xl p-2", notice.read_at ? "bg-subtle text-muted" : "bg-violet-100 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300")}><Bell size={16} /></div>
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                        <h3 className="min-w-0 break-words text-sm font-bold text-primary">{notice.title}</h3>
                        <span className="shrink-0 rounded-full bg-subtle px-2 py-0.5 text-xs font-semibold text-secondary">{kindLabel(notice.kind)}</span>
                        {!notice.read_at && <span className="shrink-0 rounded-full bg-violet-600 px-2 py-0.5 text-xs font-semibold text-white">Nuevo</span>}
                      </div>
                      <p className="mt-1 whitespace-pre-line break-words text-sm font-medium leading-6 text-secondary">{notice.body}</p>
                      <p className="mt-1.5 text-xs font-medium text-muted">{new Date(notice.created_at).toLocaleString("es-CU")}</p>
                    </div>
                    {!notice.read_at && (notice.user_id === userId || notice.user_id === null) && (
                      <button type="button" title="Marcar esta notificación como leída" aria-label="Marcar como leída" onClick={() => void markRead(notice)} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-violet-700 transition-colors hover:bg-violet-100 dark:text-violet-300 dark:hover:bg-violet-950/40"><CheckCheck size={16} /></button>
                    )}
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      )}

      {view === "history" && (
        <section className="min-w-0 space-y-3">
          <div className="flex min-w-0 flex-col gap-2 rounded-2xl border border-base bg-secondary p-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <h3 className="text-sm font-bold text-primary">De este dispositivo</h3>
              <p className="text-sm font-medium leading-5 text-muted">Stock bajo, cierres de turno y actualizaciones detectadas aquí, disponibles incluso sin conexión.</p>
            </div>
            <button
              type="button"
              title="Marcar todos los avisos locales como leídos"
              onClick={markAllLocalRead}
              disabled={localUnread === 0}
              className="flex h-11 shrink-0 items-center justify-center gap-2 rounded-xl border border-base bg-primary px-3 text-sm font-semibold text-primary transition-colors hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-50"
            >
              <CheckCheck size={15} /> {localUnread > 0 ? `Marcar todo leído (${localUnread})` : "Sin pendientes"}
            </button>
          </div>
          {localNotices.length === 0 ? (
            <div className="rounded-xl border border-dashed border-base bg-secondary p-6 text-center">
              <Package size={26} className="mx-auto text-muted" />
              <p className="mt-2 text-sm font-bold text-primary">Sin avisos locales</p>
              <p className="mt-1 text-sm font-medium text-muted">Cuando haya stock bajo, cierres de turno o una actualización pendiente, aparecerán aquí.</p>
            </div>
          ) : (
            <div className="grid min-w-0 gap-2 xl:grid-cols-2">
              {localNotices.map((notice) => (
                <article key={notice.id} className={cn("min-w-0 rounded-xl border p-3", notice.read_at ? "border-base bg-secondary" : "border-violet-200 bg-violet-50/70 dark:border-violet-900 dark:bg-violet-950/20")}>
                  <div className="flex min-w-0 items-start gap-2.5">
                    <div className={cn("shrink-0 rounded-xl p-2", notice.read_at ? "bg-subtle text-muted" : "bg-violet-100 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300")}>
                      {notice.kind === "low_stock" ? <Package size={16} /> : notice.kind === "shift_closed" ? <Clock3 size={16} /> : notice.kind === "offline_error" ? <WifiOff size={16} /> : <RefreshCw size={16} />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                        <h3 className="min-w-0 break-words text-sm font-bold text-primary">{notice.title}</h3>
                        <span className={cn("palmyra-badge shrink-0", notice.kind === "low_stock" ? "palmyra-badge-warning" : "palmyra-badge-info")}>
                          {notice.kind === "low_stock" ? "Stock bajo" : notice.kind === "shift_closed" ? "Turno" : notice.kind === "offline_error" ? "Sin conexión" : "Actualización"}
                        </span>
                        {!notice.read_at && <span className="palmyra-badge palmyra-badge-info shrink-0">Nuevo</span>}
                      </div>
                      <p className="mt-1 whitespace-pre-line break-words text-sm font-medium leading-6 text-secondary">{notice.body}</p>
                      <p className="mt-1.5 text-xs font-medium text-muted">{new Date(notice.created_at).toLocaleString("es-CU")}</p>
                    </div>
                    {!notice.read_at && (
                      <button type="button" title="Marcar esta notificación local como leída" aria-label="Marcar como leída" onClick={() => markLocalRead(notice.id)} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-violet-700 transition-colors hover:bg-violet-100 dark:text-violet-300 dark:hover:bg-violet-950/40"><CheckCheck size={16} /></button>
                    )}
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      )}

      {view === "prefs" && (
        <div className="space-y-4">

      <section className="min-w-0 rounded-2xl border border-base bg-secondary p-3 shadow-sm space-y-4 sm:p-5">
        <SettingsSectionHeader
          icon={Smartphone}
          title="Notificaciones en el móvil"
          subtitle={pushStatusDetail}
        />
        <span className="inline-flex w-fit items-center gap-1.5 rounded-full bg-violet-50 px-2.5 py-1 text-sm font-semibold text-violet-700 dark:bg-violet-950/40 dark:text-violet-300">
          {pushDeviceStatus === "registered" ? <CheckCheck size={14} /> : <Bell size={14} />}
          {pushStatusLabel}
        </span>
        <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-3">
          <button type="button" title="Solicitar permiso y registrar este dispositivo para recibir avisos push" disabled={pushBusy || loading || !companyId || !userId} onClick={() => void enablePush()} className="flex min-w-0 h-11 items-center justify-center gap-2 rounded-xl bg-violet-600 px-3 text-sm font-semibold text-white transition-colors hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-50">
            <Smartphone size={15} className="shrink-0" /><span className="break-words">{pushBusy ? "Activando…" : pushDeviceStatus === "registered" ? "Registrar de nuevo" : "Activar push"}</span>
          </button>
          <button type="button" title="Crear una notificación de prueba para comprobar el envío al móvil" disabled={testBusy || loading || !companyId} onClick={() => void sendTestNotification()} className="flex min-w-0 h-11 items-center justify-center gap-2 rounded-xl border border-violet-200 px-3 text-sm font-semibold text-violet-700 transition-colors hover:bg-violet-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-violet-900/50 dark:text-violet-300 dark:hover:bg-violet-950/40">
            <BellRing size={15} className="shrink-0" /><span>{testBusy ? "Enviando prueba…" : "Enviar prueba"}</span>
          </button>
          <button type="button" title="Volver a comprobar el permiso y la suscripción push del navegador" disabled={loading || pushDeviceStatus === "checking"} onClick={() => void checkPushStatus()} className="flex min-w-0 h-11 items-center justify-center gap-2 rounded-xl border border-base bg-primary px-3 text-sm font-semibold text-primary transition-colors hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-50">
            <RefreshCw size={15} className="shrink-0" /><span>Comprobar estado</span>
          </button>
        </div>
        <p className="text-sm font-medium leading-6 text-muted">Activar registra el móvil; Enviar prueba comprueba la entrega; Comprobar estado revisa el permiso del navegador. Cada móvil se registra por separado.</p>
      </section>

      <section className="min-w-0 rounded-2xl border border-base bg-secondary p-3 shadow-sm space-y-4 sm:p-5">
        <SettingsSectionHeader
          icon={BellRing}
          title="Alertas de tasas de cambio"
          subtitle="Configura divisas y Bitcoin por separado. Se compara la tasa publicada; no es una predicción del mercado."
        />
        <div className="space-y-2">
          <label className="flex min-w-0 items-center gap-3 rounded-xl border border-base bg-primary px-3 py-3">
            <input className="h-4 w-4 shrink-0 accent-violet-600" type="checkbox" checked={prefs.exchange_currency_alerts_enabled} onChange={(e) => update("exchange_currency_alerts_enabled", e.target.checked)} />
            <span className="min-w-0 flex-1"><span className="block text-sm font-semibold text-primary">Alertas de divisas</span><span className="block text-sm font-medium leading-5 text-muted">Avisar solo de las monedas seleccionadas.</span></span>
          </label>
          <label className="flex min-w-0 items-center gap-3 rounded-xl border border-base bg-primary px-3 py-3">
            <input className="h-4 w-4 shrink-0 accent-violet-600" type="checkbox" checked={prefs.exchange_bitcoin_alerts_enabled} onChange={(e) => update("exchange_bitcoin_alerts_enabled", e.target.checked)} />
            <span className="min-w-0 flex-1"><span className="block text-sm font-semibold text-primary">Bitcoin (BTC)</span><span className="block text-sm font-medium leading-5 text-muted">Control independiente del resto de divisas.</span></span>
          </label>
        </div>
        <details className="group min-w-0 rounded-xl border border-base bg-primary">
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 text-sm font-semibold text-primary [&amp;::-webkit-details-marker]:hidden">
            <span className="min-w-0">
              Monedas a vigilar
              <span className="ml-1.5 rounded-full bg-subtle px-2 py-0.5 text-xs font-bold text-secondary">{prefs.exchange_currency_codes.length}</span>
            </span>
            <ChevronDown size={15} className="shrink-0 text-muted transition-transform group-open:rotate-180" />
          </summary>
          <div className="border-t border-base p-3">
            <div className="mb-2 flex justify-end">
              <button type="button" title="Marcar todas las divisas disponibles en la lista" onClick={() => update("exchange_currency_codes", rateOptions.map((option) => option.code))} className="h-11 rounded-xl border border-base bg-secondary px-3 text-sm font-semibold text-primary transition-colors hover:bg-subtle">Seleccionar todas</button>
            </div>
            {rateOptions.length ? <div className="grid min-w-0 grid-cols-1 gap-1.5 sm:grid-cols-2">
              {rateOptions.map((option) => <label key={option.code} className="flex min-w-0 items-center gap-2 rounded-xl bg-subtle px-3 py-2">
                <input className="h-4 w-4 shrink-0 accent-violet-600" type="checkbox" checked={prefs.exchange_currency_codes.includes(option.code)} onChange={(e) => update("exchange_currency_codes", e.target.checked ? [...new Set([...prefs.exchange_currency_codes, option.code])] : prefs.exchange_currency_codes.filter((code) => code !== option.code))} />
                <span className="min-w-0 flex-1 break-words text-sm font-medium text-primary">{option.name}</span><span className="shrink-0 text-sm font-bold text-muted">{option.code}</span>
              </label>)}
            </div> : <p className="text-sm font-medium text-muted">No se pudo cargar la lista ahora; se mantienen las opciones guardadas.</p>}
            <p className="mt-2 text-sm font-medium text-muted">La lista depende de las divisas que publique la fuente de tasas.</p>
          </div>
        </details>
        <div className="min-w-0 space-y-2 rounded-xl border border-base bg-primary p-3">
          <span className="block text-sm font-semibold text-muted">Umbral de aviso</span>
          <div className="grid grid-cols-2 gap-1.5" role="tablist" aria-label="Tipo de umbral para alertas de tasas">
            {([
              { id: 'percent', label: 'Por porcentaje (%)' },
              { id: 'absolute', label: 'Por monto fijo' },
            ] as const).map(option => (
              <button
                key={option.id}
                type="button"
                role="tab"
                aria-selected={prefs.exchange_alert_mode === option.id}
                onClick={() => update('exchange_alert_mode', option.id)}
                className={cn(
                  'min-h-10 rounded-xl border px-2 text-sm font-semibold transition-colors',
                  prefs.exchange_alert_mode === option.id
                    ? 'border-violet-300 bg-violet-50 text-violet-700 dark:border-violet-800 dark:bg-violet-950/40 dark:text-violet-300'
                    : 'border-base bg-subtle text-secondary hover:text-primary',
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
          {prefs.exchange_alert_mode === 'percent' ? (
            <label className="block min-w-0">
              <span className="block text-sm font-semibold text-muted">Variación mínima (%)</span>
              <input
                className="mt-1 block h-11 w-full min-w-0 rounded-xl border border-base bg-subtle px-3 text-sm font-semibold text-primary outline-none focus:ring-1 focus:ring-violet-500"
                type="number" min="0" max="100" step="0.01"
                value={prefs.exchange_alert_min_change_pct}
                onChange={(e) => update('exchange_alert_min_change_pct', Math.min(100, Math.max(0, Number(e.target.value) || 0)))}
              />
              <span className="mt-1 block text-sm font-medium leading-5 text-muted">Ejemplo: 2 avisa cuando la tasa sube o baja 2 % o más. 0 = cualquier cambio detectado.</span>
            </label>
          ) : (
            <label className="block min-w-0">
              <span className="block text-sm font-semibold text-muted">Variación mínima (importe de la tasa)</span>
              <input
                className="mt-1 block h-11 w-full min-w-0 rounded-xl border border-base bg-subtle px-3 text-sm font-semibold text-primary outline-none focus:ring-1 focus:ring-violet-500"
                type="number" min="0" step="0.01"
                value={prefs.exchange_alert_min_change_abs}
                onChange={(e) => update('exchange_alert_min_change_abs', Math.max(0, Number(e.target.value) || 0))}
              />
              <span className="mt-1 block text-sm font-medium leading-5 text-muted">Ejemplo: 5 avisa solo si la tasa sube o baja 5 pesos o más, sea cual sea el porcentaje. 0 = cualquier cambio detectado.</span>
            </label>
          )}
        </div>
        <p className="text-sm font-medium text-muted">Se revisa cada cinco minutos. Los cambios se aplican al guardar.</p>
      </section>

      <section className="min-w-0 space-y-4 rounded-2xl border border-base bg-secondary p-3 shadow-sm sm:p-5">
        <SettingsSectionHeader
          icon={Clock3}
          title="Horario y preferencias"
          subtitle="Elige cuándo quieres silencio y qué tipo de avisos recibir."
        />
        <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
          <label className="flex min-h-11 min-w-0 items-center justify-between gap-3 rounded-xl border border-base bg-primary px-3 py-2.5"><span className="min-w-0"><span className="block text-sm font-semibold text-primary">Horario de silencio</span><span className="block text-sm font-medium leading-5 text-muted">Pausa avisos rutinarios en el intervalo elegido.</span></span><input className="h-4 w-4 shrink-0 accent-violet-600" type="checkbox" checked={prefs.quiet_hours_enabled} onChange={(e) => update("quiet_hours_enabled", e.target.checked)} /></label>
          <label className="flex min-h-11 min-w-0 items-center justify-between gap-3 rounded-xl border border-base bg-primary px-3 py-2.5"><span className="min-w-0"><span className="block text-sm font-semibold text-primary">Resumen diario</span><span className="block text-sm font-medium leading-5 text-muted">Recibir un resumen a la hora indicada.</span></span><input className="h-4 w-4 shrink-0 accent-violet-600" type="checkbox" checked={prefs.routine_summary_enabled} onChange={(e) => update("routine_summary_enabled", e.target.checked)} /></label>
        </div>
        <details className="group min-w-0 rounded-xl border border-base bg-primary">
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 text-sm font-semibold text-primary [&amp;::-webkit-details-marker]:hidden">
            Horarios, zona horaria y tipos de aviso
            <ChevronDown size={15} className="shrink-0 text-muted transition-transform group-open:rotate-180" />
          </summary>
          <div className="grid min-w-0 grid-cols-1 gap-2 border-t border-base p-3 sm:grid-cols-2">
            <label className="block min-w-0"><span className="block text-sm font-semibold text-muted">Inicio del silencio</span><input className="mt-1 block h-11 w-full min-w-0 rounded-xl border border-base bg-subtle px-3 text-sm font-semibold text-primary outline-none focus:ring-1 focus:ring-violet-500" type="time" value={prefs.quiet_hours_start} onChange={(e) => update("quiet_hours_start", e.target.value)} /></label>
            <label className="block min-w-0"><span className="block text-sm font-semibold text-muted">Fin del silencio</span><input className="mt-1 block h-11 w-full min-w-0 rounded-xl border border-base bg-subtle px-3 text-sm font-semibold text-primary outline-none focus:ring-1 focus:ring-violet-500" type="time" value={prefs.quiet_hours_end} onChange={(e) => update("quiet_hours_end", e.target.value)} /></label>
            <label className="block min-w-0"><span className="block text-sm font-semibold text-muted">Hora del resumen</span><input className="mt-1 block h-11 w-full min-w-0 rounded-xl border border-base bg-subtle px-3 text-sm font-semibold text-primary outline-none focus:ring-1 focus:ring-violet-500" type="time" value={prefs.routine_summary_time} onChange={(e) => update("routine_summary_time", e.target.value)} /></label>
            <label className="block min-w-0"><span className="block text-sm font-semibold text-muted">Zona horaria</span><select className="mt-1 block h-11 w-full min-w-0 rounded-xl border border-base bg-subtle px-3 text-sm font-semibold text-primary outline-none focus:ring-1 focus:ring-violet-500" value={prefs.timezone} onChange={(e) => update("timezone", e.target.value)}><option value="America/Havana">Cuba</option><option value="America/Puerto_Rico">Puerto Rico</option><option value="America/New_York">Este de EE. UU.</option><option value="UTC">UTC</option></select></label>
            <label className="flex min-h-11 min-w-0 items-center justify-between gap-3 rounded-xl bg-subtle px-3 py-2"><span className="min-w-0"><span className="block text-sm font-semibold text-primary">Push habilitado</span><span className="block text-sm font-medium leading-5 text-muted">Avisos en este dispositivo registrado.</span></span><input className="h-4 w-4 shrink-0 accent-violet-600" type="checkbox" checked={prefs.push_enabled} onChange={(e) => update("push_enabled", e.target.checked)} /></label>
            <label className="flex min-h-11 min-w-0 items-center justify-between gap-3 rounded-xl bg-subtle px-3 py-2"><span className="min-w-0"><span className="flex items-center gap-1.5 text-sm font-semibold text-primary"><ShieldAlert size={15} className="shrink-0 text-[var(--danger)]" />Avisos críticos</span><span className="block text-sm font-medium leading-5 text-muted">Prioriza alertas críticas de inmediato.</span></span><input className="h-4 w-4 shrink-0 accent-violet-600" type="checkbox" checked={prefs.critical_push_enabled} onChange={(e) => update("critical_push_enabled", e.target.checked)} /></label>
            <label className="flex min-h-11 min-w-0 items-center justify-between gap-3 rounded-xl bg-subtle px-3 py-2 sm:col-span-2"><span className="min-w-0"><span className="flex items-center gap-1.5 text-sm font-semibold text-primary"><Laugh size={15} className="shrink-0 text-violet-500" />Humor PALMYRA</span><span className="block text-sm font-medium leading-5 text-muted">Activa o desactiva los mensajes con humor.</span></span><input className="h-4 w-4 shrink-0 accent-violet-600" type="checkbox" checked={prefs.humour_enabled} onChange={(e) => update("humour_enabled", e.target.checked)} /></label>
          </div>
        </details>
      </section>

      <div className="sticky bottom-3 z-10 flex min-w-0 flex-col gap-2 rounded-2xl border border-base bg-primary/95 p-2.5 shadow-lg backdrop-blur sm:flex-row sm:items-center sm:justify-between">
        <p className="min-w-0 px-1 text-sm font-medium text-muted">Los cambios de preferencias se aplican al guardar. Registrar el móvil se aplica al instante.</p>
        <button type="button" title="Guardar todas las preferencias de notificación" disabled={saving || loading} onClick={() => void savePrefs()} className="h-11 w-full shrink-0 rounded-xl bg-violet-600 px-4 text-sm font-semibold text-white transition-colors hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto">{saving ? "Guardando…" : "Guardar preferencias"}</button>
      </div>
        </div>
      )}

      <ToastHost toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
