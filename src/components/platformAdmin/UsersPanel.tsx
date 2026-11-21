import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Check, Copy, Mail, Phone, ShieldCheck, UserRound, UsersRound } from "lucide-react";
import { loadPlatformUserDetail, loadPlatformUsers, type PlatformUser, type PlatformUserDetail } from "../../services/platformAdminConsole";
import type { AdminContext } from "./types";
import { Badge, Empty, FilterTabs, Modal, Pager, SearchBox, SectionCard, fmtDate, fmtDay, pageSlice, statusLabel, useDebounced } from "./ui";

type Filter = "all" | "owners" | "members" | "without_company" | "admins";

export default function UsersPanel({ ctx }: { ctx: AdminContext }) {
  const { version } = ctx;
  const [q, setQ] = useState("");
  const debounced = useDebounced(q, 350);
  const [filter, setFilter] = useState<Filter>("all");
  const [page, setPage] = useState(1);
  const [users, setUsers] = useState<PlatformUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<PlatformUser | null>(null);
  const [copied, setCopied] = useState("");

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    loadPlatformUsers(debounced)
      .then((rows) => { if (active) setUsers(rows); })
      .catch((err) => { if (active) setError(err?.message || "No se pudo cargar el directorio de usuarios."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [debounced, version]);

  useEffect(() => { setPage(1); }, [debounced, filter]);

  const filtered = useMemo(() => users.filter((user) => {
    if (filter === "owners") return Boolean(user.is_owner);
    if (filter === "members") return Boolean(user.company_id);
    if (filter === "without_company") return !user.company_id;
    if (filter === "admins") return user.is_platform_admin;
    return true;
  }), [users, filter]);

  const paged = pageSlice(filtered, page, 12);
  const owners = users.filter((user) => user.is_owner).length;
  const withoutCompany = users.filter((user) => !user.company_id).length;
  const activeRecently = users.filter((user) => user.last_sign_in_at && Date.now() - new Date(user.last_sign_in_at).getTime() < 30 * 864e5).length;

  const copyEmail = async (email?: string | null) => {
    if (!email) return;
    try {
      await navigator.clipboard.writeText(email);
      setCopied(email);
      window.setTimeout(() => setCopied(""), 1600);
    } catch {
      setCopied("");
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        {[
          ["Usuarios", users.length, "Cuentas con perfil"],
          ["Activos 30 días", activeRecently, "Con inicio de sesión"],
          ["Propietarios", owners, "Cuentas de empresa"],
          ["Sin empresa", withoutCompany, "Pendientes de onboarding"],
        ].map(([label, value, detail]) => (
          <div key={String(label)} className="rounded-2xl border border-base bg-secondary p-3.5">
            <p className="text-[9px] font-black uppercase tracking-[.14em] text-muted">{label}</p>
            <p className="mt-1.5 text-xl font-black text-primary">{value as number}</p>
            <p className="text-[9px] font-bold text-muted">{detail as string}</p>
          </div>
        ))}
      </div>

      <SectionCard title="Directorio de usuarios" subtitle="Quién existe, a qué empresa pertenece y cuándo entró por última vez." icon={<UsersRound className="h-4 w-4" />}>
        <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_auto]">
          <SearchBox value={q} onChange={setQ} placeholder="Buscar por correo, nombre, teléfono o empresa…" />
          <FilterTabs<Filter> value={filter} onChange={setFilter} options={[
            ["all", "Todos"], ["owners", "Propietarios"], ["members", "Con empresa"], ["without_company", "Sin empresa"], ["admins", "Plataforma"],
          ]} />
        </div>

        {error ? <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 p-2.5 text-[11px] font-bold text-rose-700">{error}</div> : null}
        {loading ? <p className="mt-3 text-xs font-bold text-muted">Cargando usuarios…</p> : null}

        {!loading ? (
          <div className="mt-3 overflow-hidden rounded-2xl border border-base">
            <div className="hidden grid-cols-[1.6fr_1.3fr_.8fr_.9fr_auto] gap-2 bg-subtle px-3 py-2 text-[9px] font-black uppercase tracking-wide text-muted lg:grid">
              <span>Usuario</span><span>Empresa</span><span>Rol</span><span>Último acceso</span><span />
            </div>
            <div className="divide-y divide-[color:var(--border-base)]">
              {paged.slice.map((user) => (
                <div key={user.user_id} className="grid gap-2 px-3 py-2.5 lg:grid-cols-[1.6fr_1.3fr_.8fr_.9fr_auto] lg:items-center">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-violet-600 text-[11px] font-black text-white">{String(user.full_name || user.email || "?").slice(0, 1).toUpperCase()}</span>
                    <div className="min-w-0">
                      <p className="truncate text-[11px] font-black text-primary">{user.full_name || user.email || "Sin nombre"}</p>
                      <p className="truncate text-[10px] font-bold text-muted">{user.email || "Sin correo"} {user.email_confirmed ? "" : "· sin confirmar"}</p>
                    </div>
                  </div>
                  <div className="min-w-0 pl-10 lg:pl-0">
                    <p className="truncate text-[11px] font-bold text-primary">{user.company_name || "Sin empresa"}</p>
                    <p className="truncate text-[9px] font-bold text-muted">{user.phone || "Sin teléfono"}</p>
                  </div>
                  <div className="flex flex-wrap gap-1 pl-10 lg:pl-0">
                    {user.is_platform_admin ? <Badge status="setup" label="Plataforma" /> : user.is_owner ? <Badge status="active" label="Propietario" /> : user.company_id ? <Badge status="invited" label="Miembro" /> : <Badge status="pending" label="Sin empresa" />}
                  </div>
                  <p className="pl-10 text-[10px] font-bold text-muted lg:pl-0">{user.last_sign_in_at ? fmtDay(user.last_sign_in_at) : "Nunca"}</p>
                  <div className="flex justify-end gap-1.5 pl-10 lg:pl-0">
                    <button type="button" onClick={() => void copyEmail(user.email)} title="Copiar correo" className="flex h-8 w-8 items-center justify-center rounded-lg border border-base text-muted">
                      {copied === user.email ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
                    </button>
                    <button type="button" onClick={() => setSelected(user)} className="h-8 rounded-lg border border-base px-2.5 text-[10px] font-black text-primary">Ficha</button>
                  </div>
                </div>
              ))}
            </div>
            {paged.slice.length === 0 ? <div className="p-3"><Empty title="Sin usuarios para este filtro" description="Prueba con otro texto o cambia el filtro." /></div> : null}
          </div>
        ) : null}

        <div className="mt-3"><Pager page={paged.page} pages={paged.pages} total={paged.total} onPage={setPage} /></div>
        <p className="mt-2 text-[9px] leading-4 text-muted">Directorio de solo lectura: altas y contraseñas se gestionan desde el acceso del propio usuario o desde Supabase Auth.</p>
      </SectionCard>

      {selected ? <UserDetailModal user={selected} onClose={() => setSelected(null)} /> : null}
    </div>
  );
}

function UserDetailModal({ user, onClose }: { user: PlatformUser; onClose: () => void }) {
  const [detail, setDetail] = useState<PlatformUserDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    loadPlatformUserDetail(user.user_id)
      .then((value) => { if (active) setDetail(value); })
      .catch((err) => { if (active) setError(err?.message || "No se pudo cargar la ficha."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [user.user_id]);

  return (
    <Modal title={user.full_name || user.email || "Usuario"} description="Identidad, empresas y accesos registrados." onClose={onClose} wide
      footer={<button type="button" onClick={onClose} className="h-10 rounded-xl border border-base px-4 text-xs font-black text-primary">Cerrar</button>}>
      {loading ? <p className="text-xs font-bold text-muted">Cargando ficha…</p> : null}
      {error ? <div className="rounded-xl border border-rose-200 bg-rose-50 p-2.5 text-[11px] font-bold text-rose-700">{error}</div> : null}

      <div className="space-y-3">
        <div className="rounded-2xl border border-base bg-primary p-3.5">
          <div className="grid gap-2 sm:grid-cols-2">
            <Info icon={<Mail className="h-3.5 w-3.5" />} label="Correo" value={user.email || "—"} />
            <Info icon={<Phone className="h-3.5 w-3.5" />} label="Teléfono" value={user.phone || "—"} />
            <Info icon={<UserRound className="h-3.5 w-3.5" />} label="Registro" value={fmtDate(user.created_at)} />
            <Info icon={<ShieldCheck className="h-3.5 w-3.5" />} label="Correo confirmado" value={user.email_confirmed ? "Sí" : "No"} />
            <Info icon={<UsersRound className="h-3.5 w-3.5" />} label="Último acceso" value={fmtDate(user.last_sign_in_at)} />
            <Info icon={<ShieldCheck className="h-3.5 w-3.5" />} label="Tipo de cuenta" value={user.is_platform_admin ? "Administrador de plataforma" : user.is_owner ? "Propietario de empresa" : user.company_id ? "Miembro de empresa" : "Sin empresa"} />
          </div>
        </div>

        {detail ? (
          <div className="grid gap-3 lg:grid-cols-2">
            <div className="rounded-2xl border border-base bg-primary p-3">
              <p className="text-[9px] font-black uppercase tracking-[.16em] text-muted">Empresas</p>
              {detail.memberships.length === 0 ? <p className="mt-1.5 text-[10px] font-bold text-muted">Sin membresías.</p> : detail.memberships.map((membership) => (
                <div key={membership.company_id} className="mt-1.5 flex items-start justify-between gap-2 border-b border-base pb-1.5 last:border-0">
                  <div className="min-w-0">
                    <p className="truncate text-[11px] font-black text-primary">{membership.company_name || membership.company_id.slice(0, 8)}</p>
                    <p className="text-[9px] font-bold text-muted">{membership.is_owner ? "Propietario" : "Miembro"} · {statusLabel(membership.status)} · {fmtDay(membership.joined_at)}</p>
                  </div>
                  <Badge status={membership.account_status} />
                </div>
              ))}
            </div>
            <div className="rounded-2xl border border-base bg-primary p-3">
              <p className="text-[9px] font-black uppercase tracking-[.16em] text-muted">Fichas de empleado</p>
              {detail.employees.length === 0 ? <p className="mt-1.5 text-[10px] font-bold text-muted">Sin fichas de empleado.</p> : detail.employees.map((employee) => (
                <div key={employee.id} className="mt-1.5 flex items-center justify-between gap-2 border-b border-base pb-1.5 last:border-0">
                  <div className="min-w-0">
                    <p className="truncate text-[11px] font-black text-primary">{employee.full_name || employee.employee_code || "Empleado"}</p>
                    <p className="truncate text-[9px] font-bold text-muted">{employee.company_name || "Empresa"} · {employee.employee_code || "Sin código"}</p>
                  </div>
                  <Badge status={employee.active ? "active" : "suspended"} />
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

function Info({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-start gap-2">
      <span className="mt-0.5 text-violet-500">{icon}</span>
      <div className="min-w-0">
        <p className="text-[9px] font-black uppercase tracking-wide text-muted">{label}</p>
        <p className="truncate text-[11px] font-bold text-primary">{value}</p>
      </div>
    </div>
  );
}
