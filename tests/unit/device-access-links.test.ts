/**
 * Regresiones del estado real de los enlaces de acceso.
 *
 * Regla del dueño (2026-11-28): UN enlace vivo por trabajador, los caducados no se
 * muestran (se eliminan) y el tiempo se pregunta AL pulsar «Generar enlace».
 *
 * La causa de la divergencia entre móviles sigue cerrada aquí: la caducidad vivía
 * solo en estado de React y `create_device_access_invite` expiraba TODAS las
 * pendientes del empleado, así que generar desde el segundo teléfono mataba el
 * enlace del primero. Las aserciones sobre fuente SQL siguen el patrón ya usado en
 * el repo (`two-phase-transfers.test.ts`, `materializer-sql.test.ts`).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  ACCESS_INVITE_MAX_PENDING_LINKS,
  accessLinkStatus,
  describeAccessLink,
  normalizeLinkRow,
} from "../../src/services/deviceAccess";

const source = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const MIGRATION = "supabase/migrations/20261128120000_device_access_links_state.sql";
const PREVIOUS = "supabase/migrations/20261126120000_warehouses_always_operational.sql";

/** Cuerpo de una función PL/pgSQL, desde su `create or replace` hasta el `$$;`. */
function fnBody(sql: string, signature: string): string {
  const start = sql.indexOf(signature);
  assert.notEqual(start, -1, `falta ${signature} en la migración`);
  const end = sql.indexOf("$$;", start);
  assert.notEqual(end, -1, `${signature} no cierra`);
  return sql.slice(start, end);
}

/* ------------------------------------------------------------------ */
/* Servidor: un enlace vivo, purga de caducados y cero fuga de secreto  */
/* ------------------------------------------------------------------ */

test("create_device_access_invite deja de invalidar los enlaces ya entregados", () => {
  const previous = fnBody(source(PREVIOUS), "create or replace function public.create_device_access_invite");
  assert.match(
    previous,
    /set expires_at = timezone\('utc', now\(\)\)\s*\n\s*where employee_id = v_employee\.id/,
    "el defecto original existía: esta prueba avisa si la migración anterior cambia"
  );

  const next = fnBody(source(MIGRATION), "create or replace function public.create_device_access_invite");
  assert.doesNotMatch(
    next,
    /set expires_at = timezone\('utc', now\(\)\)\s*\n\s*where employee_id/,
    "generar un enlace no puede expirar todas las pendientes del empleado"
  );
  // En su lugar: avisa de que ya hay uno, para que el UI obligue a revocar.
  assert.match(next, /if v_live >= 1 then raise exception 'device_link_exists'; end if;/);
  assert.match(
    next,
    /and i\.used_at is null\s*\n\s*and i\.expires_at > timezone\('utc', now\(\)\)/,
    "el conteo de vivos ignora usados y caducados"
  );
});

test("los enlaces caducados y nunca usados se eliminan, no se muestran", () => {
  const sql = source(MIGRATION);
  const purge = /delete from public\.device_access_invites\s*\n\s*where employee_id = v_employee\.id\s*\n\s*and company_id = v_employee\.company_id\s*\n\s*and used_at is null\s*\n\s*and expires_at <= timezone\('utc', now\(\)\)/g;
  // create, list y revoke purgan: un enlace vencido nunca llega a la pantalla.
  assert.equal((sql.match(purge) || []).length, 3, "cada RPC debe purgar sus caducados");
});

test("el tope del cliente y el del servidor son el mismo número", () => {
  const sql = fnBody(source(MIGRATION), "create or replace function public.create_device_access_invite");
  assert.match(sql, /if v_live >= (\d+) then/);
  const serverCap = Number(sql.match(/if v_live >= (\d+) then/)![1]);
  assert.equal(serverCap, ACCESS_INVITE_MAX_PENDING_LINKS);
  assert.equal(ACCESS_INVITE_MAX_PENDING_LINKS, 1);
});

