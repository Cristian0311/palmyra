import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.49.1";

const APP_RATES_URL = "https://palmyracrm.onrender.com/api/exchange-rates";
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-worker-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function respond(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function numeric(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.trim()) return null;
  const result = Number(value.trim().replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(result) ? result : null;
}

function rateNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const direct = numeric(value);
    if (direct !== null) return direct;
    if (value && typeof value === "object") {
      const nested = value as Record<string, unknown>;
      const parsed = numeric(nested.value ?? nested.rate ?? nested.valor ?? nested.tasa ?? nested.median ?? nested.mediana);
      if (parsed !== null) return parsed;
    }
  }
  return null;
}

function compactCode(value: string) {
  const raw = value.toUpperCase().trim().replace(/[-_\s]/g, "");
  return raw === "ECU" ? "EUR" : raw;
}

function isBitcoin(code: string) {
  return compactCode(code) === "BTC";
}

function isCrypto(code: string) {
  return /^(BTC|ETH|BNB|TRX|USDT|USDC|LTC|DOGE|SOL|XRP|TON|ADA|BCH|DOT|AVAX|SHIB|LINK|XMR|MATIC|POL)/.test(compactCode(code));
}

type RateRow = { code: string; name: string; value: number };

function extractRates(data: unknown): RateRow[] {
  let list: any = data;
  const containers = ["tasas", "rates", "data", "result", "exchangeRates", "exchange_rates", "cotizaciones"];
  for (let depth = 0; depth < 5 && list && typeof list === "object" && !Array.isArray(list); depth++) {
    const looksLikeRate = ["rate", "value", "valor", "tasa", "median", "mediana", "buy", "compra", "sell", "venta"].some((key) => list[key] !== undefined);
    if (looksLikeRate) break;
    const key = containers.find((candidate) => list[candidate] !== undefined && list[candidate] !== null);
    if (!key) break;
    list = list[key];
  }

  const entries: Array<[string, any]> = Array.isArray(list)
    ? list.map((item: any, index: number) => [String(index), item])
    : list && typeof list === "object"
      ? Object.entries(list)
      : [];

  const rates = new Map<string, RateRow>();
  for (const [fallback, raw] of entries) {
    const sourceCode = typeof raw === "object" && raw !== null
      ? String(raw.code ?? raw.currency ?? raw.moneda ?? raw.symbol ?? raw.codigo ?? fallback)
      : fallback;
    const code = compactCode(sourceCode);
    if (!code || code === "TIMESTAMP" || code === "UPDATEDAT" || code === "CAPTUREDAT") continue;
    const value = typeof raw === "object" && raw !== null
      ? rateNumber(
          raw.rate, raw.value, raw.valor, raw.tasa, raw.tasa_referencia, raw.reference,
          raw.median, raw.mediana, raw.trm, raw.promedio, raw.price, raw.precio,
          raw.last, raw.rate_mid, raw.compra_venta, raw.sell, raw.venta, raw.buy, raw.compra,
        )
      : numeric(raw);
    if (value === null || value <= 0) continue;
    const name = typeof raw === "object" && raw !== null
      ? String(raw.name ?? raw.nombre ?? raw.description ?? raw.descripcion ?? code)
      : code;
    rates.set(code, { code, name, value });
  }
  return [...rates.values()];
}

