import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

function getSecretKey() {
  const raw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (raw) { try { const parsed = JSON.parse(raw); if (parsed.default) return parsed.default; } catch {} }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return Response.json({ error: "method_not_allowed" }, { status: 405 });
  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return Response.json({ error: "authentication_required" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const companyId = String(body?.companyId || "");
  const employeeId = String(body?.employeeId || "");
  const email = String(body?.email || "").trim().toLowerCase();
  const name = String(body?.name || "").trim();
  const token = String(body?.token || "");
  if (!companyId || !employeeId || !email || !token) return Response.json({ error: "invalid_request" }, { status: 400 });

  const url = Deno.env.get("SUPABASE_URL") || "";
  const publishable = Deno.env.get("SUPABASE_ANON_KEY") || "";
  const secret = getSecretKey();
  if (!url || !secret) return Response.json({ error: "server_not_configured" }, { status: 500 });

  const userClient = createClient(url, publishable || secret, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: authHeader } }
  });
  const { data: callerData, error: callerError } = await userClient.auth.getUser();
  const caller = callerData?.user;
  if (callerError || !caller) return Response.json({ error: "authentication_required" }, { status: 401 });

  const admin = createClient(url, secret, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: membership } = await admin.from("company_memberships").select("is_owner,status").eq("company_id", companyId).eq("user_id", caller.id).maybeSingle();
  if (!membership || membership.status !== "active") return Response.json({ error: "permission_denied" }, { status: 403 });

  let allowed = Boolean(membership.is_owner);
  if (!allowed) {
    const { data: roles } = await admin.from("user_roles").select("role_id").eq("company_id", companyId).eq("user_id", caller.id);
    const roleIds = (roles || []).map((r: any) => r.role_id).filter(Boolean);
    if (roleIds.length) {
      const { data: rp } = await admin.from("role_permissions").select("permissions!inner(key)").in("role_id", roleIds);
      allowed = Boolean((rp || []).some((r: any) => r.permissions?.key === "employees.manage"));
    }
  }
  if (!allowed) return Response.json({ error: "permission_denied" }, { status: 403 });

  const appUrl = Deno.env.get("PALMYRA_APP_URL") || req.headers.get("origin") || "";
  if (!appUrl) return Response.json({ error: "app_url_not_configured" }, { status: 500 });
  const redirectTo = appUrl.replace(/\/$/, "") + "/invite?token=" + encodeURIComponent(token);

  const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
    data: { full_name: name, palmyra_company_id: companyId, palmyra_employee_id: employeeId, palmyra_invitation_token: token },
    redirectTo
  });
  if (error) {
    const msg = String(error.message || "");
    if (/already.*user|already exists|confirmed/i.test(msg)) return Response.json({ sent: false, reason: "existing_account" });
    return Response.json({ sent: false, reason: "provider_error" }, { status: 502 });
  }
  return Response.json({ sent: true, user_id: data.user?.id || null });
});
