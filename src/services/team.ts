import { getSupabase } from "../lib/supabase";
import { loadSaaSContext } from "./saas";

export interface TeamRole {
  id: string;
  key: string;
  name: string;
  description?: string | null;
  is_system: boolean;
  company_id?: string | null;
}

export interface TeamWarehouse {
  id: string;
  name: string;
  active: boolean;
}

export interface TeamEmployee {
  id: string;
  user_id?: string | null;
  employee_code: string;
  full_name: string;
  login_email?: string | null;
  base_salary: number;
  active: boolean;
  role_id: string;
  role_name: string;
  role_key: string;
  warehouse_ids: string[];
  default_warehouse_id?: string | null;
  pending_invitation?: {
    id: string;
    email: string;
    status: string;
    expires_at: string;
    created_at: string;
  } | null;
}

export interface TeamSnapshot {
  companyId: string;
  employees: TeamEmployee[];
  roles: TeamRole[];
  warehouses: TeamWarehouse[];
}

async function requireCompanyId() {
  const ctx = await loadSaaSContext();
  if (!ctx?.companyId) throw new Error("No hay una empresa activa.");
  return ctx.companyId;
}

function throwRpcError(error: any): never {
  const message = String(error?.message || "No se pudo completar la operación.");
  const known: Record<string, string> = {
    authentication_required: "Debes iniciar sesión.",
    permission_denied: "No tienes permisos para gestionar el equipo.",
    invalid_email: "El correo del trabajador no es válido.",
    invalid_role: "El rol seleccionado no es válido.",
    role_management_required: "Ese rol requiere permiso para administrar roles.",
    warehouse_required: "Selecciona al menos un almacén.",
    invalid_warehouse: "Uno de los almacenes seleccionados no está disponible.",
    plan_employee_limit: "Has alcanzado el límite de empleados de tu plan.",
    employee_code_taken: "Ese código de empleado ya existe en la empresa.",
    invitation_invalid_or_expired: "La invitación no existe o ya expiró.",
    invitation_email_mismatch: "Debes entrar con el correo al que se envió la invitación.",
    already_company_member: "Esta cuenta ya pertenece a esta empresa.",
    employee_already_linked: "Ese empleado ya tiene otra cuenta vinculada.",
    employee_not_found: "El empleado no existe."
  };
  const match = Object.entries(known).find(([key]) => message.includes(key));
  throw new Error(match ? match[1] : message);
}

export async function loadTeamSnapshot(): Promise<TeamSnapshot> {
  const supabase = getSupabase();
  if (!supabase) throw new Error("Supabase no está configurado.");
  const companyId = await requireCompanyId();

  const [
    { data: employees, error: employeesError },
    { data: roles, error: rolesError },
    { data: warehouses, error: warehousesError },
    { data: accessRows, error: accessError },
    { data: invitations, error: invitationsError }
  ] = await Promise.all([
    supabase
      .from("employees")
      .select("id,user_id,employee_code,full_name,login_email,base_salary,active,role_id,roles!inner(name,key)")
      .eq("company_id", companyId)
      .order("active", { ascending: false })
      .order("full_name", { ascending: true }),
    supabase
      .from("roles")
      .select("id,key,name,description,is_system,company_id")
      .or(`company_id.is.null,company_id.eq.${companyId}`)
      .order("is_system", { ascending: false })
      .order("name", { ascending: true }),
    supabase
      .from("warehouses")
      .select("id,name,active")
      .eq("company_id", companyId)
      .order("name", { ascending: true }),
    supabase
      .from("employee_warehouse_access")
      .select("employee_id,warehouse_id,is_default")
      .eq("company_id", companyId),
    supabase
      .from("company_invitations")
      .select("id,employee_id,email,status,expires_at,created_at")
      .eq("company_id", companyId)
      .eq("status", "pending")
      .order("created_at", { ascending: false })
  ]);

  const error = employeesError || rolesError || warehousesError || accessError || invitationsError;
  if (error) throw error;

  const accessMap = new Map<string, { ids: string[]; defaultId?: string | null }>();
  for (const row of accessRows || []) {
    const current = accessMap.get(row.employee_id) || { ids: [] };
    current.ids.push(row.warehouse_id);
    if (row.is_default) current.defaultId = row.warehouse_id;
    accessMap.set(row.employee_id, current);
  }

  const invitationMap = new Map<string, TeamEmployee["pending_invitation"]>();
  for (const invitation of invitations || []) {
    if (!invitation.employee_id || invitationMap.has(invitation.employee_id)) continue;
    invitationMap.set(invitation.employee_id, invitation);
  }

  return {
    companyId,
    employees: (employees || []).map((employee: any) => {
      const access = accessMap.get(employee.id) || { ids: [] };
      return {
        id: employee.id,
        user_id: employee.user_id,
        employee_code: employee.employee_code,
        full_name: employee.full_name,
        login_email: employee.login_email,
        base_salary: Number(employee.base_salary) || 0,
        active: employee.active !== false,
        role_id: employee.role_id,
        role_name: employee.roles?.name || "Empleado",
        role_key: employee.roles?.key || "employee",
        warehouse_ids: access.ids,
        default_warehouse_id: access.defaultId || access.ids[0] || null,
        pending_invitation: invitationMap.get(employee.id) || null
      };
    }),
    roles: (roles || []) as TeamRole[],
    warehouses: (warehouses || []) as TeamWarehouse[]
  };
}

