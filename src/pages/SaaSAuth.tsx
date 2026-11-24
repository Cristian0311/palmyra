import React, { useEffect, useState } from "react";
import { ArrowRight, Check, Eye, EyeOff, Loader2, LockKeyhole, Mail, MailCheck, Send, ShieldCheck, Sparkles, Users, Warehouse, MonitorSmartphone } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { getSupabase } from "../lib/supabase";
import { entryPathForSurface, lockDevAppSurface } from "../lib/appSurface";
import { PalmyraWordmark } from "../components/PalmyraWordmark";
import { getPlan } from "../config/saas";
import { useDocumentScrollPage } from "../hooks/useDocumentScrollPage";
import {
  loadSaaSContext,
  requestSaaSPasswordReset,
  resendSaaSSignupConfirmation,
  signInSaaSAccount,
  signUpSaaSAccount,
  updateSaaSPassword
} from "../services/saas";
import {
  forgetOfflineSaaSCredential,
  rememberOfflineSaaSCredential,
  rememberPendingOfflineCredential,
  verifyOfflineSaaSCredential
} from "../services/offlineSaaSAuth";
import { isBrowserOffline, isTransientNetworkError } from "../services/offlineNetwork";
import { rememberOfflinePosCredential, syncOfflinePosCredentials } from "../services/offlinePosAuth";

type Mode = "signin" | "signup" | "reset" | "recovery" | "sent";

// Supabase puede quedarse esperando el lock de auth (pestañas, PWA en segundo
// plano, red del móvil). Ninguna petición de acceso debe dejar el botón en
// "Procesando..." para siempre: al vencer, se libera el formulario con un
// mensaje claro y el usuario puede reintentar.
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => { window.clearTimeout(timer); resolve(value); },
      (error) => { window.clearTimeout(timer); reject(error); }
    );
  });
}

function messageFor(error: any) {
  const raw = String(error?.message || error?.error_description || "");
  if (/user already registered|already (been )?registered|email address.*already/i.test(raw)) return "Este correo ya tiene una cuenta. Inicia sesión o recupera tu contraseña.";
  if (/invalid login credentials/i.test(raw)) return "El correo o la contraseña no son correctos.";
  if (/email not confirmed/i.test(raw)) return "Confirma tu correo electrónico y vuelve a entrar.";
  if (/rate limit|too many requests|only request this after|for security purposes/i.test(raw)) return "Se alcanzó temporalmente el límite de intentos. Espera unos minutos e inténtalo de nuevo.";
  if (/password/i.test(raw) && /8/i.test(raw)) return "La contraseña debe tener al menos 8 caracteres.";
  if (/database error saving new user|error saving new user/i.test(raw)) return "No pudimos crear la cuenta en este momento. El registro no se completó; inténtalo nuevamente.";
  if (/failed to fetch|network ?error|network request failed|load failed/i.test(raw)) return "Sin conexión con PALMYRA. Revisa tu internet e inténtalo de nuevo.";
  if (/auth session missing|session not found|not authenticated|jwt/i.test(raw)) return "Tu enlace de recuperación ya no está activo. Solicita uno nuevo desde «¿Olvidaste tu contraseña?».";
  if (/redirect.*url|not allowed.*redirect/i.test(raw)) return "La configuración de acceso no aceptó la dirección de retorno. Vuelve a intentarlo.";
  if (/timed out|tiempo de espera|tardando demasiado/i.test(raw)) return "La conexión está tardando demasiado. Revisa tu internet e inténtalo de nuevo.";
  return raw || "No se pudo completar la operación.";
}

