/**
 * Aplica mailer_autoconfirm=true en Supabase Auth (Management API) para que
 * los registros no esperen correo de confirmación, y verifica el cambio con
 * el endpoint público de GoTrue. Lee el token de .secrets sin imprimirlo.
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

const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/config/auth`, {
  method: 'PATCH',
  headers: {
    Accept: 'application/json',
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ mailer_autoconfirm: true }),
  signal: AbortSignal.timeout(10_000)
});

if (!res.ok) {
  console.error('PATCH /config/auth falló:', res.status);
  if (res.status === 401) console.error('El token no es válido o no autoriza este proyecto.');
  process.exit(1);
}

const config = await res.json();
console.log('PATCH aplicado. mailer_autoconfirm:', Boolean(config.mailer_autoconfirm));

const s = await fetch(`https://${projectRef}.supabase.co/auth/v1/settings`, {
  headers: { Accept: 'application/json', apikey: ANON_KEY },
  signal: AbortSignal.timeout(10_000)
});
if (s.ok) {
  const pub = await s.json();
  const auto = pub.mailer_autoconfirm === true;
  console.log('Verificación pública (/auth/v1/settings): mailer_autoconfirm =', pub.mailer_autoconfirm);
  console.log(auto
    ? 'OK: la confirmación de correo quedó DESACTIVADA. Los registros nuevos entran al instante, sin correo.'
    : 'ATENCIÓN: la confirmación sigue activa. Revisa la configuración en el dashboard.');
  if (!auto) process.exit(1);
} else {
  console.log('No se pudo verificar con el endpoint público (status ' + s.status + ').');
  process.exit(1);
}
