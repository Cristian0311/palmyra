/**
 * Regresiones del canje de enlaces de acceso de dispositivo.
 *
 * Bug reportado: al escribir la contraseña POS, el equipo mostraba «Failed to
 * send a request to the Edge Function» (FunctionsFetchError de supabase-js).
 * Causa real: `src/lib/supabase.ts` añade `Cache-Control` y `Pragma` a TODA
 * petición del SDK; ninguna es cabecera «simple» para CORS, y la edge function
 * solo permitía `authorization, x-client-info, apikey, content-type`. El
 * preflight se rechazaba y el POST nunca salía:
 *
 *   Request header field cache-control is not allowed by
 *   Access-Control-Allow-Headers in preflight response.
 *
 * Aquí se fija: (a) las cabeceras CORS de la función cubren al SDK y reflejan
 * el preflight sin permitir inyección, (b) el cliente clasifica el fallo de red
 * y muestra un mensaje accionable en español, (c) el reintento automático es
 * único y solo para fallos de red.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";

// Mismo puente que el resto de tests: supabase.ts lee import.meta.env en el
// ámbito del módulo y tsx no lo define.
(globalThis as any).__VITE_ENV__ = {};
const LOADER = [
  'export async function load(url, context, nextLoad) {',
  '  const r = await nextLoad(url, context);',
  '  if (url.includes("/src/") && r && r.source) {',
  '    const text = r.source.toString();',
  '    if (text.includes("import.meta.env")) {',
  '      return { ...r, source: text.replaceAll("import.meta.env", "(import.meta.env ?? globalThis.__VITE_ENV__)") };',
  '    }',
  '  }',
  '  return r;',
  '}'
].join('\n');
register("data:text/javascript;charset=utf-8," + encodeURIComponent(LOADER));

const { BASE_ALLOWED_HEADERS, allowedRequestHeaders, corsHeaders } = await import(
  "../../supabase/functions/device-access/cors.ts"
);
const { ACCESS_UNREACHABLE_HINT, ACCESS_UNREACHABLE_MESSAGE, accessFailureKind, redeemWithNetworkRetry } =
  await import("../../src/pages/DeviceAccess.tsx");
const { DeviceAccessError, readRedeemFailure } = await import("../../src/services/deviceAccess.ts");
const { FunctionsFetchError, FunctionsHttpError } = await import("@supabase/supabase-js");

const credentials = { email: "pos-e1@device.palmyra.app", password: "secreta" };

function networkError() {
  return new FunctionsFetchError(new TypeError("Failed to fetch"));
}

function httpError(status: number) {
  return new FunctionsHttpError(new Response("{}", { status }));
}

test("el preflight de device-access permite las cabeceras que añade el SDK", () => {
  // Regresión exacta del bug: sin cache-control/pragma el navegador bloquea el
  // POST, nunca llega a la función y supabase-js lo reporta como FunctionsFetchError.
  const allowed = corsHeaders()["Access-Control-Allow-Headers"];
  const names = allowed.split(",").map((name) => name.trim());

  for (const required of [
    "authorization",
    "apikey",
    "content-type",
    "x-client-info",
    "cache-control",
    "pragma"
  ]) {
    assert.ok(names.includes(required), `falta ${required} en Access-Control-Allow-Headers: ${allowed}`);
  }
  assert.equal(corsHeaders()["Access-Control-Allow-Origin"], "*");
  assert.match(corsHeaders()["Access-Control-Allow-Methods"], /POST/);
  assert.match(corsHeaders()["Access-Control-Allow-Methods"], /OPTIONS/);
});

test("las cabeceras base son estables y en minúsculas", () => {
  assert.ok(BASE_ALLOWED_HEADERS.includes("cache-control"));
  assert.ok(BASE_ALLOWED_HEADERS.includes("pragma"));
  for (const name of BASE_ALLOWED_HEADERS) {
    assert.equal(name, name.toLowerCase());
  }
});

test("el preflight refleja cabeceras nuevas sin duplicados ni inyección", () => {
  const allow = allowedRequestHeaders(
    "X-Futura-Cabecera, cache-control, cabecera con espacios, x-inject\r\nset-cookie: evil"
  );
  const names = allow.split(",").map((name) => name.trim());

  assert.ok(names.includes("x-futura-cabecera"));
  assert.ok(names.includes("cache-control"));
  assert.ok(!names.includes("cabecera con espacios"));
  assert.ok(!names.includes("x-inject"), "una cabecera con CRLF debe descartarse");
  assert.ok(!/[\r\n]/.test(allow), "el valor reflejado no puede partir la respuesta");
  assert.equal(new Set(names).size, names.length, "sin cabeceras duplicadas");
});

test("el fallo de red del SDK se clasifica aparte del rechazo del servidor", () => {
  assert.equal(accessFailureKind(networkError()), "network");
  assert.equal(
    accessFailureKind({ name: "FunctionsFetchError", message: "Failed to send a request to the Edge Function" }),
    "network"
  );
  assert.equal(accessFailureKind(new TypeError("Failed to fetch")), "network");
  // La capa de servicio puede traducirlo a un código propio.
  assert.equal(accessFailureKind(new DeviceAccessError("network_error", "x")), "network");

  // Los non-2xx NO son fallos de red: llevan código de negocio y estado HTTP.
  assert.equal(accessFailureKind(httpError(401)), "server");
  assert.equal(accessFailureKind(new DeviceAccessError("pos_password_invalid", "no")), "server");
  assert.equal(accessFailureKind(new DeviceAccessError("device_link_used", "usado")), "server");
  assert.equal(accessFailureKind(null), "server");
  assert.equal(accessFailureKind(new Error("La contraseña POS no es correcta.")), "server");
});

test("el mensaje al usuario es accionable y no repite el texto del SDK", () => {
  assert.match(ACCESS_UNREACHABLE_MESSAGE, /No se pudo contactar con el servicio de acceso/);
  assert.match(ACCESS_UNREACHABLE_MESSAGE, /conexión/i);
  assert.doesNotMatch(ACCESS_UNREACHABLE_MESSAGE, /Failed to send a request/i);
  assert.match(ACCESS_UNREACHABLE_HINT, /enlace sigue disponible/i);
});

test("un fallo de red se reintenta una sola vez y luego continúa", async () => {
  const calls: Array<{ token: string; password: string }> = [];
  const waits: number[] = [];
  let attempt = 0;

  const result = await redeemWithNetworkRetry(
    "tok",
    "1234",
    "PC",
    async (token, password) => {
      calls.push({ token, password });
      attempt += 1;
      if (attempt === 1) throw networkError();
      return credentials;
    },
    async (ms) => {
      waits.push(ms);
    }
  );

  assert.equal(result.email, credentials.email);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], { token: "tok", password: "1234" });
  assert.equal(waits.length, 1);
  assert.ok(waits[0] > 0 && waits[0] <= 1_200, `espera acotada, fue ${waits[0]}`);
});

test("un rechazo del servidor no se reintenta: el enlace es de un solo uso", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      redeemWithNetworkRetry(
        "tok",
        "mal",
        "PC",
        async () => {
          calls += 1;
          throw new DeviceAccessError("pos_password_invalid", "La contraseña POS no es correcta.");
        },
        async () => {}
      ),
    (error: any) => error.code === "pos_password_invalid"
  );
  assert.equal(calls, 1, "no debe repetir el POST cuando el servidor respondió");
});

test("el reintento está acotado: dos fallos de red terminan en error", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      redeemWithNetworkRetry(
        "tok",
        "1234",
        "PC",
        async () => {
          calls += 1;
          throw networkError();
        },
        async () => {}
      ),
    (error: any) => error?.name === "FunctionsFetchError"
  );
  assert.equal(calls, 2, "solo un reintento adicional");
});

test("DeviceAccess.tsx nunca muestra el texto crudo del fallo de red", () => {
  const source = readFileSync("src/pages/DeviceAccess.tsx", "utf8");
  // El fallo de red tiene su propia rama antes del mensaje genérico.
  assert.ok(source.includes('if (accessFailureKind(e) === "network")'));
  assert.ok(source.includes("setError(ACCESS_UNREACHABLE_MESSAGE)"));
  // Y se ofrece reintento sin volver a escribir la contraseña.
  assert.ok(source.includes("const retryAfterFailure"));
  assert.ok(source.includes("await redeemWithNetworkRetry(token, value, describeDevice())"));
});

/**
 * Regresión del arranque: el paso «validando → contraseña» se programa con un
 * temporizador. Con una guarda `booted` el segundo paso de StrictMode
 * (desmontar → montar) cancelaba el timer y no programaba otro, así que el
 * activador se quedaba en «Validando el enlace» sin campo de contraseña.
 */