test("«sin caducidad» sigue llegando como infinity al servidor", () => {
  const sql = fnBody(source(MIGRATION), "create or replace function public.create_device_access_invite");
  assert.match(sql, /if coalesce\(p_expires_in_days, 7\) <= 0 then\s*\n\s*v_expires_at := 'infinity'::timestamptz;/);
});

test("list_device_access_links muestra el estado real sin revelar el token", () => {
  const sql = fnBody(source(MIGRATION), "create or replace function public.list_device_access_links");
  assert.doesNotMatch(sql, /token_hash/, "el hash nunca sale hacia el cliente");
  assert.doesNotMatch(sql, /gen_random_bytes|digest\(/, "no se regenera ni se lee el secreto");
  for (const field of ["'id'", "'created_at'", "'expires_at'", "'used_at'", "'used_by_device'"]) {
    assert.ok(sql.includes(field), `el jsonb debe incluir ${field}`);
  }
  assert.match(sql, /limit 20/, "lista acotada: el presupuesto de peticiones no perdona");
  // Solo vivos: un enlace ya usado o vencido no pinta en Equipo.
  assert.match(sql, /and i\.used_at is null\s*\n\s*and i\.expires_at > timezone\('utc', now\(\)\)/);
});

test("las tres RPCs están candadas y solo ejecutables por authenticated", () => {
  const sql = source(MIGRATION);
  const literal = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const signature of [
    "public.create_device_access_invite(uuid, integer)",
    "public.list_device_access_links(uuid)",
    "public.revoke_device_access_links(uuid, uuid[])",
  ]) {
    const fn = literal(signature);
    assert.match(sql, new RegExp(`revoke all on function ${fn} from public, anon;`), signature);
    assert.match(sql, new RegExp(`grant execute on function ${fn} to authenticated;`), signature);
  }
  // Mismo candado en las tres: propietario activo o employees.manage.
  const ownerChecks = (sql.match(/and not private\.has_permission\(v_employee\.company_id, 'employees\.manage'\) then/g) || []).length;
  assert.equal(ownerChecks, 3, "una RPC nueva sin candado abriría una puerta lateral");
});

test("la empresa se deriva del empleado, nunca del cliente", () => {
  const sql = source(MIGRATION);
  assert.doesNotMatch(sql, /p_company_id/, "ningún parámetro de empresa: no se puede apuntar a otra");
  assert.match(sql, /and i\.company_id = v_employee\.company_id/);
  assert.match(sql, /and company_id = v_employee\.company_id\s*\n\s*and id = any \(p_ids\)/);
});

test("revocar elimina el enlace pendiente y respeta el ya usado", () => {
  const sql = fnBody(source(MIGRATION), "create or replace function public.revoke_device_access_links");
  assert.match(sql, /delete from public\.device_access_invites/, "revocar = eliminar: un enlace muerto no queda en la base");
  assert.doesNotMatch(sql, /set expires_at/, "no se expira en silencio: la fila desaparece");
  // El enlace ya canjeado es el rastro de qué dispositivo se activó: no se borra.
  assert.match(sql, /and id = any \(p_ids\)\s*\n\s*and used_at is null/);
  assert.match(sql, /get diagnostics v_revoked = row_count;/, "devuelve cuántos eliminó");
  assert.match(sql, /if p_ids is null or cardinality\(p_ids\) = 0 then return 0; end if;/, "sin ids, cero peticiones");
});

/* ------------------------------------------------------------------ */
/* Cliente: la etiqueta sale de la fila, no de lo que se pidió          */
/* ------------------------------------------------------------------ */

test("un expires_at 'infinity' se lee como sin caducidad, no como año 293", () => {
  const link = normalizeLinkRow({
    id: "6f0a1c2e-0000-4000-8000-000000000001",
    created_at: "2026-11-27T03:25:48+00:00",
    expires_at: "infinity",
    used_at: null,
    used_by_device: ""
  });
  assert.ok(link);
  assert.equal(link!.expiresAt, null, "'infinity' no es una fecha");
  assert.equal(accessLinkStatus(link!, Date.parse("2026-11-28T00:00:00Z")), "active");
  assert.equal(describeAccessLink(link!, Date.parse("2026-11-28T00:00:00Z")), "Sin caducidad");
});

