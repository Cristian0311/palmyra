import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  BadgeCheck,
  Building2,
  IdCard,
  Mail,
  Phone,
  RefreshCw,
  Search,
  ShieldCheck,
  Users,
} from "lucide-react";
import {
  adminErrorMessage,
  loadPlatformUserDetail,
  loadPlatformUsers,
  type PlatformUser,
  type PlatformUserDetail,
} from "../platformAdminApi";
import { Button, EmptyPanel, LoadingBlock, Modal, StatusBadge, formatDate, statusLabel } from "../shared";

type SortKey = "created" | "access" | "name" | "company";

function displayName(user: PlatformUser) {
  return user.full_name || user.email || "Usuario sin nombre";
}

function userInitial(user: PlatformUser) {
  return displayName(user).slice(0, 1).toUpperCase();
}

export default function UsersView() {
  const [users, setUsers] = useState<PlatformUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [role, setRole] = useState("all");
  const [sort, setSort] = useState<SortKey>("created");
  const [selected, setSelected] = useState<PlatformUser | null>(null);

  const refresh = async () => {
    setLoading(true);
    setError("");
    try {
      setUsers(await loadPlatformUsers(undefined, 400));
    } catch (err) {
      setError(adminErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void refresh(); }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = users.filter((user) => {
      const matchesQuery = !q || [user.full_name, user.email, user.phone, user.company_name]
        .some((value) => String(value || "").toLowerCase().includes(q));
      const matchesRole =
        role === "all" ||
        (role === "owner" && user.is_owner) ||
        (role === "member" && !user.is_owner) ||
        (role === "admin" && user.is_platform_admin);
      return matchesQuery && matchesRole;
    });
    return [...rows].sort((a, b) => {
      if (sort === "name") return displayName(a).localeCompare(displayName(b), "es");
      if (sort === "company") return String(a.company_name || "").localeCompare(String(b.company_name || ""), "es");
      if (sort === "access") return String(b.last_sign_in_at || "").localeCompare(String(a.last_sign_in_at || ""));
      return String(b.created_at || "").localeCompare(String(a.created_at || ""));
    });
  }, [users, query, role, sort]);

  const withCompany = users.filter((user) => user.company_id).length;
  const owners = users.filter((user) => user.is_owner).length;

  return (
    <div className="admin-content-stack">
      <section className="admin-page-head">
        <div>
          <p className="admin-eyebrow">USUARIOS</p>
          <h1>Directorio de personas de la plataforma.</h1>
          <p>Consulta quién usa PALMYRA, en qué empresa y con qué rol. Es un directorio de solo lectura: no permite suplantar sesiones ni cambiar contraseñas.</p>
        </div>
        <div className="admin-page-count"><strong>{filtered.length}</strong><span>visibles</span></div>
      </section>

      <section className="admin-callout-row">
        <article className="admin-inline-stat"><Users size={15} /><div><strong>{users.length}</strong><span>cuentas cargadas</span></div></article>
        <article className="admin-inline-stat"><Building2 size={15} /><div><strong>{withCompany}</strong><span>con empresa activa</span></div></article>
        <article className="admin-inline-stat"><ShieldCheck size={15} /><div><strong>{owners}</strong><span>propietarios</span></div></article>
      </section>

      <section className="admin-toolbar">
        <div className="admin-search">
          <Search size={16} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Buscar por nombre, correo, teléfono o empresa…"
            aria-label="Buscar usuarios"
          />
        </div>
        <div className="admin-toolbar__extra">
          <select value={role} onChange={(event) => setRole(event.target.value)} aria-label="Filtrar por rol">
            <option value="all">Todos los roles</option>
            <option value="owner">Propietarios</option>
            <option value="member">Miembros</option>
            <option value="admin">Administradores de plataforma</option>
          </select>
          <select value={sort} onChange={(event) => setSort(event.target.value as SortKey)} aria-label="Ordenar usuarios">
            <option value="created">Registro más reciente</option>
            <option value="access">Último acceso</option>
            <option value="name">Nombre</option>
            <option value="company">Empresa</option>
          </select>
          <Button onClick={() => void refresh()} disabled={loading}>
            <RefreshCw size={14} className={loading ? "spin" : ""} />Actualizar
          </Button>
        </div>
      </section>

      {error ? (
        <div className="admin-global-error" role="alert">
          <AlertCircle size={16} />{error}
          <Button variant="ghost" onClick={() => void refresh()}>Reintentar</Button>
        </div>
      ) : null}

      <section className="admin-panel admin-table-panel">
        <div className="admin-panel__head">
          <div><p className="admin-kicker">DIRECTORIO</p><h2>{loading ? "Cargando usuarios…" : `${filtered.length} usuario(s)`}</h2></div>
          <Users size={17} />
        </div>

        {loading ? <LoadingBlock label="Leyendo el directorio de usuarios…" /> : null}

        {!loading && !error && filtered.length === 0 ? (
          <EmptyPanel
            title="No hay usuarios con esos filtros"
            description="Prueba con otro nombre, correo o empresa, o limpia los filtros para ver el directorio completo."
            action={<Button onClick={() => { setQuery(""); setRole("all"); }}>Limpiar filtros</Button>}
          />
        ) : null}

        {!loading && filtered.length > 0 ? (
          <div className="admin-data-table admin-data-table--users">
            <div className="admin-data-head" aria-hidden="true">
              <span>Usuario</span><span>Empresa</span><span>Rol</span><span>Último acceso</span><span>Registro</span><span />
            </div>
            {filtered.map((user) => (
              <button key={user.user_id} type="button" className="admin-data-row" onClick={() => setSelected(user)}>
                <span className="admin-user-cell">
                  <span className="admin-company-avatar admin-company-avatar--small">{userInitial(user)}</span>
                  <span className="admin-user-cell__text">
                    <strong>{displayName(user)}{user.is_platform_admin ? <em className="admin-mini-flag">Admin</em> : null}</strong>
                    <small>{user.email || "Sin correo"}{user.phone ? ` · ${user.phone}` : ""}</small>
                  </span>
                </span>
                <span className="admin-table-cell">{user.company_name || "Sin empresa"}</span>
                <span className="admin-table-cell">
                  {user.is_owner ? "Propietario" : user.company_id ? "Miembro" : "Sin membresía"}
                  {user.membership_status ? <small>{statusLabel(user.membership_status)}</small> : null}
                  <small className={user.email_confirmed ? "admin-confirmed" : ""}>{user.email_confirmed ? "Correo confirmado" : "Sin confirmar"}</small>
                </span>
                <span className="admin-table-cell">{user.last_sign_in_at ? formatDate(user.last_sign_in_at) : "Nunca"}</span>
                <span className="admin-table-cell">{formatDate(user.created_at)}</span>
                <span className="admin-table-cell admin-table-cell--action">Ver ficha</span>
              </button>
            ))}
          </div>
        ) : null}
      </section>

      {selected ? <UserDetailModal user={selected} onClose={() => setSelected(null)} /> : null}
    </div>
  );
}

