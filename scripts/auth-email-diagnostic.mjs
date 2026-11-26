/**
 * Diagnóstico de SOLO LECTURA de la configuración de correo de Supabase Auth.
 * Lee el token de .secrets/supabase.env sin imprimirlo; nunca muestra
 * smtp_pass/smtp_user ni el token. Imprime solo campos seguros del config
 * y los mensajes de error de envío recientes de auth_logs (truncados).
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const secretsFile = resolve(repoRoot, '..', '.secrets', 'supabase.env');

function loadEnv(path) {
  const text = readFileSync(path, 'utf8');
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    env[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
  }
  return env;
}

const env = loadEnv(secretsFile);
const token = env.SUPABASE_ACCESS_TOKEN;
const projectRef = env.SUPABASE_PROJECT_REF || 'hmcvujyqloyjdvngpdxz';
if (!token) {
  console.error('No se encontró SUPABASE_ACCESS_TOKEN en .secrets/supabase.env');
  process.exit(1);
}

// Clave anónima pública embebida en el bundle (src/lib/supabase.ts): no es secreta.
const ANON_KEY = 'sb_publishable_kwVdr2-FlHXUX9hEQ6pZCQ_4rGMDXyO';

const base = `https://api.supabase.com/v1/projects/${projectRef}`;
const headers = { Accept: 'application/json', Authorization: `Bearer ${token}` };
const safe = (value, fallback = '(no definido)') =>
  value === undefined || value === null || value === '' ? fallback : String(value);

console.log(`Proyecto: ${projectRef}\n`);

console.log('=== Configuración pública de GoTrue (/auth/v1/settings) ===');
try {
  const res = await fetch(`https://${projectRef}.supabase.co/auth/v1/settings`, {
    headers: { Accept: 'application/json', apikey: ANON_KEY },
    signal: AbortSignal.timeout(10_000)
  });
  if (!res.ok) {
    console.error('GET /auth/v1/settings falló:', res.status);
  } else {
    const s = await res.json();
    console.log('mailer_autoconfirm (sin espera de correo):', safe(s.mailer_autoconfirm));
    console.log('  -> requiere confirmación de correo:', s.mailer_autoconfirm === true ? 'NO' : s.mailer_autoconfirm === false ? 'SÍ' : 'desconocido');
    console.log('disable_signup:', safe(s.disable_signup));
    console.log('external_email_enabled (plana):', safe(s.external_email_enabled, safe(s.external?.email?.enabled)));
    console.log('site_url:', safe(s.site_url));
    console.log('mailer_otp_exp (segundos):', safe(s.mailer_otp_exp));
    console.log('smtp_max_frequency (segundos):', safe(s.smtp_max_frequency));
    console.log('rate_limit_email_sent (por hora):', safe(s.rate_limit_email_sent));
  }
} catch (error) {
  console.error('Error al leer settings:', error?.message || error);
}

console.log('\n=== Management API (estado del token local) ===');
try {
  const res = await fetch(`${base}/config/auth`, { headers, signal: AbortSignal.timeout(10_000) });
  if (res.status === 401) {
    console.log('El token local (SUPABASE_ACCESS_TOKEN) ya NO es válido: 401.');
    console.log('Si el servidor Render usa este mismo token para la tarjeta');
    console.log('«Confirmación de correo» del admin SaaS, tampoco podrá alternarla.');
  } else if (!res.ok) {
    console.log('GET /config/auth falló:', res.status);
  } else {
    const config = await res.json();
    // El config de Auth es PLANO: smtp_host/smtp_port/... son claves top-level.
    // Nunca imprimir smtp_user ni smtp_pass.
    console.log('mailer_autoconfirm:', safe(config.mailer_autoconfirm));
    console.log('external_email_enabled:', safe(config.external_email_enabled));
    console.log('smtp_host:', safe(config.smtp_host));
    console.log('smtp_port:', safe(config.smtp_port));
    console.log('smtp_sender_name:', safe(config.smtp_sender_name));
    console.log('smtp_admin_email:', safe(config.smtp_admin_email));
  }
} catch (error) {
  console.error('Error al leer la configuración:', error?.message || error);
}

console.log('\n=== auth_logs: errores de envío recientes (24 h) ===');
try {
  const sql = [
    "select timestamp, event_message",
    "from auth_logs",
    "where (event_message ilike '%sending%'",
    "or event_message ilike '%550%'",
    "or event_message ilike '%450%'",
    "or event_message ilike '%limit%')",
    "and timestamp > now() - interval '24 hours'",
    "order by timestamp desc",
    "limit 30"
  ].join(' ');
  const url = `${base}/analytics/endpoints/logs.all?sql=${encodeURIComponent(sql)}`;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  if (res.status === 401) {
    console.log('No disponible: el token local no autoriza (401).');
  } else if (res.status === 410) {
    console.log('No disponible: el endpoint de analytics fue deprecado (410 Gone).');
  } else if (!res.ok) {
    console.log('Consulta de logs no disponible (status ' + res.status + ').');
  } else {
    const payload = await res.json();
    const rows = Array.isArray(payload?.result) ? payload.result : [];
    if (rows.length === 0) {
      console.log('(sin registros de error de envío en las últimas 24 h)');
    }
    for (const row of rows) {
      const msg = String(row.event_message ?? '').slice(0, 160);
      console.log(`[${row.timestamp}] ${msg}`);
    }
  }
} catch (error) {
  console.log('Consulta de logs no disponible:', error?.message || error);
}
