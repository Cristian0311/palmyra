import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const STORAGE_URL_KEY = "palmyra_admin_supabase_url";
const STORAGE_KEY_KEY = "palmyra_admin_supabase_key";

const DEFAULT_URL = "https://hmcvujyqloyjdvngpdxz.supabase.co";
const DEFAULT_KEY = "sb_publishable_kwVdr2-FlHXUX9hEQ6pZCQ_4rGMDXyO";

let client: SupabaseClient | null = null;

export function getAdminSupabase(): SupabaseClient {
  if (client) return client;

  const url = import.meta.env.VITE_SUPABASE_URL || localStorage.getItem(STORAGE_URL_KEY) || DEFAULT_URL;
  const key =
    import.meta.env.VITE_SUPABASE_ANON_KEY ||
    import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
    localStorage.getItem(STORAGE_KEY_KEY) ||
    DEFAULT_KEY;

  if (!url || !key) {
    throw new Error("PALMYRA Admin no tiene configurada la conexión con Supabase.");
  }

  client = createClient(url, key, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
    global: {
      fetch: (input, init) => {
        const headers = new Headers(init?.headers || {});
        headers.set("Cache-Control", "no-store");
        headers.set("Pragma", "no-cache");
        return fetch(input, { ...(init || {}), cache: "no-store", headers });
      },
    },
  });

  return client;
}

export async function adminSignIn(email: string, password: string) {
  return getAdminSupabase().auth.signInWithPassword({
    email: email.trim().toLowerCase(),
    password,
  });
}

export async function adminSignOut() {
  await getAdminSupabase().auth.signOut();
}

export async function adminUser() {
  const { data, error } = await getAdminSupabase().auth.getUser();
  if (error) throw error;
  return data.user;
}
