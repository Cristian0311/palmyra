/**
 * Regresiones del orden de provisión de un equipo (edge function device-access).
 *
 * Bug reportado: «No se pudo activar el equipo / No se pudo guardar el perfil del
 * trabajador» al escribir la contraseña POS. Causa real, comprobada con SELECTs de
 * solo lectura contra la base viva el 2026-11-28: la función escribía `profiles`
 * ANTES que `company_memberships`, y `private.enforce_profile_company()` rechaza un
 * `active_company_id` sin membresía activa (`invalid_active_company`). El canje
 * nunca funcionó en producción: 15 invitaciones creadas, 0 consumidas.
 *
 * Aquí se fija el orden que exigen los triggers, que el alta del empleado no escriba
 * `active` (dispara `private.enforce_plan_limit()` con free = 1 trabajador), que un
 * paso roto se deshaga y que la causa del motor llegue al usuario sin filtrar SQL.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { provisionDeviceAccess, safeDetail } from "../../supabase/functions/device-access/provision.ts";

type Call = { table: string; method: string; payload: any; filters: any[] };

/**
 * sustituto del cliente de Supabase: registra cada operación al resolverse, porque
 * `delete().eq().eq()` es una cadena perezosa y lo que importa es el orden real de
 * escritura y el payload que salió.
 */
function stubDb(fail: (call: Call) => unknown | null = () => null) {
  const calls: Call[] = [];
  const run = (table: string, method: string, payload: any, filters: any[]) => {
    const call = { table, method, payload, filters };
    calls.push(call);
    const error = fail(call);
    return Promise.resolve(error ? { error, data: null } : { error: null, data: [] });
  };
  const chain = (table: string, filters: any[], op: { method: string; payload: any } | null): any => ({
    upsert: (payload: any, options?: { onConflict?: string }) =>
      chain(table, filters, { method: "upsert", payload: { ...payload, onConflict: options?.onConflict } }),
    insert: (payload: any) => chain(table, filters, { method: "insert", payload }),
    update: (payload: any) => chain(table, filters, { method: "update", payload }),
    delete: () => chain(table, filters, { method: "delete", payload: null }),
    select: () => chain(table, filters, { method: "select", payload: null }),
    eq: (key: string, value: unknown) => chain(table, [...filters, { key, value }], op),
    in: (key: string, value: unknown) => chain(table, [...filters, { key, value }], op),
    maybeSingle: () => run(table, op?.method || "select", op?.payload, filters).then((result) => ({ error: result.error, data: null })),
    then: (onFulfilled?: any, onRejected?: any) =>
      run(table, op?.method || "select", op?.payload, filters).then(onFulfilled, onRejected)
  });
  return { calls, from: (table: string) => chain(table, [], null) };
}

const BASE_INPUT = {
  userId: "u-new",
  companyId: "c-1",
  employeeId: "e-1",
  email: "pos-e-1@device.palmyra.app",
  fullName: "Verónica",
  roleId: "r-1",
  warehouseIds: ["w-1", "w-2"]
};

const order = (calls: Call[]) => calls.map((call) => `${call.table}.${call.method}`);
const first = (calls: Call[], table: string, method: string) =>
  calls.findIndex((call) => call.table === table && call.method === method);

test("la membresía se escribe antes que perfiles, roles, almacenes y empleados", async () => {
  const db = stubDb();
  const outcome = await provisionDeviceAccess({ admin: db, ...BASE_INPUT, log: () => {} });

  assert.deepEqual(outcome, { ok: true });
  const membership = first(db.calls, "company_memberships", "upsert");
  assert.ok(membership >= 0, "debe existir la membresía");
  assert.ok(membership < first(db.calls, "profiles", "upsert"), "profiles después de la membresía");
  assert.ok(membership < first(db.calls, "user_roles", "insert"), "user_roles después de la membresía");
  assert.ok(membership < first(db.calls, "employees", "update"), "employees después de la membresía");
  assert.equal(
    db.calls[membership].payload.onConflict,
    "company_id,user_id",
    "el upsert necesita el conflicto compuesto, no solo company_id"
  );
});

