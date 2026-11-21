import { useEffect, useMemo, useState } from "react";
import {
  CalendarClock,
  Check,
  Copy,
  Gauge,
  History,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  StickyNote,
  Users,
  XCircle,
} from "lucide-react";
import {
  adminErrorMessage,
  changeCompanyStatus,
  loadAdminAudit,
  loadCompanyConsole,
  loadCompanyDetail,
  loadPlatformPlans,
  saveCompanyNote,
  setCompanyPlan,
  updateCompanyProfile,
  updateCompanySubscriptionDates,
  type PlatformAuditEntry,
  type PlatformCompany,
  type PlatformCompanyConsole,
  type PlatformCompanyDetail,
  type PlatformPlan,
} from "../platformAdminApi";
import { Button, EmptyPanel, Modal, StatusBadge, formatDate, formatDay, formatMoney, methodLabel, statusLabel } from "../shared";

const STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "active", label: "Activa" },
  { value: "pending_payment", label: "Pago pendiente" },
  { value: "setup", label: "En configuración" },
  { value: "suspended", label: "Suspendida" },
];

const SUBSCRIPTION_STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "active", label: "Activa" },
  { value: "trialing", label: "En prueba" },
  { value: "past_due", label: "En gracia" },
  { value: "cancelled", label: "Cancelada" },
  { value: "expired", label: "Vencida" },
];

const CURRENCIES = ["CUP", "USD", "MLC", "EUR"];

const FEATURE_LABELS: Record<string, string> = {
  pos: "Punto de venta",
  cash: "Caja",
  inventory: "Inventario",
  offline: "Modo offline",
  basic_reports: "Reportes básicos",
  cloud_backup: "Respaldo en la nube",
  custom_roles: "Roles personalizados",
  transfers: "Transferencias",
  purchases: "Compras",
  inventory_audit: "Auditoría de inventario",
  advanced_reports: "Reportes avanzados",
  banking: "Bancos",
  multi_warehouse: "Multi-almacén",
  advanced_analytics: "Analítica avanzada",
  customers_suppliers: "Clientes y proveedores",
  visual_style: "Estilo visual",
  excel_exports: "Exportar a Excel",
  ai_dashboard: "Dashboard IA",
  warranty_returns: "Devoluciones y garantías",
  abc_analysis: "Análisis ABC",
  labels: "Etiquetas",
};

const ACTION_LABELS: Record<string, string> = {
  "plan_request.created": "Solicitud creada",
  "plan_request.approved": "Plan aprobado",
  "plan_request.rejected": "Solicitud rechazada",
  "plan_request.cancelled": "Solicitud cancelada",
  "company.status_changed": "Cambio de estado",
  "company.plan_assigned": "Plan asignado manualmente",
  "company.profile_updated": "Datos de la empresa",
  "company.note_updated": "Nota interna",
  "company.subscription_dates_updated": "Fechas de suscripción",
  "subscription.created": "Suscripción creada",
  "subscription.updated": "Suscripción actualizada",
  "support.status_changed": "Soporte actualizado",
};

const DETAIL_LABELS: Record<string, string> = {
  from: "antes",
  to: "después",
  plan_code: "plan",
  months: "meses",
  note: "nota",
  status: "estado",
  trial_ends_at: "fin de prueba",
  current_period_end: "vence",
  grace_ends_at: "fin de gracia",
  name: "nombre",
  slug: "identificador",
  currency: "moneda",
  length: "caracteres",
};

function renderDetail(detail?: Record<string, unknown>) {
  if (!detail) return "";
  return Object.entries(detail)
    .filter(([, value]) => value != null && value !== "" && typeof value !== "object")
    .slice(0, 6)
    .map(([key, value]) => `${DETAIL_LABELS[key] || key}: ${String(value)}`)
    .join(" · ");
}

