import React, { useEffect, useMemo, useState } from "react";
import { AtSign, BriefcaseBusiness, Check, CheckCircle2, ChevronLeft, ChevronRight, Copy, Edit3, Hash, Info, Link2, LockKeyhole, Mail, MapPin, MoreHorizontal, Plus, RefreshCw, ShieldCheck, UserRound, UserX, WalletCards, Warehouse, X, Shield, Save } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useStore } from "../store/useStore";
import { loadSaaSContext } from "../services/saas";
import {
  createEmployeePosSecure,
  createEmployeeWithInvitation,
  loadTeamSnapshot,
  resendEmployeeInvitation,
  revokeEmployeeInvitation,
  setEmployeeStatus,
  updateEmployee,
  updateEmployeePosSecure,
  upsertCompanyRole,
  type TeamEmployee,
  type TeamRole,
  type TeamSnapshot
} from "../services/team";
import { cn } from "../lib/utils";
import "./team.css";

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
  const navigate = useNavigate();
  const { currentUser, addNotification } = useStore();
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
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [showRoleForm, setShowRoleForm] = useState(false);
  const [editingRole, setEditingRole] = useState<TeamRole | null>(null);
  const [roleForm, setRoleForm] = useState({
    key: "",
    name: "",
    description: "",
    permissionKeys: [] as string[]
  });

  const canManageRoles = currentUser?.permissions?.includes("roles.manage") || currentUser?.role === "admin";
  const canManageEmployees = currentUser?.permissions?.includes("employees.manage") || currentUser?.role === "admin";

  const [form, setForm] = useState({
    fullName: "",
    employeeCode: "",
    baseSalary: "0",
    roleId: "",
    warehouseIds: [] as string[],
    email: "",
    sendInvite: true,
    posPassword: ""
  });

  const refresh = async () => {
    setLoading(true);
    setError("");
    try {
      const [nextContext, nextSnapshot] = await Promise.all([loadSaaSContext(), loadTeamSnapshot()]);
      if (!nextSnapshot) throw new Error("No se recibió el estado del equipo.");
      setContext(nextContext);
      setSnapshot(nextSnapshot);
      if (!form.roleId) {
        const employeeRole = (nextSnapshot.roles || []).find(role => role.key === "employee") || (nextSnapshot.roles || []).find(role => role.key !== "admin");
        if (employeeRole) setForm(prev => ({ ...prev, roleId: employeeRole.id }));
      }
      if (!form.warehouseIds.length && nextSnapshot.warehouses[0]) {
        setForm(prev => ({ ...prev, warehouseIds: [nextSnapshot.warehouses[0].id] }));
      }
    } catch (e: any) {
      setError(e?.message || "No se pudo cargar el equipo.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void refresh(); }, []);

  const employeeLimit = Number((context?.subscription?.limits as any)?.employees || 0);
  const activeEmployees = snapshot?.employees.filter(employee => employee.active).length || 0;
  const remainingSlots = employeeLimit > 0 ? Math.max(0, employeeLimit - activeEmployees) : null;

  const availableRoles = useMemo(
    () => (snapshot?.roles || []).filter(role => role.key !== "admin" && (role.is_system || canManageRoles)),
    [snapshot?.roles, canManageRoles]
  );

  const resetForm = () => {
    setEditing(null);
    setInviteLink(null);
    setForm({
      fullName: "",
      employeeCode: "",
      baseSalary: "0",
      roleId: availableRoles.find(role => role.key === "employee")?.id || availableRoles[0]?.id || "",
      warehouseIds: snapshot?.warehouses[0] ? [snapshot.warehouses[0].id] : [],
      email: "",
      sendInvite: true,
      posPassword: ""
    });
  };

  const openRoleCreate = () => {
    setEditingRole(null);
    setRoleForm({ key: "", name: "", description: "", permissionKeys: [] });
    setError("");
    setMessage("");
    setShowRoleForm(true);
  };

  const openRoleEdit = (role: TeamRole) => {
    if (role.is_system) return;
    setEditingRole(role);
    setRoleForm({
      key: role.key,
      name: role.name,
      description: role.description || "",
      permissionKeys: [...(role.permission_keys || [])]
    });
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
    if (!snapshot?.companyId) return;
    if (!canManageRoles) return setError("No tienes permiso para administrar roles.");
    if (roleForm.name.trim().length < 2) return setError("Escribe el nombre del rol.");
    if (roleForm.key.trim().length < 2) return setError("Escribe una clave para el rol.");
    setBusy(true);
    setError("");
    try {
      await upsertCompanyRole({
        companyId: snapshot.companyId,
        roleId: editingRole?.id,
        key: roleForm.key,
        name: roleForm.name,
        description: roleForm.description,
        permissionKeys: roleForm.permissionKeys
      });
      await refresh();
      setShowRoleForm(false);
      addNotification(editingRole ? "Rol actualizado." : "Rol creado.", "success");
    } catch (e: any) {
      setError(e?.message || "No se pudo guardar el rol.");
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
    setInviteLink(null);
    setMessage("");
    setError("");
    setForm({
      fullName: employee.full_name,
      employeeCode: employee.employee_code,
      baseSalary: String(employee.base_salary),
      roleId: employee.role_id,
      warehouseIds: [...employee.warehouse_ids],
      email: employee.login_email || employee.pending_invitation?.email || "",
      sendInvite: !employee.user_id,
      posPassword: ""
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
    setError("");
    setMessage("");
    setInviteLink(null);

    if (!snapshot?.companyId) return;
    if (form.fullName.trim().length < 2) return setError("Escribe el nombre completo.");
    if (!form.employeeCode.trim()) return setError("Escribe un código de empleado.");
    if (!form.roleId) return setError("Selecciona un rol.");
    if (!form.warehouseIds.length) return setError("Selecciona al menos un almacén.");
    if (form.sendInvite && !form.email.trim()) return setError("Escribe el correo del trabajador para crear su acceso web.");
    if (!form.sendInvite && !editing && form.posPassword.trim().length < 6) {
      return setError("Define una contraseña de al menos 6 caracteres para usar este empleado en el POS.");
    }
    if (!form.sendInvite && editing && form.posPassword.trim().length > 0 && form.posPassword.trim().length < 6) {
      return setError("La nueva contraseña del POS debe tener al menos 6 caracteres.");
    }

    setBusy(true);
    try {
      if (editing) {
        if (form.sendInvite) {
          await updateEmployee({
            companyId: snapshot.companyId,
            employeeId: editing.id,
            employeeCode: form.employeeCode,
            fullName: form.fullName,
            baseSalary: Number(form.baseSalary) || 0,
            roleId: form.roleId,
            warehouseIds: form.warehouseIds
          });
        } else {
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
        }

        if (form.sendInvite && !editing.user_id) {
          const invite = await resendEmployeeInvitation({
            companyId: snapshot.companyId,
            employeeId: editing.id,
            email: form.email,
            roleId: form.roleId,
            warehouseIds: form.warehouseIds
          });
          const link = `${window.location.origin}/invite?token=${encodeURIComponent(invite.token)}`;
          setInviteLink(link);
          setMessage(invite.email_sent ? "Empleado actualizado y correo de invitación reenviado." : "Empleado actualizado. Se generó un enlace nuevo para compartir.");
        } else {
          setMessage("Empleado actualizado.");
        }
      } else {
        if (form.sendInvite) {
          const invite = await createEmployeeWithInvitation({
            companyId: snapshot.companyId,
            employeeCode: form.employeeCode,
            fullName: form.fullName,
            baseSalary: Number(form.baseSalary) || 0,
            roleId: form.roleId,
            warehouseIds: form.warehouseIds,
            email: form.email
          });
          const link = `${window.location.origin}/invite?token=${encodeURIComponent(invite.token)}`;
          setInviteLink(link);
          setMessage(invite.email_sent ? "Empleado creado y correo de invitación enviado." : "Empleado creado. El correo automático no fue enviado; usa el enlace generado.");
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
          setMessage("Empleado creado sin acceso web y con contraseña para POS.");
        }
      }
      await refresh();
      setShowForm(true);
      addNotification("Cambios de equipo guardados.", "success");
    } catch (e: any) {
      setError(e?.message || "No se pudo guardar el empleado.");
    } finally {
      setBusy(false);
    }
  };

  const changeStatus = async (employee: TeamEmployee) => {
    setMenuId(null);
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

  const revokeInvite = async (employee: TeamEmployee) => {
    setMenuId(null);
    if (!employee.pending_invitation) return;
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

  const copyInvite = async (employee: TeamEmployee) => {
    if (!employee.pending_invitation || !snapshot?.companyId) return;
    try {
      const invite = await resendEmployeeInvitation({
        companyId: snapshot!.companyId,
        employeeId: employee.id,
        email: employee.pending_invitation.email,
        roleId: employee.role_id,
        warehouseIds: employee.warehouse_ids
      });
      const link = `${window.location.origin}/invite?token=${encodeURIComponent(invite.token)}`;
      await copyText(link);
      setInviteLink(link);
      addNotification("Enlace de invitación copiado.", "success");
      await refresh();
    } catch (e: any) {
      addNotification(e?.message || "No se pudo generar la invitación.", "error");
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
    <div className="space-y-5 w-full min-w-0 max-w-6xl mx-auto pb-10" onClick={() => setMenuId(null)}>
      <header className="bg-secondary border border-base rounded-3xl p-5 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <p className="text-[10px] font-black tracking-[0.18em] uppercase text-rose-500">Empresa</p>
          <h1 data-palmi-content="team" className="text-2xl font-black text-primary mt-1">Equipo y accesos</h1>
          <p className="text-xs text-muted mt-1">Cada trabajador tiene su propio acceso y conserva sus permisos al cambiar de dispositivo.</p>
        </div>
        <button onClick={openCreate} disabled={loading || busy || remainingSlots === 0}
          className="w-full sm:w-auto h-11 px-4 rounded-xl bg-rose-600 text-white font-black text-xs uppercase tracking-wider flex items-center justify-center gap-2 disabled:opacity-50">
          <Plus className="w-4 h-4" /> Agregar trabajador
        </button>
      </header>

      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="bg-secondary border border-base rounded-2xl p-4">
          <p className="text-[9px] font-black uppercase tracking-wider text-muted">Empleados activos</p>
          <p className="text-xl font-black text-primary mt-1">{activeEmployees}{employeeLimit ? ` / ${employeeLimit}` : ""}</p>
        </div>
        <div className="bg-secondary border border-base rounded-2xl p-4">
          <p className="text-[9px] font-black uppercase tracking-wider text-muted">Con acceso</p>
          <p className="text-xl font-black text-primary mt-1">{snapshot?.employees.filter(e => e.active && e.user_id).length || 0}</p>
        </div>
        <div className="bg-secondary border border-base rounded-2xl p-4">
          <p className="text-[9px] font-black uppercase tracking-wider text-muted">Pendientes</p>
          <p className="text-xl font-black text-primary mt-1">{snapshot?.employees.filter(e => e.pending_invitation).length || 0}</p>
        </div>
        <div className="bg-secondary border border-base rounded-2xl p-4">
          <p className="text-[9px] font-black uppercase tracking-wider text-muted">Almacenes</p>
          <p className="text-xl font-black text-primary mt-1">{snapshot?.warehouses.length || 0}</p>
        </div>
      </section>

      {canManageRoles && (
        <section className="bg-secondary border border-base rounded-3xl p-4 md:p-5">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <Shield className="w-5 h-5 text-rose-500" />
                <h2 className="text-sm font-black text-primary">Roles y permisos</h2>
              </div>
              <p className="text-[10px] text-muted mt-1">Crea perfiles de trabajo y decide qué módulos puede usar cada uno.</p>
            </div>
            <button onClick={openRoleCreate} className="w-full sm:w-auto h-10 px-4 rounded-xl bg-slate-950 text-white font-black text-[10px] uppercase tracking-wider flex items-center justify-center gap-2">
              <Plus className="w-4 h-4" /> Crear rol
            </button>
          </div>
          <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-2 mt-4">
            {(snapshot?.roles || []).map(role => (
              <button
                key={role.id}
                type="button"
                onClick={() => openRoleEdit(role)}
                className={cn(
                  "text-left p-3 rounded-2xl border transition",
                  role.is_system ? "border-base bg-subtle cursor-default" : "border-base bg-primary hover:border-rose-300"
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-black text-primary">{role.name}</span>
                  <span className="text-[8px] uppercase tracking-wider font-black text-muted">{role.is_system ? "Sistema" : "Personalizado"}</span>
                </div>
                <p className="text-[9px] text-muted mt-1 line-clamp-2">{role.description || "Sin descripción"}</p>
                <div className="flex flex-wrap gap-1 mt-2">
                  {(role.permission_keys || []).slice(0, 4).map(key => (
                    <span key={key} className="text-[8px] rounded-full bg-subtle border border-base px-2 py-1 text-muted">{key}</span>
                  ))}
                  {(role.permission_keys || []).length > 4 && <span className="text-[8px] text-muted px-1 py-1">+{(role.permission_keys || []).length - 4}</span>}
                </div>
              </button>
            ))}
          </div>
        </section>
      )}

      {inviteLink && (
        <section className="bg-emerald-50 border border-emerald-200 rounded-2xl p-4">
          <div className="flex flex-col md:flex-row md:items-center gap-3">
            <div className="flex-1">
              <p className="text-xs font-black text-emerald-800">Enlace de acceso del trabajador</p>
              <p className="text-[11px] text-emerald-700 mt-1 break-all">{inviteLink}</p>
              <p className="text-[10px] text-emerald-700/80 mt-1">El trabajador debe registrarse con el mismo correo de la invitación.</p>
            </div>
            <button onClick={() => copyText(inviteLink).then(() => addNotification("Enlace copiado.", "success"))}
              className="h-10 px-4 rounded-xl bg-emerald-600 text-white font-black text-[10px] uppercase tracking-wider flex items-center gap-2">
              <Copy className="w-4 h-4" /> Copiar
            </button>
          </div>
        </section>
      )}

      {message && <div className="rounded-xl bg-slate-900 text-white text-xs font-bold p-3">{message}</div>}
      {error && <div className="rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-xs font-bold p-3">{error}</div>}

      <section className="bg-secondary border border-base rounded-3xl overflow-visible">
        {loading ? (
          <div className="p-10 text-center text-sm text-muted">Cargando equipo...</div>
        ) : snapshot?.employees.length ? (
          <div className="divide-y divide-slate-200/70 dark:divide-slate-700/60">
            {snapshot.employees.map(employee => {
              const warehouseNames = employee.warehouse_ids.map(id => snapshot?.warehouses.find(w => w.id === id)?.name).filter(Boolean);
              return (
                <div key={employee.id} className="p-4 md:p-5 flex flex-col md:flex-row md:items-center gap-4">
                  <div className={cn("w-11 h-11 rounded-2xl flex items-center justify-center shrink-0", employee.active ? "bg-rose-100 text-rose-600" : "bg-slate-100 text-slate-400")}>
                    {employee.user_id ? <UserRound className="w-5 h-5" /> : <UserX className="w-5 h-5" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-black text-primary uppercase">{employee.full_name}</h3>
                      <span className="text-[9px] font-black uppercase tracking-wider rounded-full px-2 py-1 bg-subtle border border-base">{employee.role_name}</span>
                      {!employee.active && <span className="text-[9px] font-black uppercase rounded-full px-2 py-1 bg-slate-100 text-slate-500">Inactivo</span>}
                      {employee.pending_invitation && employee.active && <span className="text-[9px] font-black uppercase rounded-full px-2 py-1 bg-amber-100 text-amber-700">Invitación pendiente</span>}
                    </div>
                    <div className="grid sm:grid-cols-3 gap-2 mt-1.5 text-[10px] text-muted">
                      <span className="font-bold">Código: {employee.employee_code}</span>
                      <span className="inline-flex items-center gap-1"><Mail className="w-3 h-3" />{employee.login_email || employee.pending_invitation?.email || "Sin acceso web"}</span>
                      <span className="inline-flex items-center gap-1"><MapPin className="w-3 h-3" />{warehouseNames.length ? warehouseNames.join(", ") : "Sin almacén"}</span>
                    </div>
                  </div>
                  <div className="relative shrink-0">
                    <button onClick={(e) => { e.stopPropagation(); setMenuId(menuId === employee.id ? null : employee.id); }}
                      className="w-10 h-10 rounded-xl border border-base bg-primary text-muted hover:text-primary flex items-center justify-center">
                      <MoreHorizontal className="w-4 h-4" />
                    </button>
                    {menuId === employee.id && (
                      <div onClick={e => e.stopPropagation()} className="absolute right-0 top-12 z-30 w-56 bg-primary border border-base rounded-2xl shadow-2xl p-2">
                        <button onClick={() => openEdit(employee)} className="w-full px-3 py-2 text-left text-xs font-bold text-primary hover:bg-subtle rounded-xl flex items-center gap-2">
                          <Edit3 className="w-4 h-4" /> Editar empleado
                        </button>
                        {employee.pending_invitation && (
                          <>
                            <button onClick={() => copyInvite(employee)} className="w-full px-3 py-2 text-left text-xs font-bold text-primary hover:bg-subtle rounded-xl flex items-center gap-2">
                              <Copy className="w-4 h-4" /> Regenerar enlace
                            </button>
                            <button onClick={() => revokeInvite(employee)} className="w-full px-3 py-2 text-left text-xs font-bold text-amber-700 hover:bg-amber-50 rounded-xl flex items-center gap-2">
                              <Mail className="w-4 h-4" /> Revocar invitación
                            </button>
                          </>
                        )}
                        <button onClick={() => changeStatus(employee)} className="w-full px-3 py-2 text-left text-xs font-bold hover:bg-subtle rounded-xl flex items-center gap-2">
                          <RefreshCw className="w-4 h-4" /> {employee.active ? "Desactivar acceso" : "Reactivar acceso"}
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
            <p className="text-sm font-black text-primary">Todavía no hay trabajadores.</p>
            <p className="text-xs text-muted mt-1">Agrega el primero para probar el flujo de acceso en otro dispositivo.</p>
          </div>
        )}
      </section>

      {showForm && (
        <div className="fixed inset-0 z-[200] bg-slate-950/70 backdrop-blur-md p-3 sm:p-5 flex items-center justify-center" onClick={() => setShowForm(false)}>
          <form onSubmit={submit} onClick={e => e.stopPropagation()} className="team-employee-modal w-full max-w-2xl bg-secondary border border-base rounded-[28px] shadow-2xl overflow-hidden">
            <div className="team-employee-modal-head">
              <div className="flex items-start gap-3 min-w-0">
                <div className="team-employee-hero-icon" aria-hidden="true"><BriefcaseBusiness className="w-5 h-5" /></div>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="team-employee-kicker">{editing ? "Equipo · Configuración" : "Equipo · Alta segura"}</span>
                    <span className="team-employee-status"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />Seguro y vinculado</span>
                  </div>
                  <h2 className="text-xl sm:text-2xl font-black text-primary tracking-tight mt-1">{editing ? "Trabajador y acceso" : "Trabajador y acceso"}</h2>
                  <p className="text-[11px] sm:text-xs text-muted mt-1.5 leading-5 max-w-xl">Completa la ficha, define su operación y decide si tendrá una cuenta web independiente. Todo queda vinculado a la empresa sin compartir las credenciales del propietario.</p>
                </div>
              </div>
              <button type="button" onClick={() => setShowForm(false)} className="w-10 h-10 rounded-2xl bg-subtle text-muted hover:text-primary hover:bg-primary border border-base flex items-center justify-center shrink-0 transition" aria-label="Cerrar formulario"><X className="w-4 h-4" /></button>
            </div>
            <div className="team-employee-stepbar" aria-label="Pasos para crear trabajador">
              {[
                [1,"Información","Datos personales"],
                [2,"Operación","Rol y almacenes"],
                [3,"Acceso","Cuenta web"]
              ].map(([step,label,sub]) => {
                const n = step as 1|2|3;
                return <React.Fragment key={n}>
                  <button type="button" className={cn("team-step-item", formStep===n && "team-step-active", formStep>n && "team-step-done")} onClick={() => setFormStep(n)} disabled={busy}>
                    <span>{formStep>n ? <Check className="w-3 h-3" /> : String(n).padStart(2,"0")}</span>
                    <div><strong>{label}</strong><small>{sub}</small></div>
                  </button>
                  {n<3 && <div className={cn("team-step-line", formStep>n && "is-complete")} />}
                </React.Fragment>;
              })}
            </div>
            <div className="team-employee-modal-body">
              <section className={cn("team-form-section", formStep !== 1 && "team-form-hidden")} data-section="employee-info" aria-hidden={formStep !== 1}>
                <div className="team-form-section-head"><div className="team-form-section-icon"><UserRound className="w-4 h-4" /></div><div><h3>Información del trabajador</h3><p>Identifica a la persona que formará parte del equipo.</p></div></div>
                <div className="grid sm:grid-cols-2 gap-3">
                  <label className="team-field-wrap sm:col-span-2"><span className="team-field-label">Nombre completo <b>*</b></span><span className="team-field"><span className="team-field-icon"><UserRound className="w-4 h-4" /></span><input value={form.fullName} onChange={e => setForm({...form, fullName:e.target.value})} disabled={busy} className="team-field-input" placeholder="Ej. María González Pérez" autoComplete="name" /></span></label>
                  <label className="team-field-wrap"><span className="team-field-label">Código de empleado <b>*</b></span><span className="team-field"><span className="team-field-icon"><Hash className="w-4 h-4" /></span><input value={form.employeeCode} onChange={e => setForm({...form, employeeCode:e.target.value})} disabled={busy} className="team-field-input" placeholder="Ej. EMP-001" autoComplete="off" /></span></label>
                  <label className="team-field-wrap"><span className="team-field-label">Salario base</span><span className="team-field"><span className="team-field-icon"><WalletCards className="w-4 h-4" /></span><input type="number" min="0" step="0.01" inputMode="decimal" value={form.baseSalary} onChange={e => setForm({...form, baseSalary:e.target.value})} disabled={busy} className="team-field-input" placeholder="0.00" /></span></label>
                </div>
              </section>
              <section className={cn("team-form-section", formStep !== 2 && "team-form-hidden")} data-section="employee-operation" aria-hidden={formStep !== 2}>
                <div className="team-form-section-head"><div className="team-form-section-icon"><ShieldCheck className="w-4 h-4" /></div><div><h3>Rol y almacenes</h3><p>Define dónde trabaja y qué nivel de operación tendrá.</p></div></div>
                <label className="team-field-wrap"><span className="team-field-label">Rol <b>*</b></span><span className="team-field"><span className="team-field-icon"><ShieldCheck className="w-4 h-4" /></span><select value={form.roleId} onChange={e => setForm({...form, roleId:e.target.value})} disabled={busy || availableRoles.length===0} className="team-field-input team-field-select">{availableRoles.map(role => <option key={role.id} value={role.id}>{role.name}</option>)}</select></span>{!canManageRoles && <span className="team-field-help"><Info className="w-3.5 h-3.5" />Solo puedes asignar el rol operativo estándar.</span>}</label>
                <div className="mt-4">
                  <div className="flex items-end justify-between gap-3 mb-2"><div><span className="team-field-label">Almacenes permitidos <b>*</b></span><span className="team-field-subtext">Selecciona uno o varios almacenes a los que podrá acceder.</span></div><span className="team-selection-count">{form.warehouseIds.length} seleccionado{form.warehouseIds.length === 1 ? "" : "s"}</span></div>
                  <div className="grid sm:grid-cols-2 gap-2">
                    {(snapshot?.warehouses || []).filter(warehouse => warehouse.active).map(warehouse => {
                      const selected = form.warehouseIds.includes(warehouse.id);
                      return <label key={warehouse.id} className={cn("team-warehouse-option", selected && "is-selected")}><input type="checkbox" checked={selected} onChange={() => toggleWarehouse(warehouse.id)} disabled={busy} className="sr-only" /><span className="team-warehouse-icon"><Warehouse className="w-4 h-4" /></span><span className="min-w-0 flex-1"><span className="team-warehouse-name">{warehouse.name}</span>{snapshot?.warehouses[0]?.id === warehouse.id && <span className="team-warehouse-main">Principal sugerido</span>}</span><span className={cn("team-check", selected && "is-selected")}>{selected && <Check className="w-3.5 h-3.5" />}</span></label>;
                    })}
                  </div>
                  {!(snapshot?.warehouses || []).some(warehouse => warehouse.active) && <div className="team-empty-inline"><Warehouse className="w-4 h-4" />No hay almacenes activos disponibles. Crea uno en Configuración antes de asignar acceso.</div>}
                </div>
              </section>
                            <section className={cn("team-form-section team-access-section", form.sendInvite && "is-enabled", formStep !== 3 && "team-form-hidden")} data-section="employee-access" aria-hidden={formStep !== 3}>
                <div className="team-form-section-head"><div className="team-form-section-icon"><Link2 className="w-4 h-4" /></div><div className="min-w-0"><h3>Acceso al sistema</h3><p>Elige si tendrá cuenta web o solo contraseña para operar en el POS.</p></div><label className="team-switch ml-auto shrink-0"><input type="checkbox" checked={form.sendInvite} onChange={e => setForm({...form, sendInvite:e.target.checked, posPassword: e.target.checked ? "" : form.posPassword})} disabled={busy || Boolean(editing?.user_id)} className="sr-only" /><span className="team-switch-track"><span className="team-switch-thumb" /></span></label></div>

                {form.sendInvite ? (
                  <div className="team-access-card">
                    <div className="flex items-start gap-3"><div className="team-access-icon"><AtSign className="w-4 h-4" /></div><div className="min-w-0 flex-1"><p className="text-xs font-black text-primary">Cuenta web del trabajador</p><p className="text-[10px] sm:text-[11px] text-muted leading-5 mt-0.5">El trabajador recibirá una invitación y creará o verificará su propia cuenta PALMYRA. La contraseña que configure allí será la que podrá usar para reanudar su turno en el POS.</p></div></div>
                    {form.sendInvite && !editing?.user_id && <label className="team-field-wrap mt-3"><span className="team-field-label">Correo del trabajador <b>*</b></span><span className="team-field"><span className="team-field-icon"><Mail className="w-4 h-4" /></span><input type="email" value={form.email} onChange={e => setForm({...form,email:e.target.value})} disabled={busy} className="team-field-input" placeholder="trabajador@empresa.com" autoComplete="email" /></span></label>}
                    {editing?.user_id && <div className="team-linked-account"><CheckCircle2 className="w-4 h-4 shrink-0" /><span>Cuenta vinculada: {editing.login_email || form.email || "correo registrado"} · La contraseña de esa cuenta se usa también para validar el POS.</span></div>}
                  </div>
                ) : (
                  <div className="team-access-card">
                    <div className="flex items-start gap-3"><div className="team-access-icon"><LockKeyhole className="w-4 h-4" /></div><div className="min-w-0 flex-1"><p className="text-xs font-black text-primary">Solo acceso al POS</p><p className="text-[10px] sm:text-[11px] text-muted leading-5 mt-0.5">Este trabajador no tendrá cuenta web. Define aquí una contraseña que quedará protegida y se usará para seleccionar y reanudar su turno en el POS.</p></div></div>
                    <label className="team-field-wrap mt-3"><span className="team-field-label">{editing ? "Nueva contraseña del POS" : "Contraseña del POS"} <b>{editing ? "" : "*"}</b></span><span className="team-field"><span className="team-field-icon"><LockKeyhole className="w-4 h-4" /></span><input type="password" value={form.posPassword} onChange={e => setForm({...form,posPassword:e.target.value})} disabled={busy} className="team-field-input" placeholder={editing ? "Dejar vacío para conservar la actual" : "Mínimo 6 caracteres"} autoComplete="new-password" /></span></label>
                    <div className="team-access-off"><Info className="w-4 h-4 shrink-0" />La contraseña se guarda protegida en Supabase; nunca se muestra en la lista de empleados.</div>
                  </div>
                )}
              </section>
            </div>
            <div className="team-employee-modal-footer">
              <div className="flex items-start gap-2 min-w-0"><div className="team-footer-icon"><Info className="w-3.5 h-3.5" /></div><p>{formStep === 1 ? "Empieza por identificar al trabajador. Podrás revisar todo antes de guardar." : formStep === 2 ? "Define el rol y los almacenes. El trabajador solo tendrá acceso a lo que aquí autorices." : form.sendInvite ? "La cuenta web es independiente de la del propietario. El trabajador configurará sus propias credenciales." : "La contraseña POS se guarda protegida y será necesaria para abrir o reanudar su turno."}</p></div>
              <div className="team-footer-actions">
                <button type="button" onClick={() => formStep === 1 ? setShowForm(false) : setFormStep((formStep-1) as 1|2|3)} className="team-footer-secondary">{formStep === 1 ? "Cancelar" : <><ChevronLeft className="w-4 h-4" /> Atrás</>}</button>
                {formStep < 3 ? <button type="button" disabled={busy || (formStep===1 && (!form.fullName.trim() || !form.employeeCode.trim())) || (formStep===2 && (!form.roleId || !form.warehouseIds.length))} onClick={() => setFormStep((formStep+1) as 1|2|3)} className="team-footer-primary">Continuar <ChevronRight className="w-4 h-4" /></button> : <button type="submit" disabled={busy || (form.sendInvite && !form.email.trim())} className="team-footer-primary">{busy ? <><RefreshCw className="w-4 h-4 animate-spin" /> Guardando…</> : editing ? <><Save className="w-4 h-4" /> Guardar cambios</> : <><Check className="w-4 h-4" /> Crear trabajador</>}</button>}
              </div>
            </div>
          </form>
        </div>
      )}
      {showRoleForm && (
        <div className="fixed inset-0 z-[210] bg-slate-950/60 backdrop-blur-sm p-3 sm:p-5 flex items-center justify-center" onClick={() => setShowRoleForm(false)}>
          <form onSubmit={submitRole} onClick={e => e.stopPropagation()} className="palmyra-mobile-modal w-full max-w-xl bg-secondary border border-base rounded-2xl sm:rounded-3xl shadow-2xl p-3 sm:p-5 max-h-[calc(100dvh-1.5rem)] overflow-y-auto overscroll-contain">
            <div className="flex items-start justify-between gap-3 mb-5">
              <div>
                <p className="text-[10px] font-black uppercase tracking-[0.18em] text-rose-500">{editingRole ? "Editar rol" : "Nuevo rol"}</p>
                <h2 className="text-lg sm:text-xl font-black text-primary break-words">{editingRole ? editingRole.name : "Perfil personalizado"}</h2>
                <p className="text-[10px] sm:text-xs text-muted mt-1 leading-4">El rol define los módulos y acciones disponibles para el trabajador.</p>
              </div>
              <button type="button" onClick={() => setShowRoleForm(false)} className="w-9 h-9 rounded-xl bg-subtle text-muted flex items-center justify-center"><X className="w-4 h-4" /></button>
            </div>
            <div className="grid sm:grid-cols-2 gap-4">
              <label className="block">
                <span className="label">Nombre del rol</span>
                <input className="field" value={roleForm.name} onChange={e => setRoleForm({...roleForm,name:e.target.value})} disabled={busy || Boolean(editingRole?.is_system)} />
              </label>
              <label className="block">
                <span className="label">Clave interna</span>
                <input className="field" value={roleForm.key} onChange={e => setRoleForm({...roleForm,key:e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g,"-")})} disabled={busy || Boolean(editingRole?.is_system)} />
              </label>
            </div>
            <label className="block mt-4">
              <span className="label">Descripción</span>
              <input className="field" value={roleForm.description} onChange={e => setRoleForm({...roleForm,description:e.target.value})} disabled={busy || Boolean(editingRole?.is_system)} />
            </label>
            <div className="mt-4">
              <span className="label">Permisos</span>
              <div className="grid sm:grid-cols-2 gap-2 mt-2">
                {(snapshot?.permissions || []).map(permission => {
                  const selected = roleForm.permissionKeys.includes(permission.key);
                  return (
                    <label key={permission.id} className={cn("flex items-start gap-3 p-3 rounded-xl border cursor-pointer", selected ? "border-rose-300 bg-rose-50/50 dark:bg-rose-950/20" : "border-base bg-primary")}>
                      <input type="checkbox" checked={selected} onChange={() => toggleRolePermission(permission.key)} disabled={busy || Boolean(editingRole?.is_system)} className="mt-0.5" />
                      <span>
                        <span className="block text-xs font-bold text-primary">{permission.name}</span>
                        <span className="block text-[9px] text-muted mt-0.5">{permission.description || permission.key}</span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
            <div className="flex flex-col sm:flex-row gap-2 mt-6">
              <button type="button" onClick={() => setShowRoleForm(false)} className="h-11 px-4 rounded-xl bg-subtle text-primary font-black text-xs uppercase tracking-wider">Cancelar</button>
              <button type="submit" disabled={busy || Boolean(editingRole?.is_system)} className="h-11 px-4 rounded-xl bg-rose-600 text-white font-black text-xs uppercase tracking-wider flex-1 flex items-center justify-center gap-2">
                {busy ? "Guardando..." : <><Save className="w-4 h-4" /> Guardar rol</>}
              </button>
            </div>
          </form>
        </div>
      )}

      <p className="text-[10px] text-muted text-center">El acceso web del trabajador es independiente del selector de empleado/PIN del POS. Ambos pueden coexistir.</p>
    </div>
  );
}