export async function createEmployee(input: {
  companyId: string;
  employeeCode: string;
  fullName: string;
  baseSalary: number;
  roleId: string;
  warehouseIds: string[];
}) {
  const supabase = getSupabase();
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { data, error } = await supabase.rpc("create_employee_secure", {
    p_company_id: input.companyId,
    p_employee_code: input.employeeCode,
    p_full_name: input.fullName,
    p_base_salary: input.baseSalary,
    p_role_id: input.roleId,
    p_warehouse_ids: input.warehouseIds
  });
  if (error) throwRpcError(error);
  return data as { id: string };
}

export async function updateEmployee(input: {
  companyId: string;
  employeeId: string;
  employeeCode: string;
  fullName: string;
  baseSalary: number;
  roleId: string;
  warehouseIds: string[];
}) {
  const supabase = getSupabase();
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { data, error } = await supabase.rpc("create_employee_secure", {
    p_company_id: input.companyId,
    p_employee_id: input.employeeId,
    p_employee_code: input.employeeCode,
    p_full_name: input.fullName,
    p_base_salary: input.baseSalary,
    p_role_id: input.roleId,
    p_warehouse_ids: input.warehouseIds
  });
  if (error) throwRpcError(error);
  return data as { id: string };
}

export async function createEmployeeWithInvitation(input: {
  companyId: string;
  employeeCode: string;
  fullName: string;
  baseSalary: number;
  roleId: string;
  warehouseIds: string[];
  email: string;
}) {
  const supabase = getSupabase();
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { data, error } = await supabase.rpc("create_employee_with_invitation", {
    p_company_id: input.companyId,
    p_employee_code: input.employeeCode,
    p_full_name: input.fullName,
    p_base_salary: input.baseSalary,
    p_role_id: input.roleId,
    p_warehouse_ids: input.warehouseIds,
    p_email: input.email.trim().toLowerCase()
  });
  if (error) throwRpcError(error);
  return data as {
    employee_id: string;
    invitation_id: string;
    token: string;
    expires_at: string;
    email: string;
  };
}

export async function resendEmployeeInvitation(input: {
  companyId: string;
  employeeId: string;
  email: string;
  roleId: string;
  warehouseIds: string[];
}) {
  const supabase = getSupabase();
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { data, error } = await supabase.rpc("create_company_invitation", {
    p_company_id: input.companyId,
    p_employee_id: input.employeeId,
    p_email: input.email.trim().toLowerCase(),
    p_role_id: input.roleId,
    p_warehouse_ids: input.warehouseIds
  });
  if (error) throwRpcError(error);
  return data as { id: string; token: string; expires_at: string };
}

export async function revokeEmployeeInvitation(invitationId: string) {
  const supabase = getSupabase();
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { error } = await supabase.rpc("revoke_company_invitation", {
    p_invitation_id: invitationId
  });
  if (error) throwRpcError(error);
}

export async function setEmployeeStatus(employeeId: string, active: boolean) {
  const supabase = getSupabase();
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { error } = await supabase.rpc("set_company_employee_status", {
    p_employee_id: employeeId,
    p_active: active
  });
  if (error) throwRpcError(error);
}

export async function acceptEmployeeInvitation(token: string) {
  const supabase = getSupabase();
  if (!supabase) throw new Error("Supabase no está configurado.");
  const { data, error } = await supabase.rpc("accept_company_invitation", {
    p_token: token
  });
  if (error) throwRpcError(error);
  return data as { company_id: string; employee_id?: string | null };
}
