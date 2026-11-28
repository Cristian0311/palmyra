import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

function getSecretKey() {
  const raw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (raw) { try { const parsed = JSON.parse(raw); if (parsed.default) return parsed.default; } catch {} }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
}

function getPublishableKey() {
  const direct = Deno.env.get("SUPABASE_ANON_KEY") || "";
  if (direct) return direct;
  const raw = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS");
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, string>;
      return parsed.default || Object.values(parsed)[0] || "";
    } catch { /* keys malformed: fall back to the secret key */ }
  }
  return "";
}

// El enlace de invitación debe abrir la web real: si la app de escritorio
// invoca esta función, el Origin puede ser file://, localhost o venir vacío.
const PRODUCTION_APP_URL = "https://palmyracrm.onrender.com";

function resolveAppUrl(req: Request) {
  const configured = (Deno.env.get("PALMYRA_APP_URL") || "").trim();
  const origin = (req.headers.get("origin") || "").trim();
  const candidate = configured || origin;
  if (!candidate) return PRODUCTION_APP_URL;
  if (!/^https?:\/\//i.test(candidate)) return PRODUCTION_APP_URL;
  if (/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|\/|$)/i.test(candidate)) return PRODUCTION_APP_URL;
  return candidate.replace(/\/+$/, "");
}

async function sha256Hex(value: string) {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, cache-control, pragma",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

/** `status` es número: pasarle `{ status: 401 }` hace que `new Response` lance y el cliente reciba un 500 sin cuerpo. */
function json(data: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "authentication_required" }, 401);

  const body = await req.json().catch(() => ({}));
  const companyId = String(body?.companyId || "");
  const employeeId = String(body?.employeeId || "");
  const email = String(body?.email || "").trim().toLowerCase();
  const name = String(body?.name || "").trim();
  const token = String(body?.token || "");
  if (!companyId || !employeeId || !email || !token) return json({ error: "invalid_request" }, 400);

  const url = Deno.env.get("SUPABASE_URL") || "";
  const publishable = getPublishableKey();
  const secret = getSecretKey();
  if (!url || !secret) return json({ error: "server_not_configured" }, 500);

  const userClient = createClient(url, publishable || secret, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: authHeader } }
  });
  const { data: callerData, error: callerError } = await userClient.auth.getUser();
  const caller = callerData?.user;
  if (callerError || !caller) return json({ error: "authentication_required" }, 401);

  const admin = createClient(url, secret, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: membership } = await admin.from("company_memberships").select("is_owner,status").eq("company_id", companyId).eq("user_id", caller.id).maybeSingle();
  if (!membership || membership.status !== "active") return json({ error: "permission_denied" }, 403);

  let allowed = Boolean(membership.is_owner);
  if (!allowed) {
    const { data: roles } = await admin.from("user_roles").select("role_id").eq("company_id", companyId).eq("user_id", caller.id);
    const roleIds = (roles || []).map((r: any) => r.role_id).filter(Boolean);
    if (roleIds.length) {
      const { data: rp } = await admin.from("role_permissions").select("permissions!inner(key)").in("role_id", roleIds);
      allowed = Boolean((rp || []).some((r: any) => r.permissions?.key === "employees.manage"));
    }
  }
  if (!allowed) return json({ error: "permission_denied" }, 403);

  const tokenHash = await sha256Hex(token.trim());
  const { data: invitation } = await admin.from("company_invitations")
    .select("id,company_id,employee_id,email,status,expires_at")
    .eq("company_id", companyId).eq("employee_id", employeeId)
    .eq("email", email).eq("token_hash", tokenHash).eq("status", "pending")
    .maybeSingle();
  if (!invitation || new Date(invitation.expires_at).getTime() <= Date.now()) {
    return json({ error: "invitation_invalid_or_expired" }, 400);
  }

  const { data: employee } = await admin.from("employees")
    .select("id,company_id,full_name,active,user_id")
    .eq("id", employeeId).eq("company_id", companyId).maybeSingle();
  if (!employee || employee.active === false || employee.user_id) {
    return json({ error: "employee_invalid" }, 400);
  }

  const appUrl = resolveAppUrl(req);
  const redirectTo = appUrl + "/invite?token=" + encodeURIComponent(token);

  const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
    data: { full_name: name },
    redirectTo
  });
  if (error) {
    const msg = String(error.message || "");
    if (/already.*user|already exists|confirmed/i.test(msg)) return json({ sent: false, reason: "existing_account" });
    return json({ sent: false, reason: "provider_error" }, 502);
  }
  return json({ sent: true, user_id: data.user?.id || null });
});
