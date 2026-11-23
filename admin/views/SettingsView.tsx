import { useEffect, useState, type FormEvent } from "react";
import { AlertCircle, Check, CheckCircle2, ExternalLink, Facebook, Github, Info, Mail, MessageCircle, Phone, RefreshCw, RotateCcw, Save, Send, Settings2, ShieldAlert, ShieldCheck } from "lucide-react";
import {
  adminErrorMessage,
  loadSupportSettings,
  saveSupportSettings,
  loadPlatformAuthSettings,
  setPlatformEmailConfirmationRequired,
  type PlatformSupportSettings,
  type PlatformAuthSettings,
} from "../platformAdminApi";
import { Button, FileTextIcon, LoadingBlock } from "../shared";
import { loadAlertChannelStatus, OWNER_WHATSAPP, sendAdminTestAlert, type AlertChannelStatus } from "../ownerAlerts";
import { ADMIN_BUILT_AT } from "../adminUpdate";
import { ADMIN_PRODUCT_VERSION } from "../productVersion";

type FormState = {
  whatsapp_number: string;
  support_email: string;
  privacy_url: string;
  facebook_url: string;
  whatsapp_channel_url: string;
};

type FormKey = keyof FormState;

const EMPTY_FORM: FormState = { whatsapp_number: "", support_email: "", privacy_url: "", facebook_url: "", whatsapp_channel_url: "" };

const PRACTICES = [
  "Responde primero por el canal que el cliente eligió y deja el estado en Soporte.",
  "Confirma pagos solo con el importe real y una referencia verificable.",
  "Antes de suspender, deja una nota interna con el motivo y el acuerdo.",
  "No compartas datos de una empresa con otra: cada ficha es independiente.",
  "Revisa Auditoría cuando algo no cuadre; toda acción sensible queda registrada.",
];

function isHttpUrl(value: string) {
  return /^https?:\/\/\S+\.\S+/i.test(value.trim());
}

function validate(form: FormState): Partial<Record<FormKey, string>> {
  const errors: Partial<Record<FormKey, string>> = {};
  const phone = form.whatsapp_number.replace(/\D/g, "");
  if (form.whatsapp_number.trim() && phone.length < 7) {
    errors.whatsapp_number = "Incluye al menos 7 dígitos, con o sin prefijo de país.";
  }
  if (form.support_email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(form.support_email.trim())) {
    errors.support_email = "Escribe un correo válido, por ejemplo soporte@palmyra.com.";
  }
  if (form.privacy_url.trim() && !isHttpUrl(form.privacy_url)) {
    errors.privacy_url = "Debe ser una URL completa que empiece por http:// o https://.";
  }
  if (form.facebook_url.trim() && !isHttpUrl(form.facebook_url)) {
    errors.facebook_url = "Debe ser una URL completa de Facebook.";
  }
  if (form.whatsapp_channel_url.trim() && !/^https?:\/\/\S*whatsapp\.com\/channel\//i.test(form.whatsapp_channel_url.trim())) {
    errors.whatsapp_channel_url = "Debe ser el enlace de un canal: whatsapp.com/channel/…";
  }
  return errors;
}

function formFromSettings(value: PlatformSupportSettings): FormState {
  return {
    whatsapp_number: value.whatsapp_number || "",
    support_email: value.support_email || "",
    privacy_url: value.privacy_url || "",
    facebook_url: value.facebook_url || "",
    whatsapp_channel_url: value.whatsapp_channel_url || "",
  };
}