test("el enlace de empleados no escribe `active`: reactivar dispara el límite de trabajadores del plan", async () => {
  const db = stubDb();
  await provisionDeviceAccess({ admin: db, ...BASE_INPUT, log: () => {} });

  const employee = db.calls.find((call) => call.table === "employees")!;
  assert.equal(employee.method, "update");
  assert.ok(!("active" in employee.payload), `payload sin active, llegó ${JSON.stringify(employee.payload)}`);
  assert.deepEqual(
    { user_id: employee.payload.user_id, login_email: employee.payload.login_email, role_id: employee.payload.role_id },
    { user_id: "u-new", login_email: BASE_INPUT.email, role_id: "r-1" }
  );
  assert.deepEqual(
    employee.filters.map((filter: any) => `${filter.key}=${filter.value}`),
    ["id=e-1", "company_id=c-1"],
    "el vínculo debe quedar acotado a la empresa del enlace"
  );
});

test("las sucursales se asignan todas y la primera queda como predeterminada", async () => {
  const db = stubDb();
  await provisionDeviceAccess({ admin: db, ...BASE_INPUT, log: () => {} });

  const insert = db.calls.find((call) => call.table === "user_locations" && call.method === "insert")!;
  assert.equal(insert.payload.length, 2);
  assert.deepEqual(insert.payload.map((row: any) => row.warehouse_id), ["w-1", "w-2"]);
  assert.deepEqual(insert.payload.map((row: any) => row.is_default), [true, false]);
});

test("un fallo en las sucursales devuelve la causa del motor y deshace el rol asignado", async () => {
  const db = stubDb((call) =>
    call.table === "user_locations" && call.method === "insert"
      ? { code: "23514", message: 'warehouse_company_mismatch: la sucursal es de otra empresa' }
      : null
  );
  const logged: string[] = [];

  const outcome = await provisionDeviceAccess({ admin: db, ...BASE_INPUT, log: (message) => logged.push(message) });

  assert.deepEqual(outcome, {
    ok: false,
    error: "location_write_failed",
    detail: "warehouse_company_mismatch"
  });
  const roleDeletes = db.calls.filter((call) => call.table === "user_roles" && call.method === "delete");
  assert.equal(roleDeletes.length, 2, "la limpieza inicial más la compensación");
  assert.ok(!db.calls.some((call) => call.table === "profiles"), "no se escribe el perfil de una cuenta a medias");
  assert.ok(logged.some((line) => line.includes("warehouse_company_mismatch")), "el mensaje completo va al log");
});

test("un fallo posterior deshace en orden inverso las escrituras propias del canje", async () => {
  let writtenUntilFailure = 0;
  const db = stubDb((call) => {
    if (call.table !== "employees") return null;
    writtenUntilFailure = db.calls.length;
    return { message: "cross_company_reference: employee/user duplicado" };
  });

  const outcome = await provisionDeviceAccess({ admin: db, ...BASE_INPUT, log: () => {} });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.error, "employee_write_failed");
  assert.equal(outcome.detail, "cross_company_reference");
  // Undo inverso: sucursales primero, roles después.
  const tail = db.calls.slice(writtenUntilFailure).map((call) => `${call.table}.${call.method}`);
  assert.deepEqual(tail, ["user_locations.delete", "user_roles.delete"]);
  assert.ok(!db.calls.some((call) => call.table === "company_memberships" && call.method === "delete"),
    "la membresía no se deshace: la creó el propietario, no este canje");
});

test("un mensaje que no es código de negocio no sale hacia el cliente", async () => {
  assert.equal(safeDetail({ message: 'invalid_active_company' }), "invalid_active_company");
  assert.equal(safeDetail({ message: 'raise: new row for relation "profiles" violates foreign key "profiles_company_id_fkey"' }), null);
  assert.equal(safeDetail({ message: "" }), null);
  assert.equal(safeDetail(null), null);
});

test("la compensación averiada no convierte el fallo en excepción", async () => {
  let locations = 0;
  const db: any = stubDb((call) => {
    if (call.table === "user_locations" && call.method === "insert") {
      locations += 1;
      return { message: "warehouse_company_mismatch" };
    }
    if (call.table === "user_roles" && call.method === "delete" && locations > 0) {
      return { message: "no se pudo conectar" };
    }
    return null;
  });

  const outcome = await provisionDeviceAccess({ admin: db, ...BASE_INPUT, log: () => {} });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error, "location_write_failed");
});

test("index.ts ya no filtra almacenes por active y delega la provisión con causa", () => {
  const source = readFileSync("supabase/functions/device-access/index.ts", "utf8");
  assert.ok(!/\.eq\(\s*"active"/.test(source), "warehouses.active dejó de ser un concepto (20261126120000)");
  assert.match(source, /from "\.\/provision\.ts"/);
  assert.match(source, /provisionDeviceAccess\(\{/);
  assert.match(source, /detail: provision\.detail/);
});
