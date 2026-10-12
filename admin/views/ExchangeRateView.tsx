import { Component, useEffect, useMemo, useState, type ErrorInfo, type FormEvent, type ReactNode } from "react";
import {
  Activity,
  AlertCircle,
  ArrowUpRight,
  BarChart3,
  Building2,
  Check,
  ChevronRight,
  CircleDollarSign,
  Clock3,
  CreditCard,
  Database,
  Package,
  LogOut,
  Menu,
  RefreshCw,
  Search,
  ShoppingCart,
  Settings2,
  Shield,
  Headphones,
  Phone,
  Mail,
  Save,
  ExternalLink,
  Edit3,
  ShieldCheck,
  Sparkles,
  TicketCheck,
  Users,
  X,
  XCircle,
  Banknote,
  MapPinned,
  LockKeyhole,
  FileText,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import {
  approveRequest,
  changeCompanyStatus,
  loadPlatformSnapshot,
  rejectRequest,
  type PlanRequest,
  type PlatformPlan,
  type ExchangeRatePayload,
  type PlatformCompany,
  type PlatformSnapshot,
  type InfrastructureUsage,
  type PlatformControlCenter,
  loadPlatformControlCenter,
  loadInfrastructureUsage,
  loadExchangeRates,
  loadSupportRequests,
  loadSupportSettings,
  saveSupportSettings,
  type PlatformSupportRequest,
  type PlatformSupportSettings,
  loadPlatformPlans,
  retryPlatformSyncItem,
  updatePlatformPlan,
} from "../platformAdminApi";
import { adminSignIn, adminSignOut, adminUser, getAdminSupabase } from "../supabase";
import { Button, StatCard, StatusBadge, EmptyPanel, formatDate, statusLabel, isToday, FileTextIcon } from "../shared";

export default function ExchangeRateView() {
  return (
    <div className="admin-content-stack">
      <section className="admin-page-head">
        <div>
          <p className="admin-eyebrow">TASA DE CAMBIO PALMYRA</p>
          <h1>Referencia informativa del mercado cubano.</h1>
          <p>PALMYRA mostrará las cotizaciones publicadas por la fuente oficial de datos una vez habilitada la integración.</p>
        </div>
        <span className="admin-mini-badge"><LockKeyhole size={11}/> PRÓXIMAMENTE</span>
      </section>

      <section className="admin-coming-soon admin-coming-soon--exchange">
        <div className="admin-coming-soon__icon"><Banknote size={28}/></div>
        <p className="admin-eyebrow">EN DESARROLLO</p>
        <h2>Tasa de Cambio PALMYRA</h2>
        <p>
          Esta sección será exclusivamente informativa. No permitirá configurar una tasa,
          modificar precios del CRM ni funcionará como conversor.
        </p>

        <div className="admin-exchange-preview">
          <div className="admin-exchange-preview__head">
            <div><strong>Cotizaciones por provincia</strong><span>Vista preparada para datos oficiales</span></div>
            <MapPinned size={17}/>
          </div>
          <div className="admin-exchange-preview__columns">
            <span>Provincia</span><span>USD</span><span>EUR</span><span>MLC</span>
          </div>
          {["Pinar del Río","Artemisa","La Habana","Mayabeque","Matanzas","Villa Clara","Cienfuegos","Sancti Spíritus","Ciego de Ávila","Camagüey","Las Tunas","Holguín","Granma","Santiago de Cuba","Guantánamo","Isla de la Juventud"].slice(0,6).map((province) => (
            <div className="admin-exchange-preview__row" key={province}>
              <strong>{province}</strong><span>—</span><span>—</span><span>—</span>
            </div>
          ))}
          <div className="admin-exchange-preview__more">+ provincias restantes cuando la fuente oficial esté habilitada</div>
        </div>

        <div className="admin-coming-soon__note">
          <ShieldCheck size={15}/>
          <span>La integración utilizará la API oficial de elTOQUE cuando sea habilitada. Hasta entonces PALMYRA no mostrará valores inventados.</span>
        </div>
      </section>
    </div>
  );
}