function formatValue(value: number) {
  return new Intl.NumberFormat("es-PR", { maximumFractionDigits: 4 }).format(value);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return respond({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) return respond({ error: "Worker credentials are unavailable." }, 503);

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: secrets, error: secretError } = await supabase.rpc("get_notification_worker_secrets");
  if (secretError || !secrets?.worker_secret || req.headers.get("x-worker-secret") !== secrets.worker_secret) {
    return respond({ error: "Worker authentication failed." }, 401);
  }

  try {
    const ratesResponse = await fetch(APP_RATES_URL, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(25_000),
    });
    const ratePayload = await ratesResponse.json().catch(() => ({}));
    if (!ratesResponse.ok || ratePayload?.configured === false || ratePayload?.error) {
      return respond({
        error: "La fuente de tasas no está disponible; se conserva el último valor para no generar avisos falsos.",
        sourceStatus: ratesResponse.status,
      }, 502);
    }

    const currentRates = extractRates(ratePayload?.data);
    if (!currentRates.length) return respond({ error: "La fuente no devolvió tasas reconocibles; no se modificarán las referencias guardadas." }, 502);

    const { data: previousRates, error: previousError } = await supabase
      .from("exchange_rate_alert_snapshots")
      .select("code,name,value,updated_at");
    if (previousError) throw previousError;
    const previousByCode = new Map((previousRates || []).map((row: any) => [row.code, row]));
    const now = new Date().toISOString();
    const changes = currentRates.flatMap((current) => {
      const previous = previousByCode.get(current.code) as any;
      if (!previous) return [];
      const previousUpdatedAt = new Date(previous.updated_at || 0).getTime();
      if (!Number.isFinite(previousUpdatedAt) || Date.now() - previousUpdatedAt > 15 * 60_000) return [];
      const oldValue = numeric(previous.value);
      if (oldValue === null || oldValue <= 0 || oldValue === current.value) return [];
      const pct = ((current.value - oldValue) / oldValue) * 100;
      return [{
        ...current,
        oldValue,
        pct,
        previousName: String(previous.name || current.name),
      }];
    });

    const { data: preferences, error: prefsError } = await supabase
      .from("notification_preferences")
      .select("company_id,user_id,exchange_currency_alerts_enabled,exchange_currency_codes,exchange_bitcoin_alerts_enabled,exchange_alert_min_change_pct")
      .or("exchange_currency_alerts_enabled.eq.true,exchange_bitcoin_alerts_enabled.eq.true")
      .limit(1000);
    if (prefsError) throw prefsError;

    const notifications: Array<Record<string, unknown>> = [];
    for (const preference of preferences || []) {
      const selectedCurrencies = new Set(
        (Array.isArray(preference.exchange_currency_codes) ? preference.exchange_currency_codes : [])
          .map((value: unknown) => compactCode(String(value)))
          .filter((code: string) => code && !isCrypto(code)),
      );
      const threshold = Math.max(0, Number(preference.exchange_alert_min_change_pct || 0));
      const matched = changes.filter((change) => {
        if (Math.abs(change.pct) <= threshold + 1e-9) return false;
        if (isBitcoin(change.code)) return preference.exchange_bitcoin_alerts_enabled === true;
        return preference.exchange_currency_alerts_enabled === true && selectedCurrencies.has(change.code) && !isCrypto(change.code);
      });
      if (!matched.length) continue;

      const bitcoinOnly = matched.every((change) => isBitcoin(change.code));
      const hasBitcoin = matched.some((change) => isBitcoin(change.code));
      const title = bitcoinOnly
        ? "₿ Bitcoin cambió de precio"
        : hasBitcoin
          ? "📊 Cambios en divisas y Bitcoin"
          : "💱 Cambios en tus divisas";
      const lines = matched.map((change) => {
        const direction = change.pct > 0 ? "subió" : "bajó";
        const sign = change.pct > 0 ? "+" : "";
        return change.name + " (" + change.code + "): " + formatValue(change.oldValue) + " → " + formatValue(change.value) + " (" + sign + change.pct.toFixed(2) + "%). El precio " + direction + ".";
      });
      notifications.push({
        company_id: preference.company_id,
        user_id: preference.user_id,
        kind: "exchange_rate",
        title,
        body: lines.join("\n"),
      });
    }

    if (notifications.length) {
      const { error: insertError } = await supabase.from("notifications").insert(notifications);
      if (insertError) throw insertError;
    }

    const snapshots = currentRates.map((rate) => ({
      code: rate.code,
      name: rate.name,
      value: rate.value,
      source: ratePayload?.source || "elTOQUE",
      captured_at: ratePayload?.capturedAt || now,
      updated_at: now,
    }));
    const { error: upsertError } = await supabase
      .from("exchange_rate_alert_snapshots")
      .upsert(snapshots, { onConflict: "code" });
    if (upsertError) throw upsertError;

    return respond({
      source: ratePayload?.source || "elTOQUE",
      ratesChecked: currentRates.length,
      changedRates: changes.length,
      notificationsCreated: notifications.length,
      baseline: (previousRates || []).length === 0,
      checkedAt: now,
    });
  } catch (error) {
    console.error("[exchange-rate-alerts] monitor failed", String((error as Error)?.message || "unknown"));
    return respond({ error: "No se pudieron procesar alertas de tasas de cambio." }, 500);
  }
});