export default function SettingsView() {
  const [settings, setSettings] = useState<PlatformSupportSettings>({ whatsapp_number: null, support_email: null, privacy_url: null, facebook_url: null, whatsapp_channel_url: null });
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [loadFailed, setLoadFailed] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<FormKey, string>>>({});
  const [authSettings, setAuthSettings] = useState<PlatformAuthSettings | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authSaving, setAuthSaving] = useState(false);
  const [authMessage, setAuthMessage] = useState("");
  const [authError, setAuthError] = useState("");

  const apply = (value: PlatformSupportSettings) => {
    setSettings(value);
    setForm(formFromSettings(value));
  };

  const refresh = async () => {
    setLoading(true);
    setError("");
    setLoadFailed(false);
    try {
      apply(await loadSupportSettings());
    } catch (err) {
      setError(adminErrorMessage(err, "No se pudo cargar la configuración."));
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  };

  const refreshAuth = async () => {
    setAuthLoading(true);
    setAuthError("");
    try {
      setAuthSettings(await loadPlatformAuthSettings());
    } catch (err) {
      setAuthSettings(null);
      setAuthError(adminErrorMessage(err, "No se pudo consultar la confirmación de correo."));
    } finally {
      setAuthLoading(false);
    }
  };

  useEffect(() => { void refresh(); void refreshAuth(); }, []);

  const update = (key: FormKey, value: string) => {
    setForm((current) => ({ ...current, [key]: value }));
    setFieldErrors((current) => ({ ...current, [key]: undefined }));
    setMessage("");
  };

  const dirty = JSON.stringify(form) !== JSON.stringify(formFromSettings(settings));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const errors = validate(form);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      setError("Revisa los campos marcados antes de guardar.");
      setMessage("");
      return;
    }
    setSaving(true);
    setMessage("");
    setError("");
    try {
      const normalized: FormState = {
        ...form,
        whatsapp_number: form.whatsapp_number.replace(/[^\d+]/g, ""),
        support_email: form.support_email.trim(),
        privacy_url: form.privacy_url.trim(),
        facebook_url: form.facebook_url.trim(),
        whatsapp_channel_url: form.whatsapp_channel_url.trim(),
      };
      const value = await saveSupportSettings(normalized);
      apply(value);
      setLoadFailed(false);
      setMessage("Configuración guardada. El Centro de atención del CRM ya usa estos canales.");
    } catch (err) {
      setError(adminErrorMessage(err, "No se pudo guardar la configuración."));
    } finally {
      setSaving(false);
    }
  };

  const toggleEmailConfirmation = async () => {
    if (!authSettings || authSaving) return;
    const nextRequired = !authSettings.requireEmailConfirmation;
    const confirmation = nextRequired
      ? "¿Reactivar la confirmación de correo? Los nuevos registros volverán a recibir el correo de confirmación."
      : "¿Desactivar temporalmente la confirmación? Los nuevos registros entrarán sin verificar el correo.";
    if (!window.confirm(confirmation)) return;

    setAuthSaving(true);
    setAuthMessage("");
    setAuthError("");
    try {
      const value = await setPlatformEmailConfirmationRequired(nextRequired);
      setAuthSettings(value);
      setAuthMessage(nextRequired
        ? "Confirmación reactivada. Los nuevos registros volverán a pedir confirmación."
        : "Confirmación desactivada temporalmente. Los nuevos registros entrarán directo.");
    } catch (err) {
      setAuthError(adminErrorMessage(err, "No se pudo cambiar la confirmación de correo."));
    } finally {
      setAuthSaving(false);
    }
  };

  return (
    <div className="admin-content-stack">
      <section className="admin-page-head">
        <div><p className="admin-eyebrow">CONFIGURACIÓN</p><h1>Canales y sistema.</h1><p>Define el canal que utilizarán todas las empresas desde el Centro de atención del CRM y revisa el estado de la consola.</p></div>
        <span className="admin-status admin-status--green"><span />Protegido por Supabase</span>
      </section>

      <div className="admin-settings-layout">
        <section className="admin-panel admin-support-settings">
          <div className="admin-panel__head"><div><p className="admin-kicker">ATENCIÓN AL CLIENTE</p><h2>Canales oficiales</h2></div><Settings2 size={17} /></div>
          {loading ? <LoadingBlock label="Cargando configuración…" /> : (
            <form className="admin-settings-form" onSubmit={submit} noValidate>
              <label>
                <span><Phone size={13} />WhatsApp de atención</span>
                <div className={`admin-field-icon${fieldErrors.whatsapp_number ? " is-invalid" : ""}`}>
                  <Phone size={15} />
                  <input value={form.whatsapp_number} onChange={(event) => update("whatsapp_number", event.target.value)} placeholder="+53 5555 5555" inputMode="tel" aria-invalid={Boolean(fieldErrors.whatsapp_number)} aria-describedby={fieldErrors.whatsapp_number ? "error-whatsapp" : undefined} />
                </div>
                {fieldErrors.whatsapp_number ? <small className="admin-field-error" id="error-whatsapp">{fieldErrors.whatsapp_number}</small> : <small>Se normaliza a formato numérico al guardar.</small>}
              </label>
              <label>
                <span><Mail size={13} />Correo de soporte</span>
                <div className={`admin-field-icon${fieldErrors.support_email ? " is-invalid" : ""}`}>
                  <Mail size={15} />
                  <input type="email" value={form.support_email} onChange={(event) => update("support_email", event.target.value)} placeholder="soporte@palmyra.com" aria-invalid={Boolean(fieldErrors.support_email)} />
                </div>
                {fieldErrors.support_email ? <small className="admin-field-error">{fieldErrors.support_email}</small> : null}
              </label>
              <label>
                <span><FileTextIcon />Política y privacidad</span>
                <div className={`admin-field-icon${fieldErrors.privacy_url ? " is-invalid" : ""}`}>
                  <ExternalLink size={15} />
                  <input type="url" value={form.privacy_url} onChange={(event) => update("privacy_url", event.target.value)} placeholder="https://…" aria-invalid={Boolean(fieldErrors.privacy_url)} />
                </div>
                {fieldErrors.privacy_url ? <small className="admin-field-error">{fieldErrors.privacy_url}</small> : <small>Opcional. Aparecerá como enlace oficial dentro del CRM.</small>}
              </label>
              <label>
                <span><Facebook size={13} />Página de Facebook</span>
                <div className={`admin-field-icon${fieldErrors.facebook_url ? " is-invalid" : ""}`}>
                  <Facebook size={15} />
                  <input type="url" value={form.facebook_url} onChange={(event) => update("facebook_url", event.target.value)} placeholder="https://www.facebook.com/…" aria-invalid={Boolean(fieldErrors.facebook_url)} />
                </div>
                {fieldErrors.facebook_url ? <small className="admin-field-error">{fieldErrors.facebook_url}</small> : <small>Obligatoria en el plan Gratis: el cliente debe abrirla antes de desbloquear el plan.</small>}
              </label>
              <label>
                <span><Phone size={13} />Canal oficial de WhatsApp</span>
                <div className={`admin-field-icon${fieldErrors.whatsapp_channel_url ? " is-invalid" : ""}`}>
                  <Phone size={15} />
                  <input type="url" value={form.whatsapp_channel_url} onChange={(event) => update("whatsapp_channel_url", event.target.value)} placeholder="https://whatsapp.com/channel/…" aria-invalid={Boolean(fieldErrors.whatsapp_channel_url)} />
                </div>
                {fieldErrors.whatsapp_channel_url ? <small className="admin-field-error">{fieldErrors.whatsapp_channel_url}</small> : <small>Debe ser un enlace de canal (whatsapp.com/channel/…), no un número.</small>}
              </label>
              {error ? <div className="admin-settings-message admin-settings-message--error" role="alert"><AlertCircle size={14} />{error}{loadFailed ? <Button variant="ghost" onClick={() => void refresh()}>Reintentar</Button> : null}</div> : null}
              {message ? <div className="admin-settings-message admin-settings-message--success" role="status"><CheckCircle2 size={14} />{message}</div> : null}
              <div className="admin-settings-footer">
                <span>{settings.whatsapp_number ? "Canal configurado y disponible" : "Sin canal de WhatsApp configurado"}</span>
                <div className="admin-settings-footer__actions">
                  {dirty ? <Button variant="ghost" disabled={saving} onClick={() => { apply(settings); setFieldErrors({}); setError(""); }}><RotateCcw size={14} />Descartar</Button> : null}
                  <Button type="submit" variant="primary" disabled={saving || !dirty || loadFailed}><Save size={14} />{saving ? "Guardando…" : dirty ? "Guardar cambios" : "Sin cambios"}</Button>
                </div>
              </div>
            </form>
          )}
        </section>

        <div className="admin-settings-side">
          <section className="admin-panel">
            <div className="admin-panel__head"><div><p className="admin-kicker">SISTEMA</p><h2>Información de la consola</h2></div><Info size={17} /></div>
            <dl className="admin-kv admin-kv--boxed admin-system-kv">
              <div><dt>Entorno</dt><dd>Producción · Supabase</dd></div>
              <div><dt>Versión</dt><dd>{ADMIN_PRODUCT_VERSION}</dd></div>
              <div><dt>Compilación</dt><dd>{new Date(ADMIN_BUILT_AT).toLocaleString("es-CU")}</dd></div>
              <div><dt>Autorización</dt><dd>RPC + platform_admins</dd></div>
              <div><dt>Datos</dt><dd>Solo lectura salvo acciones auditadas</dd></div>
            </dl>
            <div className="admin-system-links">
              <a className="admin-btn admin-btn--secondary" href="https://github.com/Cristian0311/palmyra/releases/latest" target="_blank" rel="noreferrer">
                <Github size={14} />Última release<ExternalLink size={12} />
              </a>
              <span className="admin-muted">El despliegue del panel es manual y separado del CRM.</span>
            </div>
          </section>

          <OwnerAlertPanel />

          <section className="admin-panel">
            <div className="admin-panel__head"><div><p className="admin-kicker">BUENAS PRÁCTICAS</p><h2>Soporte sin errores</h2></div><ShieldCheck size={17} /></div>
            <ul className="admin-checklist">
              {PRACTICES.map((item) => <li key={item}><Check size={13} />{item}</li>)}
            </ul>
          </section>
        </div>
      </div>

      <section className="admin-panel admin-email-control">
        <div className="admin-panel__head">
          <div><p className="admin-kicker">REGISTRO Y CORREO</p><h2>Confirmación de correo</h2></div>
          <span className={`admin-status ${authSettings?.requireEmailConfirmation ? "admin-status--green" : "admin-status--amber"}`}>
            <span />{authLoading ? "Consultando…" : authSettings?.requireEmailConfirmation ? "Activada" : "Desactivada"}
          </span>
        </div>
        <div className="admin-email-control__body">
          {authLoading ? <p className="admin-email-control__hint">Consultando la configuración de Supabase…</p> : authSettings ? (
            <>
              <div className={`admin-email-control__state ${authSettings.requireEmailConfirmation ? "is-protected" : "is-open"}`}>
                {authSettings.requireEmailConfirmation ? <ShieldCheck size={22} /> : <ShieldAlert size={22} />}
                <div>
                  <strong>{authSettings.requireEmailConfirmation ? "Los usuarios deben confirmar su correo" : "Registro directo sin confirmación"}</strong>
                  <p>{authSettings.requireEmailConfirmation
                    ? "Supabase envía el correo de confirmación antes de permitir el acceso. Mantén esta opción activa cuando el proveedor de correo esté funcionando."
                    : "Desactivado temporalmente para que los registros no dependan de AgentMail. Reactívalo cuando el proveedor vuelva a enviar correos con normalidad."}</p>
                </div>
              </div>
              <p className="admin-email-control__hint">Al reactivar, solo los registros nuevos volverán a pedir confirmación. Las cuentas ya creadas no se modifican.</p>
              {authError ? <div className="admin-settings-message admin-settings-message--error" role="alert"><AlertCircle size={14} />{authError}</div> : null}
              {authMessage ? <div className="admin-settings-message admin-settings-message--success" role="status"><CheckCircle2 size={14} />{authMessage}</div> : null}
              <div className="admin-email-control__actions">
                <span>{authSettings.requireEmailConfirmation ? "Protección activa" : "Modo temporal sin verificación"}</span>
                <div className="admin-email-control__buttons">
                  <Button variant="secondary" onClick={() => void refreshAuth()} disabled={authSaving}><RefreshCw size={14} />Actualizar estado</Button>
                  <Button variant={authSettings.requireEmailConfirmation ? "danger" : "primary"} onClick={() => void toggleEmailConfirmation()} disabled={authSaving}>
                    {authSaving ? "Guardando…" : authSettings.requireEmailConfirmation ? "Desactivar temporalmente" : "Reactivar confirmación"}
                  </Button>
                </div>
              </div>
            </>
          ) : (
            <div className="admin-settings-message admin-settings-message--error" role="alert"><AlertCircle size={14} />{authError || "No se pudo consultar la confirmación de correo."}</div>
          )}
        </div>
      </section>
    </div>
  );
}

