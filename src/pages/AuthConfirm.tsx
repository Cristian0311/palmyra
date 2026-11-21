import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, ArrowRight, CheckCircle2, Loader2, MailCheck, Send } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import type { EmailOtpType, VerifyOtpParams } from "@supabase/supabase-js";
import { getSupabase } from "../lib/supabase";
import { PalmyraWordmark } from "../components/PalmyraWordmark";
import { useDocumentScrollPage } from "../hooks/useDocumentScrollPage";

type Phase = "verifying" | "success" | "error";

function getInvitationRedirect(searchParams: URLSearchParams): string | null {
  const candidates = [
    searchParams.get("redirect_to"),
    searchParams.get("redirectTo"),
    searchParams.get("next"),
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    try {
      const url = new URL(candidate, window.location.origin);
      if (url.pathname === "/invite") {
        const token = url.searchParams.get("token");
        if (token) return `/invite?token=${encodeURIComponent(token)}`;
      }
    } catch {}
  }

  const directToken = searchParams.get("invitation_token") || searchParams.get("token");
  if (directToken) return `/invite?token=${encodeURIComponent(directToken)}`;

  try {
    const pendingToken = sessionStorage.getItem("palmyra_pending_invitation");
    if (pendingToken) return `/invite?token=${encodeURIComponent(pendingToken)}`;
  } catch {}

  return null;
}

function friendlyVerifyError(message: string) {
  return /expired|invalid|otp|used/i.test(message)
    ? "El enlace ya fue utilizado o caducó. Si ya confirmaste tu correo, entra con tu contraseña; si no, reenvía el correo de confirmación."
    : message || "No pudimos verificar el enlace. Inténtalo de nuevo.";
}

