import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  Copy,
  Download,
  Info,
  KeyRound,
  Link2,
  Network,
  QrCode,
  Radar,
  RefreshCw,
  Router,
  ScanLine,
  ShieldAlert,
  Unlink,
  WifiOff,
  X
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { cn } from "../../lib/utils";
import { useDesktopRuntimeStatus } from "../../hooks/useDesktopRuntimeStatus";
import { currentAppSurface, type AppSurface } from "../../lib/appSurface";
import { getDesktopHubBridge, type DiscoveredHub } from "../../lib/desktopRuntime";
import { getPalmyraLocalScope } from "../../services/localScope";
import { newPairingCode } from "../../services/lanHub/hostRuntime";
import { HubPairingError, joinHub, leaveHub } from "../../services/lanHub/pairing";
import {
  PairingPayloadError,
  decodePairingPayload,
  hubStatusToPairingPayload,
  isWildcardHost,
  isValidPin,
  parseManualPairingInput
} from "../../services/lanHub/pairingQr";
import {
  getHubSession,
  subscribeHubSession,
  type HubSession
} from "../../services/lanHub/session";
import {
  buildReadOnlyExport,
  getHubResilienceState,
  type HubResilienceState
} from "../../services/lanHub/resilience";
import {
  dismissHubConflict,
  listHubConflicts,
  type HubConflict
} from "../../services/lanHub/conflicts";
import { getRuntimeDriver } from "../../services/localDb/runtimeDriver";
import { getDeviceName } from "../../services/device";
import { SettingsSectionHeader } from "../settings/SettingsSectionHeader";

const DASH = "—";

// Cada superficie explica por qué el hub no está disponible en lugar de
// ofrecer botones que no harían nada.
const UNAVAILABLE_COPY: Record<AppSurface, { title: string; detail: string }> = {
  "web-tab": {
    title: "La red local se configura en la app instalada",
    detail:
      "Esta pestaña web sirve para registro, cuenta, plan y descarga. El hub, el código de emparejamiento y la lista de máquinas se controlan desde PALMYRA POS instalado en la PC principal del negocio."
  },
  pwa: {
    title: "La PWA no puede abrir el hub de red local",
    detail:
      "La PWA guarda y opera sin internet, pero no expone el hub LAN de PALMYRA POS. Abre Configuración > Red local desde la app de escritorio de la PC principal para controlar la red del negocio."
  },
  "android-app": {
    title: "Cada instalación Android funciona de forma autónoma",
    detail:
      "El APK guarda su propia operación y no hospeda el hub LAN del POS de escritorio. Para ver el estado del hub y generar códigos de emparejamiento, abre esta pantalla desde PALMYRA POS en Windows."
  },
  desktop: {
    title: "El hub no está expuesto en esta instalación",
    detail:
      "La app de escritorio no cargó el puente del hub LAN. Cierra y vuelve a abrir PALMYRA POS; si el problema continúa, revisa el diagnóstico de escritorio o actualiza la aplicación."
  },
  dev: {
    title: "Vista de desarrollo sin hub de red local",
    detail:
      "Esta ejecución no expone el puente del hub. Para probar la red local, abre PALMYRA POS en Windows con el hub habilitado."
  }
};

function formatExpiry(value: string): string {
  if (!value) return DASH;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return DASH;
  return date.toLocaleString("es-ES", { dateStyle: "short", timeStyle: "short" });
}

/** La huella TLS puede llegar del puente aunque el contrato base no la declare. */
function hubTlsFingerprint(status: unknown): string {
  if (!status || typeof status !== "object") return "";
  const value = (status as { tlsFingerprint?: unknown }).tlsFingerprint;
  return typeof value === "string" ? value.trim() : "";
}

/**
 * De la IP escrita por el usuario solo interesa el equipo: si pega
 * `http://192.168.1.50:48900/` se queda con `192.168.1.50` y el puerto del hub
 * manda.
 */
