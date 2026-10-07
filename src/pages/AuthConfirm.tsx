import { useEffect, useState } from "react";
import { CheckCircle2, Loader2, AlertCircle } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { getSupabase } from "../lib/supabase";

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

export default function AuthConfirm() {
  const [params] = useSearchParams();
  const [error, setError] = useState("");
  const [status, setStatus] = useState("Confirmando tu cuenta…");

  useEffect(() => {
    let active = true;

    const verify = async () => {
      const supabase = getSupabase();
      const tokenHash = params.get("token_hash");
      const type = params.get("type") as "email" | "recovery" | "invite" | "email_change" | "sms" | "phone_change" | null;

      if (!supabase || !tokenHash || !type) {
        if (active) setError("El enlace de confirmación no es válido o está incompleto.");
        return;
      }

      const invitationRedirect = type !== "recovery" ? getInvitationRedirect(params) : null;

      const { error: verifyError } = await supabase.auth.verifyOtp({
        token_hash: tokenHash,
        type
      });

      if (!active) return;

      if (verifyError) {
        setError(
          /expired|invalid|otp/i.test(verifyError.message)
            ? "Este enlace ya no es válido o ha caducado. Solicita un nuevo enlace."
            : verifyError.message
        );
        return;
      }

      if (type === "recovery") {
        setStatus("Enlace verificado. Preparando la recuperación…");
        window.setTimeout(() => window.location.replace("/auth?recovery=1"), 150);
        return;
      }

      const { data: sessionData } = await supabase.auth.getSession();
      if (!active) return;

      if (!sessionData.session) {
        setError("El correo fue confirmado, pero no pudimos recuperar la sesión automáticamente. Vuelve a iniciar sesión para continuar.");
        return;
      }

      if (invitationRedirect) {
        try {
          const invitationUrl = new URL(invitationRedirect, window.location.origin);
          const invitationToken = invitationUrl.searchParams.get("token");
          if (invitationToken) {
            sessionStorage.setItem("palmyra_pending_invitation", invitationToken);
            sessionStorage.setItem(
              "palmyra_pending_invitation_email",
              sessionData.session.user.email?.trim().toLowerCase() || ""
            );
          }
        } catch {}
        setStatus("Correo confirmado. Activando tu acceso a la empresa…");
        window.setTimeout(() => window.location.replace(invitationRedirect), 150);
        return;
      }

      if (typeof sessionStorage !== "undefined") {
        sessionStorage.setItem("palmyra_pending_onboarding", "1");
      }

      setStatus("Correo confirmado. Preparando tu cuenta…");
      window.setTimeout(() => window.location.replace("/onboarding"), 150);
    };

    void verify();
    return () => { active = false; };
  }, [params]);

  return (
    <main className="min-h-screen bg-[#F7F5FC] flex items-center justify-center p-4">
      <section className="w-full max-w-md rounded-[26px] bg-white border border-violet-100 shadow-[0_30px_90px_-52px_rgba(59,27,110,.55)] p-7 text-center">
        <img src="/palmyra-logo-exact.svg" alt="PALMYRA" className="w-[230px] h-[59px] object-contain mx-auto mb-7" />
        {error ? (
          <>
            <div className="mx-auto w-12 h-12 rounded-2xl bg-rose-50 text-rose-600 flex items-center justify-center">
              <AlertCircle className="w-6 h-6" />
            </div>
            <h1 className="text-xl font-black text-[#3B1B78] mt-4">No pudimos confirmar el enlace</h1>
            <p className="text-sm text-slate-500 leading-6 mt-2">{error}</p>
            <a href="/auth" className="inline-flex mt-6 h-11 px-5 rounded-xl bg-[#5B2DBA] text-white text-xs font-black items-center justify-center">
              Volver a PALMYRA
            </a>
          </>
        ) : (
          <>
            <div className="mx-auto w-12 h-12 rounded-2xl bg-[#EFE8FF] text-[#5B2DBA] flex items-center justify-center">
              {status.startsWith("Correo confirmado") ? <CheckCircle2 className="w-6 h-6" /> : <Loader2 className="w-6 h-6 animate-spin" />}
            </div>
            <h1 className="text-xl font-black text-[#3B1B78] mt-4">Un momento…</h1>
            <p className="text-sm text-slate-500 leading-6 mt-2">{status}</p>
          </>
        )}
      </section>
    </main>
  );
}
