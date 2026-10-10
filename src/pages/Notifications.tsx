import { useCallback, useEffect, useState } from "react";
import { Bell, BellRing, CheckCheck, RefreshCw, Smartphone, Clock3, ShieldAlert, Laugh, AlertTriangle } from "lucide-react";
import { getSupabase } from "../lib/supabase";
import { loadSaaSContext } from "../services/saas";

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
  exchange_alert_min_change_pct: number;
};
type RateOption = { code: string; name: string };
const DEFAULT_RATE_OPTIONS: RateOption[] = [
  { code: "USD", name: "Dólar estadounidense" }, { code: "EUR", name: "Euro" },
  { code: "MLC", name: "Moneda libremente convertible (MLC)" }, { code: "CAD", name: "Dólar canadiense" },
  { code: "MXN", name: "Peso mexicano" }, { code: "GBP", name: "Libra esterlina" },
  { code: "CHF", name: "Franco suizo" }, { code: "RUB", name: "Rublo ruso" },
  { code: "CUP", name: "Peso cubano" }, { code: "CNY", name: "Yuan chino" },
  { code: "JPY", name: "Yen japonés" }, { code: "BRL", name: "Real brasileño" },
  { code: "COP", name: "Peso colombiano" }, { code: "DOP", name: "Peso dominicano" },
  { code: "AUD", name: "Dólar australiano" }, { code: "NZD", name: "Dólar neozelandés" },
  { code: "ZELLE", name: "Zelle · pagos en USD" }, { code: "CLA", name: "Clásica" },
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
  exchange_alert_min_change_pct: 0,
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

export default function Notifications() {
  const [companyId, setCompanyId] = useState("");
  const [userId, setUserId] = useState("");
  const [notices, setNotices] = useState<Notice[]>([]);
  const [prefs, setPrefs] = useState<Preferences>(defaults);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [testBusy, setTestBusy] = useState(false);
  const [message, setMessage] = useState("");
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
        setPushDeviceStatus("registered");
      } else {
        setPushDeviceStatus(vapidPublicKey ? "not_registered" : "missing_key");
      }
    } catch {
      setPushDeviceStatus(vapidPublicKey ? "not_registered" : "missing_key");
    }
  }, [vapidPublicKey]);

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
    unsupported: "Abre PALMYRA con Chrome en Android o con un navegador compatible con notificaciones push.",
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
      if (!supabase) throw new Error("Supabase no está configurado.");
      const [ctxResult, authResult] = await Promise.all([loadSaaSContext(true), supabase.auth.getUser()]);
      const cid = ctxResult?.companyId || "";
      const uid = authResult.data.user?.id || "";
      if (!cid || !uid) throw new Error("No pudimos confirmar tu empresa y usuario. Vuelve a iniciar sesión cuando tengas conexión.");
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
      setNotices(((noticeResult.data || []) as Notice[]).map((notice) => ({
        ...notice,
        read_at: notice.user_id === null ? (readById.get(notice.id) || null) : notice.read_at,
      })));
      if (prefResult.data) {
        setPrefs({
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
          exchange_alert_min_change_pct: Number(prefResult.data.exchange_alert_min_change_pct ?? 0),
        });
      }
    } catch (e: any) {
      setError(e?.message || "No se pudieron cargar las notificaciones.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const savePrefs = async () => {
    const supabase = getSupabase();
    if (!supabase || !companyId || !userId) return;
    setError("");
    if (prefs.exchange_currency_alerts_enabled && prefs.exchange_currency_codes.length === 0) {
      setError("Activa las alertas de divisas solo después de seleccionar al menos una moneda.");
      return;
    }
    setSaving(true);
    setMessage("");
    setError("");
    try {
      const { error: saveError } = await supabase.from("notification_preferences").upsert({
        company_id: companyId,
        user_id: userId,
        ...prefs,
        updated_at: new Date().toISOString(),
      }, { onConflict: "company_id,user_id" });
      if (saveError) throw saveError;
      setMessage("¡Listo! Preferencias guardadas. PALMYRA ya sabe cuándo hablar y cuándo cerrar el pico. 😂");
    } catch (e: any) {
      setError(e?.message || "No se pudieron guardar las preferencias.");
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

  const enablePush = async () => {
    setError("");
    setMessage("");
    setPushBusy(true);
    try {
      if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
        throw new Error("Este navegador no admite notificaciones push. Prueba desde Chrome e instala PALMYRA como aplicación.");
      }
      if (!vapidPublicKey) {
        throw new Error("La suscripción push está preparada, pero falta configurar VITE_VAPID_PUBLIC_KEY en el despliegue. No activaremos un envío a medias.");
      }
      if (Notification.permission === "denied") {
        throw new Error("El navegador bloqueó las notificaciones. Actívalas en los permisos del sitio y vuelve aquí.");
      }
      const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
      if (permission !== "granted") throw new Error("No se concedió permiso para mostrar notificaciones.");
      const registration = await navigator.serviceWorker.ready;
      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: decodeVapidKey(vapidPublicKey) });
      const json = subscription.toJSON();
      const keys = json.keys;
      if (!json.endpoint || !keys?.p256dh || !keys?.auth) throw new Error("El navegador no devolvió una suscripción push válida.");
      const supabase = getSupabase();
      if (!supabase) throw new Error("Supabase no está configurado.");
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
      setMessage("¡Dispositivo registrado! PALMYRA ya tiene dónde tocarte el hombro cuando llegue un aviso. 😂");
    } catch (e: any) {
      setError(e?.message || "No se pudo activar el push.");
    } finally {
      setPushBusy(false);
    }
  };

  const sendTestNotification = async () => {
    const supabase = getSupabase();
    if (!supabase || !companyId) return;
    setTestBusy(true);
    setMessage("");
    setError("");
    try {
      const { data: notificationId, error: testError } = await supabase.rpc("create_my_notification_test", { p_company_id: companyId });
      if (testError) throw testError;
      if (notificationId) {
        setNotices((items) => [{
          id: String(notificationId),
          kind: "test",
          title: "¡PRUEBA DE NOTIFICACIONES! 🔔",
          body: "Si recibes esto en el móvil, el push ya está funcionando. PALMYRA ha dejado de gritarle al vacío. 😂",
          read_at: null,
          created_at: new Date().toISOString(),
          user_id: userId,
        }, ...items.filter((item) => item.id !== String(notificationId))].slice(0, 50));
      }
      setMessage("Prueba creada; PALMYRA ha solicitado el envío inmediato al móvil. Dale unos segundos para que llegue. 😂");
    } catch (e: any) {
      setError(e?.message || "No se pudo crear la notificación de prueba.");
    } finally {
      setTestBusy(false);
    }
  };

  const update = <K extends keyof Preferences,>(key: K, value: Preferences[K]) => setPrefs((current) => ({ ...current, [key]: value }));
  const unread = notices.filter((notice) => !notice.read_at).length;

  return (
    <div className="mx-auto w-full min-w-0 max-w-4xl space-y-3 overflow-x-hidden pb-6 text-sm">
      <header className="rounded-2xl bg-gradient-to-r from-violet-800 to-indigo-700 p-4 text-white shadow-sm sm:p-5">
        <div className="flex min-w-0 items-start gap-3">
          <div className="rounded-xl border border-white/20 bg-white/10 p-2"><BellRing className="h-5 w-5" /></div>
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-bold uppercase tracking-widest text-violet-200">PALMYRA · CENTRO DE AVISOS</p>
            <h1 className="mt-1 break-words text-xl font-black tracking-tight sm:text-2xl">Notificaciones</h1>
            <p className="mt-1 max-w-2xl text-xs leading-5 text-violet-100">Configura los avisos, prueba el móvil y revisa el historial desde un solo lugar.</p>
          </div>
          <button type="button" title="Actualizar historial y preferencias" aria-label="Actualizar historial y preferencias" onClick={() => void refresh()} className="shrink-0 rounded-lg border border-white/20 bg-white/10 p-2 hover:bg-white/20 disabled:opacity-50" disabled={loading}>
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <span className="rounded-lg bg-white/15 px-2.5 py-1 text-xs font-semibold">{notices.length} avisos</span>
          <span className="rounded-lg bg-white/15 px-2.5 py-1 text-xs font-semibold">{unread} sin leer</span>
          <span className="rounded-lg bg-white/15 px-2.5 py-1 text-xs font-semibold">{pushStatusLabel}</span>
        </div>
      </header>

      {message && <div role="status" className="break-words rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-xs leading-5 font-semibold text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200">{message}</div>}
      {error && <div role="alert" className="break-words rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs leading-5 font-semibold text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200"><AlertTriangle className="mr-1.5 inline h-4 w-4" />{error}</div>}

      <section className="min-w-0 rounded-2xl border border-violet-200 bg-white p-3 shadow-sm dark:border-violet-900 dark:bg-slate-900 sm:p-4">
        <div className="flex min-w-0 items-start gap-2.5">
          <div className="shrink-0 rounded-lg bg-violet-100 p-2 text-violet-700"><Smartphone className="h-5 w-5" /></div>
          <div className="min-w-0 flex-1">
            <h2 className="font-bold text-slate-900 dark:text-white">Notificaciones en el móvil</h2>
            <p className="mt-0.5 break-words text-xs leading-5 text-slate-500">{pushStatusDetail}</p>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
          <button type="button" title="Solicitar permiso y registrar este dispositivo para recibir avisos push" disabled={pushBusy || loading || !companyId || !userId} onClick={() => void enablePush()} className="flex min-w-0 items-center justify-center gap-2 rounded-lg bg-violet-700 px-3 py-2.5 text-xs font-bold text-white hover:bg-violet-800 disabled:cursor-not-allowed disabled:opacity-50">
            <Smartphone className="h-4 w-4 shrink-0" /><span className="break-words">{pushBusy ? "Activando…" : pushDeviceStatus === "registered" ? "Registrar de nuevo" : "Activar push"}</span>
          </button>
          <button type="button" title="Crear una notificación de prueba para comprobar el envío al móvil" disabled={testBusy || loading || !companyId} onClick={() => void sendTestNotification()} className="flex min-w-0 items-center justify-center gap-2 rounded-lg border border-violet-200 px-3 py-2.5 text-xs font-bold text-violet-800 hover:bg-violet-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-violet-800 dark:text-violet-200 dark:hover:bg-violet-950/40">
            <BellRing className="h-4 w-4 shrink-0" /><span>{testBusy ? "Enviando prueba…" : "Enviar prueba"}</span>
          </button>
          <button type="button" title="Volver a comprobar el permiso y la suscripción push del navegador" disabled={loading || pushDeviceStatus === "checking"} onClick={() => void checkPushStatus()} className="flex min-w-0 items-center justify-center gap-2 rounded-lg border border-slate-200 px-3 py-2.5 text-xs font-bold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800">
            <RefreshCw className="h-4 w-4 shrink-0" /><span>Comprobar estado</span>
          </button>
        </div>
        <p className="mt-2 text-[11px] leading-4 text-slate-500">Activar registra el móvil; Enviar prueba comprueba la entrega; Comprobar estado revisa el permiso del navegador. Cada móvil se registra por separado.</p>
      </section>

      <section className="min-w-0 rounded-2xl border border-emerald-200 bg-white p-3 shadow-sm dark:border-emerald-900 dark:bg-slate-900 sm:p-4">
        <div className="flex min-w-0 items-start gap-2.5">
          <div className="shrink-0 rounded-lg bg-emerald-100 p-2 text-emerald-800"><BellRing className="h-5 w-5" /></div>
          <div className="min-w-0 flex-1">
            <h2 className="font-bold text-slate-900 dark:text-white">Alertas de tasas de cambio</h2>
            <p className="mt-0.5 text-xs leading-5 text-slate-500">Configura divisas y Bitcoin por separado. Se compara la tasa publicada; no es una predicción del mercado.</p>
          </div>
        </div>
        <div className="mt-3 space-y-2">
          <label className="flex min-w-0 items-center gap-3 rounded-lg border border-slate-200 px-3 py-2.5 dark:border-slate-700">
            <input className="h-4 w-4 shrink-0 accent-emerald-700" type="checkbox" checked={prefs.exchange_currency_alerts_enabled} onChange={(e) => update("exchange_currency_alerts_enabled", e.target.checked)} />
            <span className="min-w-0 flex-1"><span className="block text-xs font-bold text-slate-800 dark:text-slate-100">Alertas de divisas</span><span className="block text-[11px] leading-4 text-slate-500">Avisar solo de las monedas seleccionadas.</span></span>
          </label>
          <label className="flex min-w-0 items-center gap-3 rounded-lg border border-slate-200 px-3 py-2.5 dark:border-slate-700">
            <input className="h-4 w-4 shrink-0 accent-emerald-700" type="checkbox" checked={prefs.exchange_bitcoin_alerts_enabled} onChange={(e) => update("exchange_bitcoin_alerts_enabled", e.target.checked)} />
            <span className="min-w-0 flex-1"><span className="block text-xs font-bold text-slate-800 dark:text-slate-100">Bitcoin (BTC)</span><span className="block text-[11px] leading-4 text-slate-500">Control independiente del resto de divisas.</span></span>
          </label>
        </div>
        <div className="mt-3 min-w-0 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
          <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0"><h3 className="text-xs font-bold text-slate-900 dark:text-white">Monedas a vigilar</h3><p className="mt-0.5 text-[11px] text-slate-500">{prefs.exchange_currency_codes.length} seleccionadas</p></div>
            <button type="button" title="Marcar todas las divisas disponibles en la lista" onClick={() => update("exchange_currency_codes", rateOptions.map((option) => option.code))} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 sm:w-auto dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800">Seleccionar todas</button>
          </div>
          {rateOptions.length ? <div className="mt-2 grid min-w-0 grid-cols-1 gap-1.5 sm:grid-cols-2">
            {rateOptions.map((option) => <label key={option.code} className="flex min-w-0 items-center gap-2 rounded-lg bg-slate-50 px-2.5 py-2 dark:bg-slate-800">
              <input className="h-4 w-4 shrink-0 accent-emerald-700" type="checkbox" checked={prefs.exchange_currency_codes.includes(option.code)} onChange={(e) => update("exchange_currency_codes", e.target.checked ? [...new Set([...prefs.exchange_currency_codes, option.code])] : prefs.exchange_currency_codes.filter((code) => code !== option.code))} />
              <span className="min-w-0 flex-1 break-words text-xs text-slate-800 dark:text-slate-100">{option.name}</span><span className="shrink-0 text-[10px] font-bold text-slate-500">{option.code}</span>
            </label>)}
          </div> : <p className="mt-2 text-xs text-slate-500">No se pudo cargar la lista ahora; se mantienen las opciones guardadas.</p>}
          <p className="mt-2 text-[11px] leading-4 text-slate-500">La lista depende de las divisas que publique la fuente de tasas.</p>
        </div>
        <div className="mt-3 grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <label className="block min-w-0"><span className="block text-xs font-bold text-slate-700 dark:text-slate-200">Variación mínima (%)</span><input className="mt-1 block w-full min-w-0 rounded-lg border border-slate-200 bg-transparent px-3 py-2.5 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100 dark:border-slate-700" type="number" min="0" max="100" step="0.01" value={prefs.exchange_alert_min_change_pct} onChange={(e) => update("exchange_alert_min_change_pct", Math.min(100, Math.max(0, Number(e.target.value) || 0)))} /><span className="mt-1 block text-[11px] leading-4 text-slate-500">0 = cualquier cambio detectado; un porcentaje mayor reduce avisos pequeños.</span></label>
          <button type="button" title="Guardar los interruptores, las monedas elegidas y el porcentaje mínimo" disabled={saving || loading} onClick={() => void savePrefs()} className="w-full rounded-lg bg-emerald-700 px-4 py-2.5 text-xs font-bold text-white hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto">{saving ? "Guardando…" : "Guardar alertas"}</button>
        </div>
        <p className="mt-2 text-[11px] leading-4 text-slate-500">Revisión aproximada cada cinco minutos. Guarda los cambios para aplicarlos.</p>
      </section>

      <section className="min-w-0 rounded-2xl border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-800 dark:bg-slate-900 sm:p-4">
        <div className="flex min-w-0 items-start gap-2.5">
          <div className="shrink-0 rounded-lg bg-slate-100 p-2 text-slate-700 dark:bg-slate-800 dark:text-slate-200"><Clock3 className="h-5 w-5" /></div>
          <div className="min-w-0 flex-1"><h2 className="font-bold text-slate-900 dark:text-white">Horario y preferencias</h2><p className="mt-0.5 text-xs leading-5 text-slate-500">Controla el silencio, el resumen y los tipos de aviso.</p></div>
        </div>
        <div className="mt-3 grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
          <label className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-slate-200 px-3 py-2.5 dark:border-slate-700"><span className="min-w-0"><span className="block text-xs font-semibold text-slate-800 dark:text-slate-100">Horario de silencio</span><span className="block text-[11px] leading-4 text-slate-500">Pausa avisos rutinarios en el intervalo elegido.</span></span><input className="h-4 w-4 shrink-0 accent-violet-700" type="checkbox" checked={prefs.quiet_hours_enabled} onChange={(e) => update("quiet_hours_enabled", e.target.checked)} /></label>
          <label className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-slate-200 px-3 py-2.5 dark:border-slate-700"><span className="min-w-0"><span className="block text-xs font-semibold text-slate-800 dark:text-slate-100">Resumen diario</span><span className="block text-[11px] leading-4 text-slate-500">Recibir un resumen a la hora indicada.</span></span><input className="h-4 w-4 shrink-0 accent-violet-700" type="checkbox" checked={prefs.routine_summary_enabled} onChange={(e) => update("routine_summary_enabled", e.target.checked)} /></label>
          <label className="block min-w-0 rounded-lg border border-slate-200 px-3 py-2.5 dark:border-slate-700"><span className="block text-xs font-semibold text-slate-700 dark:text-slate-200">Inicio del silencio</span><input className="mt-1 block w-full min-w-0 rounded-lg border border-slate-200 bg-transparent px-3 py-2 text-sm dark:border-slate-700" type="time" value={prefs.quiet_hours_start} onChange={(e) => update("quiet_hours_start", e.target.value)} /></label>
          <label className="block min-w-0 rounded-lg border border-slate-200 px-3 py-2.5 dark:border-slate-700"><span className="block text-xs font-semibold text-slate-700 dark:text-slate-200">Fin del silencio</span><input className="mt-1 block w-full min-w-0 rounded-lg border border-slate-200 bg-transparent px-3 py-2 text-sm dark:border-slate-700" type="time" value={prefs.quiet_hours_end} onChange={(e) => update("quiet_hours_end", e.target.value)} /></label>
          <label className="block min-w-0 rounded-lg border border-slate-200 px-3 py-2.5 dark:border-slate-700"><span className="block text-xs font-semibold text-slate-700 dark:text-slate-200">Hora del resumen</span><input className="mt-1 block w-full min-w-0 rounded-lg border border-slate-200 bg-transparent px-3 py-2 text-sm dark:border-slate-700" type="time" value={prefs.routine_summary_time} onChange={(e) => update("routine_summary_time", e.target.value)} /></label>
          <label className="block min-w-0 rounded-lg border border-slate-200 px-3 py-2.5 dark:border-slate-700"><span className="block text-xs font-semibold text-slate-700 dark:text-slate-200">Zona horaria</span><select className="mt-1 block w-full min-w-0 rounded-lg border border-slate-200 bg-transparent px-3 py-2 text-sm dark:border-slate-700" value={prefs.timezone} onChange={(e) => update("timezone", e.target.value)}><option value="America/Havana">Cuba</option><option value="America/Puerto_Rico">Puerto Rico</option><option value="America/New_York">Este de EE. UU.</option><option value="UTC">UTC</option></select></label>
          <label className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-slate-200 px-3 py-2.5 dark:border-slate-700"><span className="min-w-0"><span className="block text-xs font-semibold text-slate-800 dark:text-slate-100">Push habilitado</span><span className="block text-[11px] leading-4 text-slate-500">Permite avisos en este dispositivo registrado.</span></span><input className="h-4 w-4 shrink-0 accent-violet-700" type="checkbox" checked={prefs.push_enabled} onChange={(e) => update("push_enabled", e.target.checked)} /></label>
          <label className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-slate-200 px-3 py-2.5 dark:border-slate-700"><span className="min-w-0"><span className="flex items-center gap-1.5 text-xs font-semibold text-slate-800 dark:text-slate-100"><ShieldAlert className="h-4 w-4 shrink-0 text-rose-500" />Avisos críticos</span><span className="block text-[11px] leading-4 text-slate-500">Prioriza alertas críticas de forma inmediata.</span></span><input className="h-4 w-4 shrink-0 accent-violet-700" type="checkbox" checked={prefs.critical_push_enabled} onChange={(e) => update("critical_push_enabled", e.target.checked)} /></label>
          <label className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-slate-200 px-3 py-2.5 dark:border-slate-700"><span className="min-w-0"><span className="flex items-center gap-1.5 text-xs font-semibold text-slate-800 dark:text-slate-100"><Laugh className="h-4 w-4 shrink-0 text-violet-500" />Humor PALMYRA</span><span className="block text-[11px] leading-4 text-slate-500">Activa o desactiva los mensajes con humor.</span></span><input className="h-4 w-4 shrink-0 accent-violet-700" type="checkbox" checked={prefs.humour_enabled} onChange={(e) => update("humour_enabled", e.target.checked)} /></label>
        </div>
        <button type="button" title="Guardar el horario y todas las preferencias generales de notificación" disabled={saving || loading} onClick={() => void savePrefs()} className="mt-3 w-full rounded-lg bg-violet-700 px-4 py-2.5 text-xs font-bold text-white hover:bg-violet-800 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto">{saving ? "Guardando…" : "Guardar preferencias"}</button>
      </section>

      <section className="min-w-0 space-y-2">
        <div className="flex min-w-0 items-end justify-between gap-3 px-1">
          <div className="min-w-0"><h2 className="font-bold text-slate-900 dark:text-white">Historial reciente</h2><p className="mt-0.5 text-xs text-slate-500">Avisos guardados, incluso al cerrar la pantalla.</p></div>
          <span className="shrink-0 rounded-lg bg-slate-100 px-2 py-1 text-[11px] font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300">{notices.length} total</span>
        </div>
        {loading ? <div className="rounded-xl border border-slate-200 p-6 text-center text-xs text-slate-500"><RefreshCw className="mr-1.5 inline h-4 w-4 animate-spin" />Cargando avisos…</div> : notices.length === 0 ? <div className="rounded-xl border border-dashed border-slate-300 p-6 text-center dark:border-slate-700"><Bell className="mx-auto h-7 w-7 text-slate-300" /><p className="mt-2 text-sm font-bold text-slate-700 dark:text-slate-200">Todavía no hay avisos</p><p className="mt-1 text-xs text-slate-500">Los avisos nuevos aparecerán aquí.</p></div> : notices.map((notice) => <article key={notice.id} className={`min-w-0 rounded-xl border p-3 ${notice.read_at ? "border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900" : "border-violet-200 bg-violet-50/70 dark:border-violet-900 dark:bg-violet-950/20"}`}>
          <div className="flex min-w-0 items-start gap-2.5">
            <div className={`shrink-0 rounded-lg p-2 ${notice.read_at ? "bg-slate-100 text-slate-500" : "bg-violet-100 text-violet-700"}`}><Bell className="h-4 w-4" /></div>
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 flex-wrap items-center gap-1.5"><h3 className="min-w-0 break-words font-bold text-slate-900 dark:text-white">{notice.title}</h3><span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-600 dark:bg-slate-800 dark:text-slate-300">{kindLabel(notice.kind)}</span>{!notice.read_at && <span className="shrink-0 rounded-full bg-violet-700 px-2 py-0.5 text-[10px] font-bold text-white">Nuevo</span>}</div>
              <p className="mt-1 break-words whitespace-pre-line text-xs leading-5 text-slate-600 dark:text-slate-300">{notice.body}</p>
              <p className="mt-1.5 text-[10px] text-slate-400">{new Date(notice.created_at).toLocaleString("es-PR")}</p>
            </div>
            {!notice.read_at && notice.user_id === userId && <button type="button" title="Marcar esta notificación como leída" aria-label="Marcar como leída" onClick={() => void markRead(notice)} className="shrink-0 rounded-lg p-2 text-violet-700 hover:bg-violet-100 dark:text-violet-300 dark:hover:bg-violet-950/40"><CheckCheck className="h-4 w-4" /></button>}
          </div>
        </article>)}
      </section>
    </div>
  );
}
}