export default function SaaSAuth() {
  useDocumentScrollPage();
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
  const [sentTo, setSentTo] = useState("");
  const [resendIn, setResendIn] = useState(0);
  const plannedPlan = (() => {
    try {
      const code = sessionStorage.getItem("palmyra_signup_plan") || localStorage.getItem("palmyra_signup_plan");
      if (!code) return null;
      const plan = getPlan(code);
      return plan.code === code ? plan : null;
    } catch { return null; }
  })();

  useEffect(() => {
    if (resendIn <= 0) return;
    const timer = window.setTimeout(() => setResendIn((value) => value - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [resendIn]);

  const modeParam = params.get("mode");
  const recoveryParam = params.get("recovery") === "1";

  // Llegar desde el landing con ?mode=signup / ?mode=signin debe cambiar la
  // pestaña activa aunque el componente ya estuviera montado.
  useEffect(() => {
    if (recoveryParam) {
      setMode("recovery");
      return;
    }
    if (modeParam === "signup" || modeParam === "signin") {
      setMode((current) => (current === "sent" ? current : modeParam));
    }
  }, [modeParam, recoveryParam]);

  const switchMode = (next: "signin" | "signup") => {
    setMode(next);
    setError("");
    setMessage("");
    // Mantener la URL sincronizada para que recargar no vuelva a la otra pestaña.
    try {
      window.history.replaceState({}, "", next === "signup" ? "/auth?mode=signup" : "/auth?mode=signin");
    } catch {
      // Sin History API el formulario sigue funcionando igual.
    }
  };

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

  const finishAuth = async (credentialEmail?: string, credentialPassword?: string) => {
    // Cada acceso nuevo debe terminar en la pantalla de descarga, aunque en
    // desarrollo se haya abierto la app antes en esta pestaña.
    lockDevAppSurface();
    const ctx = await withTimeout(
      loadSaaSContext(true),
      15000,
      "Tu sesión se abrió, pero la verificación de la empresa está tardando demasiado. Vuelve a intentarlo."
    );
    if (!ctx) {
      setError("La sesión no pudo ser verificada.");
      return;
    }

    // Save a salted verifier only after Supabase has authenticated the account.
    // The raw password is never stored. This enables a later offline login on
    // this same browser after the company context has been cached once.
    if (credentialEmail && credentialPassword) {
      try {
        const normalizedCredentialContext = {
          ...ctx,
          user: { ...ctx.user, email: credentialEmail.trim().toLowerCase() }
        };
        if (ctx.companyId && ctx.company?.account_status === "active" &&
            ctx.membershipStatus === "active" && ctx.warehouseIds.length &&
            ctx.deviceActive && ctx.user.isActive !== false) {
          await rememberOfflineSaaSCredential(normalizedCredentialContext, credentialPassword);
          // The owner/admin uses the same account password for POS. Seed a
          // device-local POS verifier as part of this successful online login.
          // Employee PINs are never inferred from a web-account password.
          if (ctx.isOwner || ctx.roleKey === "admin") {
            try {
              await rememberOfflinePosCredential(ctx.companyId, ctx.authUserId, credentialPassword);
            } catch (posCredentialError) {
              console.info("[PALMYRA] No se pudo preparar el acceso offline del administrador al POS.", posCredentialError);
            }
          }
        } else if (!ctx.companyId) {
          // The sign-up screen appears before first-company onboarding. Keep the
          // credential only in module memory so onboarding can bind it to the
          // final company/warehouse security scope after creation.
          rememberPendingOfflineCredential(credentialEmail, credentialPassword);
        }
      } catch (offlineCredentialError) {
        console.warn("[PALMYRA] No se pudo preparar el acceso offline en este dispositivo.", offlineCredentialError);
      }
    }

    if (!ctx.companyId) {
      // Keep navigation inside React so the short-lived, memory-only signup
      // credential survives the move into first-company onboarding.
      navigate(ctx.membershipStatus && ctx.membershipStatus !== "active" ? "/account-status" : "/onboarding", { replace: true });
      return;
    }
    if (ctx.company?.account_status === "pending_payment" || ctx.company?.account_status === "suspended" || ctx.membershipStatus !== "active" || !ctx.deviceActive) {
      window.location.replace("/account-status");
      return;
    }
    // Finish best-effort prefetch before navigating away. The server returns
    // the full employee verifier set only to managers; standard POS users get
    // only their own verifier to avoid enabling offline impersonation.
    if (ctx.companyId && ctx.user.isActive !== false &&
        (ctx.isOwner || ctx.roleKey === "admin" ||
         ctx.user.permissions?.includes("pos.access") ||
         ctx.user.permissions?.includes("employees.manage"))) {
      try {
        await syncOfflinePosCredentials(ctx.companyId);
      } catch (offlinePosError) {
        console.info("[PALMYRA] La precarga POS offline se reintentará cuando haya conexión.", offlinePosError);
      }
    }
    // La cuenta quedó activa; en web se entra a la pantalla de descarga.
    window.location.replace(entryPathForSurface());
  };

  // El error anterior se queda en pantalla aunque el usuario ya corrigió el
  // campo, así que se descarta en cuanto vuelve a escribir.
  const clearError = () => {
    if (error) setError("");
  };

  const resendConfirmation = async (address: string) => {
    const clean = address.trim().toLowerCase();
    setError("");
    setMessage("");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clean)) {
      setError("Escribe tu correo para reenviar la confirmación.");
      return;
    }
    setBusy(true);
    try {
      const { error: resendError } = await resendSaaSSignupConfirmation(clean);
      if (resendError) throw resendError;
      setMessage("Correo de confirmación reenviado. Revisa tu bandeja y la carpeta de spam.");
      setResendIn(45);
    } catch (err: any) {
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setMessage("");
    setBusy(true);
    // La sesión puede quedar activa antes de que finishAuth navegue; si el
    // permiso local de desarrollo sigue abierto, el inicio asomaría un instante.
    lockDevAppSurface();
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
        const { error: updateError } = await withTimeout(
          updateSaaSPassword(password),
          20000,
          "La actualización de la contraseña está tardando demasiado. Inténtalo de nuevo."
        );
        if (updateError) throw updateError;
        // A password change invalidates the old device-side verifier. The user
        // must next authenticate online with the new password to re-enable
        // offline login on this device.
        try {
          const supabase = getSupabase();
          // getSession reads the current recovery session locally; using getUser
          // here would depend on a second network round-trip after the password
          // has already changed successfully.
          const { data: authData } = supabase ? await supabase.auth.getSession() : { data: { session: null } };
          if (authData.session?.user?.id) forgetOfflineSaaSCredential(authData.session.user.id);
        } catch (offlineCredentialError) {
          console.warn("[PALMYRA] No se pudo invalidar la credencial offline anterior.", offlineCredentialError);
        }
        // La contraseña ya cambió. Cerramos la sesión temporal del enlace para
        // que el acceso quede protegido con la contraseña nueva y el usuario
        // no entre con la sesión de recuperación.
        try {
          await getSupabase()?.auth.signOut();
        } catch (signOutError) {
          console.warn("[PALMYRA] No se pudo cerrar la sesión de recuperación.", signOutError);
        }
        window.history.replaceState({}, "", "/auth");
        setMode("signin");
        setPassword("");
        setConfirmPassword("");
        setMessage("Contraseña actualizada. Inicia sesión con tu nueva contraseña.");
        return;
      }

      if (mode === "signup") {
        if (name.trim().length < 2) throw new Error("Escribe tu nombre completo.");
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) throw new Error("Escribe un correo válido.");
        if (password.length < 8) throw new Error("La contraseña debe tener al menos 8 caracteres.");
        if (password !== confirmPassword) throw new Error("Las contraseñas no coinciden.");

        const result = await withTimeout(
          signUpSaaSAccount(name, email, password, "/auth"),
          25000,
          "El registro está tardando demasiado. Revisa tu conexión e inténtalo de nuevo."
        );
        if (result.error) throw result.error;
        if (!result.data.user) throw new Error("No se pudo crear el usuario.");
        // Supabase devuelve identities vacías cuando el correo ya está
        // registrado: no creamos una cuenta nueva ni mostramos un falso éxito.
        if (Array.isArray(result.data.user.identities) && result.data.user.identities.length === 0) {
          throw new Error("Este correo ya tiene una cuenta PALMYRA. Inicia sesión o recupera tu contraseña.");
        }
        if (!result.data.session) {
          setSentTo(email.trim().toLowerCase());
          setMode("sent");
          setResendIn(45);
          setPassword("");
          setConfirmPassword("");
          setError("");
          setMessage("");
          return;
        }
        if (typeof sessionStorage !== "undefined") {
          sessionStorage.setItem("palmyra_pending_onboarding", "1");
        }
        await finishAuth(email, password);
        return;
      }

      if (!email.trim() || !password) throw new Error("Correo y contraseña son obligatorios.");
      if (typeof navigator !== "undefined" && !navigator.onLine) {
        const offlineContext = await verifyOfflineSaaSCredential(email, password);
        if (!offlineContext) {
          throw new Error("No hay conexión y este dispositivo no tiene una sesión offline válida para ese correo. Conéctate una vez, inicia sesión y vuelve a intentarlo sin internet.");
        }
        window.location.replace(entryPathForSurface());
        return;
      }
      const result = await withTimeout(
        signInSaaSAccount(email, password),
        25000,
        "El acceso está tardando demasiado. Revisa tu conexión e inténtalo de nuevo."
      );
      if (result.error) throw result.error;
      await finishAuth(email, password);
    } catch (err: any) {
      // navigator.onLine may remain true on Wi-Fi without working Internet.
      // After a failed real login request, allow only the previously verified
      // local credential to open this device's cached company context.
      if (mode === "signin" && email.trim() && password &&
          (isBrowserOffline() || isTransientNetworkError(err))) {
        try {
          const offlineContext = await verifyOfflineSaaSCredential(email, password);
          if (offlineContext) {
            window.location.replace(entryPathForSurface());
            return;
          }
        } catch (offlineError) {
          console.warn("[PALMYRA] Offline login check could not complete.", offlineError);
        }
      }
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="palmyra-scroll-page min-h-[100dvh] bg-[#F7F5FC] overflow-y-auto flex items-start sm:items-center justify-center px-3 pt-3 pb-[calc(1.5rem+env(safe-area-inset-bottom))] sm:p-5" data-keyboard-viewport="native">
      <div className="w-full max-w-4xl">
        <div className="flex items-center justify-between mb-3 px-1">
          <button onClick={() => navigate("/landing")} className="flex items-center gap-2.5" aria-label="Ir a la página de inicio de PALMYRA">
            <PalmyraWordmark className="h-8 w-auto sm:h-10" />
          </button>
          <button onClick={() => navigate("/landing")} className="text-[11px] font-black uppercase tracking-wider text-slate-500 hover:text-[#6535C5]">Volver al inicio</button>
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
                  { Icon: ShieldCheck, text: "Una cuenta pertenece a una sola empresa." },
                  { Icon: Warehouse, text: "Almacenes según el plan contratado." },
                  { Icon: Users, text: "Trabajadores con cuentas y permisos propios." }
                ].map(({ Icon, text }) => <div key={text} className="flex items-center gap-2.5 rounded-xl bg-white/8 border border-white/8 p-3"><Icon className="w-4 h-4 text-violet-200 shrink-0"/><span className="text-[9px] text-violet-100/80">{text}</span></div>)}
              </div>
              <div className="mt-7 rounded-2xl border border-white/10 bg-white/5 p-4"><p className="text-[8px] uppercase tracking-wider font-black text-violet-200">Cuba</p><p className="text-sm font-black mt-1">Planes con pago en efectivo</p><p className="text-[9px] text-violet-200/70 mt-1">CUP en efectivo o por transferencia y USD en efectivo; confirmación manual de cada pago.</p></div>
            </div>
          </section>

          <section className="p-4 sm:p-6">
            <div>
              <p className="text-[9px] uppercase tracking-[.18em] font-black text-[#7649D6]">
                {mode === "recovery" ? "Recuperación" : mode === "signup" ? "Crear cuenta" : mode === "reset" ? "Recuperar acceso" : mode === "sent" ? "Confirma tu correo" : "Bienvenido"}
              </p>
              <h2 className="text-2xl font-black tracking-[-.04em] text-[#2A1938] mt-1">
                {mode === "signup" ? "Crea tu cuenta PALMYRA" : mode === "reset" ? "Recupera tu contraseña" : mode === "recovery" ? "Crea una nueva contraseña" : mode === "sent" ? "Revisa tu correo" : "Entra a tu empresa"}
              </h2>
              <p className="text-xs text-slate-500 mt-2 leading-5">
                {mode === "signup" ? "Crea tu acceso en menos de un minuto. Después configurarás empresa, almacén y plan en un solo paso." : mode === "sent" ? "Enviamos un enlace seguro para activar tu cuenta." : mode === "recovery" ? "Usa una contraseña nueva de al menos 8 caracteres." : "Tu sesión determina la empresa, rol y permisos que puedes utilizar."}
              </p>
              {mode === "signup" && plannedPlan ? (
                <div className="mt-3 flex items-center justify-between gap-2 rounded-xl border border-violet-100 bg-[#F7F5FC] px-3 py-2">
                  <span className="text-[11px] leading-5 text-slate-500">
                    Plan elegido: <strong className="text-[#3B1B78]">{plannedPlan.name}</strong>
                    {plannedPlan.price === 0 ? " · Gratis" : ` · ${plannedPlan.price} USD/mes`}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      navigate("/landing");
                      window.setTimeout(() => document.getElementById("planes")?.scrollIntoView({ behavior: "smooth" }), 350);
                    }}
                    className="text-[10px] font-black text-[#6535C5]"
                  >
                    Cambiar
                  </button>
                </div>
              ) : null}
            </div>

            {mode !== "recovery" && mode !== "sent" && <div className="grid grid-cols-2 gap-1 p-1 bg-[#F7F5FC] rounded-xl mt-5">
              <button type="button" onClick={() => switchMode("signin")} className={"h-11 min-h-11 rounded-lg text-[11px] font-black " + (mode==="signin"?"bg-white text-[#3B1B6E] shadow-sm":"text-slate-500")}>Iniciar sesión</button>
              <button type="button" onClick={() => switchMode("signup")} className={"h-11 min-h-11 rounded-lg text-[11px] font-black " + (mode==="signup"?"bg-white text-[#3B1B6E] shadow-sm":"text-slate-500")}>Crear cuenta</button>
            </div>}

            {mode === "sent" ? (
              <div className="mt-5 rounded-2xl border border-violet-100 bg-[#F7F5FC] p-4">
                <div className="flex items-start gap-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#EFE8FF] text-[#5B2DBA]"><MailCheck className="h-5 w-5" /></span>
                  <div className="min-w-0">
                    <p className="text-sm font-black text-[#3B1B78]">Confirma tu cuenta para continuar</p>
                    <p className="mt-1 break-all text-[11px] leading-5 text-slate-500">Enviamos el enlace a <strong className="text-slate-700">{sentTo}</strong>. Ábrelo en este mismo dispositivo para activar tu acceso.</p>
                  </div>
                </div>
                <ol className="mt-3 space-y-1.5 text-[11px] leading-5 text-slate-600">
                  <li>1. Busca el remitente <strong className="text-slate-700">PALMYRA</strong> en Principal, Promociones o Spam.</li>
                  <li>2. Pulsa «Confirmar correo electrónico».</li>
                  <li>3. Márcalo como «No es spam» y agrégalo a contactos para que los próximos avisos lleguen a Principal.</li>
                  <li>4. Si el enlace no abre la sesión, vuelve aquí y entra con tu contraseña.</li>
                </ol>
                {error ? <div role="alert" className="mt-3 rounded-xl border border-rose-200 bg-rose-50 p-3 text-[11px] font-bold text-rose-700">{error}</div> : null}
                {message ? <div role="status" className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-[11px] font-bold text-emerald-700">{message}</div> : null}
                <button
                  type="button"
                  disabled={busy || resendIn > 0}
                  onClick={() => void resendConfirmation(sentTo)}
                  className="mt-3 inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-[#5B2DBA] text-xs font-black text-white disabled:opacity-50"
                >
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  {resendIn > 0 ? `Reenviar en ${resendIn} s` : "Reenviar correo de confirmación"}
                </button>
                <button type="button" onClick={() => { setSentTo(""); switchMode("signup"); }} className="mt-2 h-11 w-full rounded-xl bg-[#EFE8FF] text-[11px] font-black text-[#5B2DBA]">
                  Usar otro correo
                </button>
              </div>
            ) : (
            <form onSubmit={submit} className="space-y-3 mt-4">
              {mode === "signup" ? (
                <label className="block" htmlFor="auth-name">
                  <span className="form-label">Nombre completo</span>
                  <div className="relative">
                    <Users className="field-icon" />
                    <input id="auth-name" className="field-input pl-10 h-11" value={name} onChange={e=>{setName(e.target.value); clearError();}} disabled={busy} autoComplete="name" placeholder="Tu nombre"/>
                  </div>
                </label>
              ) : null}

              {mode !== "recovery" ? (
                <label className="block" htmlFor="auth-email">
                  <span className="form-label">Correo</span>
                  <div className="relative">
                    <Mail className="field-icon" />
                    <input id="auth-email" type="email" className="field-input pl-10 h-11" value={email} onChange={e=>{setEmail(e.target.value); clearError();}} disabled={busy} autoComplete="email" placeholder="nombre@empresa.com"/>
                  </div>
                </label>
              ) : null}

              {/* En modo "reset" solo se envía el enlace: pedir una contraseña
                  aquí confundía porque el campo no se usa. */}
              {mode !== "reset" ? (
              <label className="block" htmlFor="auth-password">
                <span className="form-label">{mode==="recovery" ? "Nueva contraseña" : "Contraseña"}</span>
                <div className="relative">
                  <LockKeyhole className="field-icon" />
                  <input
                    id="auth-password"
                    type={showPassword ? "text" : "password"}
                    className="field-input pl-10 pr-10 h-11"
                    value={password}
                    onChange={e=>{setPassword(e.target.value); clearError();}}
                    disabled={busy}
                    autoComplete={mode==="signin" ? "current-password" : "new-password"}
                    placeholder="Mínimo 8 caracteres"
                  />
                  <button
                    type="button"
                    onClick={()=>setShowPassword(v=>!v)}
                    aria-label={showPassword ? "Ocultar contraseña" : "Mostrar contraseña"}
                    className="absolute right-1 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-lg text-slate-500"
                  >
                    {showPassword ? <EyeOff className="w-4 h-4 mx-auto"/> : <Eye className="w-4 h-4 mx-auto"/>}
                  </button>
                </div>
              </label>
              ) : null}

              {mode === "recovery" || mode === "signup" ? (
                <label className="block" htmlFor="auth-password-confirm">
                  <span className="form-label">Confirmar contraseña</span>
                  <div className="relative">
                    <LockKeyhole className="field-icon"/>
                    <input
                      id="auth-password-confirm"
                      type={showPassword ? "text" : "password"}
                      className="field-input pl-10 h-11"
                      value={confirmPassword}
                      onChange={e=>{setConfirmPassword(e.target.value); clearError();}}
                      disabled={busy}
                      autoComplete="new-password"
                      placeholder="Repite la contraseña"
                    />
                  </div>
                </label>
              ) : null}

              {error ? (
                <div role="alert" className="rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-[11px] font-bold p-3">{error}</div>
              ) : null}
              {mode === "signin" && error && /confirma tu correo/i.test(error) ? (
                <button
                  type="button"
                  disabled={busy || resendIn > 0}
                  onClick={() => void resendConfirmation(email)}
                  className="h-11 w-full rounded-xl border border-violet-200 bg-white text-[11px] font-black text-[#5B2DBA] disabled:opacity-50"
                >
                  {resendIn > 0 ? `Reenviar en ${resendIn} s` : "Reenviar correo de confirmación"}
                </button>
              ) : null}
              {message ? (
                <div role="status" className="rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-700 text-[11px] font-bold p-3">{message}</div>
              ) : null}

              <button type="submit" disabled={busy} className="w-full h-11 mt-1 rounded-xl bg-[#6535C5] hover:bg-[#4F249D] text-white text-xs font-black flex items-center justify-center gap-2 disabled:opacity-50 active:scale-[.98]">
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
            )}

            {mode === "signin" && <button type="button" onClick={()=>{setMode("reset");setError("");setMessage("");}} className="mt-3 min-h-11 w-full text-[11px] font-black text-[#6535C5]">¿Olvidaste tu contraseña?</button>}
            {mode === "reset" && <button type="button" onClick={()=>switchMode("signin")} className="mt-3 min-h-11 w-full text-[11px] font-black text-slate-500">Volver a iniciar sesión</button>}

            <div className="mt-5 pt-4 border-t border-violet-100 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-[10px] text-slate-500">
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