const ALERT_REASON_TEXT: Record<string, string> = {
  not_configured: "El canal automático aún no tiene credencial en Render. Sigue la guía de abajo.",
  rate_limited: "Demasiadas pruebas seguidas. Espera unos minutos y vuelve a intentar.",
  authentication_required: "La sesión administrativa expiró. Vuelve a iniciar sesión.",
  network: "No se pudo conectar con el servidor de la aplicación.",
  provider_error: "El proveedor rechazó el mensaje. Revisa la credencial configurada.",
};

function OwnerAlertPanel() {
  const [status, setStatus] = useState<AlertChannelStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const refresh = async () => {
    setLoading(true);
    setStatus(await loadAlertChannelStatus());
    setLoading(false);
  };

  useEffect(() => { void refresh(); }, []);

  const test = async () => {
    setTesting(true);
    setResult(null);
    const outcome = await sendAdminTestAlert();
    setTesting(false);
    setResult(outcome.sent
      ? { ok: true, text: `Enviado por ${outcome.provider === "whatsapp_cloud" ? "WhatsApp Cloud" : "CallMeBot"}. Revisa tu WhatsApp en unos segundos.` }
      : { ok: false, text: ALERT_REASON_TEXT[outcome.reason || ""] || "No se pudo enviar la prueba. Inténtalo otra vez." });
    if (outcome.sent) void refresh();
  };

  return (
    <section className="admin-panel admin-alert-channel">
      <div className="admin-panel__head">
        <div><p className="admin-kicker">AVISOS</p><h2>WhatsApp del dueño</h2></div>
        <MessageCircle size={17} />
      </div>
      <div className="admin-alert-channel__status">
        {loading ? <LoadingBlock label="Consultando canal…" /> : (
          <span className={`admin-status ${status?.configured ? "admin-status--green" : "admin-status--amber"}`}>
            <span />{status?.configured
              ? `Envío automático · ${status.provider === "whatsapp_cloud" ? "WhatsApp Cloud" : "CallMeBot"}`
              : status?.reachable ? "Sin credencial automática" : "Servidor no disponible"}
          </span>
        )}
        <button type="button" className="admin-square-button" aria-label="Volver a consultar el canal" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw size={14} className={loading ? "spin" : ""} />
        </button>
      </div>
      <ul className="admin-alert-channel__events">
        <li><Check size={13} />Soporte: errores, mejoras y otras solicitudes.</li>
        <li><Check size={13} />Planes: altas, renovaciones, extensiones y cancelaciones.</li>
        <li><Check size={13} />Empresas nuevas registradas.</li>
      </ul>
      <p className="admin-muted">
        Destino: <a href={`https://wa.me/${OWNER_WHATSAPP}`} target="_blank" rel="noreferrer">+53 5558 1669</a>. Si el canal automático falla o no está configurado, el cliente conserva el botón de WhatsApp con el mensaje ya escrito.
      </p>
      {result ? <div className={`admin-settings-message ${result.ok ? "admin-settings-message--success" : "admin-settings-message--error"}`} role="status">{result.ok ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />}{result.text}</div> : null}
      {status && !status.configured ? (
        <details className="admin-alert-channel__guide">
          <summary>Activar el envío automático</summary>
          <ol>
            <li>Desde el WhatsApp del dueño, envía «I allow callmebot to send me messages» al +34 644 51 95 23.</li>
            <li>Recibirás una API key; guárdala como <code>CALLMEBOT_APIKEY</code> en las variables de entorno del servicio de la app en Render.</li>
            <li>Vuelve a desplegar el servicio. Alternativa: WhatsApp Cloud API con <code>WHATSAPP_CLOUD_TOKEN</code> y <code>WHATSAPP_CLOUD_PHONE_ID</code>.</li>
          </ol>
        </details>
      ) : null}
      <div className="admin-settings-footer">
        <span className="admin-muted">La prueba usa la sesión administrativa.</span>
        <Button variant="secondary" disabled={testing || loading} onClick={() => void test()}>
          <Send size={14} />{testing ? "Enviando…" : "Enviar prueba"}
        </Button>
      </div>
    </section>
  );
}
