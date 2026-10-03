import React, { useEffect, useState } from "react";
import { ArrowRight, Check, Eye, EyeOff, LockKeyhole, Mail, ShieldCheck, Sparkles, Users, Warehouse, MonitorSmartphone } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { getSupabase } from "../lib/supabase";
import {
  loadSaaSContext,
  requestSaaSPasswordReset,
  signInSaaSAccount,
  signUpSaaSAccount,
  updateSaaSPassword
} from "../services/saas";

type Mode = "signin" | "signup" | "reset" | "recovery";

function messageFor(error: any) {
  const raw = String(error?.message || error?.error_description || "");
  if (/invalid login credentials/i.test(raw)) return "El correo o la contraseña no son correctos.";
  if (/email not confirmed/i.test(raw)) return "Confirma tu correo electrónico y vuelve a entrar.";
  if (/user already registered/i.test(raw)) return "Este correo ya tiene una cuenta. Inicia sesión.";
  if (/password/i.test(raw) && /8/i.test(raw)) return "La contraseña debe tener al menos 8 caracteres.";
  return raw || "No se pudo completar la operación.";
}

export default function SaaSAuth() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [mode, setMode] = useState<Mode>(params.get("mode") === "signup" ? "signup" : "signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const supabase = getSupabase();
    if (!supabase) return;
    const recovery = params.get("recovery") === "1";
    if (recovery) setMode("recovery");

    const { data } = supabase.auth.onAuthStateChange(event => {
      if (event === "PASSWORD_RECOVERY") {
        setMode("recovery");
        setMessage("");
        setError("");
      }
    });
    return () => data.subscription.unsubscribe();
  }, [params]);

  const finishAuth = async () => {
    const ctx = await loadSaaSContext(true);
    if (!ctx) {
      setError("La sesión no pudo ser verificada.");
      return;
    }
    if (!ctx.companyId) {
      navigate(ctx.membershipStatus && ctx.membershipStatus !== "active" ? "/account-status" : "/onboarding", { replace: true });
      return;
    }
    if (ctx.company?.account_status === "pending_payment" || ctx.company?.account_status === "suspended" || ctx.membershipStatus !== "active" || !ctx.deviceActive) {
      navigate("/account-status", { replace: true });
      return;
    }
    navigate("/", { replace: true });
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setMessage("");
    setBusy(true);
    try {
      if (mode === "reset") {
        if (!email.trim()) throw new Error("Escribe tu correo.");
        const { error: resetError } = await requestSaaSPasswordReset(email);
        if (resetError) throw resetError;
        setMessage("Si la cuenta existe, recibirás un enlace para recuperar la contraseña.");
        return;
      }

      if (mode === "recovery") {
        if (password.length < 8) throw new Error("La contraseña debe tener al menos 8 caracteres.");
        if (password !== confirmPassword) throw new Error("Las contraseñas no coinciden.");
        const { error: updateError } = await updateSaaSPassword(password);
        if (updateError) throw updateError;
        setMode("signin");
        setPassword("");
        setConfirmPassword("");
        setMessage("Contraseña actualizada correctamente.");
        window.history.replaceState({}, "", "/auth");
        return;
      }

      if (mode === "signup") {
        if (name.trim().length < 2) throw new Error("Escribe tu nombre completo.");
        if (email.trim().length < 5) throw new Error("Escribe un correo válido.");
        if (password.length < 8) throw new Error("La contraseña debe tener al menos 8 caracteres.");

        const result = await signUpSaaSAccount(name, email, password, "/auth");
        if (result.error) throw result.error;
        if (!result.data.session) {
          setMode("signin");
          setMessage("Cuenta creada. Revisa tu correo para confirmar la cuenta y luego inicia sesión.");
          return;
        }
        await finishAuth();
        return;
      }

      if (!email.trim() || !password) throw new Error("Correo y contraseña son obligatorios.");
      const result = await signInSaaSAccount(email, password);
      if (result.error) throw result.error;
      await finishAuth();
    } catch (err: any) {
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="min-h-screen bg-[#F7F5FC] flex items-center justify-center p-3 sm:p-5">
      <div className="w-full max-w-4xl">
        <div className="flex items-center justify-between mb-3 px-1">
          <button onClick={() => navigate("/landing")} className="flex items-center gap-2.5">
            <img src="/palmyra-logo.svg" alt="PALMYRA" className="w-[124px] h-8 object-contain object-left" />
          </button>
          <button onClick={() => navigate("/landing")} className="text-[9px] font-black uppercase tracking-wider text-slate-400 hover:text-[#6535C5]">Volver al inicio</button>
        </div>

        <div className="grid lg:grid-cols-[.9fr_1.1fr] bg-white border border-violet-100 rounded-[26px] overflow-hidden shadow-[0_30px_90px_-52px_rgba(59,27,110,.55)]">
          <section className="hidden lg:block bg-[#3B1B6E] text-white p-7 relative overflow-hidden">
            <div className="absolute -top-28 -right-24 w-72 h-72 rounded-full bg-[#8B63E6]/35 blur-3xl"/>
            <div className="relative">
              <span className="inline-flex items-center gap-2 text-[8px] uppercase tracking-[.18em] font-black bg-white/10 border border-white/10 rounded-full px-3 py-1.5"><Sparkles className="w-3 h-3"/> PALMYRA Business OS</span>
              <h1 className="text-4xl font-black tracking-[-.06em] leading-tight mt-6">Tu negocio.<br/><span className="text-[#BBA5FF]">Bajo control.</span></h1>
              <p className="text-xs leading-6 text-violet-100/75 mt-3">Ventas, inventario, cajas, almacenes, equipo y reportes en un mismo lugar.</p>
              <div className="space-y-2 mt-7">
                {[
                  [ShieldCheck,"Una cuenta pertenece a una sola empresa."],
                  [Warehouse,"Almacenes según el plan contratado."],
                  [Users,"Trabajadores con cuentas y permisos propios."]
                ].map(([Icon, text]) => <div key={String(text)} className="flex items-center gap-2.5 rounded-xl bg-white/8 border border-white/8 p-3"><Icon className="w-4 h-4 text-violet-200 shrink-0"/><span className="text-[9px] text-violet-100/80">{text}</span></div>)}
              </div>
              <div className="mt-7 rounded-2xl border border-white/10 bg-white/5 p-4"><p className="text-[8px] uppercase tracking-wider font-black text-violet-200">Cuba</p><p className="text-sm font-black mt-1">Planes con pago en efectivo</p><p className="text-[9px] text-violet-200/70 mt-1">Pagos internacionales preparados para una fase posterior.</p></div>
            </div>
          </section>

          <section className="p-4 sm:p-7">
            <div>
              <p className="text-[9px] uppercase tracking-[.18em] font-black text-[#8B63E6]">
                {mode === "recovery" ? "Recuperación" : mode === "signup" ? "Crear cuenta" : mode === "reset" ? "Recuperar acceso" : "Bienvenido"}
              </p>
              <h2 className="text-2xl font-black tracking-[-.04em] text-[#2A1938] mt-1">
                {mode === "signup" ? "Crea tu cuenta PALMYRA" : mode === "reset" ? "Recupera tu contraseña" : mode === "recovery" ? "Crea una nueva contraseña" : "Entra a tu empresa"}
              </h2>
              <p className="text-xs text-slate-500 mt-2 leading-5">
                {mode === "signup" ? "Después crearás tu empresa y elegirás el plan." : mode === "recovery" ? "Usa una contraseña nueva de al menos 8 caracteres." : "Tu sesión determina la empresa, rol y permisos que puedes utilizar."}
              </p>
            </div>

            {mode !== "recovery" && <div className="grid grid-cols-2 gap-1 p-1 bg-[#F7F5FC] rounded-xl mt-5">
              <button onClick={() => {setMode("signin");setError("");setMessage("");}} className={"h-9 rounded-lg text-[10px] font-black " + (mode==="signin"?"bg-white text-[#3B1B6E] shadow-sm":"text-slate-400")}>Iniciar sesión</button>
              <button onClick={() => {setMode("signup");setError("");setMessage("");}} className={"h-9 rounded-lg text-[10px] font-black " + (mode==="signup"?"bg-white text-[#3B1B6E] shadow-sm":"text-slate-400")}>Crear cuenta</button>
            </div>}

            <form onSubmit={submit} className="space-y-3 mt-5">
              {mode === "signup" ? (
                <label className="block">
                  <span className="label">Nombre completo</span>
                  <div className="relative">
                    <Users className="icon"/>
                    <input className="field pl-10 h-11" value={name} onChange={e=>setName(e.target.value)} disabled={busy} autoComplete="name" placeholder="Tu nombre"/>
                  </div>
                </label>
              ) : null}

              {mode !== "recovery" ? (
                <label className="block">
                  <span className="label">Correo</span>
                  <div className="relative">
                    <Mail className="icon"/>
                    <input type="email" className="field pl-10 h-11" value={email} onChange={e=>setEmail(e.target.value)} disabled={busy} autoComplete="email" placeholder="nombre@empresa.com"/>
                  </div>
                </label>
              ) : null}

              <label className="block">
                <span className="label">{mode==="recovery" ? "Nueva contraseña" : "Contraseña"}</span>
                <div className="relative">
                  <LockKeyhole className="icon"/>
                  <input
                    type={showPassword ? "text" : "password"}
                    className="field pl-10 pr-10 h-11"
                    value={password}
                    onChange={e=>setPassword(e.target.value)}
                    disabled={busy}
                    autoComplete={mode==="signin" ? "current-password" : "new-password"}
                    placeholder="Mínimo 8 caracteres"
                  />
                  <button type="button" onClick={()=>setShowPassword(v=>!v)} className="absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 text-slate-400">
                    {showPassword ? <EyeOff className="w-4 h-4 mx-auto"/> : <Eye className="w-4 h-4 mx-auto"/>}
                  </button>
                </div>
              </label>

              {mode === "recovery" ? (
                <label className="block">
                  <span className="label">Confirmar contraseña</span>
                  <div className="relative">
                    <LockKeyhole className="icon"/>
                    <input
                      type={showPassword ? "text" : "password"}
                      className="field pl-10 h-11"
                      value={confirmPassword}
                      onChange={e=>setConfirmPassword(e.target.value)}
                      disabled={busy}
                      autoComplete="new-password"
                      placeholder="Repite la contraseña"
                    />
                  </div>
                </label>
              ) : null}

              {error ? (
                <div className="rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-[10px] font-bold p-3">{error}</div>
              ) : null}
              {message ? (
                <div className="rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-700 text-[10px] font-bold p-3">{message}</div>
              ) : null}

              <button disabled={busy} className="w-full h-11 mt-1 rounded-xl bg-[#6535C5] hover:bg-[#4F249D] text-white text-xs font-black flex items-center justify-center gap-2 disabled:opacity-50">
                {busy
                  ? "Procesando..."
                  : mode === "signup"
                    ? "Crear cuenta"
                    : mode === "reset"
                      ? "Enviar enlace"
                      : mode === "recovery"
                        ? "Actualizar contraseña"
                        : "Entrar a PALMYRA"}
                {!busy && <ArrowRight className="w-4 h-4"/>}
              </button>
            </form>

            {mode === "signin" && <button type="button" onClick={()=>{setMode("reset");setError("");setMessage("");}} className="w-full mt-3 text-[9px] font-black text-[#6535C5]">¿Olvidaste tu contraseña?</button>}
            {mode === "reset" && <button type="button" onClick={()=>{setMode("signin");setError("");setMessage("");}} className="w-full mt-3 text-[9px] font-black text-slate-400">Volver a iniciar sesión</button>}

            <div className="mt-5 pt-4 border-t border-violet-100 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-[8px] text-slate-400">
              <span className="inline-flex items-center gap-1"><Check className="w-3 h-3 text-emerald-600"/> Datos aislados</span>
              <span className="inline-flex items-center gap-1"><ShieldCheck className="w-3 h-3 text-[#6535C5]"/> Accesos por rol</span>
              <span className="inline-flex items-center gap-1"><MonitorSmartphone className="w-3 h-3 text-[#6535C5]"/> Multi-dispositivo</span>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
