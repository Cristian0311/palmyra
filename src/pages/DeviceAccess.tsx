import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  MonitorSmartphone,
  ShieldCheck,
  Smartphone
} from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import { FunctionsFetchError } from "@supabase/supabase-js";
import { getSupabase } from "../lib/supabase";
import { retryDelayMs } from "../lib/http";
import {
  buildDeviceAccessDeepLink,
  DeviceAccessError,
  redeemDeviceAccessInvite,
  type DeviceAccessCredentials
} from "../services/deviceAccess";
import { useDocumentScrollPage } from "../hooks/useDocumentScrollPage";

type Phase = "validating" | "password" | "linking" | "signing-in" | "done" | "error";

const MAX_ATTEMPTS = 5;

/** Espera antes del único reintento automático por fallo de red. */
const NETWORK_RETRY_DELAY_MS = 700;

/** Mensaje accionable cuando la petición no llegó a salir del equipo. */
export const ACCESS_UNREACHABLE_MESSAGE =
  "No se pudo contactar con el servicio de acceso. Revisa la conexión e inténtalo de nuevo.";

export const ACCESS_UNREACHABLE_HINT =
  "El enlace sigue disponible: no se ha gastado ningún intento.";

/**
 * Códigos que puede añadir la capa de servicio al traducir un fallo de red.
 * Se aceptan por si el servicio deja de exponer la clase del SDK.
 */
const UNREACHABLE_CODES = new Set([
  "network_error",
  "fetch_failed",
  "functions_fetch_failed",
  "edge_function_unreachable"
]);

/**
 * `supabase.functions.invoke` falla de tres formas distintas: FunctionsFetchError
 * (la petición nunca llegó: sin red, DNS, CORS/preflight), FunctionsHttpError
 * (llegó y respondió non-2xx, con el código de negocio) y FunctionsRelayError.
 * Antes la pantalla mostraba el `message` crudo del SDK, así que un fallo de red
 * se veía como «Failed to send a request to the Edge Function».
 */
export function accessFailureKind(error: unknown): "network" | "server" {
  if (error instanceof FunctionsFetchError) return "network";
  const known = error as { name?: string; code?: string; message?: string } | null;
  if (String(known?.name || "") === "FunctionsFetchError") return "network";
  if (UNREACHABLE_CODES.has(String(known?.code || "").toLowerCase())) return "network";
  const message = String(known?.message || "");
  return /failed to send a request to the edge function|failed to fetch|networkerror|load failed|err_network|err_internet_disconnected/i.test(
    message
  )
    ? "network"
    : "server";
}

/**
 * Un único reintento cuando el canje falla por red. Los errores del servidor
 * (contraseña incorrecta, enlace usado, etc.) NO se reintentan: el enlace es de
 * un solo uso y repetir la petición solo agotaría el limitador por IP.
 */
export async function redeemWithNetworkRetry(
  token: string,
  password: string,
  deviceName: string,
  redeem: (
    token: string,
    password: string,
    deviceName: string
  ) => Promise<DeviceAccessCredentials> = redeemDeviceAccessInvite,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
): Promise<DeviceAccessCredentials> {
  try {
    return await redeem(token, password, deviceName);
  } catch (error) {
    if (accessFailureKind(error) !== "network") throw error;
    await wait(retryDelayMs(1, NETWORK_RETRY_DELAY_MS, 1_200));
    return redeem(token, password, deviceName);
  }
}

const STEPS: Array<{ id: Exclude<Phase, "error" | "password">; label: string }> = [
  { id: "validating", label: "Validando el enlace" },
  { id: "linking", label: "Vinculando este dispositivo" },
  { id: "signing-in", label: "Iniciando sesión" },
  { id: "done", label: "Acceso listo" }
];

const PHASE_INDEX: Record<Phase, number> = {
  validating: 0,
  password: -1,
  linking: 1,
  "signing-in": 2,
  done: 3,
  error: -1
};

function describeDevice() {
  if (typeof navigator === "undefined") return "PC PALMYRA";
  const platform = navigator.platform || "PC";
  return `${platform} · ${navigator.userAgent}`.slice(0, 120);
}

