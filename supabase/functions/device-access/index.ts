import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

/**
 * device-access: canjea un enlace de un solo uso y devuelve credenciales
 * sintéticas para que el PC/APK entre directo como el empleado.
 *
 * El enlace por sí solo no basta: el trabajador debe escribir la contraseña
 * POS que configuró el administrador. La verificación se hace en la RPC
 * verify_device_access_invite (security definer, solo service_role) y recién
 * después de aprobarla se provisiona la identidad y se marca el enlace usado.
 * Una contraseña equivocada NO quema el enlace.
 *
 * POST /device-access
 *   body { action: "redeem", token: string, password: string, deviceName?: string }
 *   200 { email, password }
 *   400 body inválido / acción desconocida
 *   401 contraseña POS requerida o incorrecta
 *   404 enlace inexistente
 *   409 enlace usado, caducado, empleado/empresa inactiva, alcance inválido
 *   429 demasiados intentos desde esta IP
 *   500 configuración o escritura incompleta
 *   502 no se pudo provisionar la identidad
 *
 * Secretos: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (solo servidor).
 * Ni la contraseña POS ni la contraseña generada se registran en logs.
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400"
};

function json(data: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}

/** Códigos de negocio: mensaje genérico en español + estado HTTP. */
const VERIFY_ERRORS: Record<string, { status: number; message: string }> = {
  device_link_invalid: {
    status: 404,
    message: "El enlace de acceso no es válido. Pide uno nuevo al propietario."
  },
  device_link_used: {
    status: 409,
    message: "Este enlace ya se usó. Pide uno nuevo al propietario."
  },
  device_link_expired: {
    status: 409,
    message: "El enlace de acceso caducó. Pide uno nuevo al propietario."
  },
  employee_inactive: {
    status: 409,
    message: "El trabajador ya no está activo en la empresa."
  },
  company_inactive: {
    status: 409,
    message: "La cuenta de la empresa no está activa."
  },
  pos_password_required: {
    status: 401,
    message: "Escribe la contraseña POS configurada por el administrador."
  },
  pos_password_invalid: {
    status: 401,
    message: "La contraseña POS no es correcta."
  }
};

function verifyErrorResponse(rawMessage: string): Response {
  const code = Object.keys(VERIFY_ERRORS).find((candidate) => rawMessage.includes(candidate));
  if (!code) return json({ error: "lookup_failed" }, 500);
  const known = VERIFY_ERRORS[code];
  return json({ error: code, message: known.message }, known.status);
}

/** Limitador en memoria por IP: 10 intentos por minuto. */
const THROTTLE_WINDOW_MS = 60_000;
const THROTTLE_MAX_ATTEMPTS = 10;
const attemptsByIp = new Map<string, number[]>();

function clientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for") || "";
  const first = forwarded.split(",")[0].trim();
  return (
    first ||
    req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-real-ip") ||
    "unknown"
  );
}

function throttleExceeded(ip: string): boolean {
  const now = Date.now();
  const recent = (attemptsByIp.get(ip) || []).filter((at) => now - at < THROTTLE_WINDOW_MS);
  recent.push(now);
  attemptsByIp.set(ip, recent);
  if (attemptsByIp.size > 5000) {
    for (const [key, stamps] of attemptsByIp) {
      if (!stamps.some((at) => now - at < THROTTLE_WINDOW_MS)) attemptsByIp.delete(key);
    }
  }
  return recent.length > THROTTLE_MAX_ATTEMPTS;
}

function randomPassword(length = 32): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*-_";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