test("una fila ya consumida manda sobre la caducidad", () => {
  const link = normalizeLinkRow({
    id: "6f0a1c2e-0000-4000-8000-000000000002",
    created_at: "2026-11-20T10:00:00+00:00",
    expires_at: "infinity",
    used_at: "2026-11-21T09:30:00+00:00",
    used_by_device: "pos-50b54942@device.palmyra.app"
  });
  assert.equal(accessLinkStatus(link!), "used");
  assert.match(describeAccessLink(link!), /^Usado el /);
});

test("las fechas malas o vacías no inventan enlaces", () => {
  assert.equal(normalizeLinkRow({ created_at: "", expires_at: "no-es-fecha" }), null, "sin id no hay fila");
  const link = normalizeLinkRow({ id: "x", created_at: "basura", expires_at: "basura" });
  assert.equal(link!.expiresAt, null);
  assert.equal(accessLinkStatus(link!), "active", "sin caducidad legible el enlace se muestra vivo, no expirado");
});

test("el cliente llama las RPCs nuevas con los parámetros exactos", () => {
  const service = source("src/services/deviceAccess.ts");
  assert.match(service, /supabase\.rpc\('list_device_access_links',\s*\{\s*p_employee_id: employeeId\s*\}\)/);
  assert.match(service, /supabase\.rpc\('revoke_device_access_links',\s*\{\s*p_employee_id: employeeId,\s*p_ids: linkIds\s*\}\)/);
  // `device_link_exists` es el error normal de «ya hay uno»: debe tener frase propia.
  assert.match(service, /device_link_exists: 'Este trabajador ya tiene un enlace de acceso activo\./);
});

test("el canje explica al dispositivo que su enlace caducó o se eliminó", () => {
  const service = source("src/services/deviceAccess.ts");
  assert.match(service, /device_link_expired: 'Tu enlace de acceso caducó\./);
  assert.match(service, /device_link_invalid: 'El enlace de acceso caducó o el propietario lo eliminó\./);
  // El servidor responde esto mientras la fila existe (verify_device_access_invite).
  const verify = source("supabase/migrations/20261124170000_device_access_password.sql");
  assert.match(verify, /if v_invite\.expires_at is null or v_invite\.expires_at <= v_now then\s*\n\s*raise exception 'device_link_expired';/);
});

/* ------------------------------------------------------------------ */
/* Equipo: la preferencia es de empresa y generar pregunta el tiempo    */
/* ------------------------------------------------------------------ */

test("abrir el diálogo del enlace ya no cuaja un token nuevo", () => {
  const team = source("src/pages/Team.tsx");
  const dialog = team.slice(team.indexOf("const openAccessDialog"), team.indexOf("const generateAccessLink"));
  assert.doesNotMatch(dialog, /createDeviceAccessInvite\(/, "abrir no puede generar");
  assert.match(dialog, /reloadAccessLinks\(/, "abrir sí lee el estado del servidor");
  // Un único punto de creación para las dos superficies.
  assert.equal((team.match(/createDeviceAccessInvite\(/g) || []).length, 1);
  assert.match(team, /createDeviceAccessInvite\(employee\.id, selectedAccessExpiry\.days\)/);
});

test("ninguna superficie genera sin preguntar el tiempo antes", () => {
  const team = source("src/pages/Team.tsx");
  // `generateAccessLink` solo se llama desde los dos selectores de duración.
  assert.equal((team.match(/void generateAccessLink\(/g) || []).length, 2);
  assert.equal((team.match(/<AccessLinkDuration\b/g) || []).length, 2, "editor y diálogo comparten el selector");
  assert.doesNotMatch(team, /onClick=\{\(\) => \{ if \(accessInviteEmployee\) void generateAccessLink/, "el botón del pie ya no puede generar directo");
  assert.match(team, /setLinkPickerFor\(accessInvite\.employeeId\)/);
  assert.match(team, /setLinkPickerFor\(editing\.id\)/);
});

test("ya hay un enlace activo: el botón desaparece hasta revocar", () => {
  const team = source("src/pages/Team.tsx");
  assert.match(team, /const hasLiveLink = \(employeeId\?: string \| null\) =>/);
  assert.match(team, /Boolean\(employeeId && \(accessLinks\[employeeId\] \|\| \[\]\)\.some\(link => accessLinkStatus\(link\) === 'active'\)\)/);
  assert.match(team, /: hasLiveLink\(editing\.id\) \? \(/);
  assert.match(team, /!hasLiveLink\(accessInvite\.employeeId\) && \(/);
  assert.match(team, /Este trabajador ya tiene un enlace activo\. Revócalo y elimínalo abajo para poder generar otro\./);
});

test("la caducidad inicial sale de la preferencia de la empresa", () => {
  const team = source("src/pages/Team.tsx");
  assert.match(team, /useStore\(state => state\.storeConfig\?\.deviceAccessInviteDays\)/);
  assert.match(team, /resolveAccessInviteExpiry\(deviceAccessInviteDays \?\? ACCESS_INVITE_DEFAULT_DAYS\)\.days/);
  assert.doesNotMatch(team, /useState<number>\(ACCESS_INVITE_DEFAULT_DAYS\)/, "la caducidad no puede vivir solo en memoria del componente");
  assert.doesNotMatch(team, /accessLinkDaysByEmployee/, "la memoria por empleado era justo lo que divergía entre dispositivos");
  // Cambiar el tiempo del enlace persiste; no depende de pulsar «Guardar cambios».
  assert.equal((team.match(/setDeviceAccessInviteDays\(nextDays\)/g) || []).length, 2);
});

test("la preferencia sobrevive al viaje ida y vuelta por la nube", () => {
  const actions = source("src/store/actions/supportActions.ts");
  const queue = source("src/services/offline/processQueueItem.ts");
  const pull = source("src/services/supabaseSync/pull.ts");
  const types = source("src/services/offlineQueueTypes.ts");
  const mutations = source("src/services/supabaseSync/mutations.ts");

  assert.match(actions, /deviceAccessInviteDays: normalized/);
  assert.match(actions, /pushStoreConfigToSupabase\(nextStoreConfig/);
  assert.match(mutations, /updateCompanySettings\(\{storeConfig:config\}\)/);
  assert.match(mutations, /queue\('store_config',config,'global'\)/);
  // El replay escribe la clave camelCase que el pull lee: con snake_case se perdía.
  const replay = queue.slice(queue.indexOf("case 'receipt_config':"), queue.indexOf("case 'receipt_config':") + 1600);
  assert.match(replay, /const key = type === 'receipt_config' \? 'receiptConfig' : type === 'catalog_config' \? 'catalogConfig' : 'storeConfig';/);
  assert.match(replay, /\[key\]: \{\s*\.\.\.\(currentSettings as any\)\?\.\[key\], \.\.\.incomingConfig \}/);
  assert.doesNotMatch(queue, /settings: \{[^}]*\b(store|receipt|catalog)_config\b/);
  assert.match(replay, /upsert\(\{ company_id: companyId, settings: mergedSettings/);
  assert.match(pull, /settings\?\.storeConfig \|\| settings\?\.store_config/);
  // La revocación offline existe y tiene su tipo.
  assert.match(types, /'device_access_revoke'/);
  assert.match(queue, /case 'device_access_revoke'/);
  assert.match(queue, /rpc\('revoke_device_access_links', \{ p_employee_id: employeeId, p_ids: linkIds \}\)/);
});

test("revocar deja libre el hueco y abre el selector de tiempo", () => {
  const team = source("src/pages/Team.tsx");
  const start = team.indexOf("const revokeAccessLinks");
  const revoke = team.slice(start, start + 1700);
  assert.ok(revoke.length > 100, "el handler de revocar debe existir");
  assert.match(revoke, /setAccessLinks\(prev => \(\{/, "la fila revocada sale de la lista al instante");
  assert.match(revoke, /setGeneratedAccessInvites\(prev => \{/, "el enlace en claro muere con la fila");
  assert.match(revoke, /setLinkPickerFor\(employee\.id\)/, "al revocar se puede elegir el tiempo del siguiente");
  assert.match(revoke, /setFormAccessLink\(''\)/);
  assert.match(revoke, /enqueueOfflineItem\("device_access_revoke"/);
  assert.match(revoke, /Enlace de acceso revocado y eliminado\. Ya puedes generar otro\./);
});

test("las dos superficies comparten un mismo bloque de enlaces", () => {
  const team = source("src/pages/Team.tsx");
  assert.match(team, /import AccessLinks, \{ AccessLinkDuration \} from "\.\.\/components\/AccessLinks"/);
  assert.equal((team.match(/<AccessLinks\b/g) || []).length, 2);
  const block = source("src/components/AccessLinks.tsx");
  assert.match(block, /links: DeviceAccessLink\[\] \| null/);
  assert.match(block, /Enlaces de este trabajador/);
  assert.match(block, /\$\{liveIds\.length\} \$\{liveIds\.length === 1 \? "enlace activo" : "enlaces activos"\}/);
  // `links === null` (sin lectura) no puede pintarse como «no tiene enlaces».
  assert.match(block, /links === null/);
  assert.match(block, /No se pudo consultar el estado de los enlaces en el servidor\./);
  assert.match(block, /Solo puede haber un enlace activo\./);
});

test("el selector de tiempo es lo único que ofrece los días", () => {
  const block = source("src/components/AccessLinks.tsx");
  assert.match(block, /export function AccessLinkDuration/);
  assert.match(block, /¿Por cuánto tiempo\?/);
  assert.match(block, /ACCESS_INVITE_DAY_OPTIONS\.map\(option =>/);
  assert.match(block, /const active = option === days;/);
  assert.match(block, /aria-pressed=\{active\}/);
  assert.match(block, /\? <><RefreshCw className="h-4 w-4 animate-spin" \/> Generando…<\/>/);
  assert.match(block, /: <><Link2 className="h-4 w-4" \/> Generar enlace<\/>/);
  // Team.tsx ya no pinta el selector de días propio: la única fuente son las chips.
  const team = source("src/pages/Team.tsx");
  assert.doesNotMatch(team, /ACCESS_INVITE_DAY_OPTIONS/);
  assert.doesNotMatch(team, /<select[^>]*value=\{accessLinkDays\}/);
  assert.match(team, /Al generar se pregunta el tiempo/);
});

test("el estado del enlace se lee una vez por apertura, nunca por sondeo", () => {
  const team = source("src/pages/Team.tsx");
  // Un solo llamador del servicio: el helper de recarga.
  assert.equal((team.match(/listDeviceAccessLinks\(/g) || []).length, 1);
  assert.doesNotMatch(team, /setInterval\([^)]*reloadAccessLinks/s);
  assert.match(team, /const shouldReadLinks = \(employeeId: string\)/);
});

test("el rótulo visible llega del servidor y se compara con la versión instalada", () => {
  const team = source("src/pages/Team.tsx");
  assert.match(team, /import \{ PRODUCT_VERSION \} from "\.\.\/lib\/productVersion"/);
  assert.equal((team.match(/Este dispositivo tiene PALMYRA \{PRODUCT_VERSION\}\./g) || []).length, 2);
  assert.doesNotMatch(team, /El enlace solo se guarda en esta sesión/);
  assert.doesNotMatch(team, /Reutiliza uno de la lista si sigue vivo/);
  assert.match(team, /accessInvite\.expiryNote \|\| resolveAccessInviteExpiry\(accessInvite\.days\)\.label/);
  assert.match(team, /En el servidor: \$\{accessLinkNote\(editing\.id\)\}/);
});
