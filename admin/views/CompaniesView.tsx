import { useMemo, useState } from "react";
import { Check, Search, XCircle } from "lucide-react";
import type { PlatformCompany } from "../platformAdminApi";
import { Button, EmptyPanel, StatusBadge, formatDate } from "../shared";

function CompanyCard({
  company,
  busy,
  onToggle,
}: {
  company: PlatformCompany;
  busy: boolean;
  onToggle: (company: PlatformCompany) => void;
}) {
  const suspended = company.account_status === "suspended";
  return (
    <article className="admin-company-card">
      <div className="admin-company-card__head">
        <div className="admin-company-avatar">{company.name.slice(0, 1).toUpperCase()}</div>
        <div className="min-w-0">
          <h3>{company.name}</h3>
          <p>{company.slug || company.id}</p>
        </div>
        <StatusBadge status={company.account_status} />
      </div>
      <div className="admin-company-card__metrics">
        <div><strong>{company.products ?? "—"}</strong><span>Productos</span></div>
        <div><strong>{company.employees ?? "—"}</strong><span>Usuarios</span></div>
        <div><strong>{company.warehouses ?? "—"}</strong><span>Almacenes</span></div>
      </div>
      <div className="admin-company-card__foot">
        <span>Creada {formatDate(company.created_at)}</span>
        <Button disabled={busy} variant={suspended ? "primary" : "secondary"} onClick={() => onToggle(company)}>
          {suspended ? <Check size={14} /> : <XCircle size={14} />}
          {suspended ? "Reactivar" : "Suspender"}
        </Button>
      </div>
    </article>
  );
}

export default function CompaniesView({
  companies,
  busy,
  onToggle,
}: {
  companies: PlatformCompany[];
  busy: boolean;
  onToggle: (company: PlatformCompany) => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return companies.filter((company) => {
      const matchesSearch = !q || [company.name, company.slug, company.id].some((v) => String(v || "").toLowerCase().includes(q));
      const matchesFilter = filter === "all" || String(company.account_status || "") === filter;
      return matchesSearch && matchesFilter;
    });
  }, [companies, query, filter]);

  return (
    <div className="admin-content-stack">
      <section className="admin-page-head">
        <div><p className="admin-eyebrow">EMPRESAS</p><h1>Todos tus clientes, sin perder el contexto.</h1><p>Busca una cuenta, revisa su operación y cambia estados administrativos sin tocar su lógica interna.</p></div>
        <div className="admin-page-count"><strong>{filtered.length}</strong><span>visibles</span></div>
      </section>
      <section className="admin-toolbar">
        <div className="admin-search"><Search size={16} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar empresa, slug o ID..." /></div>
        <div className="admin-filter-row">
          {[
            ["all", "Todas"],
            ["active", "Activas"],
            ["suspended", "Suspendidas"],
            ["pending_payment", "Pago pendiente"],
          ].map(([value, label]) => (
            <button key={value} type="button" onClick={() => setFilter(value)} className={filter === value ? "active" : ""}>{label}</button>
          ))}
        </div>
      </section>
      <section className="admin-company-grid">
        {filtered.map((company) => <CompanyCard key={company.id} company={company} busy={busy} onToggle={onToggle} />)}
        {filtered.length === 0 ? <EmptyPanel title="No encontramos esa empresa" description="Prueba con otro nombre, slug o estado." /> : null}
      </section>
    </div>
  );
}