async function findUserIdByEmail(admin: any, email: string): Promise<string | null> {
  const target = email.toLowerCase();
  for (let page = 1; page <= 10; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) return null;
    const users = (data?.users || []) as any[];
    const match = users.find((u) => String(u.email || "").toLowerCase() === target);
    if (match) return String(match.id);
    if (users.length < 1000) return null;
  }
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const ip = clientIp(req);
  if (throttleExceeded(ip)) {
    return json(
      {
        error: "too_many_attempts",
        message: "Demasiados intentos. Espera un minuto y vuelve a intentarlo."
      },
      429
    );
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return json({ error: "invalid_request" }, 400);

  const action = String((body as any).action || "");
  const token = String((body as any).token || "").trim();
  const password = String((body as any).password || "").trim().slice(0, 128);
  const deviceName = String((body as any).deviceName || "").trim().slice(0, 120);

  if (action !== "redeem") return json({ error: "unsupported_action" }, 400);
  if (token.length < 16 || token.length > 256) return json({ error: "invalid_request" }, 400);

  const url = Deno.env.get("SUPABASE_URL") || "";
  const secret = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!url || !secret) return json({ error: "server_not_configured" }, 500);

  const admin = createClient(url, secret, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  // 1) Verificación (enlace + empleado + empresa + contraseña POS).
  //    No consume el enlace: se puede reintentar la contraseña.
  const { data: verified, error: verifyError } = await admin.rpc("verify_device_access_invite", {
    p_token: token,
    p_password: password
  });
  if (verifyError) {
    return verifyErrorResponse(String(verifyError.message || "").trim());
  }

  const inviteId = String((verified as any)?.invite_id || "");
  const companyId = String((verified as any)?.company_id || "");
  const employeeId = String((verified as any)?.employee_id || "");
  const fullName = String((verified as any)?.full_name || "Empleado PALMYRA");
  if (!inviteId || !companyId || !employeeId) return json({ error: "lookup_failed" }, 500);

  const { data: employee, error: employeeLookupError } = await admin
    .from("employees")
    .select("id,company_id,full_name,active,user_id,role_id")
    .eq("id", employeeId)
    .eq("company_id", companyId)
    .maybeSingle();
  if (employeeLookupError) return json({ error: "lookup_failed" }, 500);
  if (!employee || employee.active === false) {
    return json(
      { error: "employee_inactive", message: VERIFY_ERRORS.employee_inactive.message },
      409
    );
  }

  // 2) Alcance: sucursales activas de la empresa y rol vigente.
  const inviteWarehouses: string[] = Array.isArray((verified as any)?.warehouse_ids)
    ? ((verified as any).warehouse_ids as any[]).map((id) => String(id)).filter(Boolean)
    : [];
  let warehouseIds: string[] = [];
  if (inviteWarehouses.length) {
    const { data: warehouses } = await admin
      .from("warehouses")
      .select("id")
      .eq("company_id", companyId)
      .eq("active", true)
      .in("id", inviteWarehouses);
    const valid = new Set(((warehouses || []) as any[]).map((w) => String(w.id)));
    warehouseIds = inviteWarehouses.filter((id) => valid.has(id));
  }
  if (!warehouseIds.length) return json({ error: "warehouse_unavailable" }, 409);

  const roleId = (verified as any)?.role_id
    ? String((verified as any).role_id)
    : employee.role_id
      ? String(employee.role_id)
      : "";
  if (!roleId) return json({ error: "role_unavailable" }, 409);
  const { data: role } = await admin
    .from("roles")
    .select("id,company_id")
    .eq("id", roleId)
    .maybeSingle();
  if (!role || (role.company_id && String(role.company_id) !== companyId)) {
    return json({ error: "role_unavailable" }, 409);
  }

  // 3) Identidad sintética del dispositivo.
  const email = `pos-${employeeId.toLowerCase()}@device.palmyra.app`;
  const generatedPassword = randomPassword();
  const metadata = {
    full_name: fullName || employee.full_name || "Empleado PALMYRA",
    company_id: companyId,
    employee_id: employeeId,
    source: "device-access"
  };

  let userId = "";
  const created = await admin.auth.admin.createUser({
    email,
    password: generatedPassword,
    email_confirm: true,
    user_metadata: metadata
  });

  if (!created.error && created.data?.user) {
    userId = created.data.user.id;
  } else {
    const message = String(created.error?.message || "");
    if (!/already|exists|registered/i.test(message)) {
      return json({ error: "identity_provision_failed" }, 502);
    }
    const existingId = employee.user_id
      ? String(employee.user_id)
      : await findUserIdByEmail(admin, email);
    if (!existingId) return json({ error: "identity_provision_failed" }, 502);
    const updated = await admin.auth.admin.updateUserById(existingId, {
      password: generatedPassword,
      email_confirm: true,
      user_metadata: metadata
    });
    if (updated.error) return json({ error: "identity_provision_failed" }, 502);
    userId = existingId;
  }

  const { error: profileError } = await admin.from("profiles").upsert(
    { id: userId, full_name: metadata.full_name, active_company_id: companyId },
    { onConflict: "id" }
  );
  if (profileError) return json({ error: "profile_write_failed" }, 500);

  const { error: membershipError } = await admin.from("company_memberships").upsert(
    { company_id: companyId, user_id: userId, status: "active", is_owner: false },
    { onConflict: "company_id,user_id" }
  );
  if (membershipError) return json({ error: "membership_write_failed" }, 500);

  await admin.from("user_roles").delete().eq("company_id", companyId).eq("user_id", userId);
  const { error: roleError } = await admin
    .from("user_roles")
    .insert({ user_id: userId, company_id: companyId, role_id: roleId });
  if (roleError) return json({ error: "role_write_failed" }, 500);

  await admin.from("user_locations").delete().eq("company_id", companyId).eq("user_id", userId);
  const { error: locationError } = await admin.from("user_locations").insert(
    warehouseIds.map((warehouseId, index) => ({
      user_id: userId,
      company_id: companyId,
      warehouse_id: warehouseId,
      is_default: index === 0
    }))
  );
  if (locationError) return json({ error: "location_write_failed" }, 500);

  const { error: employeeWriteError } = await admin
    .from("employees")
    .update({
      user_id: userId,
      login_email: email,
      active: true,
      role_id: roleId,
      updated_at: new Date().toISOString()
    })
    .eq("id", employeeId)
    .eq("company_id", companyId);
  if (employeeWriteError) return json({ error: "employee_write_failed" }, 500);

  // 4) Cierre: claim condicional (otra persona pudo ganar la carrera).
  const nowIso = new Date().toISOString();
  const { data: claimed, error: claimError } = await admin
    .from("device_access_invites")
    .update({ used_at: nowIso, used_by_device: deviceName || null })
    .eq("id", inviteId)
    .is("used_at", null)
    .gt("expires_at", nowIso)
    .select("id");
  if (claimError) return json({ error: "claim_failed" }, 500);
  if (!Array.isArray(claimed) || claimed.length === 0) {
    return json(
      { error: "device_link_used", message: VERIFY_ERRORS.device_link_used.message },
      409
    );
  }

  return json({ email, password: generatedPassword });
});
