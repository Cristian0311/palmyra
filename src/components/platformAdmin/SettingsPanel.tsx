import { useEffect, useState } from "react";
import { Facebook, Link2, Mail, MessageCircle, Radio, Save, ShieldCheck, Sparkles } from "lucide-react";
import { setPlatformSupportSettings, type PlatformSupportSettings } from "../../services/platformAdmin";
import { DEFAULT_FACEBOOK_URL } from "../../services/platformSupport";
import type { AdminContext } from "./types";
import { SectionCard } from "./ui";

const EMPTY: PlatformSupportSettings = {
  whatsapp_number: null,
  support_email: null,
  privacy_url: null,
  facebook_url: DEFAULT_FACEBOOK_URL,
  whatsapp_channel_url: null,
};

const FIELDS: Array<{ key: keyof PlatformSupportSettings; label: string; placeholder: string; type: string; icon: typeof Mail }> = [
  { key: "whatsapp_number", label: "WhatsApp de atención", placeholder: "+53 5…", type: "tel", icon: MessageCircle },
  { key: "support_email", label: "Correo de soporte", placeholder: "soporte@palmyra.cu", type: "email", icon: Mail },
  { key: "privacy_url", label: "Política y privacidad", placeholder: "https://palmyra.cu/privacidad", type: "url", icon: Link2 },
  { key: "facebook_url", label: "Facebook oficial", placeholder: "https://facebook.com/…", type: "url", icon: Facebook },
  { key: "whatsapp_channel_url", label: "Canal oficial de WhatsApp", placeholder: "https://whatsapp.com/channel/…", type: "url", icon: Radio },
];

export default function SettingsPanel({ ctx }: { ctx: AdminContext }) {
  const { busy, run, supportSettings } = ctx;
  const [form, setForm] = useState<PlatformSupportSettings>(EMPTY);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setForm({ ...EMPTY, ...supportSettings });
    setDirty(false);
  }, [supportSettings]);

  const update = (key: keyof PlatformSupportSettings, value: string) => {
    setForm((current) => ({ ...current, [key]: value }));
    setDirty(true);
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    await run(() => setPlatformSupportSettings(form), "Canales de atención y privacidad guardados.");
    setDirty(false);
  };

  return (
    <div className="space-y-4">
      <SectionCard title="Canales de atención y privacidad" subtitle="Estos datos alimentan el Centro de atención del CRM, el registro gratuito y la landing." icon={<Sparkles className="h-4 w-4" />}>
        <form onSubmit={save} className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {FIELDS.map(({ key, label, placeholder, type, icon: Icon }) => (
            <label key={key} className="block">
              <span className="text-[9px] font-black uppercase tracking-wide text-muted">{label}</span>
              <span className="mt-1 flex h-11 items-center gap-2 rounded-xl border border-base bg-primary px-3">
                <Icon className="h-4 w-4 shrink-0 text-violet-500" />
                <input type={type} value={form[key] || ""} onChange={(event) => update(key, event.target.value)} placeholder={placeholder}
                  className="min-w-0 w-full bg-transparent text-sm font-bold text-primary outline-none" />
              </span>
            </label>
          ))}
          <div className="md:col-span-2 xl:col-span-3 flex flex-col gap-2 sm:flex-row sm:items-center">
            <button type="submit" disabled={busy || !dirty} className="flex h-11 items-center justify-center gap-2 rounded-xl bg-violet-600 px-5 text-xs font-black text-white disabled:opacity-50">
              <Save className="h-4 w-4" />{busy ? "Guardando…" : "Guardar configuración"}
            </button>
            <p className="text-[10px] leading-4 text-muted">
              {dirty ? "Hay cambios sin guardar." : "Los canales se aplican al instante en toda la plataforma."}
              {" "}Deja un campo vacío para ocultarlo de la interfaz.
            </p>
          </div>
        </form>
      </SectionCard>

      <SectionCard title="Seguridad de la plataforma" subtitle="Cómo se protege esta consola y qué se verifica antes de un cambio." icon={<ShieldCheck className="h-4 w-4" />}>
        <div className="grid gap-2.5 sm:grid-cols-2">
          {[
            ["Acceso restringido", "Solo cuentas incluidas en la tabla de administradores de plataforma acceden a estas funciones; el resto recibe acceso denegado."],
            ["Auditoría inmutable", "Cada aprobación, rechazo, suspensión o cambio de plan queda firmado con operador, empresa, fecha y detalle."],
            ["Cobros verificables", "El importe se registra tal como se recibió, en CUP o USD, con referencia obligatoria y sin conversiones automáticas."],
            ["Credenciales fuera del cliente", "Las llaves de Render y Supabase viven en el servidor; este panel nunca las muestra en el navegador."],
          ].map(([title, text]) => (
            <div key={title} className="rounded-2xl border border-base bg-primary p-3.5">
              <p className="text-[11px] font-black text-primary">{title}</p>
              <p className="mt-1 text-[10px] leading-5 text-muted">{text}</p>
            </div>
          ))}
        </div>
        <p className="mt-3 rounded-xl border border-amber-200 bg-amber-50/70 p-3 text-[10px] font-bold leading-5 text-amber-800">
          Recuerda: las suspensiones cortan el acceso de la empresa de inmediato. Revísala dos veces antes de confirmar y documenta el motivo en la auditoría.
        </p>
      </SectionCard>
    </div>
  );
}
