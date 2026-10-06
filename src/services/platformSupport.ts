import { getSupabase } from "../lib/supabase";

export type PlatformSupportSettings = {
  whatsapp_number: string | null;
  support_email: string | null;
  privacy_url: string | null;
};

const SUPPORT_CACHE_KEY = "palmyra_platform_support_settings_v1";

export function getCachedPlatformSupportSettings(): PlatformSupportSettings | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(SUPPORT_CACHE_KEY);
    return raw ? JSON.parse(raw) as PlatformSupportSettings : null;
  } catch {
    return null;
  }
}

export type SupportRequestInput = {
  requestType: string;
  subject: string;
  message: string;
  contactPhone?: string;
};

export async function loadPlatformSupportSettings(): Promise<PlatformSupportSettings> {
  const supabase = getSupabase();
  if (!supabase) return getCachedPlatformSupportSettings() || { whatsapp_number: null, support_email: null, privacy_url: null };
  const { data, error } = await supabase.rpc("get_platform_support_settings");
  if (error) {
    const cached = getCachedPlatformSupportSettings();
    if (cached) return cached;
    throw error;
  }
  const value = (data || {}) as Record<string, unknown>;
  const settings: PlatformSupportSettings = {
    whatsapp_number: value.whatsapp_number ? String(value.whatsapp_number) : null,
    support_email: value.support_email ? String(value.support_email) : null,
    privacy_url: value.privacy_url ? String(value.privacy_url) : null,
  };
  try { localStorage.setItem(SUPPORT_CACHE_KEY, JSON.stringify(settings)); } catch {}
  return settings;
}

export async function createSupportRequest(input: SupportRequestInput) {
  const supabase = getSupabase();
  if (!supabase) throw new Error("PALMYRA no está configurado.");
  const { data, error } = await supabase.rpc("create_support_request", {
    p_request_type: input.requestType,
    p_subject: input.subject,
    p_message: input.message,
    p_contact_phone: input.contactPhone || null,
    p_metadata: { source: "crm_support_center", user_agent: navigator.userAgent.slice(0, 240) },
  });
  if (error) throw error;
  return data as { ok: boolean; request_id: string; company_id: string; company_name: string };
}

export function normalizeWhatsAppNumber(value?: string | null) {
  return String(value || "").replace(/[^0-9]/g, "");
}

export function buildWhatsAppUrl(number: string, message: string) {
  const normalized = normalizeWhatsAppNumber(number);
  if (!normalized) return null;
  return `https://wa.me/${normalized}?text=${encodeURIComponent(message)}`;
}