function UserDetailModal({ user, onClose }: { user: PlatformUser; onClose: () => void }) {
  const [detail, setDetail] = useState<PlatformUserDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      setDetail(await loadPlatformUserDetail(user.user_id));
    } catch (err) {
      setError(adminErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, [user.user_id]);

  const profile = detail?.user || user;

  return (
    <Modal
      title={displayName(user)}
      description="Ficha de solo lectura: datos de la cuenta, membresías y registros de empleado."
      onClose={onClose}
      wide
      footer={<Button variant="secondary" onClick={onClose}>Cerrar</Button>}
    >
      {loading ? <LoadingBlock label="Cargando ficha del usuario…" /> : null}
      {error ? (
        <div className="admin-global-error" role="alert">
          <AlertCircle size={16} />{error}
          <Button variant="ghost" onClick={() => void load()}>Reintentar</Button>
        </div>
      ) : null}

      {detail ? (
        <>
          <section className="admin-user-hero">
            <span className="admin-company-avatar">{userInitial(profile)}</span>
            <div>
              <h3>{displayName(profile)}</h3>
              <p>{profile.email || "Sin correo"} · {profile.phone || "Sin teléfono"}</p>
            </div>
            <div className="admin-user-hero__flags">
              {profile.is_platform_admin ? <span className="admin-status admin-status--green"><span />Administrador</span> : null}
              {profile.is_owner ? <span className="admin-status admin-status--amber"><span />Propietario</span> : null}
              <span className={`admin-status ${profile.email_confirmed ? "admin-status--green" : "admin-status--slate"}`}><span />{profile.email_confirmed ? "Correo confirmado" : "Correo sin confirmar"}</span>
            </div>
          </section>

          <section className="admin-detail-grid">
            <div className="admin-detail-block">
              <p className="admin-kicker">CUENTA</p>
              <dl className="admin-kv">
                <div><dt>Identificador</dt><dd className="admin-mono">{profile.user_id}</dd></div>
                <div><dt>Registro</dt><dd>{formatDate(profile.created_at)}</dd></div>
                <div><dt>Último acceso</dt><dd>{profile.last_sign_in_at ? formatDate(profile.last_sign_in_at) : "Nunca"}</dd></div>
                <div><dt>Idioma</dt><dd>{profile.locale || "—"}</dd></div>
                <div><dt>Empresa activa</dt><dd>{profile.company_name || profile.active_company_id || "—"}</dd></div>
              </dl>
            </div>
            <div className="admin-detail-block">
              <p className="admin-kicker">CONTACTO</p>
              <dl className="admin-kv">
                <div><dt>Correo</dt><dd className="admin-break">{profile.email || "—"}</dd></div>
                <div><dt>Teléfono</dt><dd>{profile.phone || "—"}</dd></div>
              </dl>
              <div className="admin-user-actions">
                {profile.email ? <a className="admin-btn admin-btn--secondary" href={`mailto:${profile.email}`}><Mail size={14} />Escribir</a> : null}
                {profile.phone ? <a className="admin-btn admin-btn--secondary" href={`https://wa.me/${profile.phone.replace(/\D/g, "")}`} target="_blank" rel="noreferrer"><Phone size={14} />WhatsApp</a> : null}
              </div>
            </div>
          </section>

          <section className="admin-console-section">
            <div><p className="admin-kicker"><Building2 size={12} /> MEMBRESÍAS</p><h3>Empresas a las que pertenece</h3></div>
            {detail.memberships.length === 0 ? <p className="admin-muted">Este usuario no pertenece a ninguna empresa.</p> : (
              <div className="admin-data-table admin-data-table--plain">
                {detail.memberships.map((membership) => (
                  <div key={membership.company_id} className="admin-simple-row">
                    <span className="admin-simple-row__main">
                      <strong>{membership.company_name || membership.company_id}</strong>
                      <small className="admin-break">{membership.company_id}</small>
                    </span>
                    <span>{membership.is_owner ? "Propietario" : "Miembro"}</span>
                    <span><StatusBadge status={membership.status} /></span>
                    <span><StatusBadge status={membership.account_status} /></span>
                    <span className="admin-muted">Desde {formatDate(membership.joined_at)}</span>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="admin-console-section">
            <div><p className="admin-kicker"><IdCard size={12} /> FICHAS DE EMPLEADO</p><h3>Registros operativos vinculados</h3></div>
            {detail.employees.length === 0 ? <p className="admin-muted">Sin fichas de empleado asociadas.</p> : (
              <div className="admin-data-table admin-data-table--plain">
                {detail.employees.map((employee) => (
                  <div key={employee.id} className="admin-simple-row">
                    <span className="admin-simple-row__main">
                      <strong>{employee.full_name || "Empleado"}</strong>
                      <small>{employee.employee_code || "Sin código"}</small>
                    </span>
                    <span>{employee.company_name || "—"}</span>
                    <span><StatusBadge status={employee.active ? "active" : "suspended"} /></span>
                    <span className="admin-muted">{formatDate(employee.created_at)}</span>
                  </div>
                ))}
              </div>
            )}
          </section>

          <p className="admin-form-hint">
            PALMYRA Admin no puede iniciar sesión como este usuario, cambiar su contraseña ni editar su correo. Esos cambios se hacen desde la cuenta del propio usuario o desde Supabase Auth.
          </p>
          <p className="admin-form-hint admin-inline-note"><BadgeCheck size={13} /> Datos leídos con {`get_platform_user_detail`}.</p>
        </>
      ) : null}
    </Modal>
  );
}
