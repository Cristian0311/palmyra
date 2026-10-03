import React, { useEffect, useState } from "react";
import { ArrowRight, CheckCircle2, LockKeyhole, Mail, ShieldCheck, Store, UserRound, Eye, EyeOff, Warehouse, MonitorSmartphone } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { getSupabase } from "../lib/supabase";
import { signInSaaSAccount, signUpSaaSAccount, loadSaaSContext } from "../services/saas";
import { acceptEmployeeInvitation } from "../services/team";
import { useStore } from "../store/useStore";

type Mode = "signup" | "signin";

export default function SaaSInvite() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get("token") || "";
  const [mode, setMode] = useState<Mode>("signup");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [checking, setChecking] = useState(true);

  const finish = async () => {
    if (!token) throw new Error("El enlace de invitación no contiene un token válido.");
    await acceptEmployeeInvitation(token);
    const ctx = await loadSaaSContext(true);
    if (!ctx?.companyId) throw new Error("La invitación se aceptó, pero no se pudo cargar la empresa.");
    useStore.setState({ currentUser: ctx.user, currentBranchId: ctx.warehouseIds[0] || "" });
    setAccepted(true);
    navigate("/", { replace: true });
  };

  useEffect(() => {
    let active = true;
    const checkSession = async () => {
      try {
        const supabase = getSupabase();
        if (!supabase) return;
        const { data } = await supabase.auth.getSession();
        if (data.session && active) {
          try {
            await finish();
          } catch (e: any) {
            setError(e?.message || "No se pudo aceptar la invitación.");
          }
        }
      } finally {
        if (active) setChecking(false);
      }
    };
    void checkSession();
    return () => { active = false; };
  }, [token]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (!token) throw new Error("Enlace de invitación inválido.");
      if (mode === "signup") {
        if (name.trim().length < 2) throw new Error("Escribe tu nombre completo.");
        if (email.trim().length < 5) throw new Error("Escribe un correo válido.");
        if (password.length < 8) throw new Error("La contraseña debe tener al menos 8 caracteres.");
        const result = await signUpSaaSAccount(name, email, password, `/invite?token=${encodeURIComponent(token)}`);
        if (result.error) throw result.error;
        if (!result.data.session) {
          sessionStorage.setItem("palmyra_pending_invitation", token);
          sessionStorage.setItem("palmyra_pending_invitation_email", email.trim().toLowerCase());
          setMode("signin");
          setError("");
          setAccepted(false);
          return;
        }
        await finish();
      } else {
        if (!email.trim() || !password) throw new Error("Correo y contraseña son obligatorios.");
        const result = await signInSaaSAccount(email, password);
        if (result.error) throw result.error;
        await finish();
      }
    } catch (e: any) {
      const raw = String(e?.message || "");
      if (/already registered|user already registered|already exists/i.test(raw) && mode === "signup") {
        setMode("signin");
        setError("Este correo ya tiene una cuenta PALMYRA. Inicia sesión para aceptar la invitación.");
      } else {
        setError(raw || "No se pudo completar la invitación.");
      }
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const pending = sessionStorage.getItem("palmyra_pending_invitation");
    if (pending && pending === token) {
      const invitedEmail = sessionStorage.getItem("palmyra_pending_invitation_email") || "";
      if (invitedEmail) setEmail(invitedEmail);
    }
  }, [token]);

  if (accepted) {
    return (
      <main className="min-h-screen bg-[#F7F5FC] flex items-center justify-center p-4">
        <div className="bg-white rounded-3xl border border-violet-100 shadow-xl p-8 text-center max-w-md">
          <CheckCircle2 className="w-12 h-12 text-emerald-500 mx-auto" />
          <h1 className="text-xl font-black text-[#21182F] mt-3">Acceso activado</h1>
          <p className="text-sm text-[#6F647B] mt-2">Ya puedes entrar a PALMYRA desde este o cualquier otro dispositivo.</p>
        </div>
      </main>
    );
  }

  if (checking) {
    return <div className="min-h-screen bg-[#F7F5FC] flex items-center justify-center text-sm font-bold text-[#6F647B]">Comprobando invitación...</div>;
  }

  return (
    <main className="min-h-screen bg-[#F7F5FC] px-3 sm:px-5 py-5 flex items-center justify-center">
      <div className="w-full max-w-3xl bg-white rounded-[26px] border border-violet-100 shadow-[0_30px_90px_-52px_rgba(59,27,110,.55)] p-4 sm:p-6">
        <div className="flex items-center gap-3 mb-5"><img src="/palmyra-logo.svg" alt="PALMYRA" className="w-[140px] h-8 object-contain object-left"/>
          <div className="text-[9px] uppercase tracking-[.18em] text-[#8B63E6] font-black">Invitación de empresa</div>
        </div>

        <div className="grid md:grid-cols-[0.9fr_1.1fr] gap-8">
          <section className="bg-[#3B1B6E] text-white rounded-3xl p-5 sm:p-6">
            <ShieldCheck className="w-8 h-8 text-rose-300" />
            <h1 className="text-2xl font-black mt-4">Tu acceso es personal</h1>
            <p className="text-sm text-slate-300 mt-3 leading-6">
              El administrador de tu empresa te asignó un rol y uno o varios almacenes. Esos permisos se cargarán cada vez que inicies sesión.
            </p>
            <div className="mt-5 space-y-2 text-xs text-slate-300">
              <div>✓ Cuenta propia</div>
              <div>✓ Permisos por rol</div>
              <div>✓ Acceso por almacén</div>
              <div>✓ Compatible con varios dispositivos</div>
            </div>
          </section>

          <section className="p-1 md:p-0">
            <div className="grid grid-cols-2 p-1 bg-[#F0EBFA] rounded-xl">
              <button type="button" onClick={() => { setMode("signup"); setError(""); }} className={`py-2.5 rounded-lg text-sm font-bold ${mode === "signup" ? "bg-white shadow" : "text-[#6F647B]"}`}>Crear cuenta</button>
              <button type="button" onClick={() => { setMode("signin"); setError(""); }} className={`py-2.5 rounded-lg text-sm font-bold ${mode === "signin" ? "bg-white shadow" : "text-[#6F647B]"}`}>Ya tengo cuenta</button>
            </div>

            <form onSubmit={submit} className="space-y-4 mt-5">
              {mode === "signup" && (
                <label className="block"><span className="label">Nombre completo</span>
                  <div className="relative"><UserRound className="icon" /><input className="field pl-10" value={name} onChange={e=>setName(e.target.value)} disabled={busy} /></div>
                </label>
              )}

              <label className="block"><span className="label">Correo de invitación</span>
                <div className="relative"><Mail className="icon" /><input type="email" className="field pl-10" value={email} onChange={e=>setEmail(e.target.value)} disabled={busy} placeholder="trabajador@empresa.com" /></div>
              </label>

              <label className="block"><span className="label">Contraseña</span>
                <div className="relative"><LockKeyhole className="icon" /><input type="password" className="field pl-10" value={password} onChange={e=>setPassword(e.target.value)} disabled={busy} /></div>
              </label>

              {error && <div className="rounded-xl border border-rose-200 bg-rose-50 text-rose-700 text-sm p-3">{error}</div>}

              <button disabled={busy} className="w-full h-12 rounded-xl bg-[#3B1B6E] text-white font-bold flex items-center justify-center gap-2 disabled:opacity-50">
                {busy ? "Activando acceso..." : mode === "signup" ? "Crear acceso" : "Entrar y aceptar"}
                {!busy && <ArrowRight className="w-4 h-4" />}
              </button>
            </form>

            <p className="text-[10px] text-slate-400 mt-5 leading-5">
              El acceso web no reemplaza el selector de empleado/PIN del POS. Ambos sistemas pueden convivir.
            </p>
          </section>
        </div>
      </div>
    </main>
  );
}
