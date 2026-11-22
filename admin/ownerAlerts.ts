import { getAdminSupabase } from "./supabase";

/**
 * Canal de avisos del dueño (WhatsApp). El estado se consulta al servidor de
 * la aplicación; la prueba se envía con la sesión administrativa.
 */
const APP_SERVER = (import.meta.env.VITE_APP_ORIGIN || "https://palmyracrm.onrender.com").replace(/\/+$/, "");

export type AlertChannelStatus = {
  configured: boolean;
  provider: "callmebot" | "whatsapp_cloud" | null;
  targetMasked: string | null;
  reachable: boolean;
  error: string | null;
};

export const OWNER_WHATSAPP = "5355581669";

async function withTimeout<T>(task: (signal: AbortSignal) => Promise<T>, ms = 9_000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await task(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

export async function loadAlertChannelStatus(): Promise<AlertChannelStatus> {
  try {
    const response = await withTimeout((signal) => fetch(`${APP_SERVER}/api/notify/owner/status`, { cache: "no-store", signal }));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json() as { configured?: unknown; provider?: unknown; targetMasked?: unknown };
    return {
      configured: payload.configured === true,
      provider: payload.provider === "callmebot" || payload.provider === "whatsapp_cloud" ? payload.provider : null,
      targetMasked: typeof payload.targetMasked === "string" ? payload.targetMasked : null,
      reachable: true,
      error: null,
    };
  } catch (error) {
    return {
      configured: false,
      provider: null,
      targetMasked: null,
      reachable: false,
      error: error instanceof Error ? error.message : "No se pudo consultar el canal.",
    };
  }
}

export async function sendAdminTestAlert(): Promise<{ sent: boolean; reason: string | null; provider: string | null }> {
  const token = (await getAdminSupabase().auth.getSession()).data.session?.access_token;
  if (!token) return { sent: false, reason: "authentication_required", provider: null };
  try {
    const response = await withTimeout((signal) => fetch(`${APP_SERVER}/api/notify/owner`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        kind: "test",
        refId: `test:${Date.now()}`,
        lines: [
          "Prueba enviada desde la consola administrativa.",
          `Fecha: ${new Date().toLocaleString("es-CU")}`,
          "Si recibes este mensaje, los avisos automáticos están funcionando.",
        ],
      }),
      cache: "no-store",
      signal,
    }));
    const payload = await response.json().catch(() => null) as { sent?: unknown; reason?: unknown; provider?: unknown } | null;
    return {
      sent: payload?.sent === true,
      reason: typeof payload?.reason === "string" ? payload.reason : (response.ok ? null : `http_${response.status}`),
      provider: typeof payload?.provider === "string" ? payload.provider : null,
    };
  } catch {
    return { sent: false, reason: "network", provider: null };
  }
}