export default function AuthConfirm() {
  useDocumentScrollPage();
  const [params] = useSearchParams();
  const [phase, setPhase] = useState<Phase>("verifying");
  const [status, setStatus] = useState("Verificando tu enlace seguro…");
  const [error, setError] = useState("");
  const [destination, setDestination] = useState("/");
  const [target, setTarget] = useState("");
  const [resendEmail, setResendEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [resent, setResent] = useState("");
  // Permite repetir la verificación cuando el enlace tardó o la red falló.
  const [attempt, setAttempt] = useState(0);

  const type = useMemo(() => (params.get("type") || "email").toLowerCase(), [params]);
  const tokenHash = params.get("token_hash");
  const rawToken = params.get("token");
  const authCode = params.get("code");
  const queryError = params.get("error_description") || params.get("error");

  const finishSuccess = useCallback((path: string, note: string) => {
    setDestination(path);
    setStatus(note);
    setPhase("success");
    window.setTimeout(() => window.location.replace(path), 900);
  }, []);

  // La verificación nunca puede quedar girando para siempre: si Supabase no
  // responde (red móvil, lock de auth), se libera la pantalla con salidas.
  useEffect(() => {
    if (phase !== "verifying") return;
    const watchdog = window.setTimeout(() => {
      setError("La verificación está tardando más de lo normal. Revisa tu conexión y vuelve a intentarlo; si ya confirmaste el correo, entra con tu contraseña.");
      setPhase("error");
    }, 15000);
    return () => window.clearTimeout(watchdog);
  }, [phase, attempt]);

  const retryVerification = () => {
    setError("");
    setResent("");
    setPhase("verifying");
    setStatus("Verificando tu enlace seguro…");
    setAttempt((value) => value + 1);
  };

  useEffect(() => {
    let active = true;

    const decideDestination = async (supabase: ReturnType<typeof getSupabase>, userId: string) => {
      try {
        const { data, error: membershipError } = await supabase!
          .from("company_memberships")
          .select("company_id,status")
          .eq("user_id", userId)
          .limit(5);
        if (!membershipError) {
          const rows = (data || []) as Array<{ company_id: string; status: string }>;
          const usable = rows.find((row) => row.status === "active");
          if (usable) {
            try { sessionStorage.removeItem("palmyra_pending_onboarding"); } catch {}
            return { path: "/", note: "Correo confirmado. Abriendo tu empresa…" };
          }
          if (rows.length) {
            return { path: "/account-status", note: "Correo confirmado. Revisando el estado de tu empresa…" };
          }
        }
      } catch { /* Si la consulta falla, el onboarding vuelve a comprobar el estado. */ }
      try { sessionStorage.setItem("palmyra_pending_onboarding", "1"); } catch {}
      return { path: "/onboarding", note: "Correo confirmado. Prepara tu empresa para empezar…" };
    };

    const verify = async () => {
      const supabase = getSupabase();
      if (!supabase) {
        if (active) { setError("La conexión con PALMYRA no está configurada en este dispositivo."); setPhase("error"); }
        return;
      }

      if (queryError) {
        if (active) {
          setError(friendlyVerifyError(String(queryError)));
          setPhase("error");
        }
        return;
      }

      let verified = false;
      let lastMessage = "";

      if (authCode) {
        const { error: codeError } = await supabase.auth.exchangeCodeForSession(authCode);
        verified = !codeError;
        lastMessage = codeError?.message || "";
      } else if (tokenHash || rawToken) {
        const attempts = new Set<string>();
        attempts.add(type);
        if (type !== "recovery") {
          // GoTrue acepta type=email para confirmar registros; signup se
          // mantiene como respaldo para enlaces generados por otras vías.
          if (!attempts.has("email")) attempts.add("email");
          if (!attempts.has("signup")) attempts.add("signup");
        }
        const linkEmail = (params.get("email") || resendEmail || "").trim().toLowerCase();
        for (const attempt of attempts) {
          if (rawToken && !tokenHash && !linkEmail) break;
          const credentials: VerifyOtpParams = tokenHash
            ? { token_hash: tokenHash, type: attempt as EmailOtpType }
            : { email: linkEmail, token: rawToken as string, type: attempt as EmailOtpType };
          const { error: verifyError } = await supabase.auth.verifyOtp(credentials);
          if (!verifyError) { verified = true; break; }
          lastMessage = verifyError.message || lastMessage;
        }
      } else {
        // Enlaces antiguos (hash en la URL) dejan la sesión creada por
        // supabase-js al cargar la página; si ya existe, continuamos.
        const { data } = await supabase.auth.getSession();
        if (data.session?.user?.email_confirmed_at) {
          verified = true;
        } else if (!data.session) {
          lastMessage = "El enlace no incluye los datos de confirmación.";
        }
      }

      const { data: sessionData } = await supabase.auth.getSession();
      if (!active) return;

      if (!verified && sessionData.session?.user?.email_confirmed_at && /expired|invalid|otp|used/i.test(lastMessage)) {
        // El token pudo consumirse en el primer clic (o por un escáner del
        // correo). Si esta cuenta ya quedó confirmada, el acceso es válido.
        verified = true;
      }

      if (!verified) {
        if (!sessionData.session && !lastMessage) {
          lastMessage = "El enlace de confirmación está incompleto.";
        }
        setError(friendlyVerifyError(lastMessage));
        setPhase("error");
        return;
      }

      if (!sessionData.session) {
        setError("El correo quedó confirmado, pero la sesión no se abrió en este navegador. Inicia sesión con tu contraseña para continuar.");
        setPhase("error");
        return;
      }

      const user = sessionData.session.user;
      if (type === "recovery") {
        finishSuccess("/auth?recovery=1", "Enlace verificado. Crea tu nueva contraseña…");
        return;
      }

      const invitationRedirect = getInvitationRedirect(params);
      if (invitationRedirect) {
        try {
          const invitationUrl = new URL(invitationRedirect, window.location.origin);
          const invitationToken = invitationUrl.searchParams.get("token");
          if (invitationToken) {
            sessionStorage.setItem("palmyra_pending_invitation", invitationToken);
            sessionStorage.setItem("palmyra_pending_invitation_email", user.email?.trim().toLowerCase() || "");
          }
        } catch {}
        finishSuccess(invitationRedirect, "Correo confirmado. Activando tu acceso a la empresa…");
        return;
      }

      const decision = await decideDestination(supabase, user.id);
      if (!active) return;
      finishSuccess(decision.path, decision.note);
    };

    void verify().catch((unexpected) => {
      if (!active) return;
      setError(friendlyVerifyError(String((unexpected as Error)?.message || "")));
      setPhase("error");
    });

    return () => { active = false; };
  }, [params, type, tokenHash, rawToken, authCode, queryError, finishSuccess, attempt]);

  useEffect(() => {
    const supabase = getSupabase();
    if (!supabase) return;
    void supabase.auth.getSession().then(({ data }) => {
      if (data.session?.user?.email) {
        setResendEmail((current) => current || data.session?.user.email || "");
        setTarget(data.session.user.email || "");
      }
    });
  }, []);

  const resend = async () => {
    const email = resendEmail.trim().toLowerCase();
    setResent("");
    setError("");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      setError("Escribe el correo con el que te registraste.");
      return;
    }
    const supabase = getSupabase();
    if (!supabase) return;
    setSending(true);
    try {
      const { error: resendError } = await supabase.auth.resend({
        type: "signup",
        email,
        options: { emailRedirectTo: `${window.location.origin}/auth` },
      });
      if (resendError) throw resendError;
      setResent("Correo reenviado. Revisa tu bandeja de entrada y la carpeta de spam.");
    } catch (caught: any) {
      const raw = String(caught?.message || "");
      setError(/for security purposes|only request this after/i.test(raw)
        ? "Espera unos segundos antes de pedir otro correo de confirmación."
        : /rate limit/i.test(raw)
          ? "Se enviaron varios correos seguidos. Espera unos minutos antes de reenviar."
          : raw || "No pudimos reenviar el correo. Inténtalo de nuevo.");
    } finally {
      setSending(false);
    }
  };

  return (
    <main className="palmyra-scroll-page min-h-[100dvh] overflow-y-auto bg-[#F7F5FC] px-3 py-6 sm:px-5 sm:py-10" data-keyboard-viewport="native">
      <section className="mx-auto w-full max-w-lg overflow-hidden rounded-[26px] border border-violet-100 bg-white shadow-[0_30px_90px_-52px_rgba(59,27,110,.55)]">
        <div className="h-1 bg-gradient-to-r from-[#3B1B78] via-[#6535C5] to-[#9B7BE8]" />
        <div className="px-5 py-7 text-center sm:px-8 sm:py-9">
          <PalmyraWordmark className="mx-auto h-10 w-auto sm:h-12" />

          {phase === "verifying" ? (
            <>
              <div className="mx-auto mt-6 flex h-14 w-14 items-center justify-center rounded-2xl bg-[#EFE8FF] text-[#5B2DBA]">
                <Loader2 className="h-6 w-6 animate-spin" />
              </div>
              <h1 className="mt-4 text-xl font-black tracking-[-.02em] text-[#3B1B78] sm:text-2xl">Confirmando tu cuenta</h1>
              <p role="status" className="mt-2 text-sm leading-6 text-slate-500">{status}</p>
              <p className="mt-4 text-xs leading-5 text-slate-400">No cierres esta ventana; el enlace se verifica una sola vez.</p>
            </>
          ) : null}

          {phase === "success" ? (
            <>
              <div className="mx-auto mt-6 flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-600">
                <CheckCircle2 className="h-7 w-7" />
              </div>
              <h1 className="mt-4 text-xl font-black tracking-[-.02em] text-[#3B1B78] sm:text-2xl">Correo confirmado</h1>
              <p role="status" className="mt-2 text-sm leading-6 text-slate-500">{status}</p>
              <a href={destination} className="mt-6 inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-[#5B2DBA] px-5 text-xs font-black text-white hover:bg-[#4B239B]">
                Continuar ahora <ArrowRight className="h-4 w-4" />
              </a>
            </>
          ) : null}

          {phase === "error" ? (
            <>
              <div className="mx-auto mt-6 flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-50 text-amber-600">
                <AlertCircle className="h-7 w-7" />
              </div>
              <h1 className="mt-4 text-xl font-black tracking-[-.02em] text-[#3B1B78] sm:text-2xl">El enlace no pudo confirmarse</h1>
              <p role="alert" className="mt-2 text-sm leading-6 text-slate-500">{error}</p>

              {!queryError ? (
                <button
                  type="button"
                  onClick={retryVerification}
                  className="mt-4 inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-violet-200 bg-white text-xs font-black text-[#5B2DBA] active:scale-[.98]"
                >
                  Reintentar verificación
                </button>
              ) : null}

              <div className="mt-4 rounded-2xl border border-violet-100 bg-[#F7F5FC] p-4 text-left">
                <p className="flex items-center gap-2 text-xs font-black uppercase tracking-wider text-[#6535C5]"><MailCheck className="h-4 w-4" /> Reenviar confirmación</p>
                <p className="mt-1 text-xs leading-5 text-slate-500">
                  {target ? `Enviaremos un enlace nuevo a ${target}.` : "Escribe el correo con el que te registraste."}
                </p>
                <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                  <input
                    type="email"
                    inputMode="email"
                    autoComplete="email"
                    value={resendEmail}
                    onChange={(event) => setResendEmail(event.target.value)}
                    placeholder="nombre@empresa.com"
                    className="h-11 min-w-0 flex-1 rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-900 focus-visible:outline-violet-600"
                  />
                  <button
                    type="button"
                    onClick={() => void resend()}
                    disabled={sending}
                    className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-[#5B2DBA] px-4 text-xs font-black text-white disabled:opacity-50"
                  >
                    {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                    Reenviar
                  </button>
                </div>
                {resent ? <p role="status" className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-bold text-emerald-700">{resent}</p> : null}
              </div>

              <div className="mt-4 flex flex-col gap-2 sm:flex-row">
                <a href="/auth" className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-xl border border-violet-200 bg-white text-xs font-black text-[#5B2DBA]">
                  Ir a iniciar sesión
                </a>
                <a href="/landing" className="inline-flex h-11 flex-1 items-center justify-center rounded-xl bg-[#EFE8FF] text-xs font-black text-[#5B2DBA]">
                  Volver a PALMYRA
                </a>
              </div>
              <p className="mt-4 text-[11px] leading-5 text-slate-400">
                Si ya confirmaste antes, basta con iniciar sesión. Cada enlace funciona una sola vez.
              </p>
            </>
          ) : null}
        </div>
      </section>
    </main>
  );
}
