import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, Bell, BellRing, Building2, CheckCheck, CreditCard, TicketCheck, UserRound, X } from "lucide-react";
import { loadPlatformSnapshot, type PlatformSnapshot } from "./platformAdminApi";

type NotificationKind = "company" | "plan" | "support" | "user";

type AdminNotification = {
  id: string;
  kind: NotificationKind;
  title: string;
  detail: string;
  at: string;
  view: string;
  read: boolean;
};

type Counters = {
  companies: number;
  planRequests: number;
  supportOpen: number;
  users: number;
};

type StoredState = {
  counters: Counters | null;
  items: AdminNotification[];
  seenIds: { companies: string[]; planRequests: string[] };
};

const STORAGE_KEY = "palmyra_admin_notifications_v1";
const POLL_MS = 2.5 * 60_000;
const CHECK_MIN_GAP_MS = 45_000;
const MAX_ITEMS = 40;

const KIND_META: Record<NotificationKind, { icon: typeof Building2; view: string }> = {
  company: { icon: Building2, view: "companies" },
  plan: { icon: CreditCard, view: "billing" },
  support: { icon: TicketCheck, view: "support" },
  user: { icon: UserRound, view: "users" },
};

function emptyState(): StoredState {
  return { counters: null, items: [], seenIds: { companies: [], planRequests: [] } };
}

function loadState(): StoredState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyState();
    const parsed = JSON.parse(raw) as Partial<StoredState>;
    return {
      counters: parsed.counters && typeof parsed.counters === "object" ? parsed.counters as Counters : null,
      items: Array.isArray(parsed.items) ? parsed.items.slice(0, MAX_ITEMS) : [],
      seenIds: {
        companies: Array.isArray(parsed.seenIds?.companies) ? parsed.seenIds!.companies : [],
        planRequests: Array.isArray(parsed.seenIds?.planRequests) ? parsed.seenIds!.planRequests : [],
      },
    };
  } catch {
    return emptyState();
  }
}

function saveState(state: StoredState) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* almacenamiento lleno o bloqueado */ }
}

function countersFrom(snapshot: PlatformSnapshot): Counters {
  return {
    companies: Number(snapshot.overview?.companies_total ?? snapshot.companies.length) || 0,
    planRequests: Number(snapshot.overview?.pending_plan_requests ?? snapshot.requests.length) || 0,
    supportOpen: (Number(snapshot.overview?.support_open) || 0) + (Number(snapshot.overview?.support_in_progress) || 0),
    users: Number(snapshot.overview?.users_total) || 0,
  };
}

function newestCompanyName(snapshot: PlatformSnapshot): string {
  const sorted = [...snapshot.companies].sort((a, b) =>
    new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime());
  return sorted[0]?.name || "Empresa sin nombre";
}

async function pushBrowserNotification(title: string, body: string) {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try {
    const registration = await navigator.serviceWorker?.ready;
    if (registration) {
      await registration.showNotification(title, {
        body,
        icon: "/pwa-192.png",
        badge: "/pwa-192.png",
        tag: `palmyra-admin-${Date.now()}`,
      });
      return;
    }
  } catch { /* sin service worker: se usa la API directa */ }
  try { new Notification(title, { body, icon: "/pwa-192.png" }); } catch { /* navegador sin permiso */ }
}

function formatWhen(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  const minutes = Math.round((Date.now() - date.getTime()) / 60_000);
  if (minutes < 1) return "ahora";
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  return date.toLocaleDateString("es-CU", { day: "2-digit", month: "short" });
}

