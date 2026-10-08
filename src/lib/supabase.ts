import { createClient, SupabaseClient } from '@supabase/supabase-js';

const STORAGE_URL_KEY = 'palmyra_supabase_url';
const STORAGE_ANON_KEY = 'palmyra_supabase_anon_key';

export const DEFAULT_SUPABASE_URL = 'https://hmcvujyqloyjdvngpdxz.supabase.co';
export const DEFAULT_SUPABASE_ANON_KEY = 'sb_publishable_kwVdr2-FlHXUX9hEQ6pZCQ_4rGMDXyO';

export function getSupabaseCredentials() {
  const envUrl = import.meta.env.VITE_SUPABASE_URL || '';
  const envKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

  const storedUrl = localStorage.getItem(STORAGE_URL_KEY) || '';
  const storedKey = localStorage.getItem(STORAGE_ANON_KEY) || '';

  // Render/Vite environment variables take precedence in production.
  // PALMYRA-specific storage keys prevent older OmniSync/MARÉ credentials
  // from silently redirecting the POS to a different Supabase project.
  const url = envUrl || storedUrl || DEFAULT_SUPABASE_URL;
  const anonKey = envKey || storedKey || DEFAULT_SUPABASE_ANON_KEY;

  return { url, anonKey, isConfigured: Boolean(url && anonKey) };
}

export function saveSupabaseCredentials(url: string, anonKey: string) {
  if (url) localStorage.setItem(STORAGE_URL_KEY, url.trim());
  else localStorage.removeItem(STORAGE_URL_KEY);

  if (anonKey) localStorage.setItem(STORAGE_ANON_KEY, anonKey.trim());
  else localStorage.removeItem(STORAGE_ANON_KEY);

  cachedClient = null;
}

let cachedClient: SupabaseClient | null = null;

const supabaseFetch: typeof fetch = (input, init) => {
  const requestInit: RequestInit = { ...(init || {}) };
  const headers = new Headers(requestInit.headers || {});
  headers.set('Cache-Control', 'no-cache, no-store, max-age=0');
  headers.set('Pragma', 'no-cache');
  requestInit.headers = headers;
  requestInit.cache = 'no-store';
  return fetch(input, requestInit);
};

export function getSupabase(): SupabaseClient | null {
  const { url, anonKey, isConfigured } = getSupabaseCredentials();

  if (!isConfigured) {
    return null;
  }

  if (!cachedClient) {
    try {
      cachedClient = createClient(url, anonKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
        },
        global: {
          fetch: supabaseFetch,
        },
        db: {
          timeout: 15000,
        },
      });
    } catch (e) {
      console.error("Error inicializando cliente de Supabase:", e);
      return null;
    }
  }

  return cachedClient;
}

export async function checkSupabaseReachability(timeoutMs = 8000): Promise<{ ok: boolean; message?: string }> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    return { ok: false, message: 'El dispositivo está offline.' };
  }

  const client = getSupabase();
  if (!client) {
    return { ok: false, message: 'Supabase no está configurado.' };
  }

  try {
    // Probe a tiny, RLS-protected table. This is only a connectivity check;
    // it never mutates data and never becomes a dependency for the durable queue.
    const probe = client.from('products').select('id').limit(1);
    const timeout = new Promise<{ data: any; error: any }>(resolve =>
      setTimeout(() => resolve({
        data: null,
        error: { message: 'Tiempo de espera agotado al contactar Supabase.', code: 'NETWORK_TIMEOUT' }
      }), timeoutMs)
    );

    const { error } = await Promise.race([probe, timeout]);

    if (!error) return { ok: true };

    const code = String((error as any).code || '');
    const status = Number((error as any).status || 0);
    const message = String((error as any).message || 'La API de Supabase no respondió correctamente.');

    // Authentication/authorization/database errors prove that the API is
    // reachable. Do not mistake them for a network outage.
    if (
      code === 'NETWORK_TIMEOUT' ||
      status >= 500 ||
      code.startsWith('PGRST') ||
      /network|fetch|failed|timeout|connection|gateway/i.test(message)
    ) {
      return { ok: false, message };
    }

    return { ok: true };
  } catch (e: any) {
    return {
      ok: false,
      message: e?.name === 'AbortError'
        ? 'Tiempo de espera agotado al contactar Supabase.'
        : (e?.message || 'No se pudo contactar Supabase.')
    };
  }
}

export async function waitForSupabaseReachability(
  attempts = 3,
  timeoutMs = 8000
): Promise<{ ok: boolean; message?: string; attempts: number }> {
  let lastMessage = 'Supabase no está accesible todavía.';
  for (let attempt = 1; attempt <= Math.max(1, attempts); attempt++) {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      return { ok: false, message: 'El dispositivo está offline.', attempts: attempt };
    }
    const result = await checkSupabaseReachability(timeoutMs);
    if (result.ok) return { ok: true, attempts: attempt };
    lastMessage = result.message || lastMessage;
    if (attempt < attempts) {
      await new Promise(resolve => setTimeout(resolve, 450 * Math.pow(2, attempt - 1)));
    }
  }
  return { ok: false, message: lastMessage, attempts: Math.max(1, attempts) };
}

export async function testSupabaseConnection(
  url?: string,
  anonKey?: string
): Promise<{ success: boolean; message: string; tableCount?: number }> {
  try {
    const targetUrl = url || getSupabaseCredentials().url;
    const targetKey = anonKey || getSupabaseCredentials().anonKey;

    if (!targetUrl || !targetKey) {
      return {
        success: false,
        message: "URL o Clave pública de Supabase no configuradas."
      };
    }

    const client = createClient(targetUrl, targetKey);
    const { error: prodErr } = await client.from('products').select('id').limit(1);

    if (prodErr) {
      return {
        success: false,
        message: `Error de conexión: ${prodErr.message}`
      };
    }

    return {
      success: true,
      message: "¡Conexión con Supabase establecida exitosamente!"
    };
  } catch (err: any) {
    return {
      success: false,
      message: err?.message || "No se pudo conectar con Supabase."
    };
  }
}