export default function DeviceAccess() {
  useDocumentScrollPage();
  const [params] = useSearchParams();
  const token = (params.get("token") || "").trim();
  const [phase, setPhase] = useState<Phase>("validating");
  const [error, setError] = useState("");
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [fullKeyboard, setFullKeyboard] = useState(false);
  const [attempts, setAttempts] = useState(0);
  const [networkFailure, setNetworkFailure] = useState(false);
  const [busy, setBusy] = useState(false);
  const passwordRef = useRef<HTMLInputElement | null>(null);
  const booted = useRef(false);

  useEffect(() => {
    if (!token) {
      setPhase("error");
      setError("El enlace no incluye el código de acceso. Pide al propietario que genere uno nuevo.");
      return;
    }
    if (!getSupabase()) {
      setPhase("error");
      setError("Supabase no está configurado en este dispositivo. Revisa la conexión e intenta de nuevo.");
      return;
    }
    if (booted.current) return;
    booted.current = true;
    const timer = window.setTimeout(() => setPhase("password"), 250);
    return () => window.clearTimeout(timer);
  }, [token]);

  useEffect(() => {
    if (phase !== "password") return;
    const timer = window.setTimeout(() => passwordRef.current?.focus(), 60);
    return () => window.clearTimeout(timer);
  }, [phase, passwordError]);

  const runActivation = async (value: string) => {
    if (busy) return;

    setBusy(true);
    setPasswordError("");
    setNetworkFailure(false);
    setPhase("linking");

    try {
      const credentials = await redeemWithNetworkRetry(token, value, describeDevice());

      setPhase("signing-in");
      const supabase = getSupabase();
      if (!supabase) throw new Error("Supabase no está configurado en este dispositivo.");

      const { data: current } = await supabase.auth.getSession();
      if (current?.session) await supabase.auth.signOut();

      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: credentials.email,
        password: credentials.password
      });
      if (signInError) {
        throw new Error(
          "El dispositivo quedó vinculado, pero no se pudo iniciar sesión. Genera un enlace nuevo."
        );
      }

      setPhase("done");
      // Recarga completa: la sesión nueva ya está persistida en el cliente y el
      // arranque de PALMYRA resuelve empresa/rol antes de montar el POS.
      window.location.replace("/pos");
    } catch (e) {
      const code = e instanceof DeviceAccessError ? e.code : "";
      const message = String((e as { message?: string } | null)?.message || "");

      if (accessFailureKind(e) === "network") {
        // No fue un rechazo del servidor: el enlace no se consumió y la
        // contraseña se conserva para reintentar sin volver a escribirla.
        setNetworkFailure(true);
        setError(ACCESS_UNREACHABLE_MESSAGE);
        setPhase("error");
      } else if (code === "pos_password_invalid" || code === "pos_password_required") {
        const next = attempts + 1;
        setAttempts(next);
        setPassword("");
        setPasswordError(
          code === "pos_password_invalid"
            ? "La contraseña POS no es correcta. Vuelve a intentarlo."
            : "Escribe la contraseña POS configurada por el administrador."
        );
        if (next >= MAX_ATTEMPTS) {
          setError(
            "Se agotaron los intentos de contraseña en este equipo. Puedes recargar la página para intentarlo otra vez o pedir un enlace nuevo al propietario."
          );
          setPhase("error");
        } else {
          setPhase("password");
        }
      } else if (code === "too_many_attempts") {
        setPhase("password");
        setPasswordError("Demasiados intentos seguidos. Espera un minuto y vuelve a intentarlo.");
      } else {
        setError(message || "No se pudo activar este dispositivo.");
        setPhase("error");
      }
    } finally {
      setBusy(false);
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;

    const value = password.trim();
    if (!value) {
      setPasswordError("Escribe la contraseña POS configurada por el administrador.");
      passwordRef.current?.focus();
      return;
    }

    await runActivation(value);
  };

  const retryAfterFailure = () => {
    const kept = password.trim();
    if (networkFailure && kept) {
      void runActivation(kept);
      return;
    }
    setError("");
    setPassword("");
    setPasswordError("");
    setAttempts(0);
    setNetworkFailure(false);
    setPhase("password");
  };

  const stepIndex = PHASE_INDEX[phase];
  const deepLink = token ? buildDeviceAccessDeepLink(token) : "";

  return (
    <main className="palmyra-scroll-page min-h-[100dvh] bg-[#F7F5FC] px-3 sm:px-5 py-6 flex items-start justify-center overflow-y-auto sm:items-center">
      <div className="w-full max-w-lg bg-white rounded-[26px] border border-violet-100 shadow-[0_30px_90px_-52px_rgba(59,27,110,.55)] overflow-hidden">
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-violet-100">
          <img src="/palmyra-logo-exact.svg" alt="PALMYRA" className="h-auto w-[132px] shrink-0 object-contain object-left sm:w-[170px]" />
          <div className="hidden text-right sm:block">
            <div className="text-[10px] uppercase tracking-[.15em] text-[#7649D6] font-black">Acceso de dispositivo</div>
            <div className="text-[10px] text-slate-500 mt-1">Vinculación de un solo uso</div>
          </div>
        </div>

        <div className="p-5 sm:p-7">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-2xl bg-[#EFE8FF] text-[#5B2DBA] flex items-center justify-center">
              <MonitorSmartphone className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-lg font-black text-[#21182F]">Activa este equipo</h1>
              <p className="text-xs text-[#6F647B] mt-1">
                PALMYRA vinculará este PC con el trabajador asignado por tu empresa.
              </p>
            </div>
          </div>

          {phase === "error" ? (
            <div className="mt-6">
              <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 flex gap-3">
                <AlertTriangle className="w-5 h-5 text-rose-600 shrink-0 mt-0.5" />
                <div>
                  <div className="text-sm font-black text-rose-700">No se pudo activar el equipo</div>
                  <p className="text-[11px] text-rose-700/90 mt-1 leading-5">{error}</p>
                  {networkFailure ? (
                    <p className="text-[10px] text-rose-700/70 mt-1 leading-4">{ACCESS_UNREACHABLE_HINT}</p>
                  ) : null}
                </div>
              </div>

              {token ? (
                <div className="mt-4 flex flex-col gap-2">
                  <button
                    type="button"
                    onClick={retryAfterFailure}
                    disabled={busy}
                    className="h-11 rounded-xl bg-[#6535C5] hover:bg-[#4F249D] disabled:opacity-60 text-white text-xs font-black flex items-center justify-center gap-2"
                  >
                    {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                    {networkFailure ? "Reintentar ahora" : "Reintentar con este enlace"}
                  </button>
                </div>
              ) : null}

              <div className="mt-4 flex flex-col gap-2">
                <Link
                  to="/auth"
                  className="flex h-11 items-center justify-center rounded-xl bg-[#EFE8FF] text-[11px] font-black text-[#5B2DBA]"
                >
                  Iniciar sesión manualmente
                </Link>
                <Link
                  to="/landing"
                  className="flex h-11 items-center justify-center rounded-xl border border-violet-100 text-[11px] font-black text-slate-500"
                >
                  Volver a PALMYRA
                </Link>
              </div>

              {deepLink ? (
                <a
                  href={deepLink}
                  className="mt-3 flex h-11 items-center justify-center gap-1.5 rounded-xl border border-violet-100 text-[11px] font-black text-[#5B2DBA]"
                >
                  <Smartphone className="w-3.5 h-3.5" />
                  Abrir en PALMYRA
                </a>
              ) : null}

              <p className="text-[10px] text-slate-400 mt-4 leading-5">
                Cada enlace funciona una sola vez y necesita la contraseña POS del trabajador. Si necesitas otro, pídelo al propietario de la empresa en Equipo.
              </p>
            </div>
          ) : phase === "password" ? (
            <form onSubmit={handleSubmit} className="mt-6">
              <div className="rounded-2xl border border-violet-200 bg-[#F7F2FF] p-4 sm:p-5">
                <div className="flex items-center gap-2">
                  <KeyRound className="w-4 h-4 text-[#5B2DBA]" />
                  <div className="text-[10px] uppercase tracking-[.18em] text-[#7649D6] font-black">
                    Contraseña POS
                  </div>
                </div>
                <p className="text-[11px] text-[#6F647B] mt-2 leading-5">
                  Escribe la contraseña que el administrador configuró para el trabajador. Es la misma que usas en la caja.
                </p>

                <label htmlFor="pos-password" className="sr-only">
                  Contraseña POS
                </label>
                <div className="relative mt-3">
                  <input
                    id="pos-password"
                    ref={passwordRef}
                    type={showPassword ? "text" : "password"}
                    inputMode={fullKeyboard ? "text" : "numeric"}
                    autoComplete="current-password"
                    spellCheck={false}
                    autoCapitalize="off"
                    value={password}
                    onChange={(event) => {
                      setPassword(event.target.value);
                      if (passwordError) setPasswordError("");
                    }}
                    className={`w-full h-12 rounded-xl border bg-white pl-4 pr-12 text-center text-base font-black tracking-[.28em] text-[#21182F] outline-none transition ${
                      passwordError
                        ? "border-rose-300 focus:border-rose-400"
                        : "border-violet-200 focus:border-[#6535C5]"
                    }`}
                    placeholder="••••"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((value) => !value)}
                    aria-label={showPassword ? "Ocultar contraseña" : "Mostrar contraseña"}
                    className="absolute right-0.5 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-lg text-slate-400 hover:text-[#5B2DBA]"
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>

                {passwordError ? (
                  <p role="alert" className="text-[10px] text-rose-600 font-bold mt-2 leading-4">
                    {passwordError}
                  </p>
                ) : null}

                <button
                  type="submit"
                  disabled={busy || !password.trim()}
                  className="mt-3 w-full h-11 rounded-xl bg-[#6535C5] hover:bg-[#4F249D] disabled:opacity-50 disabled:hover:bg-[#6535C5] text-white text-xs font-black flex items-center justify-center gap-2"
                >
                  {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                  Activar este equipo
                </button>

                <div className="flex items-center justify-between gap-2 mt-2">
                  <span className="text-[10px] text-slate-400">
                    {attempts > 0 ? `Intentos restantes: ${Math.max(MAX_ATTEMPTS - attempts, 0)}` : "Un solo uso por enlace"}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setFullKeyboard((value) => !value);
                      passwordRef.current?.focus();
                    }}
                    className="-my-1 inline-flex min-h-9 items-center text-[11px] font-bold text-[#7649D6] hover:text-[#4F249D]"
                  >
                    {fullKeyboard ? "Usar teclado numérico" : "Mi contraseña tiene letras"}
                  </button>
                </div>
              </div>

              {deepLink ? (
                <a
                  href={deepLink}
                  className="mt-3 flex h-11 items-center justify-center gap-1.5 rounded-xl border border-violet-100 text-[11px] font-black text-[#5B2DBA]"
                >
                  <Smartphone className="w-3.5 h-3.5" />
                  Abrir en PALMYRA
                </a>
              ) : null}

              <div className="flex items-center gap-2 mt-3">
                <ShieldCheck className="w-3.5 h-3.5 text-[#7649D6]" />
                <p className="text-[10px] text-slate-400 leading-4">
                  La contraseña se verifica en el servidor y nunca se guarda en este equipo. Si falla, el enlace sigue disponible.
                </p>
              </div>
            </form>
          ) : (
            <div className="mt-6 space-y-2">
              {STEPS.map((step, index) => {
                const active = index === stepIndex;
                const complete = stepIndex > index;
                return (
                  <div
                    key={step.id}
                    className={`flex items-center gap-3 rounded-xl border px-3 py-2.5 ${
                      active
                        ? "border-violet-200 bg-[#F7F2FF]"
                        : complete
                          ? "border-emerald-100 bg-emerald-50/60"
                          : "border-slate-100 bg-white"
                    }`}
                  >
                    <span className="w-5 h-5 flex items-center justify-center">
                      {complete ? (
                        <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                      ) : active ? (
                        <Loader2 className="w-4 h-4 text-[#6535C5] animate-spin" />
                      ) : (
                        <span className="w-1.5 h-1.5 rounded-full bg-slate-200" />
                      )}
                    </span>
                    <span
                      className={`text-[11px] font-bold ${
                        active ? "text-[#3B1B6E]" : complete ? "text-emerald-700" : "text-slate-400"
                      }`}
                    >
                      {step.label}
                    </span>
                  </div>
                );
              })}
              <div className="flex items-center gap-2 pt-2">
                <ShieldCheck className="w-3.5 h-3.5 text-[#7649D6]" />
                <p className="text-[10px] text-slate-400 leading-4">
                  No compartas este enlace. Al abrirlo, este equipo quedará asociado al trabajador y entrará directo a la caja.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
