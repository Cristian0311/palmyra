import React, { useEffect, useState } from "react";
import { ArrowRight, Check, CheckCircle2, LockKeyhole, Mail, ShieldCheck, UserRound } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import { getSupabase } from "../lib/supabase";
import { signInSaaSAccount, signUpSaaSAccount, loadSaaSContext } from "../services/saas";
import { acceptEmployeeInvitation } from "../services/team";
import { useStore } from "../store/useStore";
import { useDocumentScrollPage } from "../hooks/useDocumentScrollPage";

type Mode = "signup" | "signin";

export default function SaaSInvite() {
  useDocumentScrollPage();
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
    try {
      sessionStorage.removeItem("palmyra_pending_invitation");
      sessionStorage.removeItem("palmyra_pending_invitation_email");
    } catch {}
    // Recargar la aplicación para que el guard de rutas vuelva a leer la membresía
    // recién creada y no use el estado anterior (sin empresa) que envía a onboarding.
    window.location.replace("/");
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
      } catch (e: any) {
        // getSession puede fallar sin red; antes quedaba como rechazo sin aviso.
        if (active) setError(e?.message || "No se pudo comprobar la invitación. Revisa tu conexión.");
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

        const result = await signUpSaaSAccount(
          name,
          email,
          password,
          `/invite?token=${encodeURIComponent(token)}`
        );
        if (result.error) throw result.error;

        if (!result.data.session) {
          sessionStorage.setItem("palmyra_pending_invitation", token);
          sessionStorage.setItem("palmyra_pending_invitation_email", email.trim().toLowerCase());
          setMode("signin");
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
    try {
      const pending = sessionStorage.getItem("palmyra_pending_invitation");
      if (pending && pending === token) {
        const invitedEmail = sessionStorage.getItem("palmyra_pending_invitation_email") || "";
        if (invitedEmail) setEmail(invitedEmail);
      }
    } catch {}
  }, [token]);

  if (accepted) {
    return (
      <main className="palmyra-scroll-page min-h-[100dvh] bg-[#F7F5FC] flex items-start justify-center p-4 py-8 sm:items-center">
        <div className="w-full min-w-0 max-w-md rounded-2xl border border-violet-100 bg-white p-6 text-center shadow-xl sm:p-8">
          <CheckCircle2 className="w-12 h-12 text-emerald-500 mx-auto" />
          <h1 className="text-xl font-black text-[#21182F] mt-3">Acceso activado</h1>
          <p className="text-sm text-[#6F647B] mt-2">Ya puedes entrar a PALMYRA desde este o cualquier otro dispositivo.</p>
        </div>
      </main>
    );
  }

  if (checking) {
    return (
      <main className="palmyra-scroll-page min-h-[100dvh] bg-[#F7F5FC] flex items-start justify-center p-4 py-8 sm:items-center">
        <div className="palmyra-loading-bubble" aria-live="polite">
          <span className="palmyra-loading-icon"><span className="palmyra-loading-spinner" /></span>
          Comprobando invitación…
        </div>
      </main>
    );
  }

  // Sin token el formulario nunca podría completarse; mostrarlo obligaba a
  // escribir nombre, correo y contraseña para recibir el error al final.
  if (!token) {
    return (
      <main className="palmyra-scroll-page min-h-[100dvh] bg-[#F7F5FC] flex items-start justify-center p-4 py-8 sm:items-center">
        <div className="w-full min-w-0 max-w-md rounded-2xl border border-violet-100 bg-white p-6 text-center shadow-xl sm:p-8">
          <ShieldCheck className="w-12 h-12 text-[#6535C5] mx-auto" />
          <h1 className="text-xl font-black text-[#21182F] mt-3">Invitación incompleta</h1>
          <p className="text-sm text-[#6F647B] mt-2 leading-6">
            Este enlace no incluye el código de invitación. Pide al administrador de tu empresa que reenvíe la invitación o inicia sesión si ya tienes cuenta.
          </p>
          <div className="mt-5 flex flex-col gap-2">
            <Link to="/auth" className="h-11 rounded-xl bg-[#6535C5] hover:bg-[#4F249D] text-white text-xs font-black flex items-center justify-center">
              Ir a iniciar sesión
            </Link>
            <Link to="/landing" className="min-h-11 rounded-xl bg-[#EFE8FF] text-[11px] font-black text-[#5B2DBA] flex items-center justify-center">
              Volver a PALMYRA
            </Link>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="palmyra-scroll-page min-h-[100dvh] bg-[#F7F5FC] px-3 sm:px-5 py-5 flex items-start justify-center overflow-y-auto sm:items-center">
      <div className="w-full max-w-3xl bg-white rounded-[26px] border border-violet-100 shadow-[0_30px_90px_-52px_rgba(59,27,110,.55)] overflow-hidden">
        <div className="flex items-center justify-between gap-3 px-4 sm:px-6 py-4 border-b border-violet-100 bg-white">
          <img src="/palmyra-logo-exact.svg" alt="PALMYRA" className="h-auto w-[136px] shrink-0 object-contain object-left sm:w-[190px]" />
          <div className="hidden text-right sm:block">
            <div className="text-[9px] uppercase tracking-[.15em] text-[#7649D6] font-black">Invitación de empresa</div>
            <div className="text-[10px] text-slate-500 mt-1">Acceso seguro al equipo</div>
          </div>
        </div>

        <div className="grid md:grid-cols-[0.9fr_1.1fr]">
          <section className="bg-[#3B1B6E] text-white p-5 sm:p-6">
            <ShieldCheck className="w-8 h-8 text-violet-200" />
            <h1 className="text-2xl font-black mt-4">Tu acceso es personal</h1>
            <p className="text-sm text-violet-100/75 mt-3 leading-6">
              El administrador de tu empresa te asignó un rol y uno o varios almacenes. Esos permisos se cargarán cada vez que inicies sesión.
            </p>
            <div className="mt-5 space-y-2 text-xs text-violet-100/75">
              {["Cuenta propia", "Permisos por rol", "Acceso por almacén", "Compatible con varios dispositivos"].map((item) => (
                <div key={item} className="flex items-center gap-1.5">
                  <Check className="h-3.5 w-3.5 shrink-0 text-violet-200" aria-hidden="true" />{item}
                </div>
              ))}
            </div>
          </section>

          <section className="p-4 sm:p-6 min-w-0">
            <div className="grid grid-cols-2 p-1 bg-[#F0EBFA] rounded-xl">
              <button type="button" onClick={() => { setMode("signup"); setError(""); }} className={`min-h-11 rounded-lg text-[11px] font-black transition ${mode === "signup" ? "bg-white shadow text-[#3B1B6E]" : "text-[#6F647B]"}`}>Crear cuenta</button>
              <button type="button" onClick={() => { setMode("signin"); setError(""); }} className={`min-h-11 rounded-lg text-[11px] font-black transition ${mode === "signin" ? "bg-white shadow text-[#3B1B6E]" : "text-[#6F647B]"}`}>Ya tengo cuenta</button>
            </div>

            <form onSubmit={submit} className="space-y-3 mt-5">
              {mode === "signup" && (
                <label className="block">
                  <span className="form-label">Nombre completo</span>
                  <div className="relative">
                    <UserRound className="field-icon" />
                    <input
                      className="field-input h-11 pl-10"
                      value={name}
                      onChange={e => setName(e.target.value)}
                      disabled={busy}
                      autoComplete="name"
                      placeholder="Tu nombre completo"
                      required
                    />
                  </div>
                </label>
              )}

              <label className="block">
                <span className="form-label">Correo de invitación</span>
                <div className="relative">
                  <Mail className="field-icon" />
                  <input
                    type="email"
                    className="field-input h-11 pl-10"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    disabled={busy}
                    autoComplete="email"
                    placeholder="trabajador@empresa.com"
                    required
                  />
                </div>
              </label>

              <label className="block">
                <span className="form-label">Contraseña</span>
                <div className="relative">
                  <LockKeyhole className="field-icon" />
                  <input
                    type={showPassword ? "text" : "password"}
                    className="field-input h-11 pl-10 pr-10"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    disabled={busy}
                    autoComplete={mode === "signin" ? "current-password" : "new-password"}
                    placeholder="Mínimo 8 caracteres"
                    minLength={8}
                    required
                  />
                  <button type="button" onClick={() => setShowPassword(v => !v)} className="absolute right-0.5 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-lg text-[11px] font-bold text-slate-500">
                    {showPassword ? "Ocultar" : "Ver"}
                  </button>
                </div>
              </label>

              {error && <div className="rounded-xl border border-rose-200 bg-rose-50 text-rose-700 text-[10px] font-bold p-3 leading-5">{error}</div>}

              <button disabled={busy} className="w-full h-11 rounded-xl bg-[#6535C5] hover:bg-[#4F249D] text-white text-xs font-black flex items-center justify-center gap-2 disabled:opacity-50">
                {busy ? "Activando acceso…" : mode === "signup" ? "Crear acceso" : "Entrar y aceptar"}
                {!busy && <ArrowRight className="w-4 h-4" />}
              </button>
            </form>

            <p className="mt-5 text-[10px] text-slate-400 leading-5">
              La invitación solo puede aceptarse con el correo al que fue enviada. El acceso web no reemplaza el selector de empleado/PIN del POS.
            </p>
          </section>
        </div>
      </div>
    </main>
  );
}