export default function AdminNotifications() {
  const [items, setItems] = useState<AdminNotification[]>(() => loadState().items);
  const [open, setOpen] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(
    () => (typeof Notification === "undefined" ? "unsupported" : Notification.permission),
  );
  const stateRef = useRef<StoredState>(loadState());
  const snapshotRef = useRef<PlatformSnapshot | null>(null);
  const lastCheckRef = useRef(0);
  const checkingRef = useRef(false);

  const commit = useCallback((next: StoredState) => {
    stateRef.current = next;
    saveState(next);
    setItems(next.items);
  }, []);

  const check = useCallback(async (force = false) => {
    if (checkingRef.current) return;
    const now = Date.now();
    if (!force && now - lastCheckRef.current < CHECK_MIN_GAP_MS) return;
    lastCheckRef.current = now;
    checkingRef.current = true;
    try {
      const snapshot = await loadPlatformSnapshot();
      snapshotRef.current = snapshot;
      const counters = countersFrom(snapshot);
      const previous = stateRef.current;
      if (!previous.counters) {
        // Primera ejecución: guardar la línea base sin avisar de lo ya existente.
        commit({
          counters,
          items: previous.items,
          seenIds: {
            companies: snapshot.companies.map((company) => company.id).slice(0, 2000),
            planRequests: snapshot.requests.map((request) => request.id).slice(0, 500),
          },
        });
        return;
      }
      const fresh: AdminNotification[] = [];
      const stamp = new Date().toISOString();
      const add = (kind: NotificationKind, title: string, detail: string, id: string) => {
        if (previous.items.some((item) => item.id === id)) return;
        fresh.push({ id, kind, title, detail, at: stamp, view: KIND_META[kind].view, read: false });
      };

      const companyIds = new Set(previous.seenIds.companies);
      const newCompanies = snapshot.companies.filter((company) => !companyIds.has(company.id));
      if (newCompanies.length > 0) {
        add("company", "Nueva empresa registrada", newCompanies.length === 1
          ? `${newCompanies[0].name || newestCompanyName(snapshot)} se unió a PALMYRA.`
          : `${newCompanies.length} empresas nuevas: ${newCompanies.slice(0, 3).map((c) => c.name).filter(Boolean).join(", ")}.`,
        `company:${newCompanies.map((c) => c.id).sort().join(",")}`);
      }

      const requestIds = new Set(previous.seenIds.planRequests);
      const newRequests = snapshot.requests.filter((request) => !requestIds.has(request.id));
      if (newRequests.length > 0) {
        const first = newRequests[0];
        add("plan", "Nueva solicitud de plan", newRequests.length === 1
          ? `${first.company_name || "Empresa"}: ${first.plan_name || first.plan_code || "plan"}${first.billing_months ? ` · ${first.billing_months} mes(es)` : ""}.`
          : `${newRequests.length} solicitudes pendientes de revisión.`,
        `plan:${newRequests.map((r) => r.id).sort().join(",")}`);
      }

      if (counters.supportOpen > previous.counters.supportOpen) {
        add("support", "Nueva solicitud de soporte",
          counters.supportOpen > previous.counters.supportOpen + 1
            ? `Hay ${counters.supportOpen} atenciones abiertas.`
            : "Un cliente abrió una solicitud en el Centro de ayuda.",
          `support:${counters.supportOpen}:${stamp.slice(0, 13)}`);
      }

      if (counters.users > previous.counters.users) {
        add("user", "Nuevo usuario registrado",
          counters.users - previous.counters.users === 1 ? "Se registró una persona nueva." : `${counters.users - previous.counters.users} personas nuevas.`,
          `users:${counters.users}:${stamp.slice(0, 13)}`);
      }

      const nextItems = [...fresh, ...previous.items].slice(0, MAX_ITEMS);
      commit({
        counters,
        items: nextItems,
        seenIds: {
          companies: snapshot.companies.map((company) => company.id).slice(0, 2000),
          planRequests: snapshot.requests.map((request) => request.id).slice(0, 500),
        },
      });
      for (const item of fresh.slice(0, 3)) void pushBrowserNotification(item.title, item.detail);
    } catch {
      // Sin conexión o sesión vencida: el siguiente ciclo reintenta.
    } finally {
      checkingRef.current = false;
    }
  }, [commit]);

  useEffect(() => {
    void check(true);
    const interval = window.setInterval(() => void check(), POLL_MS);
    const onFocus = () => void check();
    const onVisible = () => { if (document.visibilityState === "visible") void check(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [check]);

  const unread = items.filter((item) => !item.read).length;

  const requestPermission = async () => {
    if (typeof Notification === "undefined") return;
    try {
      setPermission(await Notification.requestPermission());
    } catch {
      setPermission(Notification.permission);
    }
  };

  const openItem = (item: AdminNotification) => {
    commit({
      ...stateRef.current,
      items: stateRef.current.items.map((entry) => entry.id === item.id ? { ...entry, read: true } : entry),
    });
    setOpen(false);
    window.location.hash = `#/${item.view}`;
  };

  const markAllRead = () => {
    commit({ ...stateRef.current, items: stateRef.current.items.map((entry) => ({ ...entry, read: true })) });
  };

  return (
    <div className="admin-bell">
      <button
        type="button"
        className={`admin-square-button ${unread > 0 ? "has-alerts" : ""}`}
        aria-label={unread > 0 ? `Notificaciones: ${unread} sin leer` : "Notificaciones"}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {unread > 0 ? <BellRing size={16} /> : <Bell size={16} />}
        {unread > 0 ? <span className="admin-bell__badge">{unread > 9 ? "9+" : unread}</span> : null}
      </button>
      {open ? (
        <>
          <button type="button" className="admin-bell__backdrop" aria-label="Cerrar notificaciones" onClick={() => setOpen(false)} />
          <div className="admin-bell__panel" role="dialog" aria-label="Centro de notificaciones">
            <header>
              <div><strong>Notificaciones</strong><span>{unread > 0 ? `${unread} sin leer` : "Todo al día"}</span></div>
              <button type="button" aria-label="Cerrar" className="admin-bell__close" onClick={() => setOpen(false)}><X size={15} /></button>
            </header>
            {permission === "default" ? (
              <button type="button" className="admin-bell__permission" onClick={() => void requestPermission()}>
                <BellRing size={14} /> Activar avisos del navegador
              </button>
            ) : null}
            {permission === "denied" ? (
              <p className="admin-bell__hint"><AlertCircle size={13} /> Los avisos del navegador están bloqueados; se muestran solo aquí.</p>
            ) : null}
            <div className="admin-bell__list">
              {items.length === 0 ? (
                <p className="admin-bell__empty">Sin novedades todavía. Las empresas nuevas y las solicitudes de plan aparecerán aquí.</p>
              ) : items.map((item) => {
                const Icon = KIND_META[item.kind].icon;
                return (
                  <button
                    type="button"
                    key={item.id}
                    className={`admin-bell__item ${item.read ? "" : "is-unread"}`}
                    onClick={() => openItem(item)}
                  >
                    <span className={`admin-bell__icon admin-bell__icon--${item.kind}`}><Icon size={15} /></span>
                    <span className="admin-bell__copy">
                      <strong>{item.title}</strong>
                      <small>{item.detail}</small>
                      <em>{formatWhen(item.at)}</em>
                    </span>
                  </button>
                );
              })}
            </div>
            {unread > 0 ? (
              <footer>
                <button type="button" onClick={markAllRead}><CheckCheck size={14} /> Marcar todo como leído</button>
              </footer>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
