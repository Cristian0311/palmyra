import React, { useEffect, useMemo, useState } from "react";
import { BriefcaseBusiness, Check, ChevronLeft, ChevronRight, Clock, Copy, Edit3, Eye, EyeOff, Hash, Info, Link2, LockKeyhole, MoreHorizontal, Plus, RefreshCw, ShieldCheck, UserRound, Users, UserX, WalletCards, Warehouse, Wifi, WifiOff, X, Shield, Save } from "lucide-react";
import { useStore } from "../store/useStore";
import { loadSaaSContext } from "../services/saas";
import { canUsePlanFeature, getPlanDisplayName } from "../services/planAccess";
import EmployeeAvatar from "../components/team/EmployeeAvatar";
import TeamConfirmDialog from "../components/team/TeamConfirmDialog";
import { buildDeviceAccessLink, createDeviceAccessInvite } from "../services/deviceAccess";
import {
  createEmployeePosSecure,
  loadTeamSnapshot,
  revokeEmployeeInvitation,
  setEmployeeStatus,
  deleteCompanyEmployee,
  updateEmployeePosSecure,
  loadCompensationSettings,
  saveCompensationSettings,
  type CompanyCompensationMode,
  type CompanyCompensationSettings,
  upsertCompanyRole,
  type TeamEmployee,
  type TeamRole,
  type TeamSnapshot
} from "../services/team";
import { cn, generateId } from "../lib/utils";
import { enqueueOfflineItem } from "../services/offlineQueue";
import "./team.css";
import OperationsSurface from '../components/OperationsSurface';

const TEAM_CACHE_PREFIX = "palmyra-team-cache-v1:";
const TEAM_COMP_CACHE_PREFIX = "palmyra-team-compensation-cache-v1:";
function teamCacheKey(companyId: string) { return TEAM_CACHE_PREFIX + companyId; }
function teamCompensationCacheKey(companyId: string) { return TEAM_COMP_CACHE_PREFIX + companyId; }
function readTeamCompensationCache(companyId?: string | null): CompanyCompensationSettings | null {
  if (!companyId || typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(teamCompensationCacheKey(companyId));
    return raw ? JSON.parse(raw) as CompanyCompensationSettings : null;
  } catch { return null; }
}
function writeTeamCompensationCache(companyId: string, settings: CompanyCompensationSettings) {
  if (typeof localStorage === "undefined") return;
  try { localStorage.setItem(teamCompensationCacheKey(companyId), JSON.stringify(settings)); } catch {}
}
function readTeamCache(companyId?: string | null): TeamSnapshot | null {
  if (!companyId || typeof localStorage === "undefined") return null;
  try { const raw = localStorage.getItem(teamCacheKey(companyId)); return raw ? JSON.parse(raw) as TeamSnapshot : null; } catch { return null; }
}
function writeTeamCache(snapshot: TeamSnapshot | null) {
  if (!snapshot || typeof localStorage === "undefined") return;
  try { localStorage.setItem(teamCacheKey(snapshot.companyId), JSON.stringify(snapshot)); } catch {}
}

/**
 * Errores del guardado de roles traducidos al español para mostrarlos en la UI.
 * La RPC upsert_company_role devuelve códigos cortos que ya llegan traducidos
 * por el servicio; aquí afinamos los que dependen del contexto del rol.
 */
function describeRoleError(raw: unknown) {
  const message = String((raw as { message?: string } | null)?.message || "").trim();
  const text = message.toLowerCase();
  if (!text) return "No se pudo guardar el rol. Inténtalo de nuevo.";
  if (text.includes("inicia sesión") || text.includes("authentication_required")) {
    return "Tu sesión expiró. Vuelve a iniciar sesión para guardar el rol.";
  }
  if (text.includes("permisos para gestionar el equipo") || text.includes("permission_denied")) {
    return "No tienes permiso para administrar roles en esta empresa.";
  }
  if (text.includes("plan_feature") || text.includes("roles personalizados")) {
    return "La gestión de roles no está incluida en tu plan. Mejora el plan para guardar cambios.";
  }
  if (text.includes("rol del sistema") || text.includes("role_not_found_or_system")) {
    return "La nube todavía no permite editar este rol del sistema. Se habilitará al aplicar la actualización de roles; mientras tanto el nombre, la descripción y los permisos quedan guardados en este dispositivo.";
  }
  if (text.includes("reservada") || text.includes("reserved_role_key")) {
    return "La clave «employee» está reservada y no se puede cambiar; edita el nombre, la descripción y los permisos.";
  }
  if (text.includes("no puedes otorgar permisos")) {
    return "No puedes otorgar permisos que tu propia cuenta no tiene. Quita esos permisos o pide acceso primero.";
  }
  if (text.includes("ya existe") || text.includes("role_name_taken") || text.includes("role_already_exists")) {
    return "Ya existe otro rol con ese nombre en la empresa. Usa un nombre distinto.";
  }
  if (text.includes("no es válido") || text.includes("no es valido")) {
    return "Revisa el nombre y los permisos: hay un dato que no es válido.";
  }
  return message;
}

function copyText(value: string) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value);
  const area = document.createElement("textarea");
  area.value = value;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  document.execCommand("copy");
  document.body.removeChild(area);
  return Promise.resolve();
}

