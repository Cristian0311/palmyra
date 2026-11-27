/**
 * CORS de la edge function device-access.
 *
 * Regresión que corrige este módulo: el cliente (`src/lib/supabase.ts`) añade
 * SIEMPRE las cabeceras `Cache-Control` y `Pragma` a cada petición del SDK para
 * esquivar cachés intermedias. Ninguna de las dos es una cabecera «simple» para
 * CORS, así que el navegador exige verlas listadas en `Access-Control-Allow-Headers`
 * o descarta la petición real antes de enviarla:
 *
 *   Access to fetch ... has been blocked by CORS policy: Request header field
 *   cache-control is not allowed by Access-Control-Allow-Headers in preflight response.
 *
 * El gateway REST de Supabase refleja las cabeceras pedidas y por eso el resto
 * de la app funciona; una edge function, en cambio, responde el preflight con
 * lo que escriba su propio código. Con la lista corta (authorization,
 * x-client-info, apikey, content-type) el POST nunca salía y supabase-js lo
 * reportaba como FunctionsFetchError: «Failed to send a request to the Edge
 * Function». Aquí la lista cubre lo que manda el SDK y, en el preflight, se
 * reflejan además las cabeceras solicitadas para no volver a romperse cuando el
 * SDK añada otra.
 *
 * Reflejar cabeceras no relaja la autenticación: el origen permitido sigue
 * siendo `*` sin credenciales, y el secreto del canje viaja en el cuerpo
 * (token + contraseña POS), no en una cabecera.
 */

/** Cabeceras fijas de toda respuesta de la función. */
export const BASE_ALLOWED_HEADERS: readonly string[] = [
  "authorization",
  "x-client-info",
  "apikey",
  "x-region",
  "content-type",
  "cache-control",
  "pragma",
  "x-supabase-api-version"
];

/** Nombre de cabecera válido: minúsculas, sin espacios ni CRLF ni comas. */
const HEADER_NAME = /^[a-z0-9][a-z0-9-]{0,47}$/;

/** Tope defensivo para el reflejo del preflight. */
const MAX_ECHOED_HEADERS = 24;

/**
 * Valor de `Access-Control-Allow-Headers`: las cabeceras fijas más las que pida
 * el preflight, saneadas (un `\r\n` inyectado serviría para partir la respuesta).
 */
export function allowedRequestHeaders(requested?: string | null): string {
  const echoed: string[] = [];
  for (const raw of String(requested || "").split(",")) {
    if (echoed.length >= MAX_ECHOED_HEADERS) break;
    const name = raw.trim().toLowerCase();
    if (!HEADER_NAME.test(name)) continue;
    if (echoed.includes(name)) continue;
    echoed.push(name);
  }
  const all = [...BASE_ALLOWED_HEADERS, ...echoed];
  return all.filter((name, index) => all.indexOf(name) === index).join(", ");
}

/** Cabeceras CORS completas (respuestas normales y preflight). */
export function corsHeaders(
  requested?: string | null,
  extra: Record<string, string> = {}
): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": allowedRequestHeaders(requested),
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    ...extra
  };
}
