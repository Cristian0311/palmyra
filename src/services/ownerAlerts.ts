import { PALMYRA_REMOTE_ORIGIN } from "../lib/install";
import { getSupabase } from "../lib/supabase";
import {
  companyCreatedAlertLines,
  planCancelledAlertLines,
  planRequestAlertLines,
  supportAlertLines,
} from "../lib/ownerAlertMessages";

/**
 * Avisos operativos al WhatsApp del dueño del SaaS. El servidor público es el
 * único que conoce la credencial del proveedor; aquí solo se envía texto con
 * la sesión del usuario. Nunca bloquea ni rompe la operación del cliente: si
 * falla, la interfaz ofrece el envío manual por WhatsApp como respaldo.
 */

export type OwnerAlertKind = "support" | "plan_request" | "plan_cancelled" | "company_new" | "test";

export type OwnerAlertResult = {
  sent: boolean;
  reason: string | null;
};

const ALERT_TIMEOUT_MS = 9_000;

export { companyCreatedAlertLines, planCancelledAlertLines, planRequestAlertLines, supportAlertLines };

export async function sendOwnerAlert(kind: OwnerAlertKind, lines: string[], refId?: string): Promise<OwnerAlertResult> {
  try {
    const supabase = getSupabase();
    const token = supabase ? (await supabase.auth.getSession()).data.session?.access_token : null;
    if (!token) return { sent: false, reason: "authentication_required" };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ALERT_TIMEOUT_MS);
    try {
      const response = await fetch(`${PALMYRA_REMOTE_ORIGIN}/api/notify/owner`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ kind, lines, refId }),
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) return { sent: false, reason: `http_${response.status}` };
      const payload = await response.json().catch(() => null) as { sent?: unknown; reason?: unknown } | null;
      return { sent: payload?.sent === true, reason: typeof payload?.reason === "string" ? payload.reason : null };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return { sent: false, reason: "network" };
  }
}
