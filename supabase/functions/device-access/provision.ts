/**
 * device-access: orden de provisión del equipo, separado de `index.ts` para poder
 * probarlo sin el cliente de Supabase.
 *
 * El orden no es opcional: las reglas de la base lo exigen.
 * - `company_memberships` va primero. `private.enforce_profile_company()` rechaza un
 *   `profiles.active_company_id` sin membresía activa (`invalid_active_company`) y
 *   `validate_user_role_assignment()` rechaza el rol sin ella (`membership_not_active`).
 *   Ese era el fallo: el perfil se escribía antes que la membresía y el canje moría en
 *   el primer paso («No se pudo guardar el perfil del trabajador»).
 * - El alta de `employees` va al final y no toca la columna `active`: `UPDATE OF active`
 *   dispara `private.enforce_plan_limit()` y un canje no crea trabajadores, solo liga el
 *   que ya existe (la relectura previa garantizó `active = true`).
 * - Si un paso posterior falla se deshacen las escrituras de alcance de este redeem, para
 *   no dejar una cuenta con almacenes sin rol. El enlace no se consume: se puede reintentar.
 */

export type ProvisionInput = {
  admin: any;
  userId: string;
  companyId: string;
  employeeId: string;
  email: string;
  fullName: string;
  roleId: string;
  warehouseIds: string[];
  log?: (message: string) => void;
};

export type ProvisionOutcome =
  | { ok: true }
  | { ok: false; error: string; detail: string | null };

/** Códigos de negocio que se pueden mostrar: nunca SQL ni datos de otras empresas. */
const SAFE_DETAILS = [
  "invalid_active_company",
  "membership_not_active",
  "role_not_found",
  "role_company_mismatch",
  "warehouse_company_mismatch",
  "cross_company_reference",
  "plan_employees_limit",
  "plan_warehouses_limit",
  "company_id_immutable",
  "company_required",
  "company_not_found"
];

export function safeDetail(error: unknown): string | null {
  const message = String((error as any)?.message || "");
  if (!message) return null;
  return SAFE_DETAILS.find((code) => message.includes(code)) || null;
}

export async function provisionDeviceAccess(input: ProvisionInput): Promise<ProvisionOutcome> {
  const { admin, userId, companyId, employeeId, email, fullName, roleId, warehouseIds } = input;
  const log = input.log || ((message: string) => console.error(message));
  const undo: Array<() => Promise<unknown>> = [];

  const failure = async (stage: string, error: unknown): Promise<ProvisionOutcome> => {
    const detail = safeDetail(error);
    // El mensaje completo del motor solo va al registro de la función: es lo que
    // faltaba para poder diagnosticar un canje roto desde el panel de Supabase.
    log(`${stage}: ${String((error as any)?.code || "")} ${String((error as any)?.message || "unknown")}`.trim());
    for (const revert of undo.reverse()) {
      // `Promise.resolve` es obligatorio: la cadena de PostgREST es `thenable` pero
      // no tiene `.catch`, así que `revert().catch(...)` lanzaría aquí mismo.
      const undone = await Promise.resolve(revert()).catch((revertError: unknown) => revertError);
      if (undone && (undone as any).error) log(`compensacion parcial: ${String((undone as any).error.message || "")}`);
    }
    return { ok: false, error: stage, detail };
  };

  const membership = await admin
    .from("company_memberships")
    .upsert(
      { company_id: companyId, user_id: userId, status: "active", is_owner: false },
      { onConflict: "company_id,user_id" }
    );
  if (membership?.error) return failure("membership_write_failed", membership.error);

  const roles = await admin.from("user_roles").delete().eq("company_id", companyId).eq("user_id", userId);
  if (roles?.error) return failure("role_write_failed", roles.error);
  const roleInsert = await admin
    .from("user_roles")
    .insert({ user_id: userId, company_id: companyId, role_id: roleId });
  if (roleInsert?.error) return failure("role_write_failed", roleInsert.error);
  undo.push(() => admin.from("user_roles").delete().eq("company_id", companyId).eq("user_id", userId));

  const locations = await admin
    .from("user_locations")
    .delete()
    .eq("company_id", companyId)
    .eq("user_id", userId);
  if (locations?.error) return failure("location_write_failed", locations.error);
  const locationInsert = await admin.from("user_locations").insert(
    warehouseIds.map((warehouseId, index) => ({
      user_id: userId,
      company_id: companyId,
      warehouse_id: warehouseId,
      is_default: index === 0
    }))
  );
  if (locationInsert?.error) return failure("location_write_failed", locationInsert.error);
  undo.push(() => admin.from("user_locations").delete().eq("company_id", companyId).eq("user_id", userId));

  const profile = await admin
    .from("profiles")
    .upsert({ id: userId, full_name: fullName, active_company_id: companyId }, { onConflict: "id" });
  if (profile?.error) return failure("profile_write_failed", profile.error);

  const employee = await admin
    .from("employees")
    .update({ user_id: userId, login_email: email, role_id: roleId, updated_at: new Date().toISOString() })
    .eq("id", employeeId)
    .eq("company_id", companyId);
  if (employee?.error) return failure("employee_write_failed", employee.error);

  return { ok: true };
}
