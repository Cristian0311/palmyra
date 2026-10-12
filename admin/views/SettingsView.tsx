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

export default function SettingsView() {
  const [settings,setSettings] = useState<PlatformSupportSettings>({whatsapp_number:null,support_email:null,privacy_url:null});
  const [form,setForm] = useState({whatsapp_number:"",support_email:"",privacy_url:""});
  const [loading,setLoading] = useState(true);
  const [saving,setSaving] = useState(false);
  const [message,setMessage] = useState("");
  const [error,setError] = useState("");

  const refresh = async () => {
    setLoading(true); setError("");
    try {
      const value=await loadSupportSettings();
      setSettings(value);
      setForm({whatsapp_number:value.whatsapp_number||"",support_email:value.support_email||"",privacy_url:value.privacy_url||""});
    } catch(err) {
      setError(err instanceof Error?err.message:"No se pudo cargar la configuración.");
    } finally { setLoading(false); }
  };

  useEffect(()=>{void refresh()},[]);

  const submit = async (event: FormEvent) => {
    event.preventDefault(); setSaving(true); setMessage(""); setError("");
    try {
      const value=await saveSupportSettings(form);
      setSettings(value);
      setForm({whatsapp_number:value.whatsapp_number||"",support_email:value.support_email||"",privacy_url:value.privacy_url||""});
      setMessage("Configuración guardada correctamente.");
    } catch(err) {
      setError(err instanceof Error?err.message:"No se pudo guardar la configuración.");
    } finally { setSaving(false); }
  };

  return (
    <div className="admin-content-stack">
      <section className="admin-page-head">
        <div><p className="admin-eyebrow">CONFIGURACIÓN</p><h1>Centro de atención de PALMYRA.</h1><p>Define el canal que utilizarán todas las empresas desde el Centro de atención del CRM.</p></div>
        <span className="admin-status admin-status--green"><span/>Protegido por Supabase</span>
      </section>
      <section className="admin-panel admin-support-settings">
        <div className="admin-panel__head"><div><p className="admin-kicker">ATENCIÓN AL CLIENTE</p><h2>Canales oficiales</h2></div><Settings2 size={17}/></div>
        <form className="admin-settings-form" onSubmit={submit}>
          <label><span><Phone size={13}/>WhatsApp de atención</span><div className="admin-field-icon"><Phone size={15}/><input value={form.whatsapp_number} onChange={e=>setForm({...form,whatsapp_number:e.target.value})} placeholder="+53 5555 5555" inputMode="tel"/></div><small>Se limpiará automáticamente a formato numérico al guardar.</small></label>
          <label><span><Mail size={13}/>Correo de soporte</span><div className="admin-field-icon"><Mail size={15}/><input type="email" value={form.support_email} onChange={e=>setForm({...form,support_email:e.target.value})} placeholder="soporte@palmyra.com"/></div></label>
          <label><span><FileText size={13}/>Política y privacidad</span><div className="admin-field-icon"><ExternalLink size={15}/><input type="url" value={form.privacy_url} onChange={e=>setForm({...form,privacy_url:e.target.value})} placeholder="https://…"/></div><small>Opcional. Aparecerá como enlace oficial dentro del CRM.</small></label>
          {error?<div className="admin-settings-message admin-settings-message--error">{error}</div>:null}
          {message?<div className="admin-settings-message admin-settings-message--success">{message}</div>:null}
          <div className="admin-settings-footer"><span>{loading?"Cargando…":settings.whatsapp_number?"Canal configurado y disponible":"Sin canal configurado"}</span><Button type="submit" variant="primary" disabled={saving||loading}><Save size={14}/>{saving?"Guardando…":"Guardar cambios"}</Button></div>
        </form>
      </section>
    </div>
  );
}