function hostOnly(raw: string): string {
  const value = raw.trim().replace(/^https?:\/\//i, "").replace(/[/?#].*$/, "");
  if (!value) return "";
  if (value.includes("::")) return value; // IPv6 entre corchetes o no
  return value.replace(/:\d+$/, "");
}

export default function LanPanel() {
  const { available, hub, refreshing, refresh } = useDesktopRuntimeStatus();
  const [surface] = useState<AppSurface>(() => currentAppSurface());
  const [generating, setGenerating] = useState(false);
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [session, setSession] = useState<HubSession | null>(null);
  const [hubHost, setHubHost] = useState("");
  const [pairingInput, setPairingInput] = useState("");
  const [qrPaste, setQrPaste] = useState("");
  const [pinInput, setPinInput] = useState("");
  const [pastedFingerprint, setPastedFingerprint] = useState("");
  const [localIp, setLocalIp] = useState("");
  const [linking, setLinking] = useState(false);
  const [linkFeedback, setLinkFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [discovered, setDiscovered] = useState<DiscoveredHub[]>([]);
  const [discoveryNote, setDiscoveryNote] = useState("");
  const [resilience, setResilience] = useState<HubResilienceState>(() => getHubResilienceState());
  const [conflicts, setConflicts] = useState<HubConflict[]>(() => listHubConflicts());
  const [exporting, setExporting] = useState(false);
  const [exportNote, setExportNote] = useState("");
  const [inviteCopied, setInviteCopied] = useState(false);

  // La sesión del hub se refleja en vivo: emparejar o desvincular en otra
  // pestaña (o desde el bucle) actualiza esta tarjeta sin recargar.
  useEffect(() => {
    let mounted = true;
    void getHubSession().then((current) => {
      if (mounted) setSession(current);
    });
    const unsubscribe = subscribeHubSession((next) => {
      if (mounted) setSession(next);
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  // La caducidad del código se recalcula sin esperar al sondeo del hook.
  useEffect(() => {
    if (!available) return;
    const timer = window.setInterval(() => setNow(Date.now()), 15000);
    return () => window.clearInterval(timer);
  }, [available]);

  // Salud del enlace y conflictos: se refrescan al instante cuando el bucle
  // registra un rechazo y cada medio minuto para el contador de 72 h.
  useEffect(() => {
    const refresh = () => {
      setResilience(getHubResilienceState());
      setConflicts(listHubConflicts());
    };
    refresh();
    const timer = window.setInterval(refresh, 30000);
    window.addEventListener("palmyra:hub-conflict", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("palmyra:hub-conflict", refresh);
    };
  }, []);

  const expiresMs = Date.parse(hub.pairingExpiresAt || "");
  const pairingActive =
    hub.running &&
    Boolean(hub.pairingCode) &&
    Number.isFinite(expiresMs) &&
    expiresMs > now;
  const minutesLeft = pairingActive ? Math.max(1, Math.ceil((expiresMs - now) / 60000)) : 0;
  const address = hub.running && hub.host && hub.port > 0 ? `${hub.host}:${hub.port}` : "";

  // El QR se arma con el estado real del hub. Si escucha en 0.0.0.0 o ::, la
  // IP la escribe el dueño: aquí nunca se inventa una dirección.
  const wildcardHost = isWildcardHost(hub.host);
  const hubFingerprint = hubTlsFingerprint(hub);
  const pairingQr = useMemo(() => {
    if (!available || !pairingActive) return null;
    const host = wildcardHost ? hostOnly(localIp) : hub.host;
    if (!host) return null;
    try {
      return hubStatusToPairingPayload({
        host,
        port: hub.port,
        pairingCode: hub.pairingCode,
        companyId: hub.companyId,
        tlsFingerprint: hubFingerprint
      });
    } catch {
      return null;
    }
  }, [
    available,
    pairingActive,
    wildcardHost,
    localIp,
    hub.host,
    hub.port,
    hub.pairingCode,
    hub.companyId,
    hubFingerprint
  ]);

  // La invitación es el mismo contenido del QR, en texto: el otro equipo la
  // pega tal cual y no necesita cámara ni lector. Si aún no hay QR (IP sin
  // escribir), se arma con «IP:puerto código», que el campo de dirección acepta.
  const invitation = useMemo(() => {
    if (!pairingActive) return "";
    if (pairingQr?.payload) return pairingQr.payload;
    const host = wildcardHost ? hostOnly(localIp) : hub.host;
    return host && hub.port > 0 ? `${host}:${hub.port} ${hub.pairingCode}` : "";
  }, [pairingActive, pairingQr, wildcardHost, localIp, hub.host, hub.port, hub.pairingCode]);

  const handleCopyInvite = async () => {
    if (!invitation) return;
    try {
      await navigator.clipboard.writeText(invitation);
      setInviteCopied(true);
      window.setTimeout(() => setInviteCopied(false), 2200);
    } catch {
      setFeedback({ type: "error", message: "El navegador no permitió copiar la invitación." });
    }
  };

  const handleQrPaste = (value: string) => {
    setQrPaste(value);
    setLinkFeedback(null);
    if (!value.trim()) {
      setPastedFingerprint("");
      return;
    }
    try {
      const decoded = decodePairingPayload(value);
      setHubHost(decoded.baseUrl);
      setPairingInput(decoded.code);
      setPastedFingerprint(decoded.fingerprint);
      setLinkFeedback({
        type: "success",
        message: `QR leído: ${decoded.baseUrl} · código ${decoded.code}. Pulsa Vincular para confirmar.`
      });
    } catch {
      // Mientras se pega el QR puede estar incompleto: el detalle sale al vincular.
      setPastedFingerprint("");
    }
  };

  const handleRegenerate = async () => {
    if (generating || !hub.running) return;
    setGenerating(true);
    setFeedback(null);
    try {
      const result = await newPairingCode();
      if (!result.available) {
        setFeedback({ type: "error", message: "El hub LAN solo está disponible en la app de escritorio." });
        return;
      }
      if (!result.status.pairingCode) {
        setFeedback({
          type: "error",
          message: result.status.lastError || "No se pudo generar el código de emparejamiento."
        });
        return;
      }
      setFeedback({ type: "success", message: "Código nuevo generado. Los códigos anteriores dejan de funcionar." });
      await refresh();
    } catch {
      setFeedback({ type: "error", message: "No se pudo generar el código de emparejamiento." });
    } finally {
      setGenerating(false);
    }
  };

  const handleLink = async () => {
    if (linking) return;
    const pasted = qrPaste.trim();
    let baseUrl = hubHost.trim();
    let code = pairingInput.trim();
    let fingerprint = pastedFingerprint;

    if (pasted) {
      try {
        const decoded = decodePairingPayload(pasted);
        baseUrl = decoded.baseUrl;
        code = decoded.code || code;
        fingerprint = decoded.fingerprint || fingerprint;
      } catch (error) {
        setLinkFeedback({
          type: "error",
          message:
            error instanceof PairingPayloadError
              ? error.message
              : "El contenido pegado no es un QR de emparejamiento de PALMYRA."
        });
        return;
      }
    } else {
      try {
        const manual = parseManualPairingInput(baseUrl);
        baseUrl = manual.baseUrl;
        if (!code && manual.code) code = manual.code;
      } catch (error) {
        setLinkFeedback({
          type: "error",
          message:
            error instanceof PairingPayloadError
              ? error.message
              : "Escribe la dirección del hub (por ejemplo 192.168.1.10:48900)."
        });
        return;
      }
    }

    if (!baseUrl) {
      setLinkFeedback({ type: "error", message: "Escribe la dirección del hub (por ejemplo 192.168.1.10:48900)." });
      return;
    }
    if (!/^\d{8}$/.test(code)) {
      setLinkFeedback({ type: "error", message: "El código de emparejamiento tiene 8 dígitos." });
      return;
    }
    const pin = pinInput.trim();
    if (pin && !isValidPin(pin)) {
      setLinkFeedback({ type: "error", message: "El PIN del equipo debe tener entre 4 y 8 dígitos." });
      return;
    }

    setLinking(true);
    setLinkFeedback(null);
    try {
      const joined = await joinHub({
        baseUrl,
        code,
        pin: pin || undefined,
        tlsFingerprint: fingerprint || undefined,
        deviceName: getDeviceName()
      });
      setPairingInput("");
      setQrPaste("");
      setPinInput("");
      setPastedFingerprint("");
      setLinkFeedback({
        type: "success",
        message: `Equipo vinculado con la PC principal (${joined.session.hubId}). Las ventas y los cambios se sincronizan en ambos sentidos.`
      });
    } catch (error) {
      const message =
        error instanceof HubPairingError
          ? error.message
          : "No se pudo vincular este equipo al hub. Inténtalo de nuevo.";
      setLinkFeedback({ type: "error", message });
    } finally {
      setLinking(false);
    }
  };

  const handleDiscover = async () => {
    const bridge = getDesktopHubBridge();
    if (!bridge?.discoverHubs) {
      setDiscoveryNote("La búsqueda automática solo está disponible en la app de escritorio.");
      return;
    }
    if (discovering) return;
    setDiscovering(true);
    setDiscovered([]);
    setDiscoveryNote("");
    try {
      const result = await bridge.discoverHubs(1800);
      if (result.ok === false) {
        setDiscoveryNote(result.error);
        return;
      }
      setDiscovered(result.hubs);
      setDiscoveryNote(
        result.hubs.length > 0
          ? "Toca un hub para rellenar la dirección. El código de 8 dígitos lo sigue mostrando la PC principal."
          : "No se encontró ningún hub. Escribe la IP manualmente: muchos routers no dejan pasar mDNS."
      );
    } catch {
      setDiscoveryNote("No se pudo buscar el hub en la red local.");
    } finally {
      setDiscovering(false);
    }
  };

  const handlePickDiscovered = (hub: DiscoveredHub) => {
    setHubHost(hub.url);
    setPastedFingerprint(hub.fingerprint || "");
    setDiscoveryNote(
      `Hub ${hub.name || hub.host} seleccionado: escribe el código de 8 dígitos para vincular.`
    );
  };

  const handleDismissConflict = (actionId: string) => {
    if (dismissHubConflict(actionId)) setConflicts(listHubConflicts());
  };

  const handleExportReadOnly = async () => {
    if (exporting) return;
    const companyId = getPalmyraLocalScope()?.companyId;
    if (!companyId) {
      setExportNote("Inicia sesión en tu empresa para exportar el almacén local.");
      return;
    }
    setExporting(true);
    setExportNote("");
    try {
      const driver = await getRuntimeDriver();
      const payload = await buildReadOnlyExport(driver, { companyId });
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `palmyra-solo-lectura-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      // El navegador necesita el objeto vivo hasta que empieza la descarga.
      window.setTimeout(() => URL.revokeObjectURL(url), 4000);
      setExportNote("Exportación descargada: incluye toda la operación local del negocio.");
    } catch {
      setExportNote("No se pudo exportar el almacén local. Inténtalo de nuevo.");
    } finally {
      setExporting(false);
    }
  };

  const handleUnlink = async () => {
    if (linking) return;
    setLinking(true);
    setLinkFeedback(null);
    try {
      await leaveHub();
      setLinkFeedback({
        type: "success",
        message: "Equipo desvinculado. Dejará de recibir los cambios del hub hasta que lo vincules de nuevo."
      });
    } catch {
      setLinkFeedback({ type: "error", message: "No se pudo desvincular el equipo. Inténtalo de nuevo." });
    } finally {
      setLinking(false);
    }
  };

  const linked = Boolean(session);
  const canSubmitLink = !linking && Boolean(qrPaste.trim() || hubHost.trim() || pairingInput.trim());

  return (
    <section className="rounded-2xl border border-base bg-secondary p-3 sm:p-5 shadow-sm space-y-4 min-w-0">
      <SettingsSectionHeader
        icon={Network}
        title="Red local"
        subtitle="Estado del hub, QR de emparejamiento y vinculación de equipos del mismo Wi-Fi."
        action={
          available ? (
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={refreshing}
              aria-label="Actualizar estado de la red local"
              className="h-11 w-11 rounded-xl border border-base bg-primary text-primary flex items-center justify-center hover:bg-subtle disabled:opacity-50 transition-colors"
            >
              <RefreshCw size={15} className={refreshing ? "animate-spin" : ""} />
            </button>
          ) : undefined
        }
      />

      {/* Este equipo puede ser un cliente aunque no hospede el hub: por eso
          la vinculación se ofrece en todas las superficies. */}
      <div className="rounded-xl border border-base bg-primary p-3 sm:p-4 space-y-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-sm font-bold text-primary">
              <Link2 size={15} className="shrink-0 text-violet-600" /> Vincular esta PC con la PC principal
            </p>
            <p className="mt-1 text-sm font-medium leading-6 text-muted">
              Solo para equipos con PALMYRA instalado. Pega aquí la invitación que copiaste en la PC
              principal o escribe su dirección con el código de 8 dígitos.
            </p>
          </div>
          <span
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 self-start rounded-full px-2 py-0.5 text-sm font-semibold",
              linked
                ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"
                : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"
            )}
          >
            <span className={cn("h-1.5 w-1.5 rounded-full", linked ? "bg-emerald-500" : "bg-slate-400")} />
            {linked ? "Vinculado" : "Sin vincular"}
          </span>
        </div>

        {session && (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-3 dark:border-emerald-900/40 dark:bg-emerald-950/20">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <div className="min-w-0">
                <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700/80 dark:text-emerald-300/80">Hub</p>
                <p className="mt-0.5 font-mono text-sm font-bold break-all text-primary">{session.hubId}</p>
              </div>
              <div className="min-w-0">
                <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700/80 dark:text-emerald-300/80">Equipo</p>
                <p className="mt-0.5 font-mono text-sm font-semibold break-all text-primary">{session.deviceId}</p>
              </div>
              <div className="min-w-0">
                <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700/80 dark:text-emerald-300/80">Dirección</p>
                <p className="mt-0.5 font-mono text-sm font-semibold break-all text-primary">{session.baseUrl}</p>
              </div>
            </div>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm font-medium text-muted">
                Vinculado {formatExpiry(session.joinedAt)} · último cambio aplicado #{session.cursor}
              </p>
              <button
                type="button"
                onClick={() => void handleUnlink()}
                disabled={linking}
                className="inline-flex h-11 shrink-0 items-center justify-center gap-1.5 rounded-xl border border-rose-200 bg-white px-4 text-sm font-semibold text-rose-600 transition-colors hover:bg-rose-50 disabled:opacity-50 dark:border-rose-900/40 dark:bg-transparent dark:text-rose-300 dark:hover:bg-rose-950/30"
              >
                <Unlink size={15} /> Desvincular
              </button>
            </div>
          </div>
        )}

        <div className="space-y-2">
          <label className="block min-w-0 space-y-1">
            <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
              <ScanLine size={13} className="shrink-0" /> Invitación o QR de la PC principal
            </span>
            <textarea
              value={qrPaste}
              onChange={(event) => handleQrPaste(event.target.value)}
              placeholder="Pega aquí la invitación (palmyra://hub… o 192.168.1.10:48900 48219307)"
              rows={2}
              autoComplete="off"
              spellCheck={false}
              maxLength={1000}
              className="w-full resize-y rounded-xl border border-base bg-primary px-3 py-2 font-mono text-sm font-medium leading-5 text-primary outline-none focus:border-violet-400"
            />
            <span className="block text-sm font-medium leading-5 text-muted">
              Al pegar la invitación se rellenan la dirección y el código. Después pulsa Vincular.
            </span>
          </label>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,150px)]">
            <label className="min-w-0 space-y-1">
              <span className="block text-xs font-semibold uppercase tracking-wide text-muted">Dirección de la PC principal</span>
              <input
                type="text"
                value={hubHost}
                onChange={(event) => setHubHost(event.target.value)}
                placeholder="192.168.1.10:48900"
                autoComplete="off"
                spellCheck={false}
                maxLength={120}
                className="h-11 w-full rounded-xl border border-base bg-primary px-3 font-mono text-sm font-semibold text-primary outline-none focus:border-violet-400"
              />
              <span className="block text-sm font-medium leading-5 text-muted">
                También vale «IP:puerto código» en el mismo campo.
              </span>
            </label>
            <label className="min-w-0 space-y-1">
              <span className="block text-xs font-semibold uppercase tracking-wide text-muted">Código de 8 dígitos</span>
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                value={pairingInput}
                onChange={(event) => setPairingInput(event.target.value.replace(/\D/g, "").slice(0, 8))}
                placeholder="00000000"
                autoComplete="one-time-code"
                maxLength={8}
                className="h-11 w-full rounded-xl border border-base bg-primary px-3 font-mono text-lg font-black tracking-[0.2em] text-primary outline-none focus:border-violet-400"
              />
            </label>
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
            <label className="min-w-0 space-y-1">
              <span className="block text-xs font-semibold uppercase tracking-wide text-muted">
                PIN de este equipo (4-8 dígitos, opcional)
              </span>
              <input
                type="password"
                inputMode="numeric"
                pattern="[0-9]*"
                value={pinInput}
                onChange={(event) => setPinInput(event.target.value.replace(/\D/g, "").slice(0, 8))}
                placeholder="Opcional"
                autoComplete="off"
                maxLength={8}
                className="h-11 w-full rounded-xl border border-base bg-primary px-3 font-mono text-lg font-black tracking-[0.2em] text-primary outline-none focus:border-violet-400"
              />
              <span className="block text-sm font-medium leading-5 text-muted">
                Solo si el equipo principal exige PIN para vincular.
              </span>
            </label>
            <button
              type="button"
              onClick={() => void handleLink()}
              disabled={!canSubmitLink}
              className="inline-flex h-11 items-center justify-center gap-1.5 rounded-xl bg-violet-600 px-4 text-sm font-semibold text-white transition-colors hover:bg-violet-700 disabled:opacity-50"
            >
              <Link2 size={15} className={linking ? "animate-pulse" : ""} />
              {linking ? "Vinculando…" : linked ? "Vincular de nuevo" : "Vincular"}
            </button>
          </div>

          <div className="space-y-2 rounded-xl border border-dashed border-base bg-subtle p-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm font-medium leading-5 text-muted">
                ¿No sabes la IP? Busca el hub automáticamente en el mismo Wi-Fi.
              </p>
              <button
                type="button"
                onClick={() => void handleDiscover()}
                disabled={discovering}
                className="inline-flex h-11 shrink-0 items-center justify-center gap-1.5 rounded-xl border border-base bg-primary px-4 text-sm font-semibold text-primary transition-colors hover:bg-subtle disabled:opacity-50"
              >
                <Radar size={15} className={discovering ? "animate-pulse" : ""} />
                {discovering ? "Buscando…" : "Buscar en la red"}
              </button>
            </div>
            {discovered.length > 0 && (
              <ul className="space-y-1.5">
                {discovered.map((hub) => (
                  <li key={`${hub.host}:${hub.port}`}>
                    <button
                      type="button"
                      onClick={() => handlePickDiscovered(hub)}
                      className="flex w-full items-center justify-between gap-2 rounded-xl border border-base bg-primary px-3 py-2 text-left transition-colors hover:bg-subtle"
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-mono text-sm font-bold text-primary">{hub.url}</span>
                        <span className="block truncate text-sm font-medium text-muted">
                          {hub.name || hub.host}
                          {hub.fingerprint ? " · TLS con huella" : ""}
                        </span>
                      </span>
                      <Link2 size={14} className="shrink-0 text-violet-600" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {discoveryNote && (
              <p role="status" aria-live="polite" className="text-sm font-medium leading-5 text-muted">
                {discoveryNote}
              </p>
            )}
          </div>
        </div>

        {linkFeedback && (
          <p
            role="status"
            aria-live="polite"
            className={cn(
              "text-sm font-semibold",
              linkFeedback.type === "success"
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-rose-600 dark:text-rose-400"
            )}
          >
            {linkFeedback.message}
          </p>
        )}
      </div>

      {linked && (
        <div className="rounded-xl border border-base bg-primary p-3 sm:p-4 space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <p className="flex items-center gap-2 text-sm font-bold text-primary">
                <ShieldAlert size={15} className="shrink-0 text-violet-600" /> Enlace con el hub
              </p>
              <p className="mt-1 text-sm font-medium leading-6 text-muted">
                {resilience.mode === "read_only"
                  ? "Pasaron 72 h sin contacto con el hub: este equipo sigue operando, pero no envía cambios nuevos. Exporta su operación y revisa la red."
                  : resilience.mode === "offline_ok"
                    ? "El hub no responde ahora mismo. Este equipo sigue vendiendo y guarda cada cambio para enviarlo al recuperar la red."
                    : "El hub responde: los cambios de este equipo se envían y se confirman al momento."}
              </p>
            </div>
            <span
              className={cn(
                "inline-flex shrink-0 items-center gap-1.5 self-start rounded-full px-2 py-0.5 text-sm font-semibold",
                resilience.mode === "online"
                  ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"
                  : resilience.mode === "offline_ok"
                    ? "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300"
                    : "bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300"
              )}
            >
              <span
                className={cn(
                  "h-1.5 w-1.5 rounded-full",
                  resilience.mode === "online"
                    ? "bg-emerald-500"
                    : resilience.mode === "offline_ok"
                      ? "bg-amber-500"
                      : "bg-rose-500"
                )}
              />
              {resilience.mode === "online" ? "Conectado" : resilience.mode === "offline_ok" ? "Sin hub" : "Solo lectura"}
            </span>
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div className="rounded-xl border border-base bg-secondary p-3 min-w-0">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted">Margen sin hub</p>
              <p className="mt-1 font-mono text-sm font-bold text-primary">
                {resilience.lastContactAt === null
                  ? "Sin contacto registrado"
                  : `Quedan ${Math.ceil(resilience.remainingMs / 3600000)} h de 72 h`}
              </p>
              <p className="mt-1 text-sm font-medium leading-5 text-muted">
                Último contacto:{" "}
                {resilience.lastContactAt ? formatExpiry(new Date(resilience.lastContactAt).toISOString()) : DASH}
              </p>
            </div>
            <div className="rounded-xl border border-base bg-secondary p-3 min-w-0">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted">Conflictos sin resolver</p>
              <p className="mt-1 font-mono text-sm font-bold text-primary">{conflicts.length}</p>
              <p className="mt-1 text-sm font-medium leading-5 text-muted">
                Operaciones que el hub rechazó y necesitan revisión.
              </p>
            </div>
          </div>

          {conflicts.length > 0 && (
            <ul className="space-y-1.5">
              {conflicts.slice(0, 4).map((conflict) => (
                <li
                  key={conflict.actionId}
                  className="flex items-start justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50/60 px-3 py-2 dark:border-amber-900/40 dark:bg-amber-950/20"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-bold text-primary">
                      {conflict.table} · {conflict.code || "rechazada"}
                    </span>
                    <span className="block truncate font-mono text-xs font-semibold text-muted">
                      {conflict.rowIds.join(", ") || conflict.actionId}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => handleDismissConflict(conflict.actionId)}
                    aria-label="Descartar conflicto"
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-base bg-primary text-muted hover:bg-subtle"
                  >
                    <X size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}

          {resilience.mode === "read_only" && (
            <div className="space-y-2">
              <button
                type="button"
                onClick={() => void handleExportReadOnly()}
                disabled={exporting}
                className="inline-flex h-11 w-full items-center justify-center gap-1.5 rounded-xl bg-violet-600 px-4 text-sm font-semibold text-white transition-colors hover:bg-violet-700 disabled:opacity-50 sm:w-auto"
              >
                <Download size={15} /> {exporting ? "Exportando…" : "Exportar operación local"}
              </button>
              {exportNote && (
                <p role="status" aria-live="polite" className="text-sm font-medium leading-5 text-muted">
                  {exportNote}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {!available ? (
        <div className="rounded-xl border border-base bg-primary p-3 sm:p-4 space-y-2">
          <p className="flex items-center gap-2 text-sm font-bold text-primary">
            <WifiOff size={15} className="shrink-0 text-amber-600" /> {UNAVAILABLE_COPY[surface].title}
          </p>
          <p className="text-sm font-medium leading-6 text-muted">{UNAVAILABLE_COPY[surface].detail}</p>
          <p className="flex items-start gap-1.5 text-sm font-medium leading-6 text-muted">
            <Router size={13} className="mt-1 shrink-0" />
            Por eso esta pantalla no muestra botones del hub: esta instalación no lo expone.
          </p>
        </div>
      ) : (
        <>
          <div className="rounded-xl border border-base bg-primary p-3 min-w-0">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-medium text-muted">Estado del hub</p>
              <span
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-sm font-semibold",
                  hub.running
                    ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"
                    : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"
                )}
              >
                <span className={cn("h-1.5 w-1.5 rounded-full", hub.running ? "bg-emerald-500" : "bg-slate-400")} />
                {hub.running ? "Activo" : "Detenido"}
              </span>
            </div>
            {address ? (
              <p className="mt-2 font-mono text-sm font-bold break-all text-primary">{address}</p>
            ) : null}
            {!hub.enabled && (
              <p className="mt-1.5 text-sm font-medium leading-5 text-muted">
                La red local está desactivada en este POS.
              </p>
            )}
          </div>

          <div className="rounded-xl border border-base bg-primary p-3 space-y-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <p className="flex items-center gap-2 text-sm font-bold text-primary">
                  <KeyRound size={15} className="shrink-0 text-violet-600" /> Código de emparejamiento
                </p>
                <p className="mt-1 text-sm font-medium leading-6 text-muted">
                  Compártelo solo con el equipo que quieres vincular. Cada código nuevo invalida el anterior.
                </p>
              </div>
              <button
                type="button"
                onClick={() => void handleRegenerate()}
                disabled={generating || !hub.running}
                className="h-11 w-full shrink-0 rounded-xl bg-violet-600 px-4 text-sm font-semibold text-white flex items-center justify-center gap-1.5 hover:bg-violet-700 disabled:opacity-50 transition-colors sm:w-auto"
              >
                <RefreshCw size={15} className={generating ? "animate-spin" : ""} />
                {generating ? "Generando…" : "Generar código nuevo"}
              </button>
            </div>

            {pairingActive ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
                <div className="min-w-0 space-y-2">
                  <div className="rounded-xl border border-violet-200 bg-violet-50/70 p-3 dark:border-violet-900/40 dark:bg-violet-950/20">
                    <p className="font-mono text-lg font-black tracking-[0.25em] break-all text-violet-800 dark:text-violet-200 sm:text-xl">
                      {hub.pairingCode}
                    </p>
                    <p className="mt-1 text-sm font-medium text-violet-700/80 dark:text-violet-300/80">
                      Caduca {formatExpiry(hub.pairingExpiresAt)} · quedan {minutesLeft} min
                    </p>
                    <button
                      type="button"
                      onClick={() => void handleCopyInvite()}
                      disabled={!invitation}
                      className="mt-2 inline-flex h-11 w-full items-center justify-center gap-1.5 rounded-xl bg-violet-600 px-3 text-sm font-semibold text-white transition-colors hover:bg-violet-700 disabled:opacity-50 sm:w-auto"
                    >
                      {inviteCopied ? <Check size={15} /> : <Copy size={15} />}
                      {inviteCopied ? "Invitación copiada" : "Copiar invitación"}
                    </button>
                    <p className="mt-1.5 text-sm font-medium leading-5 text-violet-700/80 dark:text-violet-300/80">
                      Pégala en la otra PC, en «Vincular esta PC con la PC principal».
                    </p>
                  </div>

                  {wildcardHost && (
                    <label className="block min-w-0 space-y-1">
                      <span className="block text-xs font-semibold uppercase tracking-wide text-muted">
                        IP de este equipo en la red
                      </span>
                      <input
                        type="text"
                        value={localIp}
                        onChange={(event) => setLocalIp(event.target.value)}
                        placeholder="192.168.1.50"
                        autoComplete="off"
                        spellCheck={false}
                        maxLength={60}
                        className="h-11 w-full rounded-xl border border-base bg-primary px-3 font-mono text-sm font-semibold text-primary outline-none focus:border-violet-400"
                      />
                      <span className="block text-sm font-medium leading-5 text-muted">
                        El hub escucha en todas las interfaces ({hub.host || "0.0.0.0"}). Escribe la IP de esta PC
                        en el Wi-Fi para que el QR apunte a ella.
                      </span>
                    </label>
                  )}

                </div>

                <div className="flex flex-col items-center justify-center gap-1.5 rounded-xl border border-base bg-primary p-2 sm:justify-self-end">
                  {pairingQr?.payload ? (
                    <>
                      <div className="rounded-lg bg-white p-1.5 shadow-sm">
                        <QRCodeSVG value={pairingQr.payload} size={132} level="M" />
                      </div>
                      <span className="flex items-center gap-1 text-center text-sm font-medium leading-5 text-muted">
                        <QrCode size={13} className="shrink-0" /> Mismo contenido que la invitación
                      </span>
                      {pairingQr.baseUrl && (
                        <span className="max-w-[168px] break-all text-center font-mono text-xs font-semibold text-muted">
                          {pairingQr.baseUrl}
                        </span>
                      )}
                    </>
                  ) : (
                    <p className="max-w-[176px] p-2 text-center text-sm font-medium leading-5 text-muted">
                      {wildcardHost
                        ? "Escribe la IP de este equipo para generar el QR."
                        : "El QR aparecerá al tener un código vigente."}
                    </p>
                  )}
                </div>
              </div>
            ) : (
              <p className="rounded-xl border border-dashed border-base bg-subtle p-3 text-sm font-medium leading-6 text-muted">
                {hub.running
                  ? hub.pairingCode
                    ? "El código anterior caducó. Genera uno nuevo para emparejar un equipo."
                    : "No hay un código vigente. Genera uno para emparejar un equipo nuevo."
                  : "El hub está detenido: abre PALMYRA POS con la red local activa para poder generar un código."}
              </p>
            )}

            {feedback && (
              <p
                role="status"
                aria-live="polite"
                className={cn(
                  "text-sm font-semibold",
                  feedback.type === "success"
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-rose-600 dark:text-rose-400"
                )}
              >
                {feedback.message}
              </p>
            )}
          </div>

          {hub.lastError && (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50/70 p-3 text-sm font-medium leading-6 text-rose-700 dark:border-rose-900/40 dark:bg-rose-950/20 dark:text-rose-300"
            >
              <AlertTriangle size={15} className="mt-0.5 shrink-0" /> {hub.lastError}
            </p>
          )}
        </>
      )}

      <div className="flex items-start gap-3 rounded-xl border border-violet-200 bg-violet-50/60 p-3 dark:border-violet-900/40 dark:bg-violet-950/20">
        <Info size={16} className="mt-0.5 shrink-0 text-violet-600 dark:text-violet-300" />
        <p className="text-sm font-medium leading-6 text-violet-900/90 dark:text-violet-100/90">
          El POS funciona sin internet: cada equipo guarda sus ventas en local y las envía a la PC principal por
          el Wi-Fi, o al reconectar. La red local comparte la operación entre equipos instalados del mismo negocio;
          no reemplaza a internet.
        </p>
      </div>
    </section>
  );
}