function toDateTimeInput(value?: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function fromDateTimeInput(value: string) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function addMonths(date: Date, months: number) {
  const next = new Date(date);
  next.setMonth(next.getMonth() + months);
  return next;
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function daysUntil(value?: string | null) {
  if (!value) return null;
  const target = new Date(value).getTime();
  if (Number.isNaN(target)) return null;
  return Math.ceil((target - Date.now()) / 86400000);
}

function usagePercent(used: number, limit: unknown) {
  const max = Number(limit);
  if (!Number.isFinite(max) || max <= 0) return null;
  return Math.min(100, Math.round((used / max) * 100));
}

function planFeatureKeys(plan: PlatformCompanyConsole["plan"]) {
  const features = plan?.features || {};
  const keys = Array.isArray(features.feature_keys) ? features.feature_keys : [];
  const normalized = keys.filter((key): key is string => typeof key === "string");
  if (normalized.length) return normalized;
  return Array.isArray(features.features) ? features.features.filter((item): item is string => typeof item === "string") : [];
}

function CompanyRow({
  company,
  busy,
  onToggle,
  onOpen,
}: {
  company: PlatformCompany;
  busy: boolean;
  onToggle: (company: PlatformCompany) => void;
  onOpen: (company: PlatformCompany) => void;
}) {
  const suspended = company.account_status === "suspended";
  const free = company.plan_code === "free";
  const days = daysUntil(company.period_end);
  const expiringSoon = !free && days != null && days >= 0 && days <= 7;
  const [copied, setCopied] = useState(false);

  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(company.id);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <article className="admin-company-row">
      <div className="admin-company-row__identity">
        <div className="admin-company-avatar">{company.name.slice(0, 1).toUpperCase()}</div>
        <div className="min-w-0">
          <h3>{company.name}</h3>
          <p>{company.slug || company.id}</p>
        </div>
      </div>
      <div><StatusBadge status={company.account_status} /></div>
      <div className="admin-company-row__plan">
        <span className="admin-plan-chip">{company.plan_name || "Sin plan"}</span>
        <span className={`admin-company-row__sub${expiringSoon ? " admin-expiry" : ""}`}>
          {free
            ? "Sin vencimiento"
            : company.period_end
              ? `Vence ${formatDay(company.period_end)}${expiringSoon ? ` · ${days === 0 ? "hoy" : `${days} día(s)`}` : ""}`
              : statusLabel(company.plan_status)}
        </span>
      </div>
      <div className="admin-company-row__usage">
        <span><strong>{company.products ?? "—"}</strong>prod.</span>
        <span><strong>{company.employees ?? "—"}</strong>usuarios</span>
        <span><strong>{company.warehouses ?? "—"}</strong>almacenes</span>
      </div>
      <div className="admin-company-row__created">Creada {formatDay(company.created_at)}</div>
      <div className="admin-company-row__actions">
        <Button variant="ghost" onClick={() => void copyId()} disabled={busy} className="admin-company-row__copy">
          <Copy size={13} />{copied ? "Copiado" : "ID"}
        </Button>
        <Button variant="primary" disabled={busy} onClick={() => onOpen(company)}>
          <SlidersHorizontal size={13} />Configurar
        </Button>
        <Button disabled={busy} variant={suspended ? "secondary" : "secondary"} onClick={() => onToggle(company)}>
          {suspended ? <Check size={13} /> : <XCircle size={13} />}
          {suspended ? "Reactivar" : "Suspender"}
        </Button>
      </div>
    </article>
  );
}

type ConsoleTab = "cuenta" | "plan" | "uso" | "acceso" | "historial";

function CompanyConsoleModal({
  company,
  plans,
  onClose,
  onChanged,
}: {
  company: PlatformCompany;
  plans: PlatformPlan[];
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [consoleData, setConsoleData] = useState<PlatformCompanyConsole | null>(null);
  const [detail, setDetail] = useState<PlatformCompanyDetail | null>(null);
  const [audit, setAudit] = useState<PlatformAuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [tab, setTab] = useState<ConsoleTab>("cuenta");

  const [name, setName] = useState(company.name);
  const [slug, setSlug] = useState(company.slug || "");
  const [currency, setCurrency] = useState("CUP");
  const [accountStatus, setAccountStatus] = useState(company.account_status || "active");
  const [noteDraft, setNoteDraft] = useState("");

  const [planCode, setPlanCode] = useState(company.plan_code || "starter");
  const [months, setMonths] = useState(1);
  const [planNote, setPlanNote] = useState("");

  const [subStatus, setSubStatus] = useState("active");
  const [trialEnd, setTrialEnd] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [graceEnd, setGraceEnd] = useState("");
  const [dateNote, setDateNote] = useState("");

  const [savingAccount, setSavingAccount] = useState(false);
  const [savingNote, setSavingNote] = useState(false);
  const [applyingPlan, setApplyingPlan] = useState(false);
  const [savingDates, setSavingDates] = useState(false);

  const plan = consoleData?.plan || null;
  const subscription = consoleData?.subscription || null;
  const freePlan = plan?.code === "free";
  const planFeatures = useMemo(() => planFeatureKeys(plan), [plan]);

  const syncForms = (data: PlatformCompanyConsole) => {
    setName(data.company.name);
    setSlug(data.company.slug || "");
    setCurrency(data.company.currency || "CUP");
    setAccountStatus(data.company.account_status || "active");
    setNoteDraft(data.note?.text || "");
    setPlanCode(data.subscription?.plan_code || company.plan_code || "starter");
    setSubStatus(data.subscription?.status || "active");
    setTrialEnd(toDateTimeInput(data.subscription?.trial_ends_at));
    setPeriodEnd(toDateTimeInput(data.subscription?.current_period_end));
    setGraceEnd(toDateTimeInput(data.subscription?.grace_ends_at));
  };

  const reload = async () => {
    setError("");
    try {
      const [consoleResult, detailResult, auditResult] = await Promise.allSettled([
        loadCompanyConsole(company.id),
        loadCompanyDetail(company.id),
        loadAdminAudit(40, company.id),
      ]);
      if (consoleResult.status === "rejected") throw consoleResult.reason;
      if (detailResult.status === "rejected") throw detailResult.reason;
      setConsoleData(consoleResult.value);
      setDetail(detailResult.value);
      setAudit(auditResult.status === "fulfilled" ? auditResult.value : []);
      syncForms(consoleResult.value);
    } catch (err) {
      setError(adminErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setLoading(true);
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company.id]);

  const afterChange = async () => {
    await reload();
    await onChanged();
  };

  const saveAccount = async () => {
    if (!consoleData) return;
    setSavingAccount(true);
    setError("");
    setMessage("");
    try {
      const profileChanged =
        name.trim() !== consoleData.company.name ||
        slug.trim().toLowerCase() !== (consoleData.company.slug || "") ||
        currency !== (consoleData.company.currency || "CUP");
      if (profileChanged) await updateCompanyProfile(company.id, { name, slug, currency });
      if (accountStatus !== (consoleData.company.account_status || "active")) {
        await changeCompanyStatus(company.id, accountStatus as "active" | "suspended" | "setup" | "pending_payment");
      }
      await afterChange();
      setMessage("Datos de la empresa actualizados.");
    } catch (err) {
      setError(adminErrorMessage(err));
    } finally {
      setSavingAccount(false);
    }
  };

  const persistNote = async () => {
    setSavingNote(true);
    setError("");
    setMessage("");
    try {
      await saveCompanyNote(company.id, noteDraft);
      await afterChange();
      setMessage("Nota interna guardada.");
    } catch (err) {
      setError(adminErrorMessage(err));
    } finally {
      setSavingNote(false);
    }
  };

  const applyPlan = async () => {
    const target = plans.find((item) => item.code === planCode);
    if (!target) return;
    const duration = target.code === "free" ? "sin vencimiento" : `${months} mes(es)`;
    if (!window.confirm(`¿Asignar ${target.name} a ${company.name} por ${duration}? Se cancelarán solicitudes pendientes y facturas abiertas.`)) return;
    setApplyingPlan(true);
    setError("");
    setMessage("");
    try {
      const result = await setCompanyPlan(company.id, target.code, months, planNote);
      setPlanNote("");
      await afterChange();
      setMessage(`${result.plan_name} asignado${result.current_period_end ? ` hasta ${formatDay(result.current_period_end)}` : " sin vencimiento"}.`);
    } catch (err) {
      setError(adminErrorMessage(err));
    } finally {
      setApplyingPlan(false);
    }
  };

  const saveDates = async () => {
    setSavingDates(true);
    setError("");
    setMessage("");
    try {
      await updateCompanySubscriptionDates(company.id, {
        status: subStatus,
        trialEndsAt: fromDateTimeInput(trialEnd),
        currentPeriodEnd: fromDateTimeInput(periodEnd),
        graceEndsAt: fromDateTimeInput(graceEnd),
        note: dateNote,
      });
      setDateNote("");
      await afterChange();
      setMessage("Fechas de la suscripción actualizadas.");
    } catch (err) {
      setError(adminErrorMessage(err));
    } finally {
      setSavingDates(false);
    }
  };

  const extendPeriodOneMonth = () => {
    const base = periodEnd ? new Date(periodEnd) : new Date();
    const next = addMonths(base.getTime() < Date.now() ? new Date() : base, 1);
    setPeriodEnd(toDateTimeInput(next.toISOString()));
    if (subStatus === "expired" || subStatus === "cancelled") setSubStatus("active");
  };

  const extendGraceOneWeek = () => {
    const base = periodEnd ? new Date(periodEnd) : graceEnd ? new Date(graceEnd) : new Date();
    const next = addDays(base.getTime() < Date.now() ? new Date() : base, 7);
    setGraceEnd(toDateTimeInput(next.toISOString()));
  };

  const activateFourteenDayTrial = () => {
    const end = addDays(new Date(), 14);
    const iso = toDateTimeInput(end.toISOString());
    setSubStatus("trialing");
    setTrialEnd(iso);
    setPeriodEnd(iso);
  };

  const daysLeft = daysUntil(subscription?.trial_ends_at || subscription?.current_period_end);

  return (
    <Modal
      title={consoleData?.company.name || company.name}
      description="Cuenta, plan, fechas, uso, acceso y auditoría de esta empresa en un solo lugar."
      onClose={onClose}
      wide
    >
      {loading && !consoleData ? <p className="admin-muted">Cargando configuración de la empresa…</p> : null}
      {error ? <div className="admin-alert admin-alert--error">{error}</div> : null}
      {message ? <div className="admin-settings-message admin-settings-message--success">{message}</div> : null}

      {consoleData ? (
        <>
          <div className="admin-console-summary">
            <StatusBadge status={consoleData.company.account_status} />
            <span className="admin-plan-chip">{subscription?.plan_name || "Sin plan"}</span>
            <span>{subscription?.status ? statusLabel(subscription.status) : "Sin suscripción"}</span>
            <span>
              {freePlan
                ? "Sin vencimiento"
                : daysLeft != null
                  ? daysLeft >= 0
                    ? `Quedan ${daysLeft} día(s)`
                    : `Vencida hace ${Math.abs(daysLeft)} día(s)`
                  : "Sin fecha de vencimiento"}
            </span>
            <span>Moneda {consoleData.company.currency || "CUP"}</span>
          </div>

          <nav className="admin-console-tabs" role="tablist" aria-label="Configuración de la empresa">
            {([
              ["cuenta", "Cuenta"],
              ["plan", "Plan y fechas"],
              ["uso", "Uso y límites"],
              ["acceso", "Acceso"],
              ["historial", "Historial"],
            ] as Array<[ConsoleTab, string]>).map(([value, label]) => (
              <button key={value} type="button" role="tab" aria-selected={tab === value} className={tab === value ? "is-active" : ""} onClick={() => setTab(value)}>
                {label}
              </button>
            ))}
          </nav>

          {tab === "cuenta" ? (
            <>
              <section className="admin-console-section">
                <div><p className="admin-kicker">IDENTIDAD</p><h3>Datos de la empresa</h3></div>
                <div className="admin-console-form">
                  <label>Nombre
                    <input value={name} maxLength={120} onChange={(event) => setName(event.target.value)} />
                  </label>
                  <label>Identificador (slug)
                    <input value={slug} maxLength={61} onChange={(event) => setSlug(event.target.value.toLowerCase())} placeholder="mi-empresa" />
                  </label>
                  <label>Moneda base
                    <select value={currency} onChange={(event) => setCurrency(event.target.value)}>
                      {CURRENCIES.map((code) => <option key={code} value={code}>{code}</option>)}
                    </select>
                  </label>
                  <label>Estado de la cuenta
                    <select value={accountStatus} onChange={(event) => setAccountStatus(event.target.value)}>
                      {STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </select>
                  </label>
                  <div className="admin-console-form__wide admin-console-actions">
                    <Button variant="primary" disabled={savingAccount} onClick={() => void saveAccount()}>
                      {savingAccount ? "Guardando…" : "Guardar cambios"}
                    </Button>
                  </div>
                </div>
                <p className="admin-form-hint">
                  Suspender corta el acceso de toda la empresa sin borrar datos; reactivarla lo restaura. La moneda base afecta cómo se muestran los importes en el CRM. Todo queda registrado en Auditoría.
                </p>
              </section>

              <section className="admin-console-section">
                <div><p className="admin-kicker"><StickyNote size={12} /> NOTAS INTERNAS</p><h3>Solo visibles para el equipo PALMYRA</h3></div>
                <div className="admin-console-form">
                  <label className="admin-console-form__wide">Nota
                    <textarea rows={3} maxLength={2000} value={noteDraft} onChange={(event) => setNoteDraft(event.target.value)} placeholder="Acuerdos de pago, incidencias, contexto de la cuenta…" />
                  </label>
                  <div className="admin-console-form__wide admin-console-actions">
                    <Button disabled={savingNote} onClick={() => void persistNote()}>
                      {savingNote ? "Guardando…" : "Guardar nota"}
                    </Button>
                  </div>
                </div>
                {consoleData.note ? (
                  <p className="admin-form-hint">
                    Actualizada {formatDate(consoleData.note.updated_at)} por {consoleData.note.updated_by || "administrador"}.
                  </p>
                ) : null}
              </section>
            </>
          ) : null}

          {tab === "plan" ? (
            <>
              <section className="admin-detail-grid">
                <div className="admin-detail-block">
                  <p className="admin-kicker">SUSCRIPCIÓN ACTUAL</p>
                  <h3>{subscription?.plan_name || "Sin plan"}</h3>
                  <dl className="admin-kv">
                    <div><dt>Estado</dt><dd>{statusLabel(subscription?.status)}</dd></div>
                    <div><dt>Precio</dt><dd>{formatMoney(subscription?.monthly_price, "USD")}/mes</dd></div>
                    <div><dt>Fin de prueba</dt><dd>{subscription?.trial_ends_at ? formatDay(subscription.trial_ends_at) : "—"}</dd></div>
                    <div><dt>Vence</dt><dd>{subscription?.current_period_end ? formatDay(subscription.current_period_end) : "Sin vencimiento"}</dd></div>
                    <div><dt>Fin de gracia</dt><dd>{subscription?.grace_ends_at ? formatDay(subscription.grace_ends_at) : "—"}</dd></div>
                    <div><dt>Cancelada</dt><dd>{subscription?.cancelled_at ? formatDay(subscription.cancelled_at) : "—"}</dd></div>
                  </dl>
                </div>
                <div className="admin-detail-block">
                  <p className="admin-kicker">OPERACIÓN</p>
                  <h3>Consumo actual</h3>
                  <dl className="admin-kv">
                    <div><dt>Productos</dt><dd>{consoleData.counts.products}</dd></div>
                    <div><dt>Empleados</dt><dd>{consoleData.counts.employees}</dd></div>
                    <div><dt>Almacenes</dt><dd>{consoleData.counts.warehouses}</dd></div>
                    <div><dt>Dispositivos</dt><dd>{consoleData.counts.devices}</dd></div>
                  </dl>
                </div>
              </section>

              <section className="admin-detail-block">
                <div className="admin-detail-block__head">
                  <div><p className="admin-kicker">ADMINISTRACIÓN</p><h3>Asignar o extender plan</h3></div>
                  <CalendarClock size={17} />
                </div>
                <div className="admin-plan-form">
                  <label>Plan
                    <select value={planCode} onChange={(event) => setPlanCode(event.target.value)}>
                      {plans.map((item) => <option key={item.code} value={item.code}>{item.name} · {formatMoney(item.monthly_price, "USD")}/mes</option>)}
                    </select>
                  </label>
                  <label>Duración
                    <select value={months} disabled={planCode === "free"} onChange={(event) => setMonths(Number(event.target.value))}>
                      {[1, 3, 6, 12].map((value) => <option key={value} value={value}>{value} mes(es)</option>)}
                    </select>
                  </label>
                  <Button variant="primary" disabled={applyingPlan || plans.length === 0} onClick={() => void applyPlan()}>
                    {applyingPlan ? "Aplicando…" : "Asignar plan"}
                  </Button>
                  <label className="admin-plan-form__note">Nota interna (opcional)
                    <input value={planNote} onChange={(event) => setPlanNote(event.target.value)} placeholder="Ej.: pago recibido en efectivo" />
                  </label>
                </div>
                <p className="admin-form-hint">
                  La asignación manual activa la empresa, extiende desde el vencimiento actual si es el mismo plan y anula facturas abiertas.
                </p>
              </section>

              <section className="admin-detail-block">
                <div className="admin-detail-block__head">
                  <div><p className="admin-kicker">FECHAS Y ESTADO</p><h3>Ajustar suscripción</h3></div>
                  <CalendarClock size={17} />
                </div>
                <div className="admin-console-form">
                  <label>Estado de suscripción
                    <select value={subStatus} onChange={(event) => setSubStatus(event.target.value)} disabled={freePlan}>
                      {SUBSCRIPTION_STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </select>
                  </label>
                  <label>Fin de prueba
                    <input type="datetime-local" value={trialEnd} onChange={(event) => setTrialEnd(event.target.value)} disabled={freePlan} />
                  </label>
                  <label>Fin de período
                    <input type="datetime-local" value={periodEnd} onChange={(event) => setPeriodEnd(event.target.value)} disabled={freePlan} />
                  </label>
                  <label>Fin de gracia
                    <input type="datetime-local" value={graceEnd} onChange={(event) => setGraceEnd(event.target.value)} disabled={freePlan} />
                  </label>
                  <label className="admin-console-form__wide">Nota interna (opcional)
                    <input value={dateNote} onChange={(event) => setDateNote(event.target.value)} placeholder="Motivo del ajuste" />
                  </label>
                  <div className="admin-console-form__wide admin-console-actions admin-console-actions--split">
                    <span className="admin-quick-actions">
                      <Button variant="ghost" disabled={freePlan} onClick={extendPeriodOneMonth}>+1 mes</Button>
                      <Button variant="ghost" disabled={freePlan} onClick={extendGraceOneWeek}>+7 días de gracia</Button>
                      <Button variant="ghost" disabled={freePlan} onClick={activateFourteenDayTrial}>Prueba de 14 días</Button>
                    </span>
                    <Button variant="primary" disabled={savingDates || freePlan} onClick={() => void saveDates()}>
                      {savingDates ? "Guardando…" : "Guardar fechas"}
                    </Button>
                  </div>
                </div>
                <p className="admin-form-hint">
                  {freePlan
                    ? "El plan Gratis no vence: no admite fechas de prueba ni de período."
                    : "Guardar fechas no cambia el plan. Activar prueba exige fin de prueba; una suscripción activa exige fin de período. Queda en Auditoría."}
                </p>
              </section>
            </>
          ) : null}

          {tab === "uso" ? (
            <>
              <section className="admin-console-section">
                <div><p className="admin-kicker"><Gauge size={12} /> CAPACIDAD</p><h3>Consumo frente a los límites del plan</h3></div>
                <div className="admin-usage-grid">
                  {([
                    ["Productos", consoleData.counts.products, plan?.limits?.products],
                    ["Empleados", consoleData.counts.employees, plan?.limits?.employees],
                    ["Almacenes", consoleData.counts.warehouses, plan?.limits?.warehouses],
                  ] as Array<[string, number, unknown]>).map(([label, used, limit]) => {
                    const percent = usagePercent(used, limit);
                    const warning = percent != null && percent >= 90;
                    return (
                      <article key={label} className="admin-usage-card">
                        <header><span>{label}</span><b>{used} / {Number.isFinite(Number(limit)) ? String(limit) : "∞"}</b></header>
                        <div className={`admin-usage-bar${warning ? " is-warning" : ""}`}><i style={{ width: `${percent ?? 6}%` }} /></div>
                        <small>{percent == null ? "Sin límite definido" : `${percent}% usado${warning ? " · cerca del límite" : ""}`}</small>
                      </article>
                    );
                  })}
                </div>
                <p className="admin-form-hint">Dispositivos activos: {consoleData.counts.devices}. Los límites cambian solo cambiando de plan.</p>
              </section>

              <section className="admin-console-section">
                <div><p className="admin-kicker"><ShieldCheck size={12} /> FUNCIONES INCLUIDAS</p><h3>Lo que este plan habilita</h3></div>
                <div className="admin-feature-list">
                  {planFeatures.length === 0 ? <p className="admin-muted">Este plan no declara funciones específicas.</p> :
                    planFeatures.map((key) => <span key={key} className="admin-feature-chip"><Check size={11} />{FEATURE_LABELS[key] || key}</span>)}
                </div>
                <p className="admin-form-hint">
                  Reportes: {String(plan?.limits?.reports || "básicos")} · Soporte: {String(plan?.limits?.support || "estándar")} · Almacenamiento: {FEATURE_LABELS[String(plan?.features?.storage_mode || "cloud_backup")] || String(plan?.features?.storage_mode || "cloud_backup")}
                </p>
              </section>
            </>
          ) : null}

          {tab === "acceso" ? (
            <section className="admin-console-section">
              <div><p className="admin-kicker"><Users size={12} /> EQUIPO</p><h3>Propietario y miembros</h3></div>
              {consoleData.owner ? (
                <div className="admin-detail-block">
                  <p className="admin-kicker">PROPIETARIO</p>
                  <dl className="admin-kv">
                    <div><dt>Nombre</dt><dd>{consoleData.owner.full_name || "—"}</dd></div>
                    <div><dt>Correo</dt><dd>{consoleData.owner.email || "—"}</dd></div>
                    <div><dt>Teléfono</dt><dd>{consoleData.owner.phone || "—"}</dd></div>
                    <div><dt>Estado</dt><dd>{statusLabel(consoleData.company.account_status)}</dd></div>
                  </dl>
                </div>
              ) : <p className="admin-muted">No se encontró un propietario registrado.</p>}

              <div className="admin-member-list">
                {consoleData.members.length === 0 ? <p className="admin-muted">Sin miembros registrados.</p> : consoleData.members.map((member) => (
                  <div key={member.user_id} className="admin-member-row">
                    <div>
                      <strong>{member.full_name || member.email || "Usuario"}</strong>
                      <span>{member.email || "Sin correo"}</span>
                    </div>
                    <div><span>{member.roles || (member.is_owner ? "Propietario" : "Sin rol")}</span></div>
                    <div><StatusBadge status={member.status} /></div>
                  </div>
                ))}
              </div>
              <p className="admin-form-hint">
                Las contraseñas y el doble factor se gestionan desde el correo del propietario; el administrador no puede verlas ni cambiarlas. Suspender la cuenta corta el acceso de todo el equipo.
              </p>
            </section>
          ) : null}

          {tab === "historial" ? (
            <>
              {detail ? (
                <section className="admin-history">
                  <p className="admin-kicker">MOVIMIENTOS DE FACTURACIÓN</p>
                  <div className="admin-history__grid">
                    <div>
                      <h4>Solicitudes</h4>
                      {detail.requests.length === 0 ? <p className="admin-muted">Sin solicitudes.</p> : detail.requests.map((request) => (
                        <div key={request.id} className="admin-history-row">
                          <div><strong>{request.plan_name || request.plan_code}</strong><span>{request.billing_months || 1} mes(es) · {formatDate(request.requested_at)}</span></div>
                          <div className="admin-history-row__end"><StatusBadge status={request.status} /><span>{formatMoney(request.quoted_amount, request.quoted_currency || "USD")}</span></div>
                        </div>
                      ))}
                    </div>
                    <div>
                      <h4>Facturas</h4>
                      {detail.invoices.length === 0 ? <p className="admin-muted">Sin facturas.</p> : detail.invoices.map((invoice) => (
                        <div key={`${invoice.invoice_number}-${invoice.created_at}`} className="admin-history-row">
                          <div><strong>{invoice.invoice_number}</strong><span>{formatDate(invoice.created_at)}</span></div>
                          <div className="admin-history-row__end"><StatusBadge status={invoice.status} /><span>{formatMoney(invoice.amount, invoice.currency)}</span></div>
                        </div>
                      ))}
                    </div>
                    <div>
                      <h4>Pagos</h4>
                      {detail.payments.length === 0 ? <p className="admin-muted">Sin pagos registrados.</p> : detail.payments.map((payment) => (
                        <div key={payment.id} className="admin-history-row">
                          <div><strong>{formatMoney(payment.amount, payment.currency)}</strong><span>{methodLabel(payment.payment_method)} · {formatDate(payment.paid_at || payment.created_at)}</span><span className="admin-history-ref">{payment.reference || "Sin referencia"}</span></div>
                          <div className="admin-history-row__end"><StatusBadge status={payment.status} /></div>
                        </div>
                      ))}
                    </div>
                  </div>
                </section>
              ) : null}

              <section className="admin-panel">
                <div className="admin-panel__head">
                  <div><p className="admin-kicker"><History size={12} /> AUDITORÍA</p><h2>Acciones administrativas de esta empresa</h2></div>
                  <ShieldCheck size={17} />
                </div>
                {audit.length === 0 ? <p className="admin-muted">Sin acciones administrativas registradas.</p> : (
                  <div className="admin-audit-list">
                    {audit.map((entry) => (
                      <article key={entry.id} className="admin-audit-row">
                        <span className="admin-audit-dot" aria-hidden="true" />
                        <div className="admin-audit-main">
                          <strong>{ACTION_LABELS[entry.action] || entry.action}</strong>
                          <span>{formatDate(entry.created_at)}</span>
                          {renderDetail(entry.detail) ? <span className="admin-audit-detail">{renderDetail(entry.detail)}</span> : null}
                        </div>
                        <span className="admin-audit-actor">{entry.actor_email || "Sistema"}</span>
                      </article>
                    ))}
                  </div>
                )}
              </section>
            </>
          ) : null}
        </>
      ) : null}
    </Modal>
  );
}

export default function CompaniesView({
  companies,
  onChanged,
}: {
  companies: PlatformCompany[];
  onChanged: () => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [planFilter, setPlanFilter] = useState("all");
  const [sort, setSort] = useState<"name" | "created" | "expiry">("name");
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<PlatformCompany | null>(null);
  const [plans, setPlans] = useState<PlatformPlan[]>([]);

  const planCodes = useMemo(() => {
    const codes = new Set<string>();
    companies.forEach((company) => { if (company.plan_code) codes.add(company.plan_code); });
    return [...codes].sort();
  }, [companies]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = companies.filter((company) => {
      const matchesSearch = !q || [company.name, company.slug, company.id, company.plan_name].some((v) => String(v || "").toLowerCase().includes(q));
      const matchesFilter = filter === "all" || String(company.account_status || "") === filter;
      const matchesPlan = planFilter === "all" || String(company.plan_code || "") === planFilter;
      return matchesSearch && matchesFilter && matchesPlan;
    });
    return [...rows].sort((a, b) => {
      if (sort === "created") return String(b.created_at || "").localeCompare(String(a.created_at || ""));
      if (sort === "expiry") {
        const ax = a.period_end ? new Date(a.period_end).getTime() : Number.POSITIVE_INFINITY;
        const bx = b.period_end ? new Date(b.period_end).getTime() : Number.POSITIVE_INFINITY;
        return ax - bx;
      }
      return a.name.localeCompare(b.name, "es");
    });
  }, [companies, query, filter, planFilter, sort]);

  const toggle = async (company: PlatformCompany) => {
    const next = company.account_status === "suspended" ? "active" : "suspended";
    if (!window.confirm(next === "suspended" ? `¿Suspender ${company.name}? Se cortará el acceso de todo el equipo.` : `¿Reactivar ${company.name}?`)) return;
    setBusyId(company.id);
    setError("");
    try {
      await changeCompanyStatus(company.id, next);
      await onChanged();
    } catch (err) {
      setError(adminErrorMessage(err));
    } finally {
      setBusyId("");
    }
  };

  const open = async (company: PlatformCompany) => {
    setSelected(company);
    setError("");
    if (plans.length) return;
    try {
      setPlans(await loadPlatformPlans());
    } catch (err) {
      setError(adminErrorMessage(err));
    }
  };

  return (
    <div className="admin-content-stack">
      <section className="admin-page-head">
        <div>
          <p className="admin-eyebrow">EMPRESAS</p>
          <h1>Todos tus clientes, sin perder el contexto.</h1>
          <p>Lista operativa de cada cuenta. Abre <b>Configurar</b> para administrar datos, plan, fechas, límites, acceso e historial sin tocar su operación interna.</p>
        </div>
        <div className="admin-page-count"><strong>{filtered.length}</strong><span>visibles</span></div>
      </section>

      <section className="admin-toolbar admin-toolbar--companies">
        <div className="admin-search"><Search size={16} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar empresa, slug, plan o ID…" /></div>
        <div className="admin-toolbar__extra">
          <select value={planFilter} onChange={(event) => setPlanFilter(event.target.value)} aria-label="Filtrar por plan">
            <option value="all">Todos los planes</option>
            {planCodes.map((code) => <option key={code} value={code}>{statusLabel(code)}</option>)}
          </select>
          <select value={sort} onChange={(event) => setSort(event.target.value as "name" | "created" | "expiry")} aria-label="Ordenar empresas">
            <option value="name">Ordenar por nombre</option>
            <option value="created">Más recientes</option>
            <option value="expiry">Próximas a vencer</option>
          </select>
        </div>
        <div className="admin-filter-row admin-toolbar__span">
          {[
            ["all", "Todas"],
            ["active", "Activas"],
            ["suspended", "Suspendidas"],
            ["pending_payment", "Pago pendiente"],
            ["setup", "Configuración"],
          ].map(([value, label]) => (
            <button key={value} type="button" onClick={() => setFilter(value)} className={filter === value ? "active" : ""}>{label}</button>
          ))}
        </div>
      </section>

      {error ? <div className="admin-global-error">{error}<button type="button" onClick={() => setError("")}>×</button></div> : null}

      <section className="admin-company-list">
        {filtered.map((company) => (
          <CompanyRow key={company.id} company={company} busy={busyId === company.id} onToggle={(item) => void toggle(item)} onOpen={(item) => void open(item)} />
        ))}
        {filtered.length === 0 ? <EmptyPanel title="No encontramos esa empresa" description="Prueba con otro nombre, plan, slug o estado." /> : null}
      </section>

      {selected ? <CompanyConsoleModal company={selected} plans={plans} onClose={() => setSelected(null)} onChanged={onChanged} /> : null}
    </div>
  );
}
