import React, { useEffect, useState } from "react";
import { ArrowRight, CheckCircle2, LockKeyhole, Mail, Store, UserRound } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { loadSaaSContext, signInSaaSAccount, signUpSaaSAccount, requestSaaSPasswordReset, updateSaaSPassword } from "../services/saas";
import { getSupabase } from "../lib/supabase";

type Mode = "signin" | "signup" | "reset" | "recovery";

export default function SaaSAuth() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>("signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [recoveryMode, setRecoveryMode] = useState(
    new URLSearchParams(window.location.search).get("recovery") === "1"
  );

  useEffect(() => {
    const supabase = getSupabase();
    if (!supabase) return;
    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") {
        setRecoveryMode(true);
        setMode("recovery");
        setError("");
        setMessage("");
      }
    });
    return () => data.subscription.unsubscribe();
  }, []);

  const continueAfterAuth = async () => {
    const ctx = await loadSaaSContext();
    if (!ctx) {
      setError("No se pudo cargar tu sesión. Vuelve a intentarlo.");
      return;
    }
    if (!ctx.companyId) {
      navigate("/onboarding", { replace: true });
      return;
    }
    if (ctx.company?.account_status === "pending_payment" || ctx.company?.account_status === "suspended") {
      navigate("/account-status", { replace: true });
      return;
    }
    navigate("/", { replace: true });
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");

    try {
      if (mode === "reset") {
        if (!email.trim()) {
          setError("Escribe tu correo.");
          return;
        }
        const { error: resetError } = await requestSaaSPasswordReset(email);
        if (resetError) throw resetError;
        setMessage("Si existe una cuenta con ese correo, recibirás un enlace para restablecer la contraseña.");
        return;
      }

      if (mode === "recovery" || recoveryMode) {
        if (password.length < 8) {
          setError("La contraseña debe tener al menos 8 caracteres.");
          return;
        }
        if (password !== confirmPassword) {
          setError("Las contraseñas no coinciden.");
          return;
        }
        const { error: updateError } = await updateSaaSPassword(password);
        if (updateError) throw updateError;
        setPassword("");
        setConfirmPassword("");
        setRecoveryMode(false);
        setMessage("Contraseña actualizada. Ya puedes entrar a PALMYRA.");
        setMode("signin");
        window.history.replaceState({}, "", "/auth");
        return;
      }

      if (mode === "signup") {
        if (name.trim().length < 2) {
          setError("Escribe tu nombre completo.");
          return;
        }
        if (password.length < 8) {
          setError("La contraseña debe tener al menos 8 caracteres.");
          return;
        }

        const { data, error: signUpError } = await signUpSaaSAccount(name, email, password);
        if (signUpError) throw signUpError;

        if (!data.session) {
          setMessage("Cuenta creada. Revisa tu correo para confirmar la cuenta y después entra a PALMYRA.");
          setMode("signin");
          return;
        }

        await continueAfterAuth();
      } else {
        if (!email.trim() || !password) {
          setError("Correo y contraseña son obligatorios.");
          return;
        }

        const { error: signInError } = await signInSaaSAccount(email, password);
        if (signInError) throw signInError;
        await continueAfterAuth();
      }
    } catch (err: any) {
      setError(err?.message || "No se pudo completar la operación.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-8 flex items-center justify-center">
      <div className="w-full max-w-5xl grid lg:grid-cols-[1.05fr_0.95fr] bg-white border border-slate-200 rounded-[2rem] overflow-hidden shadow-xl">
        <section className="hidden lg:flex bg-slate-950 text-white p-12 flex-col justify-between">
          <div>
            <div className="flex items-center gap-3 mb-10">
              <div className="w-11 h-11 rounded-2xl bg-rose-500 flex items-center justify-center">
                <Store className="w-6 h-6" />
              </div>
              <span className="text-xl font-black tracking-tight">PALMYRA</span>
            </div>
            <p className="text-xs font-black tracking-[0.2em] text-rose-300 uppercase">SaaS de gestión empresarial</p>
            <h1 className="text-4xl font-black leading-tight mt-4 max-w-lg">
              Una cuenta para administrar tu negocio completo.
            </h1>
            <p className="text-slate-300 mt-5 max-w-xl text-sm leading-6">
              Ventas, inventario, caja, compras, clientes, empleados, almacenes y trabajo offline dentro de una misma empresa.
            </p>
          </div>
          <div className="space-y-3 text-sm text-slate-300">
            {[
              "Aislamiento por empresa",
              "Usuarios y permisos",
              "Modo offline + sincronización",
              "Planes y suscripciones"
            ].map((item) => (
              <div key={item} className="flex items-center gap-3">
                <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                <span>{item}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="p-6 sm:p-10">
          <div className="lg:hidden flex items-center gap-3 mb-8">
            <div className="w-10 h-10 rounded-xl bg-rose-500 text-white flex items-center justify-center">
              <Store className="w-5 h-5" />
            </div>
            <span className="text-lg font-black">PALMYRA</span>
          </div>

          <div className="max-w-md mx-auto">
            <p className="text-[10px] font-black tracking-[0.18em] text-slate-400 uppercase">Acceso</p>
            <h2 className="text-3xl font-black text-slate-950 mt-2">
              {mode === "signin" ? "Entra a tu cuenta" : "Crea tu cuenta"}
            </h2>
            <p className="text-sm text-slate-500 mt-2">
              {mode === "reset"
                ? "Te enviaremos un enlace para recuperar tu contraseña."
                : mode === "recovery"
                  ? "Crea una nueva contraseña para continuar."
                  : mode === "signin"
                    ? "Tu sesión determina automáticamente la empresa y los permisos."
                    : "Después de registrarte crearás tu empresa y elegirás el plan."}
            </p>

            {mode !== "recovery" && (
            <div className="grid grid-cols-2 p-1 bg-slate-100 rounded-xl mt-7">
              <button
                type="button"
                onClick={() => { setMode("signin"); setError(""); setMessage(""); }}
                className={`py-2.5 rounded-lg text-sm font-bold transition ${mode === "signin" ? "bg-white shadow text-slate-950" : "text-slate-500"}`}
              >
                Iniciar sesión
              </button>
              <button
                type="button"
                onClick={() => { setMode("signup"); setError(""); setMessage(""); }}
                className={`py-2.5 rounded-lg text-sm font-bold transition ${mode === "signup" ? "bg-white shadow text-slate-950" : "text-slate-500"}`}
              >
                Crear cuenta
              </button>
            </div>
          )}

            <form onSubmit={submit} className="space-y-4 mt-6">
              {mode === "signup" && (
                <label className="block">
                  <span className="block text-xs font-bold text-slate-600 mb-2">Nombre completo</span>
                  <div className="relative">
                    <UserRound className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                    <input value={name} onChange={e => setName(e.target.value)} disabled={busy}
                      className="w-full h-12 pl-10 pr-4 rounded-xl border border-slate-200 bg-slate-50 outline-none focus:bg-white focus:border-rose-400"
                      placeholder="Tu nombre" />
                  </div>
                </label>
              )}

              {mode !== "recovery" && <label className="block">
                <span className="block text-xs font-bold text-slate-600 mb-2">Correo</span>
                <div className="relative">
                  <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                  <input type="email" value={email} onChange={e => setEmail(e.target.value)} disabled={busy} autoComplete="email"
                    className="w-full h-12 pl-10 pr-4 rounded-xl border border-slate-200 bg-slate-50 outline-none focus:bg-white focus:border-rose-400"
                    placeholder="nombre@empresa.com" />
                </div>
              </label>}

              <label className="block">
                <span className="block text-xs font-bold text-slate-600 mb-2">{mode === "recovery" ? "Nueva contraseña" : "Contraseña"}</span>
                <div className="relative">
                  <LockKeyhole className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                  <input type="password" value={password} onChange={e => setPassword(e.target.value)} disabled={busy} autoComplete={mode === "signin" ? "current-password" : "new-password"}
                    className="w-full h-12 pl-10 pr-4 rounded-xl border border-slate-200 bg-slate-50 outline-none focus:bg-white focus:border-rose-400"
                    placeholder="••••••••" />
                </div>
              </label>

              {mode === "recovery" && (
                <label className="block">
                  <span className="block text-xs font-bold text-slate-600 mb-2">Confirmar contraseña</span>
                  <div className="relative">
                    <LockKeyhole className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                    <input type="password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} disabled={busy} autoComplete="new-password"
                      className="w-full h-12 pl-10 pr-4 rounded-xl border border-slate-200 bg-slate-50 outline-none focus:bg-white focus:border-rose-400"
                      placeholder="••••••••" />
                  </div>
                </label>
              )}

              {error && <div className="rounded-xl border border-rose-200 bg-rose-50 text-rose-700 text-sm p-3">{error}</div>}
              {message && <div className="rounded-xl border border-emerald-200 bg-emerald-50 text-emerald-700 text-sm p-3">{message}</div>}

              <button disabled={busy} className="w-full h-12 rounded-xl bg-slate-950 text-white font-bold flex items-center justify-center gap-2 disabled:opacity-50">
                {busy ? "Procesando..." : mode === "recovery" ? "Actualizar contraseña" : mode === "reset" ? "Enviar enlace" : mode === "signin" ? "Entrar a PALMYRA" : "Crear cuenta"}
                {!busy && <ArrowRight className="w-4 h-4" />}
              </button>
            </form>

            {mode === "signin" && (
              <button type="button" onClick={() => { setMode("reset"); setError(""); setMessage(""); }} className="w-full text-xs font-bold text-rose-600 mt-4">
                ¿Olvidaste tu contraseña?
              </button>
            )}
            {mode === "reset" && (
              <button type="button" onClick={() => { setMode("signin"); setError(""); setMessage(""); }} className="w-full text-xs font-bold text-slate-500 mt-4">
                Volver a iniciar sesión
              </button>
            )}

            <p className="text-[11px] text-slate-400 mt-6 leading-5">
              La cuenta principal de PALMYRA usa autenticación de Supabase. Los empleados operativos de cada empresa se gestionan por separado dentro del sistema.
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}
