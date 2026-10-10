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
    <div className="mx-auto w-full max-w-5xl space-y-5 pb-8">
      <header className="overflow-hidden rounded-3xl bg-gradient-to-br from-violet-800 via-violet-700 to-indigo-700 p-5 text-white shadow-lg sm:p-7">
        <div className="flex items-start gap-3">
          <div className="rounded-2xl border border-white/20 bg-white/10 p-3"><BellRing className="h-6 w-6" /></div>
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-black uppercase tracking-[.18em] text-violet-200">PALMYRA · Centro de avisos</p>
            <h1 className="mt-1 text-2xl font-black tracking-tight sm:text-3xl">Que los avisos no se escapen</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-violet-100">Todo en un sitio, con humor y sin estar dando la lata cada cinco segundos.</p>
          </div>
          <button onClick={() => void refresh()} className="rounded-xl border border-white/20 bg-white/10 p-2.5 hover:bg-white/20" aria-label="Actualizar notificaciones"><RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} /></button>
        </div>
        <div className="mt-5 flex flex-wrap gap-2">
          <span className="rounded-full bg-white/15 px-3 py-1.5 text-xs font-bold">{notices.length} avisos guardados</span>
          <span className="rounded-full bg-white/15 px-3 py-1.5 text-xs font-bold">{unread} sin leer</span>
        </div>
      </header>

      {message && <div role="status" className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-800">{message}</div>}
      {error && <div role="alert" className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-900"><AlertTriangle className="mr-2 inline h-4 w-4" />{error}</div>}

      <section className="rounded-3xl border-2 border-violet-300 bg-white p-4 shadow-sm dark:border-violet-800 dark:bg-slate-900 sm:p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-3">
            <div className="rounded-xl bg-violet-100 p-2.5 text-violet-700"><Smartphone className="h-6 w-6" /></div>
            <div>
              <h2 className="text-lg font-black text-slate-900 dark:text-white">Notificaciones push en tu móvil</h2>
              <p className="mt-1 text-sm leading-5 text-slate-500">Recibe avisos aunque no estés mirando el historial de PALMYRA.</p>
            </div>
          </div>
          <span className={`inline-flex w-fit items-center rounded-full px-3 py-1.5 text-xs font-black ${pushDeviceStatus === "registered" ? "bg-emerald-100 text-emerald-800" : pushDeviceStatus === "checking" ? "bg-slate-100 text-slate-700" : "bg-amber-100 text-amber-900"}`}>{pushStatusLabel}</span>
        </div>
        <p className="mt-3 text-sm leading-6 text-slate-600 dark:text-slate-300">{pushStatusDetail}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <button disabled={pushBusy || loading || !companyId || !userId} onClick={() => void enablePush()} className="inline-flex items-center gap-2 rounded-xl bg-violet-700 px-4 py-3 text-sm font-black text-white hover:bg-violet-800 disabled:opacity-50"><Smartphone className="h-4 w-4" />{pushBusy ? "Activando…" : pushDeviceStatus === "registered" ? "Volver a registrar este móvil" : "Activar notificaciones push"}</button>
          <button disabled={testBusy || loading || !companyId} onClick={() => void sendTestNotification()} className="inline-flex items-center gap-2 rounded-xl border border-violet-200 px-4 py-3 text-sm font-bold text-violet-800 hover:bg-violet-50 disabled:opacity-50"><BellRing className="h-4 w-4" />{testBusy ? "Enviando prueba…" : "Enviar prueba"}</button>
          <button disabled={loading || pushDeviceStatus === "checking"} onClick={() => void checkPushStatus()} className="inline-flex items-center gap-2 rounded-xl border border-slate-200 px-4 py-3 text-sm font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-50"><RefreshCw className="h-4 w-4" />Comprobar estado</button>
        </div>
        <p className="mt-3 text-xs leading-5 text-slate-500">Importante: ver avisos en el historial no activa por sí solo el push. Hay que registrar cada móvil y conceder el permiso del navegador. Después, usa «Enviar prueba» para confirmar si llega una notificación del sistema.</p>
      </section>

      <section className="rounded-3xl border-2 border-emerald-200 bg-white p-4 shadow-sm dark:border-emerald-900 dark:bg-slate-900 sm:p-6">
        <div className="mb-4 flex items-start gap-3">
          <div className="rounded-xl bg-emerald-100 p-2.5 text-emerald-800"><BellRing className="h-5 w-5" /></div>
          <div className="min-w-0 flex-1">
            <h2 className="font-black text-slate-900 dark:text-white">Avisos de tasa de cambio</h2>
            <p className="mt-1 text-xs leading-5 text-slate-500">Elige las divisas que quieres vigilar y activa Bitcoin por separado. PALMYRA compara la tasa publicada y crea un aviso si supera tu umbral.</p>
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex items-start justify-between gap-3 rounded-2xl border border-slate-200 p-3 dark:border-slate-700">
            <span><span className="block text-sm font-bold text-slate-800 dark:text-slate-100">Alertas de divisas</span><span className="mt-1 block text-xs text-slate-500">Notificar cambios solo en las monedas seleccionadas abajo.</span></span>
            <input type="checkbox" checked={prefs.exchange_currency_alerts_enabled} onChange={(e) => update("exchange_currency_alerts_enabled", e.target.checked)} />
          </label>
          <label className="flex items-start justify-between gap-3 rounded-2xl border border-slate-200 p-3 dark:border-slate-700">
            <span><span className="block text-sm font-bold text-slate-800 dark:text-slate-100">Bitcoin (BTC)</span><span className="mt-1 block text-xs text-slate-500">Avisarme cuando cambie el valor publicado de Bitcoin.</span></span>
            <input type="checkbox" checked={prefs.exchange_bitcoin_alerts_enabled} onChange={(e) => update("exchange_bitcoin_alerts_enabled", e.target.checked)} />
          </label>
        </div>
        <div className="mt-4 rounded-2xl border border-slate-200 p-3 dark:border-slate-700">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div><h3 className="text-sm font-black text-slate-900 dark:text-white">Selecciona las divisas</h3><p className="mt-1 text-xs text-slate-500">{prefs.exchange_currency_codes.length} seleccionadas · las alertas de divisas deben estar activadas</p></div>
            <button type="button" onClick={() => update("exchange_currency_codes", rateOptions.map((option) => option.code))} className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-50">Seleccionar todas</button>
          </div>
          {rateOptions.length ? <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {rateOptions.map((option) => <label key={option.code} className="flex items-center gap-2 rounded-xl bg-slate-50 px-3 py-2 text-sm dark:bg-slate-800">
              <input type="checkbox" checked={prefs.exchange_currency_codes.includes(option.code)} onChange={(e) => update("exchange_currency_codes", e.target.checked ? [...new Set([...prefs.exchange_currency_codes, option.code])] : prefs.exchange_currency_codes.filter((code) => code !== option.code))} />
              <span className="min-w-0 flex-1 truncate text-slate-800 dark:text-slate-100">{option.name}</span><span className="text-xs font-black text-slate-500">{option.code}</span>
            </label>)}
          </div> : <p className="text-xs text-slate-500">La fuente no devolvió divisas en este momento. Se conservan las selecciones guardadas.</p>}
          <p className="mt-3 text-xs leading-5 text-slate-500">Las monedas disponibles se cargan desde la fuente de tasas cuando responde; si el servicio no está disponible, se muestran opciones habituales.</p>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
          <label className="block"><span className="text-xs font-bold text-slate-600 dark:text-slate-300">Variación mínima para avisar (%)</span><input className="mt-1 w-full rounded-xl border border-slate-200 bg-transparent p-2.5 text-sm dark:border-slate-700" type="number" min="0" max="100" step="0.01" value={prefs.exchange_alert_min_change_pct} onChange={(e) => update("exchange_alert_min_change_pct", Math.min(100, Math.max(0, Number(e.target.value) || 0)))} /><span className="mt-1 block text-xs text-slate-500">Usa 0 para avisarte ante cualquier cambio detectado; aumenta el porcentaje para evitar avisos por variaciones pequeñas.</span></label>
          <button disabled={saving || loading} onClick={() => void savePrefs()} className="rounded-xl bg-emerald-700 px-4 py-3 text-sm font-black text-white hover:bg-emerald-800 disabled:opacity-50">{saving ? "Guardando…" : "Guardar preferencias de alertas"}</button>
        </div>
        <p className="mt-3 text-xs leading-5 text-slate-500">La fuente se revisa aproximadamente cada 5 minutos. Las alertas avisan de un cambio en el precio publicado, no de una predicción del mercado.</p>
      </section>

      <section className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900 sm:p-6">
        <div className="mb-4 flex items-center gap-3">
          <div className="rounded-xl bg-violet-100 p-2.5 text-violet-700"><Clock3 className="h-5 w-5" /></div>
          <div><h2 className="font-black text-slate-900 dark:text-white">Cuándo te avisamos</h2><p className="text-xs text-slate-500">Los avisos rutinarios descansan; los críticos no se quedan dormidos.</p></div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex items-center justify-between gap-3 rounded-2xl border border-slate-200 p-3 dark:border-slate-700"><span className="text-sm font-semibold text-slate-800 dark:text-slate-200">Silenciar avisos rutinarios</span><input type="checkbox" checked={prefs.quiet_hours_enabled} onChange={(e) => update("quiet_hours_enabled", e.target.checked)} /></label>
          <label className="flex items-center justify-between gap-3 rounded-2xl border border-slate-200 p-3 dark:border-slate-700"><span className="text-sm font-semibold text-slate-800 dark:text-slate-200">Resumen diario</span><input type="checkbox" checked={prefs.routine_summary_enabled} onChange={(e) => update("routine_summary_enabled", e.target.checked)} /></label>
          <label className="rounded-2xl border border-slate-200 p-3 dark:border-slate-700"><span className="block text-xs font-bold text-slate-500">Inicio del silencio</span><input className="mt-1 w-full rounded-lg border border-slate-200 bg-transparent p-2 text-sm dark:border-slate-700" type="time" value={prefs.quiet_hours_start} onChange={(e) => update("quiet_hours_start", e.target.value)} /></label>
          <label className="rounded-2xl border border-slate-200 p-3 dark:border-slate-700"><span className="block text-xs font-bold text-slate-500">Fin del silencio</span><input className="mt-1 w-full rounded-lg border border-slate-200 bg-transparent p-2 text-sm dark:border-slate-700" type="time" value={prefs.quiet_hours_end} onChange={(e) => update("quiet_hours_end", e.target.value)} /></label>
          <label className="rounded-2xl border border-slate-200 p-3 dark:border-slate-700"><span className="block text-xs font-bold text-slate-500">Hora del resumen</span><input className="mt-1 w-full rounded-lg border border-slate-200 bg-transparent p-2 text-sm dark:border-slate-700" type="time" value={prefs.routine_summary_time} onChange={(e) => update("routine_summary_time", e.target.value)} /></label>
          <label className="rounded-2xl border border-slate-200 p-3 dark:border-slate-700"><span className="block text-xs font-bold text-slate-500">Zona horaria</span><select className="mt-1 w-full rounded-lg border border-slate-200 bg-transparent p-2 text-sm dark:border-slate-700" value={prefs.timezone} onChange={(e) => update("timezone", e.target.value)}><option value="America/Havana">Cuba · America/Havana</option><option value="America/Puerto_Rico">Puerto Rico · America/Puerto_Rico</option><option value="America/New_York">Este de EE. UU. · America/New_York</option><option value="UTC">UTC</option></select></label>
          <label className="flex items-center justify-between gap-3 rounded-2xl border border-slate-200 p-3 dark:border-slate-700"><span className="text-sm font-semibold text-slate-800 dark:text-slate-200">Push en este dispositivo</span><input type="checkbox" checked={prefs.push_enabled} onChange={(e) => update("push_enabled", e.target.checked)} /></label>
          <label className="flex items-center justify-between gap-3 rounded-2xl border border-slate-200 p-3 dark:border-slate-700"><span className="flex items-center gap-2 text-sm font-semibold text-slate-800 dark:text-slate-200"><ShieldAlert className="h-4 w-4 text-rose-500" />Críticas inmediatas</span><input type="checkbox" checked={prefs.critical_push_enabled} onChange={(e) => update("critical_push_enabled", e.target.checked)} /></label>
          <label className="flex items-center justify-between gap-3 rounded-2xl border border-slate-200 p-3 dark:border-slate-700"><span className="flex items-center gap-2 text-sm font-semibold text-slate-800 dark:text-slate-200"><Laugh className="h-4 w-4 text-violet-500" />Humor PALMYRA</span><input type="checkbox" checked={prefs.humour_enabled} onChange={(e) => update("humour_enabled", e.target.checked)} /></label>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <button disabled={saving || loading} onClick={() => void savePrefs()} className="rounded-xl bg-violet-700 px-4 py-2.5 text-sm font-black text-white hover:bg-violet-800 disabled:opacity-50">{saving ? "Guardando…" : "Guardar preferencias"}</button>
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3"><div><h2 className="font-black text-slate-900 dark:text-white">Historial reciente</h2><p className="text-xs text-slate-500">Los avisos no se borran por cerrar la pantalla.</p></div><span className="text-xs font-bold text-slate-500">{notices.length} resultados</span></div>
        {loading ? <div className="rounded-2xl border border-slate-200 p-8 text-center text-sm text-slate-500"><RefreshCw className="mr-2 inline h-4 w-4 animate-spin" />Cargando avisos…</div> : notices.length === 0 ? <div className="rounded-2xl border border-dashed border-slate-300 p-8 text-center"><Bell className="mx-auto h-8 w-8 text-slate-300" /><p className="mt-2 font-bold text-slate-700 dark:text-slate-200">Todavía no hay avisos guardados</p><p className="mt-1 text-sm text-slate-500">Silencio total. Hasta la impresora está sorprendida. 😂</p></div> : notices.map((notice) => <article key={notice.id} className={`rounded-2xl border p-4 ${notice.read_at ? "border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900" : "border-violet-200 bg-violet-50/70 dark:border-violet-900 dark:bg-violet-950/20"}`}>
          <div className="flex items-start gap-3">
            <div className={`mt-0.5 rounded-xl p-2 ${notice.read_at ? "bg-slate-100 text-slate-500" : "bg-violet-100 text-violet-700"}`}><Bell className="h-4 w-4" /></div>
            <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h3 className="font-black text-slate-900 dark:text-white">{notice.title}</h3><span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-600">{kindLabel(notice.kind)}</span>{!notice.read_at && <span className="rounded-full bg-violet-700 px-2 py-0.5 text-[10px] font-bold text-white">Nuevo</span>}</div><p className="mt-1 whitespace-pre-line text-sm leading-6 text-slate-600 dark:text-slate-300">{notice.body}</p><p className="mt-2 text-[11px] text-slate-400">{new Date(notice.created_at).toLocaleString("es-PR")}</p></div>
            {!notice.read_at && notice.user_id === userId && <button onClick={() => void markRead(notice)} className="shrink-0 rounded-lg p-2 text-violet-700 hover:bg-violet-100" aria-label="Marcar como leído"><CheckCheck className="h-4 w-4" /></button>}
          </div>
        </article>)}
      </section>
    </div>
  );
}