test("el activador siempre llega al campo de contraseña tras montar", () => {
  // Solo se mira el código: el comentario de la corrección nombra la guarda que ya no existe.
  const code = readFileSync("src/pages/DeviceAccess.tsx", "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
  assert.ok(!/\bbooted\b/.test(code), "no puede haber una guarda que salte el programador del timer");
  assert.ok(!/useRef\(false\)/.test(code), "el arranque no puede memorizarse en una ref");
  assert.ok(code.includes('window.setTimeout(() => setPhase("password"), 250)'));
  assert.ok(code.includes("return () => window.clearTimeout(timer);"));
});

/**
 * Regresión de la opacidad: los seis pasos de provisión devolvían
 * `json({ error: "profile_write_failed" }, 500)` y tiraban el mensaje de Postgres,
 * así que el dueño leía «No se pudo guardar el perfil del trabajador» sin saber si
 * era el límite de trabajadores del plan Gratis o una regla de la base. Ahora la
 * función publica `detail` con códigos de negocio y el cliente lo traduce.
 */
function bodyFailure(payload: unknown) {
  return { context: new Response(JSON.stringify(payload), { status: 500 }) };
}

test("la causa del motor acompaña al mensaje de provisión", async () => {
  const profile = await readRedeemFailure(bodyFailure({ error: "profile_write_failed", detail: "invalid_active_company" }));
  assert.equal(profile.code, "profile_write_failed");
  assert.match(profile.message, /No se pudo guardar el perfil del trabajador/);
  assert.match(profile.message, /La cuenta aún no quedó vinculada a la empresa/);

  const limit = await readRedeemFailure(bodyFailure({ error: "employee_write_failed", detail: "plan_employees_limit" }));
  assert.match(limit.message, /límite de trabajadores de su plan/);
  assert.match(limit.message, /sube de plan/i);
});

test("un detalle fuera de la lista blanca no añade texto ni filtra SQL", async () => {
  const failure = await readRedeemFailure(
    bodyFailure({ error: "role_write_failed", detail: 'violates foreign key "user_roles_role_id_fkey" on table "public.user_roles"' })
  );
  assert.equal(failure.code, "role_write_failed");
  assert.equal(failure.message, "No se pudo asignar el rol del trabajador.");
  assert.doesNotMatch(failure.message, /foreign key|user_roles_role_id_fkey|table/i);
});

test("los códigos nuevos de la edge function tienen mensaje en español", async () => {
  for (const [code, expected] of [
    ["warehouse_unavailable", "sucursal"],
    ["role_unavailable", "rol"],
    ["lookup_failed", "enlace nuevo"],
    ["internal_error", "Inténtalo de nuevo"]
  ] as const) {
    const failure = await readRedeemFailure(bodyFailure({ error: code }));
    assert.equal(failure.code, code);
    assert.match(failure.message, new RegExp(expected, "i"), `${code}: ${failure.message}`);
  }
});

test("el cuerpo no JSON no convierte el canje en un error vacío", async () => {
  const failure = await readRedeemFailure({ context: new Response("<html>502 Bad Gateway</html>", { status: 502 }) });
  assert.equal(failure.code, "");
  assert.match(failure.message, /No se pudo canjear el enlace de acceso/);
});