export default function Team() {
  const currentUser = useStore(state => state.currentUser);
  const addNotification = useStore(state => state.addNotification);
  const cashSessions = useStore(state => state.cashSessions);
  const activeShiftNames = useMemo(() => {
    const map = new Set<string>();
    for (const session of cashSessions || []) {
      if (session.status !== 'open' || session.deletedAt) continue;
      if (session.userId) map.add(`id:${session.userId}`);
      if (session.workerName) map.add(`name:${String(session.workerName).trim().toLowerCase()}`);
    }
    return map;
  }, [cashSessions]);
  const employeeInShift = (employee: TeamEmployee) =>
    activeShiftNames.has(`id:${employee.user_id || employee.id}`) ||
    activeShiftNames.has(`name:${employee.full_name.trim().toLowerCase()}`);
  const [snapshot, setSnapshot] = useState<TeamSnapshot | null>(null);
  const [context, setContext] = useState<Awaited<ReturnType<typeof loadSaaSContext>>>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [formStep, setFormStep] = useState<1 | 2 | 3>(1);
  const [editing, setEditing] = useState<TeamEmployee | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<TeamEmployee | null>(null);
  const [accessInvite, setAccessInvite] = useState<{ employeeId: string; employeeName: string; link: string } | null>(null);
  const [accessInviteBusy, setAccessInviteBusy] = useState(false);
  const [accessInviteError, setAccessInviteError] = useState("");
  const [showRoleForm, setShowRoleForm] = useState(false);
  const [editingRole, setEditingRole] = useState<TeamRole | null>(null);
  const [roleForm, setRoleForm] = useState({
    key: "",
    name: "",
    description: "",
    permissionKeys: [] as string[]
  });
  const [roleFormStep, setRoleFormStep] = useState<1 | 2>(1);
  const [compensationSettings, setCompensationSettings] = useState<CompanyCompensationSettings>({ mode: 'fixed_product', percentRate: 0, fixedAmount: 0, workerCount: 1, active: true });
  const [savingCompensation, setSavingCompensation] = useState(false);
  const [showPosPassword, setShowPosPassword] = useState(false);
  // Pestañas del modal de edición: Datos (ficha + rol/almacenes) y Acceso
  // (contraseña POS + enlace de un solo uso del trabajador).
  const [formTab, setFormTab] = useState<'datos' | 'acceso'>('datos');
  const [formAccessLink, setFormAccessLink] = useState('');
  const [formAccessBusy, setFormAccessBusy] = useState(false);
  const [formAccessError, setFormAccessError] = useState('');
  // Caducidad del enlace de acceso: días (1-90) o 0 = sin caducidad.
  const [accessLinkDays, setAccessLinkDays] = useState(7);
  // Feedback inmediato del botón «Copiar»: el aviso global queda arriba y en
  // móvil puede pasar desapercibido.
  const [copiedLink, setCopiedLink] = useState(false);
  const [activeSection, setActiveSection] = useState<'employees' | 'roles' | 'compensation'>('employees');
  const [employeeSearch, setEmployeeSearch] = useState('');
  const [employeeStatus, setEmployeeStatusFilter] = useState('all');
  const [employeeRole, setEmployeeRole] = useState('all');
  const filteredEmployees = useMemo(() => (snapshot?.employees || []).filter(employee => {
    const term = employeeSearch.trim().toLocaleLowerCase('es');
    return `${employee.full_name} ${employee.employee_code}`.toLocaleLowerCase('es').includes(term)
      && (employeeRole === 'all' || employee.role_id === employeeRole)
      && (employeeStatus === 'all'
        || (employeeStatus === 'pending' ? Boolean(employee.pending_invitation)
          : employeeStatus === 'shift' ? employee.active && employeeInShift(employee)
            : employeeStatus === 'active' ? employee.active && !employee.pending_invitation
              : !employee.active));
  }), [snapshot?.employees, employeeSearch, employeeRole, employeeStatus, activeShiftNames]);

  const canManageRoles = currentUser?.permissions?.includes("roles.manage") || currentUser?.role === "admin";
  const planCode = context?.subscription?.planCode || null;
  const canUseCustomRoles = canUsePlanFeature(planCode, "custom_roles");
  const customRolesPlanName = getPlanDisplayName(planCode ? (canUseCustomRoles ? planCode : "starter") : "starter");
  const canManageEmployees = currentUser?.permissions?.includes("employees.manage") || currentUser?.role === "admin";
  // El rol «Empleado» lo crea el sistema, pero el administrador debe poder
  // ajustar su nombre, descripción y permisos. El rol admin y la propiedad de
  // la empresa siguen protegidos y nunca se abren en el editor.
  const isEmployeeSystemRole = (role: TeamRole | null | undefined) => Boolean(role?.is_system && role.key === 'employee');
  const canEditRole = (role: TeamRole) => isEmployeeSystemRole(role) || (role.is_system ? false : canUseCustomRoles);

  const [form, setForm] = useState({
    fullName: "",
    employeeCode: "",
    baseSalary: "0",
    roleId: "",
    warehouseIds: [] as string[],
    posPassword: "",
  });

  // La contraseña POS es obligatoria al dar de alta y al convertir un acceso
  // heredado; en un trabajador que ya opera con POS solo es opcional (cambiarla).
  const posPasswordRequired = !editing || Boolean(editing.user_id || editing.pending_invitation);

  const refresh = async () => {
    if (!canManageEmployees) { setLoading(false); return; }
    setLoading(true);
    setError("");
    const offline = typeof navigator !== "undefined" && !navigator.onLine;
    let knownContext = context;
    if (offline && !knownContext) {
      try {
        knownContext = await loadSaaSContext();
        if (knownContext) setContext(knownContext);
      } catch {}
    }
    const companyId = snapshot?.companyId || knownContext?.companyId || context?.companyId;
    const cached = readTeamCache(companyId);
    if (offline && cached) {
      setSnapshot(cached);
      const cachedCompensation = readTeamCompensationCache(cached.companyId);
      if (cachedCompensation) setCompensationSettings(cachedCompensation);
      setLoading(false);
      return;
    }
    try {
      const [nextContext, nextSnapshot] = await Promise.all([loadSaaSContext(), loadTeamSnapshot()]);
      if (!nextSnapshot) throw new Error("No se recibió el estado del equipo.");
      setContext(nextContext);
      setSnapshot(nextSnapshot);
      writeTeamCache(nextSnapshot);
      try {
        const loadedCompensation = await loadCompensationSettings(nextSnapshot.companyId);
        setCompensationSettings(loadedCompensation);
        writeTeamCompensationCache(nextSnapshot.companyId, loadedCompensation);
      } catch (e) {
        const cachedCompensation = readTeamCompensationCache(nextSnapshot.companyId);
        if (cachedCompensation) setCompensationSettings(cachedCompensation);
        console.warn("[PALMYRA] No se pudo cargar compensación global", e);
      }
      if (!form.roleId) {
        const employeeRole = (nextSnapshot.roles || []).find(role => role.key === "employee") || (nextSnapshot.roles || []).find(role => role.key !== "admin");
        if (employeeRole) setForm(prev => ({ ...prev, roleId: employeeRole.id }));
      }
      if (!form.warehouseIds.length && nextSnapshot.warehouses[0]) {
        setForm(prev => ({ ...prev, warehouseIds: [nextSnapshot.warehouses[0].id] }));
      }
    } catch (e: any) {
      const fallback = readTeamCache(snapshot?.companyId || context?.companyId);
      if (fallback) {
        setSnapshot(fallback);
        const cachedCompensation = readTeamCompensationCache(fallback.companyId);
        if (cachedCompensation) setCompensationSettings(cachedCompensation);
        setError(typeof navigator !== "undefined" && !navigator.onLine ? "Mostrando el último estado guardado. Los cambios nuevos se sincronizarán al recuperar conexión." : "No se pudo actualizar desde la nube; se conserva el último estado local.");
      } else setError(e?.message || "No se pudo cargar el equipo.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void refresh(); }, []);

  // La nube puede no responder nunca (red que no falla ni resuelve). Sin este
  // límite la lista quedaría en «Cargando equipo…» de forma indefinida.
  useEffect(() => {
    if (!loading) return;
    const timer = window.setTimeout(() => {
      setLoading(false);
      setError(prev => prev || "La nube está tardando en responder. Puedes seguir viendo el equipo; los cambios se sincronizarán cuando vuelva la conexión.");
    }, 15000);
    return () => window.clearTimeout(timer);
  }, [loading]);

  useEffect(() => {
    const onQueueChange = () => {
      if (typeof navigator !== "undefined" && navigator.onLine) void refresh();
      else { const cached = readTeamCache(snapshot?.companyId || context?.companyId); if (cached) setSnapshot(cached); }
    };
    window.addEventListener("online", onQueueChange);
    window.addEventListener("offline_queue_updated", onQueueChange as EventListener);
    return () => {
      window.removeEventListener("online", onQueueChange);
      window.removeEventListener("offline_queue_updated", onQueueChange as EventListener);
    };
  }, [snapshot?.companyId, context?.companyId]);

  // Escape cierra los diálogos flotantes de Equipo (el confirm de borrado tiene su propio manejo).
  useEffect(() => {
    if (!showForm && !showRoleForm && !accessInvite) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (showForm) setShowForm(false);
      else if (showRoleForm) setShowRoleForm(false);
      else if (accessInvite) setAccessInvite(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [showForm, showRoleForm, accessInvite]);

  const employeeLimit = Number((context?.subscription?.limits as any)?.employees || 0);
  // Una invitación sin aceptar no es un trabajador operativo, pero sí reserva
  // su plaza en el plan hasta que se cancele o caduque.
  const activeEmployees = snapshot?.employees.filter(employee => employee.active && !employee.pending_invitation).length || 0;
  const pendingInvites = snapshot?.employees.filter(employee => employee.pending_invitation).length || 0;
  const remainingSlots = employeeLimit > 0 ? Math.max(0, employeeLimit - (activeEmployees + pendingInvites)) : null;
  const usedSlots = activeEmployees + pendingInvites;
  const capacityPct = employeeLimit > 0 ? Math.min(100, Math.round((usedSlots / employeeLimit) * 100)) : 0;
  const resolvedPlanName = getPlanDisplayName(planCode);
  const planLabel = planCode && resolvedPlanName !== 'tu plan actual' ? resolvedPlanName : null;
  const employeesInShift = (snapshot?.employees || []).filter(employee => employee.active && employeeInShift(employee)).length;
  const online = typeof navigator === "undefined" ? true : navigator.onLine;
  // Al editar se usan dos pestañas (Datos / Acceso); al crear se mantiene el
  // asistente de tres pasos que ya guía el alta.
  const infoSectionVisible = editing ? formTab === 'datos' : formStep === 1;
  const operationSectionVisible = editing ? formTab === 'datos' : formStep === 2;
  const accessSectionVisible = editing ? formTab === 'acceso' : formStep === 3;

  const availableRoles = useMemo(
    () => (snapshot?.roles || []).filter(role => role.key !== "admin" && (role.is_system || canManageRoles)),
    [snapshot?.roles, canManageRoles]
  );

  const permissionGroups = useMemo(() => {
    const labels: Record<string, string> = {
      pos: 'Punto de venta', cash: 'Caja y turnos', sales: 'Ventas', inventory: 'Inventario',
      warehouse: 'Almacenes', transfers: 'Traslados', purchases: 'Compras', suppliers: 'Proveedores',
      customers: 'Clientes', quotes: 'Cotizaciones', reports: 'Reportes', banking: 'Bancos',
      employees: 'Equipo', roles: 'Roles', settings: 'Configuración', audit: 'Auditoría', company: 'Empresa'
    };
    const groups = new Map<string, NonNullable<typeof snapshot>['permissions']>();
    for (const permission of snapshot?.permissions || []) {
      const prefix = permission.key.includes('.') ? permission.key.split('.')[0] : 'otros';
      const list = groups.get(prefix) || [];
      list.push(permission);
      groups.set(prefix, list);
    }
    return Array.from(groups.entries())
      .map(([prefix, permissions]) => ({
        prefix,
        label: labels[prefix] || prefix.charAt(0).toUpperCase() + prefix.slice(1),
        permissions
      }))
      .sort((a, b) => a.label.localeCompare(b.label, 'es'));
  }, [snapshot?.permissions]);

  const resetForm = () => {
    setEditing(null);
    setShowPosPassword(false);
    setFormTab('datos');
    setFormAccessLink('');
    setFormAccessError('');
    setFormAccessBusy(false);
    setCopiedLink(false);
    setForm({
      fullName: "",
      employeeCode: "",
      baseSalary: "0",
      roleId: availableRoles.find(role => role.key === "employee")?.id || availableRoles[0]?.id || "",
      warehouseIds: snapshot?.warehouses[0] ? [snapshot.warehouses[0].id] : [],
      posPassword: "",
    });
  };

  const openRoleCreate = () => {
    if (!canUseCustomRoles) {
      setError(`Los roles personalizados están disponibles desde el plan ${customRolesPlanName}.`);
      return;
    }
    setEditingRole(null);
    setRoleForm({ key: "", name: "", description: "", permissionKeys: [] });
    setRoleFormStep(1);
    setError("");
    setMessage("");
    setShowRoleForm(true);
  };

  const openRoleEdit = (role: TeamRole) => {
    if (!canEditRole(role)) {
      if (!role.is_system) setError(`Los roles personalizados están disponibles desde el plan ${customRolesPlanName}.`);
      return;
    }
    setEditingRole(role);
    setRoleForm({
      key: role.key,
      name: role.name,
      description: role.description || "",
      permissionKeys: [...(role.permission_keys || [])]
    });
    setRoleFormStep(1);
    setError("");
    setMessage("");
    setShowRoleForm(true);
  };

  const toggleRolePermission = (key: string) => {
    setRoleForm(prev => ({
      ...prev,
      permissionKeys: prev.permissionKeys.includes(key)
        ? prev.permissionKeys.filter(item => item !== key)
        : [...prev.permissionKeys, key]
    }));
  };

  const submitRole = async (e: React.FormEvent) => {
    e.preventDefault();
    if (roleFormStep === 1) {
      if (roleForm.name.trim().length < 2) return setError("Escribe el nombre del rol.");
      if (roleForm.key.trim().length < 2) return setError("Escribe una clave para el rol.");
      setError("");
      setRoleFormStep(2);
      return;
    }
    if (!snapshot?.companyId) return;
    if (!canManageRoles) return setError("No tienes permiso para administrar roles.");
    if (!(editingRole && isEmployeeSystemRole(editingRole)) && !canUseCustomRoles) {
      return setError(`Los roles personalizados están disponibles desde el plan ${customRolesPlanName}.`);
    }
    if (editingRole && !canEditRole(editingRole)) return setError("Ese rol del sistema está protegido y no se puede modificar.");
    if (roleForm.name.trim().length < 2) return setError("Escribe el nombre del rol.");
    if (roleForm.key.trim().length < 2) return setError("Escribe una clave para el rol.");
    const offline = typeof navigator !== "undefined" && !navigator.onLine;
    if (offline) {
      try {
        const roleId = editingRole?.id || generateId();
        const role: TeamRole = {
          id: roleId,
          key: roleForm.key.trim().toLowerCase(),
          name: roleForm.name.trim(),
          description: roleForm.description.trim(),
          is_system: editingRole?.is_system ?? false,
          company_id: editingRole?.company_id ?? snapshot.companyId,
          permission_keys: [...roleForm.permissionKeys]
        };
        await enqueueOfflineItem("team_role_upsert", {
          companyId: snapshot.companyId,
          roleId,
          key: role.key,
          name: role.name,
          description: role.description || "",
          permissionKeys: [...roleForm.permissionKeys]
        }, "team-role:" + roleId);
        const nextSnapshot: TeamSnapshot = {
          ...snapshot,
          roles: editingRole
            ? snapshot.roles.map(item => item.id === roleId ? role : item)
            : [role, ...snapshot.roles]
        };
        setSnapshot(nextSnapshot);
        writeTeamCache(nextSnapshot);
        setShowRoleForm(false);
        addNotification(editingRole ? "Cambios del rol guardados offline; se sincronizarán al volver Internet." : "Rol guardado offline; se sincronizará al volver Internet.", "success");
      } catch (e: any) {
        setError(e?.message || "No se pudo guardar el rol offline.");
      }
      return;
    }
    setBusy(true);
    setError("");
    try {
      await upsertCompanyRole({
        companyId: snapshot.companyId,
        roleId: editingRole?.id,
        key: roleForm.key.trim().toLowerCase(),
        name: roleForm.name.trim(),
        description: roleForm.description.trim(),
        permissionKeys: roleForm.permissionKeys
      });
      await refresh();
      setShowRoleForm(false);
      addNotification(editingRole ? "Rol actualizado." : "Rol creado.", "success");
    } catch (e: any) {
      const detail = describeRoleError(e);
      setError(detail);
      addNotification(detail, "error");
    } finally {
      setBusy(false);
    }
  };

  const openCreate = () => {
    resetForm();
    setMessage("");
    setError("");
    setFormStep(1);
    setShowForm(true);
  };

  const openEdit = (employee: TeamEmployee) => {
    setEditing(employee);
    setShowPosPassword(false);
    setFormTab('datos');
    setFormAccessLink('');
    setFormAccessError('');
    setFormAccessBusy(false);
    setCopiedLink(false);
    setMessage("");
    setError("");
    setForm({
      fullName: employee.full_name,
      employeeCode: employee.employee_code,
      baseSalary: String(employee.base_salary),
      roleId: employee.role_id,
      warehouseIds: [...employee.warehouse_ids],
      posPassword: "",
    });
    setFormStep(1);
    setShowForm(true);
    setMenuId(null);
  };

  const toggleWarehouse = (warehouseId: string) => {
    setForm(prev => ({
      ...prev,
      warehouseIds: prev.warehouseIds.includes(warehouseId)
        ? prev.warehouseIds.filter(id => id !== warehouseId)
        : [...prev.warehouseIds, warehouseId]
    }));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    // Evita crear dos empleados o dos operaciones en cola con dobles toques.
    if (busy) return;
    setError("");
    setMessage("");

    if (!snapshot?.companyId) return;
    if (form.fullName.trim().length < 2) return setError("Escribe el nombre completo.");
    if (!form.employeeCode.trim()) return setError("Escribe un código de empleado.");
    if (!form.roleId) return setError("Selecciona un rol.");
    if (!form.warehouseIds.length) return setError("Selecciona al menos un almacén.");
    if (posPasswordRequired && form.posPassword.trim().length < 6) {
      // Si falta la contraseña estando en «Datos», llevamos al trabajador a la
      // pestaña «Acceso» para que vea el campo que debe completar.
      if (editing) setFormTab('acceso');
      return setError("Define una contraseña POS de al menos 6 caracteres.");
    }
    if (!posPasswordRequired && form.posPassword.trim().length > 0 && form.posPassword.trim().length < 6) {
      return setError("La nueva contraseña del POS debe tener al menos 6 caracteres.");
    }

    const offline = typeof navigator !== "undefined" && !navigator.onLine;
    if (!editing && offline) {
      setBusy(true);
      try {
        const localId = generateId("EMP-OFF");
        const role = snapshot.roles.find(role => role.id === form.roleId);
        const localEmployee: TeamEmployee = {
          id: localId, user_id: null, employee_code: form.employeeCode.trim(), full_name: form.fullName.trim(),
          login_email: null, base_salary: Number(form.baseSalary) || 0,
          compensation_type: compensationSettings.mode === "sales_percent" ? "sales_percentage" : "fixed_product", sales_percentage: compensationSettings.mode === "sales_percent" ? Number(compensationSettings.percentRate) || 0 : 0, active: true, role_id: form.roleId,
          role_name: role?.name || "Empleado", role_key: role?.key || "employee", warehouse_ids: [...form.warehouseIds],
          default_warehouse_id: form.warehouseIds[0] || null,
          pending_invitation: null
        };
        // Primero la cola durable: si IndexedDB rechaza la operación, no debe
        // quedar un empleado fantasma visible ni un rechazo sin mensaje.
        await enqueueOfflineItem("employee_create", {
          localEmployeeId: localId, companyId: snapshot.companyId, employeeCode: form.employeeCode.trim(), fullName: form.fullName.trim(),
          baseSalary: Number(form.baseSalary) || 0, roleId: form.roleId, warehouseIds: [...form.warehouseIds],
          email: "", sendInvite: false, posPassword: form.posPassword.trim()
        }, "employee-create:" + localId);
        const nextSnapshot: TeamSnapshot = { ...snapshot, employees: [localEmployee, ...snapshot.employees] };
        setSnapshot(nextSnapshot); writeTeamCache(nextSnapshot);
        setMessage("Trabajador guardado en este dispositivo. Se creará en la nube automáticamente al recuperar Internet.");
        setShowForm(false); setFormStep(1);
        addNotification("Trabajador guardado offline y puesto en cola para sincronización.", "success");
      } catch (offlineCreateError: any) {
        setError(offlineCreateError?.message || "No se pudo guardar el trabajador en este dispositivo.");
      } finally {
        setBusy(false);
      }
      return;
    }

    // Edición offline: actualizar la vista local y dejar el cambio durable en
    // cola. Al volver Internet, el handler aplica los cambios y la contraseña
    // POS mediante las RPC protegidas.
    if (editing && offline) {
      try {
        const role = snapshot.roles.find(item => item.id === form.roleId);
        const nextEmployee: TeamEmployee = {
          ...editing,
          employee_code: form.employeeCode.trim(),
          full_name: form.fullName.trim(),
          base_salary: Number(form.baseSalary) || 0,
          role_id: form.roleId,
          role_name: role?.name || editing.role_name || "Empleado",
          role_key: role?.key || editing.role_key || "employee",
          warehouse_ids: [...form.warehouseIds],
          default_warehouse_id: form.warehouseIds[0] || null
        };
        await enqueueOfflineItem("employee_update", {
          companyId: snapshot.companyId,
          employeeId: editing.id,
          employeeUserId: editing.user_id || null,
          employeeCode: form.employeeCode.trim(),
          fullName: form.fullName.trim(),
          baseSalary: Number(form.baseSalary) || 0,
          roleId: form.roleId,
          warehouseIds: [...form.warehouseIds],
          sendInvite: false,
          email: "",
          posPassword: form.posPassword.trim() || undefined
        }, "employee-update:" + editing.id + ":" + generateId("OFF"));
        const nextSnapshot: TeamSnapshot = {
          ...snapshot,
          employees: snapshot.employees.map(item => item.id === editing.id ? nextEmployee : item)
        };
        setSnapshot(nextSnapshot);
        writeTeamCache(nextSnapshot);
        setMessage("Cambios guardados en este dispositivo. Se sincronizarán cuando vuelva Internet.");
        setShowForm(false);
        setFormStep(1);
        addNotification("Cambios del trabajador guardados offline y puestos en cola para sincronización.", "success");
      } catch (e: any) {
        setError(e?.message || "No se pudieron guardar los cambios offline.");
      }
      return;
    }

    setBusy(true);
    try {
      if (editing) {
        await updateEmployeePosSecure({
          companyId: snapshot.companyId,
          employeeId: editing.id,
          employeeCode: form.employeeCode,
          fullName: form.fullName,
          baseSalary: Number(form.baseSalary) || 0,
          roleId: form.roleId,
          warehouseIds: form.warehouseIds,
          posPassword: form.posPassword.trim() || undefined
        });
        setMessage("Empleado actualizado.");
      } else {
        await createEmployeePosSecure({
          companyId: snapshot.companyId,
          employeeCode: form.employeeCode,
          fullName: form.fullName,
          baseSalary: Number(form.baseSalary) || 0,
          roleId: form.roleId,
          warehouseIds: form.warehouseIds,
          posPassword: form.posPassword.trim()
        });
        setMessage("Empleado creado con contraseña para el POS. Genera su enlace de acceso cuando lo necesite.");
      }
      await refresh();
      setShowForm(false);
      setFormStep(1);
      resetForm();
      addNotification("Cambios de equipo guardados.", "success");
    } catch (e: any) {
      setError(e?.message || "No se pudo guardar el empleado.");
    } finally {
      setBusy(false);
    }
  };

  const changeStatus = async (employee: TeamEmployee) => {
    setMenuId(null);
    const offline = typeof navigator !== "undefined" && !navigator.onLine;
    if (offline) {
      try {
        const active = !employee.active;
        const nextSnapshot = {
          ...snapshot!,
          employees: snapshot!.employees.map(item => item.id === employee.id ? { ...item, active } : item)
        };
        await enqueueOfflineItem("employee_status", { employeeId: employee.id, active }, "employee-status:" + employee.id + ":" + active + ":" + generateId("OFF"));
        setSnapshot(nextSnapshot);
        writeTeamCache(nextSnapshot);
        addNotification(active ? "Empleado reactivado offline; se sincronizará al volver Internet." : "Empleado desactivado offline; se revocará el acceso al sincronizar.", "success");
      } catch (e: any) {
        addNotification(e?.message || "No se pudo guardar el cambio offline.", "error");
      }
      return;
    }
    setBusy(true);
    try {
      await setEmployeeStatus(employee.id, !employee.active);
      await refresh();
      addNotification(employee.active ? "Empleado desactivado y acceso revocado." : "Empleado reactivado.", "success");
    } catch (e: any) {
      addNotification(e?.message || "No se pudo cambiar el estado del empleado.", "error");
    } finally {
      setBusy(false);
    }
  };

  const deleteEmployee = async (employee: TeamEmployee) => {
    setMenuId(null);
    setError("");
    const offline = typeof navigator !== "undefined" && !navigator.onLine;
    if (offline) {
      try {
        await enqueueOfflineItem("employee_delete", { employeeId: employee.id }, "employee-delete:" + employee.id);
        const nextSnapshot = {
          ...snapshot!,
          employees: snapshot!.employees.filter(item => item.id !== employee.id)
        };
        setSnapshot(nextSnapshot);
        writeTeamCache(nextSnapshot);
        addNotification("Eliminación guardada offline; se completará al volver Internet.", "success");
      } catch (e: any) {
        const message = e?.message || "No se pudo guardar la eliminación offline.";
        addNotification(message, "error");
        setError(message);
      }
      return;
    }
    setBusy(true);
    try {
      await deleteCompanyEmployee(employee.id);
      await refresh();
      addNotification(`Empleado ${employee.full_name} eliminado correctamente.`, "success");
    } catch (e: any) {
      const message = e?.message || "No se pudo eliminar el empleado.";
      addNotification(message, "error");
      setError(message);
    } finally {
      setBusy(false);
    }
  };

  const revokeInvite = async (employee: TeamEmployee) => {
    setMenuId(null);
    if (!employee.pending_invitation) return;
    const offline = typeof navigator !== "undefined" && !navigator.onLine;
    if (offline) {
      try {
        const invitationId = employee.pending_invitation.id;
        await enqueueOfflineItem("invitation_revoke", { companyId: snapshot!.companyId, employeeId: employee.id }, "invitation-revoke:" + employee.id + ":" + generateId("OFF"));
        const nextSnapshot = {
          ...snapshot!,
          employees: snapshot!.employees.map(item => item.id === employee.id ? { ...item, pending_invitation: null } : item)
        };
        setSnapshot(nextSnapshot);
        writeTeamCache(nextSnapshot);
        addNotification("Revocación guardada offline; se aplicará al volver Internet.", "success");
      } catch (e: any) {
        addNotification(e?.message || "No se pudo guardar la revocación offline.", "error");
      }
      return;
    }
    setBusy(true);
    try {
      await revokeEmployeeInvitation(employee.pending_invitation.id);
      await refresh();
      addNotification("Invitación revocada.", "success");
    } catch (e: any) {
      addNotification(e?.message || "No se pudo revocar la invitación.", "error");
    } finally {
      setBusy(false);
    }
  };

  // Enlace de acceso de un solo uso: el administrador lo genera y lo entrega
  // manualmente (WhatsApp, en mano). No se envía correo ni se crea cuenta web.
  const openAccessInvite = async (employee: TeamEmployee) => {
    setMenuId(null);
    setAccessInviteError("");
    setCopiedLink(false);
    setAccessInvite({ employeeId: employee.id, employeeName: employee.full_name, link: "" });
    setAccessInviteBusy(true);
    try {
      const invite = await createDeviceAccessInvite(employee.id);
      const link = invite.link || buildDeviceAccessLink(invite.token);
      if (!link) throw new Error("El servidor no devolvió un enlace válido.");
      setAccessInvite({ employeeId: employee.id, employeeName: employee.full_name, link });
    } catch (e: any) {
      const detail = String(e?.message || "");
      const offlineOrNetwork = !navigator.onLine || /fetch|network|conexi/i.test(detail);
      setAccessInviteError(offlineOrNetwork
        ? "No se pudo generar el enlace de acceso. Revisa tu conexión e inténtalo de nuevo."
        : detail || "No se pudo generar el enlace de acceso. Inténtalo de nuevo.");
      addNotification("No se pudo generar el enlace de acceso.", "error");
    } finally {
      setAccessInviteBusy(false);
    }
  };

  const copyAccessLink = async (link: string) => {
    try {
      await copyText(link);
      setCopiedLink(true);
      window.setTimeout(() => setCopiedLink(false), 2200);
      addNotification("Enlace de acceso copiado.", "success");
    } catch {
      addNotification("No se pudo copiar el enlace. Selecciónalo y cópialo manualmente.", "error");
    }
  };

  // Enlace dentro de la pestaña «Acceso» del modal: mismo servicio, pero el
  // resultado se muestra en línea (sin abrir otra ventana encima del formulario).
  const generateFormAccessLink = async (employee: TeamEmployee) => {
    setFormAccessError("");
    setCopiedLink(false);
    setFormAccessBusy(true);
    try {
      const invite = await createDeviceAccessInvite(employee.id, accessLinkDays);
      const link = invite.link || buildDeviceAccessLink(invite.token);
      if (!link) throw new Error("El servidor no devolvió un enlace válido.");
      setFormAccessLink(link);
      addNotification("Enlace de acceso generado. Cópialo y entrégalo al trabajador.", "success");
    } catch (e: any) {
      const detail = String(e?.message || "");
      const offlineOrNetwork = (typeof navigator !== "undefined" && !navigator.onLine) || /fetch|network|conexi/i.test(detail);
      setFormAccessError(offlineOrNetwork
        ? "No se pudo generar el enlace de acceso. Revisa tu conexión e inténtalo de nuevo."
        : detail || "No se pudo generar el enlace de acceso. Inténtalo de nuevo.");
    } finally {
      setFormAccessBusy(false);
    }
  };

  if (!canManageEmployees) {
    return (
      <div className="min-h-[50vh] flex items-center justify-center">
        <div className="max-w-md bg-secondary border border-base rounded-3xl p-8 text-center">
          <ShieldCheck className="w-10 h-10 text-rose-500 mx-auto mb-3" />
          <h2 className="font-black text-primary">Acceso restringido</h2>
          <p className="text-sm text-muted mt-2">No tienes permiso para gestionar el equipo de la empresa.</p>
        </div>
      </div>
    );
  }

  return (
    <OperationsSurface className="space-y-5 w-full min-w-0 max-w-[1600px] mx-auto pb-10" onClick={() => setMenuId(null)}>
      <header className="relative overflow-hidden rounded-3xl border border-base bg-secondary p-5 md:p-6">
        <div className="pointer-events-none absolute -right-20 -top-24 h-64 w-64 rounded-full bg-violet-500/10 blur-3xl" aria-hidden="true" />
        <div className="relative flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-start gap-4 min-w-0">
            <span className="hidden sm:flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-600 to-fuchsia-500 text-white shadow-lg shadow-violet-500/20">
              <Users className="h-6 w-6" />
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-[10px] font-black tracking-[0.18em] uppercase text-violet-600 dark:text-violet-300">Empresa{planLabel ? ` · Plan ${planLabel}` : ''}</p>
                <span className={cn('inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-black uppercase tracking-wider',
                  online ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-300'
                    : 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300')}>
                  {online ? <Wifi className="h-2 w-2" /> : <WifiOff className="h-2 w-2" />}
                  {online ? 'En línea' : 'Modo local'}
                </span>
              </div>
              <h1 data-palmi-content="team" className="mt-1 text-2xl font-black text-primary tracking-tight">Equipo y accesos</h1>
              <p className="mt-1 max-w-2xl text-xs leading-5 text-secondary">Cada trabajador entra con su nombre, código y contraseña POS; si necesita entrar desde otro equipo, genera su enlace de acceso de un solo uso.</p>
              {(snapshot?.employees || []).some(employee => employee.active) && (
                <div className="mt-3 flex items-center gap-2">
                  <div className="flex -space-x-2">
                    {(snapshot?.employees || []).filter(employee => employee.active).slice(0, 5).map(employee => (
                      <EmployeeAvatar key={employee.id} name={employee.full_name} seed={employee.user_id || employee.id} size="sm" active={employee.active} inShift={employeeInShift(employee)} className="ring-2 ring-[var(--bg-secondary)]" />
                    ))}
                  </div>
                  <span className="text-[10px] font-bold text-muted">
                    {activeEmployees} activo{activeEmployees === 1 ? '' : 's'}{employeesInShift > 0 ? ` · ${employeesInShift} en turno` : ''}
                  </span>
                </div>
              )}
            </div>
          </div>
          <button onClick={openCreate} disabled={loading || busy || remainingSlots === 0}
            title={remainingSlots === 0 ? "Alcanzaste las plazas de tu plan" : undefined}
            className="w-full lg:w-auto h-11 px-5 rounded-xl bg-violet-600 text-white font-black text-xs uppercase tracking-wider flex items-center justify-center gap-2 shadow-lg shadow-violet-600/20 disabled:opacity-50 shrink-0">
            <Plus className="w-4 h-4" /> Agregar trabajador
          </button>
        </div>

        {employeeLimit > 0 && (
          <div className="relative mt-5 rounded-2xl border border-base bg-subtle px-4 py-3">
            <div className="flex items-center justify-between gap-3 text-[10px] font-black uppercase tracking-wider">
              <span className="text-secondary">Plazas del plan</span>
              <span className={cn('tabular-nums', usedSlots >= employeeLimit ? 'text-[var(--danger)]' : 'text-primary')}>{usedSlots} / {employeeLimit}</span>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-[var(--bg-primary)]">
              <div className={cn('h-full rounded-full transition-all', usedSlots >= employeeLimit ? 'bg-[var(--danger)]' : 'bg-violet-600')} style={{ width: `${capacityPct}%` }} />
            </div>
            <p className="mt-1.5 text-[10px] font-medium leading-4 text-muted">
              {usedSlots >= employeeLimit
                ? `Alcanzaste el límite de plazas${planLabel ? ` del plan ${planLabel}` : ''}. Desactiva o elimina un trabajador, o mejora el plan para agregar más.`
                : `${remainingSlots} plaza${remainingSlots === 1 ? '' : 's'} disponible${remainingSlots === 1 ? '' : 's'}${pendingInvites > 0 ? ` · ${pendingInvites} reservada${pendingInvites === 1 ? '' : 's'} por invitación` : ''}.`}
            </p>
          </div>
        )}
      </header>

      <nav aria-label="Secciones de equipo" className="grid grid-cols-3 gap-2 rounded-2xl border border-base bg-secondary p-1.5">
        {([
          ['employees', 'Empleados', `${snapshot?.employees.length || 0}`, UserRound],
          ['roles', 'Roles', `${snapshot?.roles.length || 0}`, Shield],
          ['compensation', 'Pago', '', WalletCards],
        ] as [typeof activeSection, string, string, typeof UserRound][]).map(([id, label, detail, Icon]) => (
          <button
            key={id}
            type="button"
            aria-pressed={activeSection === id}
            disabled={id === 'roles' && !canManageRoles}
            onClick={() => setActiveSection(id)}
            className={cn(
              'flex min-h-11 min-w-0 items-center justify-center gap-2 rounded-xl px-2 py-2 transition-colors',
              activeSection === id ? 'bg-violet-600 text-white shadow-sm' : 'text-secondary hover:bg-subtle',
              id === 'roles' && !canManageRoles && 'opacity-50 cursor-not-allowed'
            )}
          >
            <Icon className="h-4 w-4 shrink-0" />
            <span className="truncate text-[11px] font-black uppercase tracking-wider">{label}</span>
            {detail && <span className={cn('hidden sm:inline rounded-full px-1.5 py-px text-[9px] font-black tabular-nums', activeSection === id ? 'bg-white/20 text-white' : 'bg-subtle text-muted')}>{detail}</span>}
          </button>
        ))}
      </nav>

      <section className="grid grid-cols-3 gap-2.5">
        <div className="rounded-2xl border border-base bg-secondary p-4">
          <p className="text-[9px] font-black uppercase tracking-wider text-muted">Empleados activos</p>
          <p className="mt-1 text-xl font-black tabular-nums text-primary">{activeEmployees}{employeeLimit ? <span className="text-xs text-muted font-bold"> / {employeeLimit}</span> : ""}</p>
        </div>
        <div className="rounded-2xl border border-base bg-secondary p-4">
          <p className="flex items-center gap-1 text-[9px] font-black uppercase tracking-wider text-muted"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />En turno</p>
          <p className="mt-1 text-xl font-black tabular-nums text-primary">{employeesInShift}</p>
        </div>
        <div className="rounded-2xl border border-base bg-secondary p-4">
          <p className="text-[9px] font-black uppercase tracking-wider text-muted">Invitaciones</p>
          <p className="mt-1 text-xl font-black tabular-nums text-primary">{pendingInvites}</p>
        </div>
      </section>

      {activeSection === 'roles' && canManageRoles && (
        <section className="bg-secondary border border-base rounded-3xl p-4 md:p-5">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <Shield className="w-5 h-5 text-rose-500" />
                <h2 className="text-sm font-black text-primary">Roles y permisos</h2>
              </div>
              <p className="text-[10px] text-muted mt-1">Crea perfiles de trabajo y decide qué módulos puede usar cada uno.</p>
            </div>
            <button onClick={openRoleCreate} disabled={!canUseCustomRoles} className="w-full sm:w-auto h-10 px-4 rounded-xl bg-violet-600 text-white font-black text-[10px] uppercase tracking-wider flex items-center justify-center gap-2 disabled:opacity-60">
              <Plus className="w-4 h-4" /> {canUseCustomRoles ? "Crear rol" : `Disponible desde ${customRolesPlanName}`}
            </button>
          </div>
          <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-2 mt-4">
            {(snapshot?.roles || []).map(role => (
              <button
                key={role.id}
                type="button"
                onClick={() => openRoleEdit(role)}
                disabled={!canEditRole(role)}
                title={canEditRole(role) ? `Editar ${role.name}` : role.is_system ? "Rol protegido del sistema" : `Disponible desde el plan ${customRolesPlanName}`}
                className={cn(
                  "text-left p-3 rounded-2xl border transition",
                  canEditRole(role)
                    ? "border-base bg-primary hover:border-violet-300 dark:hover:border-violet-800 cursor-pointer"
                    : role.is_system ? "border-base bg-subtle cursor-default opacity-80" : "border-base bg-subtle cursor-not-allowed opacity-70"
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-black text-primary">{role.name}</span>
                  <span className="text-[8px] uppercase tracking-wider font-black text-muted">{role.is_system ? (isEmployeeSystemRole(role) ? "Sistema · editable" : "Sistema") : "Personalizado"}</span>
                </div>
                <p className="text-[9px] text-muted mt-1 line-clamp-2">{role.description || "Sin descripción"}</p>
                <div className="flex flex-wrap gap-1 mt-1.5">
                  {(role.permission_keys || []).slice(0, 3).map(key => (
                    <span key={key} className="text-[8px] rounded-full bg-subtle border border-base px-1.5 py-0.5 text-secondary">
                      {(snapshot?.permissions || []).find(permission => permission.key === key)?.name || key}
                    </span>
                  ))}
                  {(role.permission_keys || []).length > 3 && <span className="text-[8px] font-black text-violet-600 dark:text-violet-300 px-1 py-0.5">+{(role.permission_keys || []).length - 3}</span>}
                </div>
              </button>
            ))}
          </div>
        </section>
      )}

      {activeSection === 'compensation' && (
                    <section className="team-compensation-global bg-secondary border border-base rounded-3xl p-4 md:p-5 mt-4">
                <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <WalletCards className="w-5 h-5 text-rose-500 shrink-0" />
                      <h2 className="text-sm font-black text-primary">Configuración de pago del equipo</h2>
                    </div>
                    <p className="text-[10px] text-muted mt-1 leading-5">Define aquí la modalidad de pago para todos los trabajadores. Esta configuración es independiente del alta individual.</p>
                  </div>
                  <span className="text-[8px] font-black uppercase tracking-wider px-2 py-1 rounded-full bg-subtle border border-base text-muted shrink-0">
                    {activeEmployees} activo{activeEmployees === 1 ? "" : "s"}{pendingInvites > 0 ? ` · ${pendingInvites} invitación${pendingInvites === 1 ? "" : "es"} pendiente${pendingInvites === 1 ? "" : "s"}` : ""}
                  </span>
                </div>
                <div className="grid md:grid-cols-2 gap-2 mt-3">
                  {([
                    ['fixed_product','CUP fijo por producto','Usa la comisión CUP configurada en cada producto.'],
                    ['sales_percent','% sobre el total de venta','Usa el mismo porcentaje general para todos los empleados.']
                  ] as [CompanyCompensationMode,string,string][]).map(([mode,label,description]) => (
                    <button key={mode} type="button" disabled={savingCompensation}
                      onClick={() => setCompensationSettings(prev => ({ ...prev, mode }))}
                      className={cn("text-left p-3.5 rounded-2xl border transition-all", compensationSettings.mode === mode ? "bg-violet-50 dark:bg-violet-950/30 border-violet-300 shadow-sm" : "bg-primary border-base hover:border-violet-200")}>
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-[10px] font-black text-primary uppercase tracking-wider">{label}</p>
                        <span className={cn("w-4 h-4 rounded-full border flex items-center justify-center shrink-0", compensationSettings.mode === mode ? "bg-violet-600 border-violet-600 text-white" : "border-base text-transparent")}><Check className="w-2.5 h-2.5" /></span>
                      </div>
                      <p className="text-[9px] text-muted mt-1 leading-5">{description}</p>
                    </button>
                  ))}
                </div>
                {compensationSettings.mode === 'sales_percent' && (
                  <div className="mt-3 rounded-2xl bg-violet-50/70 dark:bg-violet-950/25 border border-violet-100 dark:border-violet-900/40 p-3">
                    <label className="team-field-wrap">
                      <span className="team-field-label">Porcentaje general sobre ventas <b>*</b></span>
                      <span className="team-field"><span className="team-field-icon"><WalletCards className="w-4 h-4" /></span>
                        <input type="number" min="0" max="100" step="0.01" inputMode="decimal" value={String(compensationSettings.percentRate)}
                          onChange={e => setCompensationSettings(prev => ({ ...prev, percentRate: Math.max(0, Math.min(100, Number(e.target.value) || 0)) }))}
                          disabled={savingCompensation} className="team-field-input" placeholder="Ej. 5" />
                        <span className="pr-3 font-black text-muted">%</span>
                      </span>
                    </label>
                  </div>
                )}
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mt-4 pt-3 border-t border-base">
                  <p className="text-[9px] text-muted leading-5">El cambio no modifica comisiones históricas; controla las nuevas ventas.</p>
                  <button type="button" disabled={savingCompensation || !snapshot?.companyId}
                    onClick={async () => {
                      if (!snapshot?.companyId) return;
                      setSavingCompensation(true); setError(""); setMessage("");
                      try {
                        const nextRate = compensationSettings.mode === 'sales_percent' ? Number(compensationSettings.percentRate) || 0 : 0;
                        const nextType = compensationSettings.mode === 'sales_percent' ? 'sales_percentage' : 'fixed_product';
                        const store = useStore.getState();
                        const offline = typeof navigator !== "undefined" && !navigator.onLine;
                        if (offline) {
                          const nextSettings = {
                            ...compensationSettings,
                            percentRate: nextRate,
                            fixedAmount: 0,
                            active: true
                          };
                          await enqueueOfflineItem("team_compensation_settings", {
                            companyId: snapshot.companyId,
                            mode: compensationSettings.mode,
                            percentRate: nextRate
                          }, "team-compensation:" + snapshot.companyId);
                          setCompensationSettings(nextSettings);
                          writeTeamCompensationCache(snapshot.companyId, nextSettings);
                          store.users.forEach(user => store.updateUser(user.id, {
                            compensationType: nextType,
                            salesPercentage: nextRate,
                            commissionRate: nextRate,
                            ...(nextType === 'sales_percentage' ? { baseSalary: 0 } : {})
                          }));
                          if (store.currentUser) {
                            store.updateUser(store.currentUser.id, {
                              compensationType: nextType,
                              salesPercentage: nextRate,
                              commissionRate: nextRate,
                              ...(nextType === 'sales_percentage' ? { baseSalary: 0 } : {})
                            });
                          }
                          addNotification("Configuración de pago guardada offline; se sincronizará al volver Internet.", "success");
                          return;
                        }
                        await saveCompensationSettings({ companyId: snapshot.companyId, mode: compensationSettings.mode, percentRate: nextRate });
                        // Sincronizar inmediatamente la modalidad global con el estado local del POS.
                        // Así Caja/POS/Reportes no siguen usando una configuración antigua persistida.
                        store.users.forEach(user => store.updateUser(user.id, {
                          compensationType: nextType,
                          salesPercentage: nextRate,
                          commissionRate: nextRate,
                          ...(nextType === 'sales_percentage' ? { baseSalary: 0 } : {})
                        }));
                        if (store.currentUser) {
                          store.updateUser(store.currentUser.id, {
                            compensationType: nextType,
                            salesPercentage: nextRate,
                            commissionRate: nextRate,
                            ...(nextType === 'sales_percentage' ? { baseSalary: 0 } : {})
                          });
                        }
                        writeTeamCompensationCache(snapshot.companyId, { ...compensationSettings, percentRate: nextRate, fixedAmount: 0, active: true });
                        await refresh();
                        addNotification(compensationSettings.mode === "sales_percent" ? "Compensación global guardada." : "Compensación CUP fijo por producto guardada.", "success");
                      } catch (e: any) {
                        setError(e?.message || "No se pudo guardar la configuración de compensación.");
                      } finally { setSavingCompensation(false); }
                    }}
                    className="w-full sm:w-auto h-10 px-4 rounded-xl bg-violet-600 text-white font-black text-[10px] uppercase tracking-wider flex items-center justify-center gap-2 disabled:opacity-50">
                    {savingCompensation ? <><RefreshCw className="w-4 h-4 animate-spin" /> Guardando…</> : <><Save className="w-4 h-4" /> Guardar configuración</>}
                  </button>
                </div>
              </section>
      )}

      {message && <div className="rounded-xl bg-slate-900 text-white text-xs font-bold p-3">{message}</div>}
      {error && <div className="rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-xs font-bold p-3">{error}</div>}

      {activeSection === 'employees' && (
      <section className="bg-secondary border border-base rounded-3xl overflow-visible">
        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_170px_170px] p-4 border-b border-base">
          <label className="min-w-0">
            <span className="text-[10px] font-black uppercase tracking-wider text-muted">Buscar</span>
            <input type="search" value={employeeSearch} onChange={e => setEmployeeSearch(e.target.value)} placeholder="Nombre o código" className="mt-1 w-full px-3 py-2.5 rounded-xl border border-base bg-primary text-primary text-xs font-bold outline-none focus:ring-1 focus:ring-violet-500" />
          </label>
          <label>
            <span className="text-[10px] font-black uppercase tracking-wider text-muted">Estado</span>
            <select value={employeeStatus} onChange={e => setEmployeeStatusFilter(e.target.value)} className="mt-1 w-full px-3 py-2.5 rounded-xl border border-base bg-primary text-primary text-xs font-bold outline-none focus:ring-1 focus:ring-violet-500">
              <option value="all">Todos</option>
              <option value="active">Activos</option>
              <option value="shift">En turno ahora</option>
              <option value="inactive">Inactivos</option>
              <option value="pending">Invitación pendiente</option>
            </select>
          </label>
          <label>
            <span className="text-[10px] font-black uppercase tracking-wider text-muted">Rol</span>
            <select value={employeeRole} onChange={e => setEmployeeRole(e.target.value)} className="mt-1 w-full px-3 py-2.5 rounded-xl border border-base bg-primary text-primary text-xs font-bold outline-none focus:ring-1 focus:ring-violet-500">
              <option value="all">Todos</option>
              {(snapshot?.roles || []).map(role => <option key={role.id} value={role.id}>{role.name}</option>)}
            </select>
          </label>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 pb-2 -mt-1">
          <p className="text-[10px] font-bold text-muted">
            {filteredEmployees.length} de {snapshot?.employees.length || 0} trabajador{(snapshot?.employees.length || 0) === 1 ? '' : 'es'}
            {employeesInShift > 0 && <span className="ml-2 inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-300"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />{employeesInShift} en turno</span>}
          </p>
          {(employeeSearch || employeeStatus !== 'all' || employeeRole !== 'all') && (
            <button type="button" onClick={() => { setEmployeeSearch(''); setEmployeeStatusFilter('all'); setEmployeeRole('all'); }} className="text-[10px] font-black uppercase tracking-wider text-violet-600 hover:text-violet-700 dark:text-violet-300">
              Limpiar filtros
            </button>
          )}
        </div>
        {loading && !snapshot ? (
          <div className="p-10 text-center text-sm text-muted">Cargando equipo...</div>
        ) : filteredEmployees.length ? (
          <div className="divide-y divide-slate-200/70 dark:divide-slate-700/60">
            {filteredEmployees.map(employee => {
              const warehouseNames = employee.warehouse_ids
                .map(id => ({ id, name: snapshot?.warehouses.find(w => w.id === id)?.name }))
                .filter((item): item is { id: string; name: string } => Boolean(item.name));
              const inShift = employeeInShift(employee);
              const inviteDaysLeft = employee.pending_invitation
                ? Math.ceil((Date.parse(employee.pending_invitation.expires_at) - Date.now()) / 86400000)
                : null;
              return (
                <div key={employee.id} className="team-employee-row">
                  <EmployeeAvatar
                    name={employee.full_name}
                    seed={employee.user_id || employee.id}
                    size="sm"
                    active={employee.active}
                    pending={Boolean(employee.pending_invitation)}
                    inShift={inShift}
                    className="team-list-avatar"
                  />
                  <div className="team-employee-main">
                    <strong className="team-employee-name" title={employee.full_name}>{employee.full_name}</strong>
                    <div className="team-employee-sub">
                      <span className="team-employee-code">{employee.employee_code}</span>
                      {inShift && <em className="not-italic inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 font-black uppercase tracking-wider text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />En turno</em>}
                      <span className="team-employee-warehouses" aria-label={warehouseNames.length ? `Almacenes: ${warehouseNames.map(item => item.name).join(', ')}` : 'Sin almacén asignado'}>
                        {warehouseNames.length ? warehouseNames.map(item => (
                          <span key={item.id} className="team-employee-warehouse">
                            <Warehouse className="h-3.5 w-3.5" aria-hidden="true" />
                            {item.name}
                          </span>
                        )) : (
                          <span className="team-employee-warehouse is-empty">
                            <Warehouse className="h-3.5 w-3.5" aria-hidden="true" />
                            Sin almacén
                          </span>
                        )}
                      </span>
                    </div>
                  </div>
                  <div className="team-employee-role">
                    <span>{employee.role_name}</span>
                    {!employee.active && <em>Inactivo</em>}
                    {employee.pending_invitation && employee.active && (
                      <em className="pending" title={`Expira ${employee.pending_invitation.expires_at ? new Date(employee.pending_invitation.expires_at).toLocaleDateString('es-CU') : 'pronto'}`}>
                        Invitación{inviteDaysLeft !== null && inviteDaysLeft >= 0 ? ` · ${inviteDaysLeft}d` : ''}
                      </em>
                    )}
                  </div>
                  <div className="team-employee-actions">
                    <button onClick={(e) => { e.stopPropagation(); setMenuId(menuId === employee.id ? null : employee.id); }}
                      aria-label={`Acciones de ${employee.full_name}`}
                      aria-expanded={menuId === employee.id}
                      title="Acciones del trabajador"
                      className="team-employee-menu-button">
                      <MoreHorizontal className="w-4 h-4" />
                    </button>
                    {menuId === employee.id && (
                      <div onClick={e => e.stopPropagation()} className="palmyra-popover absolute right-0 top-12 z-[var(--z-dropdown)] w-56 p-2">
                        <button onClick={() => openEdit(employee)} className="w-full px-3 py-2 text-left text-xs font-bold text-primary hover:bg-subtle rounded-xl flex items-center gap-2">
                          <Edit3 className="w-4 h-4" /> Editar empleado
                        </button>
                        {employee.active && (
                          <button onClick={() => void openAccessInvite(employee)} disabled={accessInviteBusy} className="w-full px-3 py-2 text-left text-xs font-bold text-primary hover:bg-subtle rounded-xl flex items-center gap-2 disabled:opacity-50">
                            <Link2 className="w-4 h-4" /> Enlace de acceso
                          </button>
                        )}
                        {employee.pending_invitation && (
                          <button onClick={() => void revokeInvite(employee)} className="w-full px-3 py-2 text-left text-xs font-bold text-amber-700 hover:bg-amber-50 rounded-xl flex items-center gap-2">
                            <X className="w-4 h-4" /> Revocar invitación
                          </button>
                        )}
                        <button onClick={() => changeStatus(employee)} className="w-full px-3 py-2 text-left text-xs font-bold hover:bg-subtle rounded-xl flex items-center gap-2">
                          <RefreshCw className="w-4 h-4" /> {employee.active ? "Desactivar acceso" : "Reactivar acceso"}
                        </button>
                        <button onClick={() => { setMenuId(null); setPendingDelete(employee); }} disabled={busy} className="w-full px-3 py-2 text-left text-xs font-bold text-[var(--danger)] hover:bg-[var(--danger)]/10 rounded-xl flex items-center gap-2">
                          <UserX className="w-4 h-4" /> Eliminar empleado
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="p-10 text-center">
            <UserRound className="w-10 h-10 text-slate-300 mx-auto mb-3" />
            {snapshot?.employees.length ? (
              <>
                <p className="text-sm font-black text-primary">Ningún trabajador coincide con los filtros.</p>
                <button type="button" onClick={() => { setEmployeeSearch(''); setEmployeeStatusFilter('all'); setEmployeeRole('all'); }} className="mt-3 h-10 px-4 rounded-xl border border-base text-xs font-black text-primary">Limpiar filtros</button>
              </>
            ) : (
              <>
                <p className="text-sm font-black text-primary">Todavía no hay trabajadores.</p>
                <p className="text-xs text-muted mt-1">Agrega el primero para probar el flujo de acceso en otro dispositivo.</p>
              </>
            )}
          </div>
        )}
      </section>
      )}

      {showForm && (
        <div className="palmyra-overlay z-[var(--z-modal)] p-3 sm:p-5 flex items-center justify-center" onClick={() => setShowForm(false)}>
          <form onSubmit={submit} onClick={e => e.stopPropagation()} className="team-emp-modal keyboard-modal-surface palmyra-modal-panel palmyra-mobile-modal w-full min-w-0">
            <div className="team-emp-head">
              <span className="team-emp-head-icon" aria-hidden="true"><UserRound className="h-4 w-4 sm:h-5 sm:w-5" /></span>
              <div className="min-w-0 flex-1">
                <p className="team-emp-kicker truncate">{editing ? "Equipo · Configuración" : "Equipo · Alta segura"}</p>
                <h2 className="truncate">{editing ? editing.full_name : "Trabajador y acceso"}</h2>
              </div>
              <button type="button" onClick={() => setShowForm(false)} className="team-emp-close" aria-label="Cerrar formulario"><X className="h-4 w-4" /></button>
            </div>
            {editing ? (
              <div className="team-emp-tabs" role="tablist" aria-label="Secciones del trabajador">
                <button
                  type="button"
                  role="tab"
                  id="team-tab-datos"
                  aria-selected={formTab === 'datos'}
                  aria-controls="team-panel-datos"
                  className={cn("team-emp-tab", formTab === 'datos' && "is-active")}
                  onClick={() => setFormTab('datos')}
                  disabled={busy}
                >
                  <UserRound className="h-3.5 w-3.5 shrink-0" /> Datos
                </button>
                <button
                  type="button"
                  role="tab"
                  id="team-tab-acceso"
                  aria-selected={formTab === 'acceso'}
                  aria-controls="team-panel-acceso"
                  className={cn("team-emp-tab", formTab === 'acceso' && "is-active")}
                  onClick={() => setFormTab('acceso')}
                  disabled={busy}
                >
                  <LockKeyhole className="h-3.5 w-3.5 shrink-0" /> Acceso
                </button>
              </div>
            ) : (
              <div className="team-emp-steps" aria-label="Pasos para crear trabajador">
                {([["Información", "Datos personales"], ["Operación", "Rol y almacenes"], ["Acceso", "Contraseña POS"]] as [string, string][]).map(([label, sub], index) => {
                  const n = (index + 1) as 1 | 2 | 3;
                  return (
                    <button key={n} type="button" aria-current={formStep === n ? "step" : undefined} className={cn("team-emp-step", formStep === n && "is-active", formStep > n && "is-done")} onClick={() => setFormStep(n)} disabled={busy}>
                      <span className="team-emp-step-dot">{formStep > n ? <Check className="h-3 w-3" /> : n}</span>
                      <span className="min-w-0"><strong>{label}</strong><small>{sub}</small></span>
                    </button>
                  );
                })}
              </div>
            )}
            <div className="team-emp-body keyboard-safe-scroll">
              {/* Los errores de validación deben verse dentro del modal: el
                  aviso de la página queda detrás del fondo fijo. */}
              {error && (
                <div role="alert" className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 p-2.5 text-[11px] font-bold leading-4 text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/30 dark:text-rose-300">
                  <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span className="min-w-0">{error}</span>
                </div>
              )}
              <section id="team-panel-datos" className={cn("team-emp-section", !infoSectionVisible && "hidden")} data-section="employee-info" aria-hidden={!infoSectionVisible}>
                <div className="mb-3 flex items-center gap-2.5 min-w-0">
                  <span className="team-emp-section-icon"><UserRound className="h-4 w-4" /></span>
                  <div className="min-w-0">
                    <h3 className="text-xs font-black text-primary leading-tight">Información del trabajador</h3>
                    <p className="mt-0.5 text-[11px] text-muted leading-4">Identifica a la persona que formará parte del equipo.</p>
                  </div>
                </div>
                <div className="grid gap-2.5 sm:grid-cols-2">
                  <label className="team-emp-field sm:col-span-2"><span className="team-emp-label">Nombre completo <b>*</b></span><span className="team-emp-control"><span className="team-emp-control-icon"><UserRound className="h-4 w-4" /></span><input value={form.fullName} onChange={e => setForm({...form, fullName:e.target.value})} disabled={busy} className="team-emp-input" placeholder="Ej. María González Pérez" autoComplete="name" /></span></label>
                  <label className="team-emp-field"><span className="team-emp-label">Código de empleado <b>*</b></span><span className="team-emp-control"><span className="team-emp-control-icon"><Hash className="h-4 w-4" /></span><input value={form.employeeCode} onChange={e => setForm({...form, employeeCode:e.target.value})} disabled={busy} className="team-emp-input" placeholder="Ej. EMP-001" autoComplete="off" /></span></label>
                  {compensationSettings.mode === 'fixed_product' ? (
                    <label className="team-emp-field"><span className="team-emp-label">Salario base</span><span className="team-emp-control"><span className="team-emp-control-icon"><WalletCards className="h-4 w-4" /></span><input type="number" min="0" step="0.01" inputMode="decimal" value={form.baseSalary} onChange={e => setForm({...form, baseSalary:e.target.value})} disabled={busy} className="team-emp-input" placeholder="0.00" /></span></label>
                  ) : (
                    <div className="team-emp-field">
                      <span className="team-emp-label">Modalidad de pago</span>
                      <span className="team-emp-control"><span className="team-emp-control-icon"><WalletCards className="h-4 w-4" /></span><span className="team-emp-input flex items-center truncate text-[var(--primary)]">Porcentaje sobre el total de la venta · {Number(compensationSettings.percentRate || 0)}%</span></span>
                    </div>
                  )}
                </div>
              </section>
              <section className={cn("team-emp-section", !operationSectionVisible && "hidden")} data-section="employee-operation" aria-hidden={!operationSectionVisible}>
                <div className="mb-3 flex items-center gap-2.5 min-w-0">
                  <span className="team-emp-section-icon"><ShieldCheck className="h-4 w-4" /></span>
                  <div className="min-w-0">
                    <h3 className="text-xs font-black text-primary leading-tight">Rol y almacenes</h3>
                    <p className="mt-0.5 text-[11px] text-muted leading-4">Define dónde trabaja y qué nivel de operación tendrá.</p>
                  </div>
                </div>
                <label className="team-emp-field"><span className="team-emp-label">Rol <b>*</b></span><span className="team-emp-control"><span className="team-emp-control-icon"><ShieldCheck className="h-4 w-4" /></span><select value={form.roleId} onChange={e => setForm({...form, roleId:e.target.value})} disabled={busy || availableRoles.length===0} className="team-emp-input team-emp-select">{availableRoles.map(role => <option key={role.id} value={role.id}>{role.name}</option>)}</select></span>{!canManageRoles && <span className="team-emp-help"><Info className="h-3.5 w-3.5 shrink-0" />Solo puedes asignar el rol operativo estándar.</span>}</label>
                <div className="mt-3">
                  <div className="mb-2 flex items-end justify-between gap-3 min-w-0">
                    <div className="min-w-0"><span className="team-emp-label block">Almacenes permitidos <b>*</b></span><span className="team-emp-help !mt-0.5">Uno o varios almacenes a los que podrá acceder.</span></div>
                    <span className="team-emp-count">{form.warehouseIds.length} seleccionado{form.warehouseIds.length === 1 ? "" : "s"}</span>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {(snapshot?.warehouses || []).filter(warehouse => warehouse.active).map(warehouse => {
                      const selected = form.warehouseIds.includes(warehouse.id);
                      return <label key={warehouse.id} className={cn("team-emp-warehouse", selected && "is-selected")}><input type="checkbox" checked={selected} onChange={() => toggleWarehouse(warehouse.id)} disabled={busy} className="sr-only" /><Warehouse className="h-4 w-4 shrink-0" /><span className="min-w-0 flex-1 truncate text-[11px] sm:text-xs font-bold text-primary">{warehouse.name}</span>{snapshot?.warehouses[0]?.id === warehouse.id && <span className="team-emp-warehouse-main">Principal</span>}<span className={cn("team-emp-check", selected && "is-selected")}>{selected && <Check className="h-3.5 w-3.5" />}</span></label>;
                    })}
                  </div>
                  {!(snapshot?.warehouses || []).some(warehouse => warehouse.active) && <div className="team-emp-note"><Warehouse className="h-4 w-4 shrink-0" />No hay almacenes activos disponibles. Crea uno en Configuración antes de asignar acceso.</div>}
                </div>
              </section>
              <section id="team-panel-acceso" className={cn("team-emp-section", !accessSectionVisible && "hidden")} data-section="employee-access" aria-hidden={!accessSectionVisible}>
                <div className="mb-3 flex items-center gap-2.5 min-w-0">
                  <span className="team-emp-section-icon"><LockKeyhole className="h-4 w-4" /></span>
                  <div className="min-w-0">
                    <h3 className="text-xs font-black text-primary leading-tight">Acceso al POS</h3>
                    <p className="mt-0.5 text-[11px] text-muted leading-4">El trabajador opera con su nombre, su código y esta contraseña.</p>
                  </div>
                </div>
                <div className="team-emp-access">
                  <label className="team-emp-field"><span className="team-emp-label">{editing ? "Nueva contraseña del POS" : "Contraseña del POS"} <b>{posPasswordRequired ? "*" : ""}</b></span><span className="team-emp-control"><span className="team-emp-control-icon"><LockKeyhole className="h-4 w-4" /></span><input type={showPosPassword ? "text" : "password"} value={form.posPassword} onChange={e => setForm({...form,posPassword:e.target.value})} disabled={busy} className="team-emp-input" placeholder={posPasswordRequired ? "Mínimo 6 caracteres" : "Vacío = conservar la contraseña actual"} autoComplete="new-password" /><button type="button" onClick={() => setShowPosPassword(value => !value)} disabled={busy} aria-label={showPosPassword ? "Ocultar contraseña" : "Mostrar contraseña"} className="mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted hover:text-primary" title={showPosPassword ? "Ocultar contraseña" : "Mostrar contraseña"}>{showPosPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button></span></label>
                  <p className="team-emp-note"><Info className="h-3.5 w-3.5 shrink-0" />{posPasswordRequired ? "Define una contraseña POS de al menos 6 caracteres; es obligatoria para operar. Puedes verla con el icono del ojo mientras escribes." : "La contraseña actual no se puede recuperar porque se guarda como hash seguro. Déjalo vacío para conservarla o escribe una nueva."}</p>
                </div>
                {editing && (
                  <div className="team-emp-access mt-2.5">
                    <div className="flex items-start gap-2.5 min-w-0">
                      <span className="team-emp-section-icon"><Link2 className="h-4 w-4" /></span>
                      <div className="min-w-0">
                        <p className="text-xs font-black text-primary">Enlace de acceso de un solo uso</p>
                        <p className="mt-0.5 text-[11px] text-muted leading-4">Cada trabajador tiene su propio enlace. Genéralo y entrégalo por WhatsApp o en mano; no se envía por correo.</p>
                      </div>
                    </div>
                    {formAccessLink && (
                      <label className="team-emp-field mt-3">
                        <span className="team-emp-label">Enlace de {editing.full_name}</span>
                        <span className="team-emp-control">
                          <span className="team-emp-control-icon"><Link2 className="h-4 w-4" /></span>
                          <input readOnly value={formAccessLink} onFocus={event => event.currentTarget.select()} className="team-emp-input" aria-label="Enlace de acceso generado" />
                        </span>
                      </label>
                    )}
                    <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
                      <label className="team-emp-field min-w-0 flex-1">
                        <span className="team-emp-label">Caducidad del enlace</span>
                        <span className="team-emp-control">
                          <span className="team-emp-control-icon"><Clock className="h-4 w-4" /></span>
                          <select
                            value={accessLinkDays}
                            onChange={e => setAccessLinkDays(Number(e.target.value))}
                            disabled={formAccessBusy || busy}
                            className="team-emp-input team-emp-select"
                            aria-label="Caducidad del enlace de acceso"
                          >
                            <option value={1}>Válido 1 día</option>
                            <option value={7}>Válido 7 días</option>
                            <option value={30}>Válido 30 días</option>
                            <option value={90}>Válido 90 días</option>
                            <option value={0}>Sin caducidad</option>
                          </select>
                        </span>
                      </label>
                      <div className="flex flex-col gap-2 min-w-0 sm:flex-row">
                        <button type="button" onClick={() => void generateFormAccessLink(editing)} disabled={formAccessBusy || busy} className="team-emp-btn team-emp-btn-primary">
                          {formAccessBusy
                            ? <><RefreshCw className="h-4 w-4 animate-spin" /> Generando…</>
                            : <><Link2 className="h-4 w-4" /> {formAccessLink ? "Generar otro enlace" : "Generar enlace"}</>}
                        </button>
                        {formAccessLink && (
                          <button type="button" onClick={() => void copyAccessLink(formAccessLink)} className="team-emp-btn team-emp-btn-secondary">
                            {copiedLink ? <><Check className="h-4 w-4" /> Copiado</> : <><Copy className="h-4 w-4" /> Copiar</>}
                          </button>
                        )}
                      </div>
                    </div>
                    <p className="team-emp-note team-emp-note-warn"><Clock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /> {accessLinkDays <= 0 ? "Sin caducidad" : `Válido ${accessLinkDays} ${accessLinkDays === 1 ? "día" : "días"}`} · un solo uso · personal e intransferible</p>
                    <span className="sr-only" aria-live="polite">{copiedLink ? "Enlace de acceso copiado." : ""}</span>
                    {formAccessError && <div className="team-emp-note"><Info className="h-3.5 w-3.5 shrink-0" />{formAccessError}</div>}
                  </div>
                )}
              </section>
            </div>
            <div className="team-emp-footer">
              {editing ? (
                <>
                  <button type="button" onClick={() => setShowForm(false)} className="team-emp-btn team-emp-btn-secondary">Cancelar</button>
                  <button type="submit" disabled={busy} className="team-emp-btn team-emp-btn-primary">{busy ? <><RefreshCw className="h-4 w-4 animate-spin" /> Guardando…</> : <><Save className="h-4 w-4" /> Guardar cambios</>}</button>
                </>
              ) : (
                <>
                  <button type="button" onClick={() => formStep === 1 ? setShowForm(false) : setFormStep((formStep-1) as 1|2|3)} className="team-emp-btn team-emp-btn-secondary">{formStep === 1 ? "Cancelar" : <><ChevronLeft className="h-4 w-4" /> Atrás</>}</button>
                  {formStep < 3 ? <button type="button" disabled={busy || (formStep===1 && (!form.fullName.trim() || !form.employeeCode.trim())) || (formStep===2 && (!form.roleId || !form.warehouseIds.length))} onClick={() => setFormStep((formStep+1) as 1|2|3)} className="team-emp-btn team-emp-btn-primary">Continuar <ChevronRight className="h-4 w-4" /></button> : <button type="submit" disabled={busy || (posPasswordRequired && form.posPassword.trim().length < 6)} className="team-emp-btn team-emp-btn-primary">{busy ? <><RefreshCw className="h-4 w-4 animate-spin" /> Guardando…</> : <><Check className="h-4 w-4" /> Crear trabajador</>}</button>}
                </>
              )}
            </div>
          </form>
        </div>
      )}
      {showRoleForm && (
        <div className="palmyra-overlay z-[var(--z-modal)] p-3 sm:p-5 flex items-center justify-center" onClick={() => setShowRoleForm(false)}>
          <form onSubmit={submitRole} onClick={e => e.stopPropagation()} className="team-role-flow palmyra-modal-panel palmyra-mobile-modal w-full max-w-xl overflow-hidden">
            <div className="team-role-flow-head">
              <div className="team-employee-hero-icon"><ShieldCheck className="w-5 h-5" /></div>
              <div className="min-w-0 flex-1">
                <p className="team-employee-kicker">{editingRole ? "Editar rol" : "Crear rol"}</p>
                <h2>{editingRole ? editingRole.name : "Nuevo perfil de trabajo"}</h2>
                <p>{isEmployeeSystemRole(editingRole)
                  ? "Rol del sistema: puedes ajustar su nombre, descripción y permisos. La clave «employee» se mantiene."
                  : "Define primero la identidad del rol y después sus permisos."}</p>
              </div>
              <button type="button" onClick={() => setShowRoleForm(false)} className="team-role-flow-close"><X className="w-4 h-4" /></button>
            </div>
            <div className="team-role-flow-steps">
              <button type="button" className={cn("team-role-step",roleFormStep===1&&"is-active",roleFormStep===2&&"is-done")} onClick={()=>setRoleFormStep(1)}>
                <span>1</span><div><strong>Perfil</strong><small>Nombre y descripción</small></div>
              </button>
              <i />
              <button type="button" className={cn("team-role-step",roleFormStep===2&&"is-active")} disabled={roleFormStep===1}>
                <span>2</span><div><strong>Permisos</strong><small>Módulos y acciones</small></div>
              </button>
            </div>
            <div className="team-role-flow-body">
              {error && (
                <div role="alert" className="mb-3 flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs font-bold leading-5 text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/30 dark:text-rose-300">
                  <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  <span className="min-w-0">{error}</span>
                </div>
              )}
              {roleFormStep===1 ? (
                <div className="team-form-section">
                  <div className="team-form-section-head"><div className="team-form-section-icon"><BriefcaseBusiness className="w-4 h-4"/></div><div><h3>Identidad del rol</h3><p>Información que verá el administrador al asignar trabajadores.</p></div></div>
                  <div className="grid sm:grid-cols-2 gap-3">
                    <label className="team-field-wrap"><span className="team-field-label">Nombre del rol <b>*</b></span><div className="team-field"><span className="team-field-icon"><ShieldCheck className="w-4 h-4"/></span><input className="team-field-input" value={roleForm.name} onChange={e=>setRoleForm({...roleForm,name:e.target.value})} disabled={busy||Boolean(editingRole && !canEditRole(editingRole))} placeholder="Ej. Supervisor"/></div></label>
                    <label className="team-field-wrap"><span className="team-field-label">Clave interna <b>*</b></span><div className="team-field"><span className="team-field-icon"><Hash className="w-4 h-4"/></span><input className="team-field-input" value={roleForm.key} onChange={e=>setRoleForm({...roleForm,key:e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g,"-")})} disabled={busy||Boolean(editingRole?.is_system)} placeholder="supervisor"/></div></label>
                  </div>
                  <label className="team-field-wrap mt-3"><span className="team-field-label">Descripción</span><div className="team-field"><span className="team-field-icon"><Info className="w-4 h-4"/></span><input className="team-field-input" value={roleForm.description} onChange={e=>setRoleForm({...roleForm,description:e.target.value})} disabled={busy||Boolean(editingRole && !canEditRole(editingRole))} placeholder="Qué puede hacer este perfil"/></div></label>
                  {editingRole?.is_system && (
                    <div className="team-field-help mt-2"><Info className="w-3.5 h-3.5" />{isEmployeeSystemRole(editingRole)
                      ? "Rol creado por PALMYRA: la clave no cambia, pero el nombre, la descripción y los permisos sí se pueden editar."
                      : "Este rol del sistema está protegido y no se puede modificar."}</div>
                  )}
                </div>
              ) : (
                <div className="team-form-section">
                  <div className="team-form-section-head"><div className="team-form-section-icon"><LockKeyhole className="w-4 h-4"/></div><div><h3>Permisos del rol</h3><p>Selecciona exactamente las acciones que tendrá este perfil.</p></div></div>
                  <div className="space-y-3">
                    {permissionGroups.map(group => (
                      <div key={group.prefix}>
                        <div className="mb-1.5 flex items-center justify-between gap-2">
                          <p className="text-[8px] font-black uppercase tracking-[0.12em] text-violet-600 dark:text-violet-300">{group.label}</p>
                          <button
                            type="button"
                            disabled={busy || Boolean(editingRole && !canEditRole(editingRole))}
                            onClick={() => {
                              const keys = group.permissions.map(permission => permission.key);
                              const allSelected = keys.every(key => roleForm.permissionKeys.includes(key));
                              setRoleForm(prev => ({
                                ...prev,
                                permissionKeys: allSelected
                                  ? prev.permissionKeys.filter(key => !keys.includes(key))
                                  : Array.from(new Set([...prev.permissionKeys, ...keys]))
                              }));
                            }}
                            className="text-[8px] font-black uppercase tracking-wider text-muted hover:text-violet-600 disabled:opacity-50"
                          >
                            {group.permissions.every(permission => roleForm.permissionKeys.includes(permission.key)) ? 'Quitar todo' : 'Todo'}
                          </button>
                        </div>
                        <div className="grid sm:grid-cols-2 gap-2">
                          {group.permissions.map(permission => {
                            const selected = roleForm.permissionKeys.includes(permission.key);
                            return <label key={permission.id} className={cn("team-role-permission",selected&&"is-selected")}>
                              <input type="checkbox" checked={selected} onChange={()=>toggleRolePermission(permission.key)} disabled={busy||Boolean(editingRole && !canEditRole(editingRole))} />
                              <span><strong>{permission.name}</strong><small>{permission.description||permission.key}</small></span>
                            </label>;
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <div className="team-role-flow-footer">
              <button type="button" onClick={()=>roleFormStep===1?setShowRoleForm(false):setRoleFormStep(1)} className="team-footer-secondary">{roleFormStep===1?"Cancelar":"Atrás"}</button>
              <button type="submit" disabled={busy||Boolean(editingRole && !canEditRole(editingRole))} className="team-footer-primary">{busy?"Guardando…":roleFormStep===1?"Continuar":"Guardar rol"}<ChevronRight className="w-4 h-4"/></button>
            </div>
          </form>
        </div>
      )}

      {accessInvite && (
        <div className="palmyra-overlay z-[var(--z-modal)] p-3 sm:p-5 flex items-center justify-center" onClick={() => setAccessInvite(null)}>
          <div role="dialog" aria-modal="true" aria-label="Enlace de acceso del trabajador" onClick={e => e.stopPropagation()} className="palmyra-modal-panel palmyra-mobile-modal w-full max-w-lg overflow-hidden">
            <div className="flex items-start gap-3 border-b border-base p-4 sm:p-5">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-violet-500/10 text-violet-600 dark:text-violet-300"><Link2 className="h-5 w-5" /></span>
              <div className="min-w-0 flex-1">
                <p className="text-[10px] font-black uppercase tracking-[0.18em] text-violet-600 dark:text-violet-300">Enlace de acceso</p>
                <h2 className="mt-1 truncate text-base font-black text-primary">{accessInvite.employeeName}</h2>
                <p className="mt-1 text-[11px] leading-5 text-muted">Entrégalo manualmente por WhatsApp, correo interno o en mano. No se envía nada automáticamente.</p>
              </div>
              <button type="button" onClick={() => setAccessInvite(null)} aria-label="Cerrar" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-base bg-subtle text-muted hover:text-primary"><X className="w-4 h-4" /></button>
            </div>
            <div className="space-y-3 p-4 sm:p-5">
              {accessInviteBusy ? (
                <div className="flex items-center justify-center gap-2 rounded-2xl border border-base bg-subtle p-6 text-xs font-bold text-muted"><RefreshCw className="h-4 w-4 animate-spin" /> Generando enlace…</div>
              ) : accessInviteError ? (
                <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-xs font-bold leading-5 text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/30 dark:text-rose-300">{accessInviteError}</div>
              ) : (
                <>
                  <label className="block min-w-0">
                    <span className="text-[10px] font-black uppercase tracking-wider text-muted">Enlace de un solo uso</span>
                    <input readOnly value={accessInvite.link} onFocus={e => e.currentTarget.select()} className="mt-1 w-full rounded-xl border border-base bg-primary px-3 py-2.5 text-xs font-bold text-primary outline-none" />
                  </label>
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <p className="inline-flex items-center gap-1.5 text-[11px] font-black text-amber-700 dark:text-amber-300"><Clock className="h-3.5 w-3.5" /> Válido 7 días, un solo uso</p>
                    <button type="button" onClick={() => void copyAccessLink(accessInvite.link)} className="flex h-10 items-center justify-center gap-2 rounded-xl bg-violet-600 px-4 text-[10px] font-black uppercase tracking-wider text-white shadow-lg shadow-violet-600/20">
                      {copiedLink ? <><Check className="w-4 h-4" /> Copiado</> : <><Copy className="w-4 h-4" /> Copiar</>}
                    </button>
                  </div>
                </>
              )}
            </div>
            <div className="flex flex-col gap-2 border-t border-base p-4 sm:flex-row sm:items-center sm:justify-end sm:p-5">
              {accessInviteError && (
                <p className="mr-auto text-[10px] font-bold leading-5 text-muted">Si el problema continúa, verifica tu conexión o contacta a soporte.</p>
              )}
              {accessInviteError && !accessInviteBusy && (
                <button type="button" onClick={() => { const target = (snapshot?.employees || []).find(item => item.id === accessInvite.employeeId); if (target) void openAccessInvite(target); }} className="flex h-10 items-center justify-center gap-2 rounded-xl bg-violet-600 px-4 text-[10px] font-black uppercase tracking-wider text-white">
                  <RefreshCw className="w-4 h-4" /> Reintentar
                </button>
              )}
              <button type="button" onClick={() => setAccessInvite(null)} className="h-10 rounded-xl border border-base bg-subtle px-4 text-[10px] font-black uppercase tracking-wider text-primary">Cerrar</button>
            </div>
          </div>
        </div>
      )}

      <TeamConfirmDialog
        open={Boolean(pendingDelete)}
        title={pendingDelete ? `Eliminar a ${pendingDelete.full_name}` : 'Eliminar trabajador'}
        description="Se eliminará su acceso a la empresa, invitaciones pendientes, contraseña POS y configuraciones personales. Las ventas y turnos históricos conservan la referencia del empleado."
        confirmLabel="Eliminar empleado"
        busy={busy}
        onClose={() => setPendingDelete(null)}
        onConfirm={async () => {
          if (!pendingDelete) return;
          const target = pendingDelete;
          await deleteEmployee(target);
          setPendingDelete(null);
        }}
      />

      <p className="text-[10px] text-muted text-center leading-5">Cada trabajador opera con su nombre, su código y su contraseña POS. El enlace de acceso es personal, de un solo uso y lo entregas tú; no se envían invitaciones por correo.</p>
    </OperationsSurface>
  );
}

