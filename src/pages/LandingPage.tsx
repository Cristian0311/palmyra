import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight, ArrowLeftRight, BarChart3, Boxes, Check, ChevronRight, CloudOff, CreditCard, ClipboardCheck,
  MonitorSmartphone, Users, WifiOff, ShoppingCart, Truck,
  Settings2, LineChart, Menu, X, UserRound,
  ShieldCheck, Sparkles, Globe2,
  CircleDollarSign, LockKeyhole, Landmark, Caravan, Castle,
  Download, Smartphone, FileText, BookOpen, Headphones, Loader2
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { PalmyraWordmark } from "../components/PalmyraWordmark";

const CITY_IMAGE = "/landing/palmyra-ruins.webp";
const CITY_CREDIT = "Fotografía real de Palmyra, Siria · Vyacheslav Argenberg · Wikimedia Commons · CC BY 4.0";
const PALMYRA_PWA_INSTALLED_KEY = "palmyra:pwa-installed";
const DESKTOP_DOWNLOAD_URL =
  (import.meta.env.VITE_DESKTOP_DOWNLOAD_URL as string | undefined)?.trim() || "/download/windows";
const ANDROID_APK_URL =
  (import.meta.env.VITE_ANDROID_DOWNLOAD_URL as string | undefined)?.trim() || "/download/android";
const CaravanIcon = Caravan;
const CitadelIcon = Castle;

const areaGroups = ["Operación", "Gestión", "Finanzas", "Administración", "Ayuda"] as const;
type AreaGroup = typeof areaGroups[number];
type LandingArea = {
  id: string; label: string; icon: typeof BarChart3; group: AreaGroup;
  plan: "Gratis" | "Oasis" | "Caravana" | "Ciudadela"; route: string;
  title: string; summary: string; steps: string[]; capabilities: string[];
};

// Cada entrada corresponde a una sección real del menú de PALMYRA con su ruta.
const areas: LandingArea[] = [
  {
    id: "dashboard", label: "Dashboard", icon: BarChart3, group: "Operación", plan: "Gratis", route: "/",
    title: "El estado del negocio al abrir el día.",
    summary: "Ventas del día, caja abierta, stock bajo, operaciones pendientes y accesos directos a lo que necesita atención.",
    steps: ["Revisa ventas y caja del día", "Detecta stock bajo y descuadres", "Abre el área que necesita acción"],
    capabilities: ["Ventas y tickets del día", "Caja abierta por almacén", "Alertas de stock bajo", "Estado de sincronización"],
  },
  {
    id: "pos", label: "Punto de venta", icon: ShoppingCart, group: "Operación", plan: "Gratis", route: "/pos",
    title: "Cobrar rápido, incluso sin internet.",
    summary: "Catálogo del almacén, carrito, clientes, descuentos, varias formas de pago y cierre de turno con arqueo.",
    steps: ["Abre turno con tu empleado y fondo", "Busca productos y arma el carrito", "Cobra, imprime y cierra el turno"],
    capabilities: ["Búsqueda por nombre, SKU o código", "Efectivo, transferencia y USD", "Turnos con arqueo y cuadre", "Opera offline y sincroniza al volver"],
  },
  {
    id: "quotes", label: "Cotizaciones", icon: FileText, group: "Operación", plan: "Gratis", route: "/quotes",
    title: "Presupuestos que se convierten en venta.",
    summary: "Crea cotizaciones con vigencia, datos del cliente y PDF; al aprobarse, el carrito pasa directo al POS.",
    steps: ["Arma la cotización con productos", "Comparte o imprime el PDF", "Cobra la cotización en el POS"],
    capabilities: ["Vigencia y estados", "PDF para el cliente", "Envío directo al POS", "Eliminación con cola offline"],
  },
  {
    id: "transfers", label: "Transferencias", icon: ArrowLeftRight, group: "Operación", plan: "Caravana", route: "/transfers",
    title: "Mueve mercancía entre almacenes con trazabilidad.",
    summary: "Envíos individuales o masivos, panel de en tránsito y recepción que confirma el stock en destino.",
    steps: ["Elige origen, destino y cantidades", "Confirma el despacho", "Recibe en destino y ajusta stock"],
    capabilities: ["Historial general y por sucursal", "Constructor de envío masivo", "En tránsito con recibir o cancelar", "Dos fases sin duplicar stock"],
  },
  {
    id: "returns", label: "Garantías y devoluciones", icon: ShieldCheck, group: "Operación", plan: "Ciudadela", route: "/returns",
    title: "Devoluciones y garantías sin perder el hilo.",
    summary: "Busca la venta original, elige productos y cantidades, define el reintegro y repone el stock automáticamente.",
    steps: ["Busca el ticket de la venta", "Selecciona productos y motivo", "Confirma el reintegro"],
    capabilities: ["Devolución total o parcial", "Reintegro de stock", "Motivos y trazabilidad", "Historial por venta"],
  },
  {
    id: "customers", label: "Clientes", icon: Users, group: "Gestión", plan: "Caravana", route: "/customers",
    title: "La ficha del cliente con su historial real.",
    summary: "Datos de contacto, compras, saldo y notas, sin convertir el CRM en un laberinto.",
    steps: ["Registra o busca el cliente", "Consulta historial y saldo", "Atiende con contexto"],
    capabilities: ["Historial de compras", "Saldo y crédito", "Datos de contacto", "Búsqueda rápida"],
  },
  {
    id: "inventory", label: "Inventario", icon: Boxes, group: "Gestión", plan: "Gratis", route: "/inventory",
    title: "Existencias por almacén, sin confusión.",
    summary: "Productos con SKU, variantes, precios, mínimos y movimientos; el stock se descuenta al vender.",
    steps: ["Crea productos y categorías", "Asigna existencias por almacén", "Repón con movimientos y compras"],
    capabilities: ["Stock por almacén", "Variantes y códigos", "Mínimos y alertas", "Entradas, salidas y ajustes"],
  },
  {
    id: "audit", label: "Auditoría de inventario", icon: ClipboardCheck, group: "Gestión", plan: "Caravana", route: "/inventory-audit",
    title: "Conteo físico con revisión antes de ajustar.",
    summary: "Cuenta existencias, compara contra el sistema, recuenta las diferencias y aprueba el ajuste.",
    steps: ["Abre una auditoría por almacén", "Cuenta y registra lo encontrado", "Recuenta y aprueba el ajuste"],
    capabilities: ["Conteo por producto", "Diferencias y recuento", "Aprobación con trazabilidad", "Historial de auditorías"],
  },
  {
    id: "suppliers", label: "Proveedores y compras", icon: Truck, group: "Gestión", plan: "Caravana", route: "/suppliers",
    title: "Proveedores, órdenes y recepción en un flujo.",
    summary: "Registra proveedores, arma órdenes de compra y recibe mercancía actualizando inventario y costos.",
    steps: ["Guarda el proveedor", "Crea la orden de compra", "Recibe la mercancía en almacén"],
    capabilities: ["Búsqueda por nombre, SKU o código", "Órdenes y recepciones", "Costos de compra", "Historial por proveedor"],
  },
  {
    id: "banks", label: "Bancos", icon: Landmark, group: "Finanzas", plan: "Caravana", route: "/banks",
    title: "Cuentas y movimientos bancarios confirmados.",
    summary: "Tarjetas y cuentas con sus movimientos, ingresos por turno y conciliación desde un solo lugar.",
    steps: ["Agrega la cuenta o tarjeta", "Registra ingresos y egresos", "Concilia contra caja"],
    capabilities: ["Cuentas y tarjetas", "Movimientos confirmados", "Ingresos por turno", "Saldo por cuenta"],
  },
  {
    id: "reports", label: "Reportes", icon: LineChart, group: "Finanzas", plan: "Oasis", route: "/reports",
    title: "Decisiones con datos del negocio real.",
    summary: "Ventas, nómina, cajas, descuadres, movimientos y transferencias, con exportación y detalle por ticket.",
    steps: ["Elige período y almacén", "Revisa ventas, caja y descuadres", "Revisa el detalle o exporta"],
    capabilities: ["Ventas por horario y categoría", "Cajas y descuadres", "Detalle de venta con reintegro", "Exportación a Excel"],
  },
  {
    id: "settings", label: "Configuración", icon: Settings2, group: "Administración", plan: "Gratis", route: "/settings",
    title: "Todo lo que define cómo opera PALMYRA.",
    summary: "Empresa, almacenes, categorías, monedas y tasas, impresora, apariencia, red local, datos y notificaciones.",
    steps: ["Define empresa y almacenes", "Configura monedas e impresora", "Revisa conexión y respaldos"],
    capabilities: ["Empresa y almacenes", "Monedas y tasas", "Impresora y comprobantes", "Red local y respaldo"],
  },
  {
    id: "team", label: "Equipo", icon: UserRound, group: "Administración", plan: "Oasis", route: "/team",
    title: "Personas, roles y accesos claros.",
    summary: "Cada trabajador tiene su cuenta, su rol y solo ve las áreas que su permiso permite.",
    steps: ["Invita al trabajador", "Asigna rol y almacén", "Revisa sus accesos"],
    capabilities: ["Empleados y roles", "Permisos por área", "Asignación a almacenes", "Sesiones por dispositivo"],
  },
  {
    id: "subscription", label: "Plan y facturación", icon: CreditCard, group: "Administración", plan: "Gratis", route: "/subscription",
    title: "Plan, vencimiento y método de pago.",
    summary: "Consulta el plan activo, sus límites, el vencimiento y cómo renovar o cambiar de plan.",
    steps: ["Revisa el plan actual", "Comprueba el vencimiento", "Solicita renovación o cambio"],
    capabilities: ["Plan y límites", "Vencimiento", "Métodos de pago", "Historial de pagos"],
  },
  {
    id: "exchange-rate", label: "Tasa de cambio", icon: CircleDollarSign, group: "Administración", plan: "Gratis", route: "/exchange-rate",
    title: "Tasas de referencia con historial.",
    summary: "Tasas del mercado informal, su variación y umbrales para avisarte cuando cambien.",
    steps: ["Consulta la tasa del día", "Revisa historial y variación", "Activa avisos de cambio"],
    capabilities: ["Tasas por moneda", "Gráficos e historial", "Umbral de cambio", "Avisos en notificaciones"],
  },
  {
    id: "tutorial", label: "Escuela PALMYRA", icon: BookOpen, group: "Ayuda", plan: "Gratis", route: "/tutorial",
    title: "Aprende el sistema dentro del sistema.",
    summary: "Lecciones guiadas sobre caja, inventario, compras, reportes y configuración, con progreso guardado.",
    steps: ["Abre la lección", "Sigue los pasos en tu pantalla", "Completa tu progreso"],
    capabilities: ["Lecciones por área", "Progreso guardado", "Ejemplos del sistema real", "Acceso desde Reportes"],
  },
  {
    id: "help-center", label: "Centro de atención", icon: Headphones, group: "Ayuda", plan: "Gratis", route: "/help-center",
    title: "Soporte y respuestas dentro de la app.",
    summary: "Guías, preguntas frecuentes y contacto con soporte, incluyendo seguridad y respaldos.",
    steps: ["Busca tu duda", "Lee la guía del área", "Contacta si necesitas ayuda"],
    capabilities: ["Guías por tema", "Preguntas frecuentes", "Contacto con soporte", "Sección de seguridad"],
  },
];

const plans = [
  {
    code: "free", icon: CloudOff, name: "Gratis", price: "0 USD", note: "Sin vencimiento", warehouses: "1 almacén", employees: "1 empleado + propietario", products: "25 tipos de productos/SKUs",
    description: "Operación básica sin vencimiento, con respaldo comercial en la nube incluido.",
    features: ["POS básico", "Caja en efectivo", "Inventario básico", "Reportes básicos", "Modo offline", "Respaldo comercial en la nube"], featured: false
  },
  {
    code: "starter", icon: Sparkles, name: "Oasis", price: "$10", note: "Inicio esencial", warehouses: "1 almacén", employees: "2 empleados + administrador", products: "50 tipos de productos/SKUs",
    description: "Para comenzar a vender y controlar lo esencial sin complicaciones.",
    features: ["Punto de venta", "Inventario y caja", "Equipo con roles", "Reportes básicos", "Modo offline"], featured: false
  },
  {
    code: "growth", icon: CaravanIcon, name: "Caravana", price: "$15", note: "Operación en expansión", warehouses: "3 almacenes", employees: "4 empleados + administrador", products: "150 tipos de productos/SKUs",
    description: "Para negocios que ya mueven mercancía entre varios puntos y necesitan más control.",
    features: ["Punto de venta", "Inventario y caja", "Clientes y proveedores", "Modo offline", "Compras y recepción", "Transferencias entre almacenes", "Reportes avanzados", "Equipo con roles", "Operación multi-almacén"], featured: true
  },
  {
    code: "pro", icon: CitadelIcon, name: "Ciudadela", price: "$25", note: "Control empresarial", warehouses: "7 almacenes", employees: "10 empleados + administrador", products: "300 tipos de productos/SKUs",
    description: "Para empresas con mayor estructura, más ubicaciones y análisis profundo.",
    features: ["Punto de venta", "Inventario y caja", "Clientes y proveedores", "Modo offline", "Compras y recepción", "Transferencias entre almacenes", "Reportes avanzados", "Equipo con roles", "Operación multi-almacén", "Analítica avanzada", "Soporte prioritario"], featured: false
  }
];

const palette = [
  ["#3B1B78", "Violeta profundo"], ["#5B2DBA", "PALMYRA"], ["#7C4DDE", "Activo"],
  ["#9B7BE8", "Lavanda"], ["#EFE8FF", "Superficie"], ["#F7F5FC", "Fondo"]
];

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <img
      src="/palmyra-logo-exact.svg"
      alt="PALMYRA"
      className={compact ? "w-[116px] h-[30px] object-contain object-left" : "w-[236px] h-[61px] object-contain object-left"}
    />
  );
}

function AreaPanel({ area, compact = false, onOpen }: { area: LandingArea; compact?: boolean; onOpen?: () => void }) {
  const Icon = area.icon;
  return (
    <div className="rounded-[26px] border border-violet-100 bg-white p-4 shadow-[0_24px_70px_-46px_rgba(59,27,110,.4)] sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-[#EFE8FF] text-[#5B2DBA]"><Icon className="h-5 w-5" /></span>
        <div className="flex flex-wrap justify-end gap-1.5">
          <span className="rounded-full bg-[#F7F5FC] px-2.5 py-1 text-[9px] font-black uppercase tracking-wider text-slate-500">{area.group}</span>
          <span className="rounded-full bg-[#EFE8FF] px-2.5 py-1 text-[9px] font-black uppercase tracking-wider text-[#5B2DBA]">Plan {area.plan}</span>
        </div>
      </div>
      <p className="mt-4 text-[9px] font-black uppercase tracking-[.18em] text-[#7C4DDE]">
        {area.label} <span className="normal-case tracking-normal text-slate-500">· {area.route}</span>
      </p>
      <h3 className="mt-1.5 text-lg font-black tracking-[-.02em] text-[#3B1B78] sm:text-xl">{area.title}</h3>
      <p className="mt-2 text-xs leading-6 text-slate-500">{area.summary}</p>
      {!compact && (
        <>
          <p className="mt-4 text-[9px] font-black uppercase tracking-[.18em] text-slate-500">Cómo se usa</p>
          <ol className="mt-2 grid gap-1.5">
            {area.steps.map((step, index) => (
              <li key={step} className="flex items-center gap-2.5 rounded-xl border border-violet-100 bg-[#F8F6FC] px-3 py-2">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md border border-violet-100 bg-white text-[9px] font-black text-[#5B2DBA]">{index + 1}</span>
                <span className="text-[11px] font-bold text-[#3B1B78]">{step}</span>
              </li>
            ))}
          </ol>
        </>
      )}
      <div className="mt-4 rounded-2xl bg-[#3B1B78] p-3.5 text-white">
        <p className="text-[8px] font-black uppercase tracking-[.18em] text-violet-200">Qué puedes hacer</p>
        <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
          {area.capabilities.map((capability) => (
            <li key={capability} className="flex items-start gap-1.5 text-[10px] font-bold leading-4 text-white/90">
              <Check className="mt-0.5 h-3 w-3 shrink-0 text-violet-200" />{capability}
            </li>
          ))}
        </ul>
      </div>
      {onOpen && (
        <>
          <button type="button" onClick={onOpen} className="mt-4 flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-[#5B2DBA] text-xs font-black text-white shadow-[0_12px_28px_-12px_rgba(101,53,197,.65)]">
            Abrir {area.label} <ArrowRight className="h-4 w-4" />
          </button>
          <p className="mt-2 text-center text-[10px] font-semibold leading-4 text-slate-600">
            Si aún no has iniciado sesión, PALMYRA te pedirá entrar.
          </p>
        </>
      )}
    </div>
  );
}

type InstallPlatform = "ios" | "android" | "desktop";

function DownloadCta({
  href,
  label,
  sizeLabel,
  className,
  onStarted,
}: {
  href: string;
  label: string;
  sizeLabel: string;
  className?: string;
  onStarted?: () => void;
}) {
  const [phase, setPhase] = useState<"idle" | "starting" | "sent">("idle");

  useEffect(() => {
    if (phase === "idle") return;
    const toSent = phase === "starting" ? setTimeout(() => setPhase("sent"), 6000) : undefined;
    return () => {
      if (toSent) clearTimeout(toSent);
    };
  }, [phase]);

  const started = phase !== "idle";

  return (
    <div>
      <a
        href={href}
        onClick={() => {
          setPhase("starting");
          onStarted?.();
        }}
        className={`relative flex min-h-11 w-full items-center justify-center gap-2 overflow-hidden rounded-xl px-3 text-center text-xs font-black text-white shadow-[0_14px_30px_-16px_rgba(101,53,197,.8)] transition active:scale-[.99] ${
          started ? "bg-[#3B1B78]" : "bg-[#5B2DBA]"
        } ${className || ""}`}
      >
        {phase === "idle" ? <Download className="w-4 h-4 shrink-0" /> : <Loader2 className="w-4 h-4 shrink-0 animate-spin" />}
        {phase === "idle" ? label : phase === "starting" ? "Iniciando descarga…" : "Descarga iniciada"}
        {phase === "starting" && (
          <span className="pointer-events-none absolute inset-x-0 bottom-0 h-1 overflow-hidden bg-white/20">
            <span className="block h-full w-1/3 animate-[download-slide_1.1s_ease-in-out_infinite] rounded-full bg-white/90" />
          </span>
        )}
      </a>
      <div className="mt-2 flex items-start justify-between gap-2 text-[9px] leading-4 text-slate-600">
        <span>
          {started
            ? "Revisa la barra de descargas de tu navegador. Si no aparece, vuelve a tocar el botón."
            : sizeLabel}
        </span>
        {started && (
          <button
            type="button"
            onClick={() => setPhase("idle")}
            className="shrink-0 font-black text-[#5B2DBA] underline decoration-dotted underline-offset-2"
          >
            Ocultar
          </button>
        )}
      </div>
    </div>
  );
}

function DownloadCenter() {
  const [installPromptReady, setInstallPromptReady] = useState(false);
  const [installed, setInstalled] = useState(false);
  const [platform, setPlatform] = useState<InstallPlatform>("desktop");

  useEffect(() => {
    const userAgent = navigator.userAgent;
    const isIOS =
      /iPad|iPhone|iPod/.test(userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    setPlatform(isIOS ? "ios" : /Android/i.test(userAgent) ? "android" : "desktop");
    setInstalled(
      Boolean(window.matchMedia?.("(display-mode: standalone)").matches) ||
        Boolean((navigator as Navigator & { standalone?: boolean }).standalone) ||
        localStorage.getItem(PALMYRA_PWA_INSTALLED_KEY) === "1"
    );

    const bridge = () =>
      (window as typeof window & { __palmyraInstallPrompt?: { prompt?: () => Promise<void> } })
        .__palmyraInstallPrompt;
    const syncPrompt = () => setInstallPromptReady(Boolean(bridge()?.prompt));
    syncPrompt();
    const markInstalled = () => setInstalled(true);
    window.addEventListener("palmyra:pwa-install-available", syncPrompt);
    window.addEventListener("palmyra:pwa-installed", markInstalled);
    return () => {
      window.removeEventListener("palmyra:pwa-install-available", syncPrompt);
      window.removeEventListener("palmyra:pwa-installed", markInstalled);
    };
  }, []);

  const requestInstall = async () => {
    const install = (
      window as typeof window & { __palmyraInstallPrompt?: { prompt?: () => Promise<void> } }
    ).__palmyraInstallPrompt;
    await install?.prompt?.();
  };

  const mobileHint =
    platform === "ios"
      ? "En Safari: toca Compartir y elige «Añadir a pantalla de inicio»."
      : platform === "android"
        ? "En Chrome: abre el menú ⋮ y elige «Instalar aplicación» o «Añadir a pantalla de inicio»."
        : "Abre esta página en tu teléfono para añadirla a la pantalla de inicio. En Chrome de escritorio: menú ⋮ → «Instalar PALMYRA».";

  const pwaInstallFallback = installed ? (
    <div className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 text-center text-[10px] font-black text-emerald-800">
      <Check className="h-4 w-4 shrink-0" />
      App instalada en este dispositivo
    </div>
  ) : installPromptReady ? (
    <div>
      <button
        type="button"
        onClick={requestInstall}
        className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-violet-200 bg-white px-3 text-center text-[11px] font-black text-[#5B2DBA]"
      >
        <Download className="h-4 w-4 shrink-0" />
        O instálala desde el navegador
      </button>
      <p className="mt-1.5 text-[9px] font-semibold leading-4 text-slate-600">{mobileHint}</p>
    </div>
  ) : (
    <div className="rounded-xl border border-violet-200 bg-white px-3 py-2.5">
      <p className="text-[9px] font-black uppercase tracking-wider text-[#5B2DBA]">O instálala desde el navegador</p>
      <p className="mt-1 text-[10px] leading-5 text-slate-600">{mobileHint}</p>
    </div>
  );

  return (
    <section id="descargas" className="bg-white border-y border-violet-100">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-14 lg:py-18">
        <div className="max-w-3xl">
          <p className="text-[10px] font-black uppercase tracking-[.2em] text-[#7C4DDE]">Descargas</p>
          <h2 className="text-2xl sm:text-4xl font-black tracking-[-.04em] text-[#3B1B78] mt-2">
            Lleva PALMYRA a tu PC o a tu móvil.
          </h2>
          <p className="text-sm text-slate-500 mt-3 leading-6">
            Instala el programa completo en Windows o descarga el APK en tu Android. También puedes añadirla a la pantalla
            de inicio desde el navegador. Todo usa la misma cuenta, empresa y datos: lo que registres en un dispositivo
            aparece en el otro al sincronizar.
          </p>
        </div>

        <div className="grid md:grid-cols-2 gap-3 mt-8">
          <article className="relative flex flex-col overflow-hidden rounded-3xl border border-violet-100 bg-[#F7F5FC] p-5 sm:p-6">
            <div className="pointer-events-none absolute -top-20 -right-16 h-52 w-52 rounded-full bg-[#EFE8FF] blur-2xl" />
            <div className="relative flex flex-col h-full">
              <div className="flex items-center justify-between gap-3">
                <span className="w-11 h-11 rounded-2xl bg-[#5B2DBA] text-white flex items-center justify-center">
                  <MonitorSmartphone className="w-5 h-5" />
                </span>
                <span className="px-2.5 py-1 rounded-full bg-white border border-violet-100 text-[8px] font-black uppercase tracking-wider text-[#5B2DBA]">
                  Windows 10 / 11 · 64 bits
                </span>
              </div>
              <h3 className="text-xl font-black text-[#3B1B78] mt-4">PALMYRA para PC</h3>
              <p className="text-xs text-slate-500 mt-2 leading-6">
                El sistema completo como programa de escritorio, con acceso directo y operación offline.
              </p>
              <div className="mt-4 space-y-1.5">
                {[
                  "Instalador .exe con asistente paso a paso",
                  "Trabaja sin internet y sincroniza al reconectar",
                  "Conserva la sesión y los datos al cerrar y abrir",
                ].map((item) => (
                  <div key={item} className="flex items-center gap-2 text-[10px] text-slate-600">
                    <Check className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                    {item}
                  </div>
                ))}
              </div>
              <div className="mt-auto pt-5">
                <div className="rounded-xl border border-violet-100 bg-white px-3 py-2">
                  <p className="text-[10px] font-black text-[#3B1B78]">Versión actual · v{__APP_VERSION__}</p>
                  <p className="mt-0.5 text-[9px] font-semibold text-slate-600">Siempre la última versión publicada</p>
                </div>
                <DownloadCta
                  href={DESKTOP_DOWNLOAD_URL}
                  label="Descargar instalador"
                  sizeLabel="Instalador para Windows · aprox. 84 MB"
                  className="mt-2"
                />
                <p className="mt-2 text-[9px] leading-4 text-slate-600">
                  Si Windows muestra el aviso de SmartScreen por ser un instalador nuevo, elige «Más información →
                  Ejecutar de todas formas».
                </p>
              </div>
            </div>
          </article>

          <article className="relative flex flex-col overflow-hidden rounded-3xl border border-violet-100 bg-[#F7F5FC] p-5 sm:p-6">
            <div className="pointer-events-none absolute -bottom-20 -right-16 h-52 w-52 rounded-full bg-[#EFE8FF] blur-2xl" />
            <div className="relative flex flex-col h-full">
              <div className="flex items-center justify-between gap-3">
                <span className="w-11 h-11 rounded-2xl bg-[#3B1B78] text-white flex items-center justify-center">
                  <Smartphone className="w-5 h-5" />
                </span>
                <span className="px-2.5 py-1 rounded-full bg-white border border-violet-100 text-[8px] font-black uppercase tracking-wider text-[#5B2DBA]">
                  Android 7+ · iPhone / iPad
                </span>
              </div>
              <h3 className="text-xl font-black text-[#3B1B78] mt-4">PALMYRA para móvil</h3>
              <p className="text-xs text-slate-500 mt-2 leading-6">
                Descarga el APK en Android o añade la app a la pantalla de inicio. Sin pasar por una tienda de aplicaciones.
              </p>
              <div className="mt-4 space-y-1.5">
                {[
                  "APK para Android 7 o superior",
                  "Instala sin tienda de aplicaciones",
                  "Pantalla completa, como una app nativa",
                  "Funciona offline y sincroniza al recuperar señal",
                ].map((item) => (
                  <div key={item} className="flex items-center gap-2 text-[10px] text-slate-600">
                    <Check className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                    {item}
                  </div>
                ))}
              </div>
              <div className="mt-auto space-y-2 pt-5">
                {platform !== "ios" ? (
                  <>
                    <DownloadCta
                      href={ANDROID_APK_URL}
                      label="Descargar APK para Android"
                      sizeLabel="APK para Android 7 o superior · aprox. 2 MB"
                    />
                    <p className="text-[9px] font-semibold leading-4 text-slate-600">
                      Instala sin tienda de aplicaciones. Si Android lo solicita, activa «Instalar apps desconocidas».
                    </p>
                    <div className="pt-1">{pwaInstallFallback}</div>
                  </>
                ) : (
                  <>
                    <p className="text-[9px] font-black uppercase tracking-wider text-[#3B1B78]">En iPhone / iPad</p>
                    {pwaInstallFallback}
                    <p className="text-[9px] font-semibold leading-4 text-slate-600">
                      iPhone y iPad no aceptan APK: usa Safari y añádela a la pantalla de inicio.
                    </p>
                  </>
                )}
              </div>
            </div>
          </article>
        </div>

        <p className="text-[10px] text-slate-500 mt-5">
          ¿Prefieres no instalar nada todavía? También puedes entrar directo desde el navegador con tu cuenta.
        </p>
      </div>
    </section>
  );
}

export default function LandingPage() {
  useEffect(() => {
    const html = document.documentElement;
    const body = document.body;
    const root = document.getElementById("root");
    const previous = {
      htmlOverflow: html.style.overflow,
      bodyOverflow: body.style.overflow,
      bodyOverflowY: body.style.overflowY,
      bodyTouchAction: body.style.touchAction,
      rootOverflow: root?.style.overflow ?? "",
      rootOverflowY: root?.style.overflowY ?? "",
    };

    html.style.overflow = "auto";
    body.style.overflow = "visible";
    body.style.overflowY = "auto";
    body.style.touchAction = "pan-y";
    if (root) {
      root.style.overflow = "visible";
      root.style.overflowY = "auto";
    }

    return () => {
      html.style.overflow = previous.htmlOverflow;
      body.style.overflow = previous.bodyOverflow;
      body.style.overflowY = previous.bodyOverflowY;
      body.style.touchAction = previous.bodyTouchAction;
      if (root) {
        root.style.overflow = previous.rootOverflow;
        root.style.overflowY = previous.rootOverflowY;
      }
    };
  }, []);
  const navigate = useNavigate();
  const [active, setActive] = useState("dashboard");
  const [mobileMenu, setMobileMenu] = useState(false);
  const current = useMemo(() => areas.find(item => item.id === active) || areas[0], [active]);

  return (
    <div className="palmyra-landing-page min-h-screen bg-[#F7F5FC] text-[#21182F]">
      <header className="sticky top-0 z-50 border-b border-violet-100 bg-[#F7F5FC]/90 backdrop-blur-xl">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-[68px] flex items-center justify-between gap-4">
          <button onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })} aria-label="Ir al inicio"><Brand /></button>
          <nav className="hidden lg:flex items-center gap-7 text-[12px] font-bold text-slate-600">
            <a href="#producto">Producto</a><a href="#modulos">Módulos</a><a href="#descargas">Descargas</a><a href="#planes">Planes</a><a href="#historia">Historia</a>
          </nav>
          <div className="flex items-center gap-2">
            <button onClick={() => navigate("/auth")} className="hidden sm:inline-flex h-10 px-4 rounded-xl items-center justify-center text-xs font-black text-[#5B2DBA] hover:bg-white">Entrar</button>
            <button onClick={() => navigate("/auth?mode=signup")} className="h-10 px-4 sm:px-5 rounded-xl bg-[#5B2DBA] text-white text-xs font-black shadow-[0_12px_28px_-12px_rgba(101,53,197,.65)]">Crear cuenta</button>
            <button onClick={() => setMobileMenu(v => !v)} className="lg:hidden w-10 h-10 rounded-xl border border-violet-100 bg-white text-[#5B2DBA]" aria-label="Menú">{mobileMenu ? <X className="w-4 h-4 mx-auto" /> : <Menu className="w-4 h-4 mx-auto" />}</button>
          </div>
        </div>
        {mobileMenu && <div className="lg:hidden border-t border-violet-100 bg-white px-4 py-3"><div className="flex flex-col gap-3 text-xs font-bold text-slate-600"><a href="#producto" onClick={() => setMobileMenu(false)}>Producto</a><a href="#modulos" onClick={() => setMobileMenu(false)}>Módulos</a><a href="#descargas" onClick={() => setMobileMenu(false)}>Descargas</a><a href="#planes" onClick={() => setMobileMenu(false)}>Planes</a><a href="#historia" onClick={() => setMobileMenu(false)}>Historia</a></div></div>}
      </header>

      <main>
        <section id="producto" className="relative overflow-hidden">
          <div className="absolute -top-40 -right-36 w-[30rem] h-[30rem] rounded-full palmyra-orb" />
          <div className="absolute bottom-0 left-0 w-[18rem] h-[18rem] rounded-full bg-[#EDE7FA]/70 blur-3xl" />
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-14 pb-12 lg:pt-20 lg:pb-16 grid xl:grid-cols-[.82fr_1.18fr] gap-9 items-center">
            <div className="relative z-10">
              <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-[#EFE8FF] text-[#5B2DBA] text-[10px] font-black">
                <Sparkles className="w-3 h-3" /> Business OS para negocios reales
              </div>
              <h1 className="text-[2.8rem] sm:text-5xl lg:text-6xl font-black tracking-[-.06em] leading-[.98] mt-5 text-[#3B1B78]">
                Vende mejor.<br/><span className="palmyra-gradient-text">Controla todo.</span>
              </h1>
              <p className="text-sm sm:text-base lg:text-lg leading-7 text-slate-600 mt-5 max-w-xl">
                PALMYRA reúne ventas, inventario, cajas, compras, clientes, almacenes, equipo y reportes en un solo sistema. Una cuenta pertenece a una sola empresa y crece con los almacenes permitidos por tu plan.
              </p>
              <div className="flex flex-col sm:flex-row gap-2.5 mt-7">
                <button onClick={() => navigate("/auth?mode=signup")} className="h-12 px-5 rounded-2xl bg-[#5B2DBA] text-white font-black text-sm flex items-center justify-center gap-2 shadow-[0_18px_40px_-18px_rgba(101,53,197,.7)]">Crear mi cuenta <ArrowRight className="w-4 h-4"/></button>
                <a href="#modulos" className="h-12 px-5 rounded-2xl bg-white border border-violet-200 text-[#5B2DBA] font-black text-sm flex items-center justify-center">Ver cómo funciona</a>
              </div>
              <div className="grid grid-cols-2 sm:flex sm:flex-wrap gap-x-5 gap-y-2.5 mt-6 text-[10px] font-bold text-slate-500">
                <span><Check className="inline w-3.5 h-3.5 text-emerald-600 mr-1"/>1 cuenta = 1 empresa</span>
                <span><Check className="inline w-3.5 h-3.5 text-emerald-600 mr-1"/>Almacenes por plan</span>
                <span><Check className="inline w-3.5 h-3.5 text-emerald-600 mr-1"/>Offline</span>
                <span><Check className="inline w-3.5 h-3.5 text-emerald-600 mr-1"/>Accesos por rol</span>
              </div>
            </div>

            <div className="relative">
              <div className="palmyra-3d rounded-[28px] bg-white/60 p-2.5 border border-violet-100 shadow-[0_40px_90px_-42px_rgba(59,27,110,.48)]">
                <AreaPanel area={current} compact onOpen={() => navigate(current.route)} />
              </div>
              <div className="absolute -bottom-4 -left-2 sm:-left-4 px-3 py-2 rounded-2xl bg-white border border-violet-100 shadow-xl flex items-center gap-2">
                <span className="w-8 h-8 rounded-xl bg-[#EFE8FF] text-[#5B2DBA] flex items-center justify-center"><WifiOff className="w-4 h-4"/></span>
                <div><p className="text-[9px] font-black text-[#3B1B78]">Modo offline</p><p className="text-[8px] text-slate-500">Sigue operando sin internet</p></div>
              </div>
              <div className="absolute -top-5 -right-2 sm:-right-5 px-3 py-2 rounded-2xl bg-[#3B1B78] text-white shadow-2xl flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-violet-200"/>
                <div><p className="text-[9px] font-black">Datos aislados</p><p className="text-[8px] text-violet-200">Empresa · usuario · dispositivo</p></div>
              </div>
            </div>
          </div>
        </section>

        <section id="modulos" className="border-y border-violet-100 bg-white">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-14 lg:py-18">
            <div className="max-w-3xl">
              <p className="text-[10px] font-black uppercase tracking-[.2em] text-[#7C4DDE]">Explora el producto</p>
              <h2 className="text-2xl sm:text-4xl font-black tracking-[-.04em] text-[#3B1B78] mt-2">Conoce cada área antes de entrar.</h2>
              <p className="text-sm text-slate-500 mt-3 leading-6">Estas son las {areas.length} áreas reales de PALMYRA, agrupadas igual que el menú del sistema. Cada una indica qué resuelve, cómo se usa, qué puedes hacer y desde qué plan está disponible.</p>
            </div>
            <div className="mt-6 flex gap-1.5 overflow-x-auto pb-1 lg:hidden">
              {areas.map(({ id, label, icon: Icon }) => (
                <button key={id} onClick={() => setActive(id)} className={"shrink-0 h-11 px-3 rounded-xl flex items-center gap-2 text-[10px] font-black transition " + (active === id ? "bg-[#5B2DBA] text-white shadow-md" : "bg-[#F7F5FC] text-slate-500 hover:bg-[#EFE8FF] hover:text-[#5B2DBA]")}>
                  <Icon className="w-3.5 h-3.5"/>{label}
                </button>
              ))}
            </div>
            <div className="mt-6 grid gap-5 lg:grid-cols-[.34fr_.66fr] lg:items-start">
              <nav aria-label="Áreas de PALMYRA" className="hidden rounded-3xl border border-violet-100 bg-[#F7F5FC] p-3 lg:sticky lg:top-24 lg:block">
                {areaGroups.map(group => {
                  const groupAreas = areas.filter(area => area.group === group);
                  return (
                    <div key={group} className="mb-3 last:mb-0">
                      <p className="px-2 pb-1.5 text-[9px] font-black uppercase tracking-[.18em] text-slate-500">{group}</p>
                      <div className="space-y-1">
                        {groupAreas.map(area => {
                          const Icon = area.icon;
                          const isActive = active === area.id;
                          return (
                            <button key={area.id} type="button" onClick={() => setActive(area.id)} aria-current={isActive ? "true" : undefined}
                              className={"flex min-h-10 w-full items-center gap-2.5 rounded-xl px-2.5 text-left text-[11px] font-bold transition " + (isActive ? "bg-white text-[#5B2DBA] shadow-sm ring-1 ring-violet-200" : "text-slate-500 hover:bg-white/70 hover:text-[#5B2DBA]")}>
                              <span className={"flex h-7 w-7 shrink-0 items-center justify-center rounded-lg " + (isActive ? "bg-[#5B2DBA] text-white" : "bg-white text-[#7C4DDE]")}><Icon className="w-3.5 h-3.5"/></span>
                              <span className="min-w-0 flex-1 truncate">{area.label}</span>
                              <span className="shrink-0 text-[8px] font-black uppercase tracking-wider text-slate-500">{area.plan}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </nav>
              <AreaPanel area={current} onOpen={() => navigate(current.route)} />
            </div>
          </div>
        </section>

        <DownloadCenter />

        <section className="bg-[#3B1B78] text-white">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12 grid lg:grid-cols-[1fr_auto] gap-7 items-center">
            <div>
              <p className="text-[10px] font-black uppercase tracking-[.2em] text-violet-200">Lenguaje visual</p>
              <h2 className="text-2xl sm:text-4xl font-black tracking-[-.04em] mt-2">Morado para la marca. Claridad para trabajar.</h2>
              <p className="text-sm text-violet-100/75 mt-3 max-w-2xl leading-6">La paleta nace del logo: profundidad para navegación y encabezados, violeta para acciones, lavanda para superficies y contrastes suaves para largas jornadas frente a la pantalla.</p>
            </div>
            <div className="w-full rounded-2xl bg-white/5 border border-white/10 p-4 lg:w-[26rem]">
              <div className="grid grid-cols-3 gap-x-3 gap-y-4 sm:grid-cols-6 lg:grid-cols-3">
                {palette.map(([hex, name]) => (
                  <div key={hex} className="flex min-w-0 flex-col items-center gap-1.5 text-center">
                    <span style={{ backgroundColor: hex }} className="block h-10 w-10 rounded-full border border-white/20 shadow-inner" />
                    <span className="block break-words text-[10px] font-bold leading-tight text-violet-100">{name}</span>
                    <span className="block text-[9px] font-semibold uppercase tracking-wide text-violet-200/70">{hex}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section id="planes" className="bg-[#F7F5FC]">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-14 lg:py-18">
            <div className="text-center max-w-2xl mx-auto">
              <p className="text-[10px] font-black uppercase tracking-[.2em] text-[#7C4DDE]">Planes</p>
              <h2 className="text-2xl sm:text-4xl font-black text-[#3B1B78] mt-2">Empieza pequeño. Crece sin cambiar de sistema.</h2>
              <p className="text-sm text-slate-500 mt-3">Un administrador por empresa y el número de almacenes y empleados que permite cada plan.</p>
            </div>
            <div className="grid sm:grid-cols-2 xl:grid-cols-4 gap-3 mt-8">
              {plans.map(plan => {
                const Icon = plan.icon;
                return (
                  <article key={plan.code} className={"relative rounded-2xl p-4 border " + (plan.featured ? "border-[#8B63E6] bg-white shadow-[0_25px_60px_-34px_rgba(101,53,197,.55)] md:-translate-y-2" : "border-violet-100 bg-white/80")}>
                    {plan.featured && <div className="absolute -top-2.5 left-4 px-2.5 py-1 rounded-full bg-[#5B2DBA] text-white text-[8px] font-black uppercase tracking-wider">Más elegido</div>}
                    <div className="flex items-center justify-between gap-2"><div className="flex items-center gap-2"><span className="w-8 h-8 rounded-xl bg-[#EFE8FF] text-[#5B2DBA] flex items-center justify-center"><Icon className="w-4 h-4"/></span><div><p className="text-[9px] uppercase tracking-wider text-slate-500 font-black">{plan.note}</p><h3 className="text-base font-black text-[#3B1B78]">{plan.name}</h3></div></div><p className="text-xl font-black text-[#3B1B78]">{plan.price}{plan.code !== "free" && <span className="text-[8px] text-slate-500 font-bold">/mes</span>}</p></div>
                    <div className="grid grid-cols-3 gap-1.5 mt-4">{[plan.warehouses, plan.employees, plan.products].map((value, index) => <div key={index} className="rounded-lg bg-[#F7F5FC] border border-violet-50 px-2 py-2 text-center"><p className="text-[7px] text-slate-500 uppercase font-black">{["Almacenes","Empleados","Productos"][index]}</p><p className="text-[10px] font-black text-[#5B2DBA] mt-0.5">{value}</p></div>)}</div>
                    <p className="text-[9px] text-slate-500 leading-5 mt-3">{plan.description}</p>
                    <div className="space-y-1.5 mt-4">{plan.features.map(f => <div key={f} className="flex items-center gap-2 text-[9px] text-slate-500"><span className="w-4 h-4 rounded-md bg-[#EFE8FF] text-[#5B2DBA] flex items-center justify-center shrink-0"><Check className="w-2.5 h-2.5"/></span>{f}</div>)}</div>
                    <button onClick={() => { sessionStorage.setItem("palmyra_signup_plan", plan.code); navigate("/auth?mode=signup"); }} className={"w-full h-10 mt-5 rounded-xl text-[10px] font-black " + (plan.featured ? "bg-[#5B2DBA] text-white" : "bg-[#F0EBFA] text-[#5B2DBA]")}>{plan.code === "free" ? "Comenzar con Gratis" : "Elegir plan"}</button>
                    <p className="text-[7px] text-center text-slate-500 mt-2">{plan.code === "free" ? "Gratis permanente · modo offline · respaldo comercial en la nube" : "CUP en efectivo o transferencia · USD en efectivo · confirmación manual"}</p>
                  </article>
                );
              })}
            </div>
          </div>
        </section>

        <section className="bg-white border-y border-violet-100">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12 grid lg:grid-cols-3 gap-3">
            {[
              { Icon: LockKeyhole, title: "Cuenta personal", text: "Cada usuario entra con su propia identidad." },
              { Icon: MonitorSmartphone, title: "Desde cualquier dispositivo", text: "Mismo negocio, mismo rol y permisos." },
              { Icon: CloudOff, title: "Offline de verdad", text: "La operación puede continuar y sincronizarse después." }
            ].map(({ Icon, title, text }) => <div key={title} className="rounded-2xl border border-violet-100 bg-[#F7F5FC] p-4"><div className="w-9 h-9 rounded-xl bg-white border border-violet-100 text-[#5B2DBA] flex items-center justify-center"><Icon className="w-4 h-4"/></div><h3 className="text-sm font-black text-[#3B1B78] mt-3">{title}</h3><p className="text-[10px] text-slate-500 mt-1 leading-5">{text}</p></div>)}
          </div>
        </section>

        <section id="historia" className="bg-[#F7F5FC]">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-14 lg:py-18 grid lg:grid-cols-[1.05fr_.95fr] gap-8 items-center">
            <div className="relative rounded-[28px] overflow-hidden border border-violet-100 shadow-[0_30px_70px_-40px_rgba(59,27,110,.45)] bg-gradient-to-br from-[#241143] via-[#5D2DB9] to-[#A987F3] h-[300px] sm:h-[390px]">
              <img src={CITY_IMAGE} alt="Fotografía real de las ruinas de la antigua ciudad de Palmyra, Siria" className="absolute inset-0 w-full h-full object-cover" loading="lazy" decoding="async" />
              <div className="absolute inset-x-0 bottom-0 p-4 bg-gradient-to-t from-black/70 to-transparent text-white"><p className="text-[8px] font-bold opacity-80">{CITY_CREDIT}</p></div>
            </div>
            <div>
              <p className="text-[10px] font-black uppercase tracking-[.2em] text-[#7C4DDE]">Por qué PALMYRA</p>
              <h2 className="text-2xl sm:text-4xl font-black tracking-[-.04em] text-[#3B1B78] mt-2">Un nombre nacido de conexión, comercio y movimiento.</h2>
              <p className="text-sm text-slate-600 leading-7 mt-4">Elegimos PALMYRA por la historia de una ciudad que durante siglos fue un punto de encuentro en medio del desierto: una parada clave para comerciantes y caravanas que conectaban rutas y culturas.</p>
              <p className="text-sm text-slate-600 leading-7 mt-3">Para nosotros, el nombre representa exactamente lo que queremos construir: un sistema que conecte ventas, inventario, cajas, almacenes, personas y decisiones dentro de un mismo lugar.</p>
              <div className="grid sm:grid-cols-3 gap-2 mt-6">
                {[["Conexión","Rutas que se encuentran"],["Comercio","Movimiento que crea valor"],["Resiliencia","Seguir avanzando"]].map(([a,b]) => <div key={a} className="rounded-xl bg-white border border-violet-100 p-3"><p className="text-xs font-black text-[#5B2DBA]">{a}</p><p className="text-[9px] text-slate-500 mt-1">{b}</p></div>)}
              </div>
            </div>
          </div>
        </section>

        <section className="bg-[#3B1B78] text-white">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12 grid md:grid-cols-[1fr_auto] gap-7 items-center">
            <div><p className="text-[10px] font-black uppercase tracking-[.2em] text-violet-200">Cuba primero · mundo después</p><h2 className="text-2xl sm:text-4xl font-black mt-2 tracking-[-.04em]">Hoy cobramos los planes en efectivo. La arquitectura queda lista para escalar.</h2><p className="text-sm text-violet-100/75 mt-3 max-w-2xl leading-6">PALMYRA usa un modelo de facturación preparado para registrar pagos manuales en Cuba y, más adelante, conectar proveedores internacionales sin cambiar las cuentas, empresas ni el historial.</p></div>
            <div className="rounded-2xl bg-white/5 border border-white/10 p-4 min-w-[240px]"><div className="flex items-center gap-2"><CircleDollarSign className="w-5 h-5 text-violet-200"/><span className="text-xs font-black">Método actual</span></div><div className="mt-3 p-3 rounded-xl bg-white/10"><p className="text-[9px] uppercase tracking-wider text-violet-200 font-black">Cuba</p><p className="text-sm font-black mt-1">Efectivo o transferencia bancaria</p><p className="text-[8px] text-violet-200 mt-1">Activación manual después de confirmar el pago</p></div><div className="mt-2 flex items-center gap-2 text-[8px] text-violet-200"><Globe2 className="w-3.5 h-3.5"/> Proveedores internacionales preparados</div></div>
          </div>
        </section>

        <section id="como-funciona" className="bg-white">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-14">
            <div className="text-center max-w-2xl mx-auto"><p className="text-[10px] font-black uppercase tracking-[.2em] text-[#7C4DDE]">Cómo empieza</p><h2 className="text-2xl sm:text-4xl font-black text-[#3B1B78] mt-2">De cero a operativo en pocos pasos.</h2></div>
            <div className="grid md:grid-cols-3 gap-3 mt-8">
              {[
                [1, "Crea tu cuenta", "Tu cuenta pertenece a una sola empresa."],
                [2, "Configura el negocio", "Selecciona plan, crea el primer almacén y organiza el equipo."],
                [3, "Empieza a operar", "Vende, controla inventario, cierra cajas y trabaja online u offline."]
              ].map(([n,t,d]) => <div key={String(n)} className="rounded-2xl border border-violet-100 bg-[#F7F5FC] p-5"><span className="w-8 h-8 rounded-xl bg-[#5B2DBA] text-white flex items-center justify-center text-xs font-black">{n}</span><h3 className="text-sm font-black text-[#3B1B78] mt-4">{t}</h3><p className="text-[10px] text-slate-500 mt-1.5 leading-5">{d}</p></div>)}
            </div>
          </div>
        </section>

        <section className="bg-[#F7F5FC] border-t border-violet-100">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12 flex flex-col md:flex-row md:items-center justify-between gap-6">
            <div><PalmyraWordmark className="h-6 w-auto shrink-0 mb-1" /><h2 className="text-2xl sm:text-3xl font-black text-[#3B1B78] mt-2">Tu negocio merece un sistema que no estorbe.</h2><p className="text-xs text-slate-500 mt-2">Claro para trabajar. Potente para crecer.</p></div>
            <div className="flex flex-col sm:flex-row gap-2.5">
              <button onClick={() => navigate("/auth?mode=signup")} className="h-12 px-5 rounded-2xl bg-[#5B2DBA] text-white font-black text-sm flex items-center justify-center gap-2 shadow-[0_18px_40px_-20px_rgba(101,53,197,.7)]">Crear cuenta <ArrowRight className="w-4 h-4"/></button>
              <a href="#descargas" className="h-12 px-5 rounded-2xl bg-white border border-violet-200 text-[#5B2DBA] font-black text-sm flex items-center justify-center gap-2"><Download className="w-4 h-4"/> Descargar app</a>
            </div>
          </div>
        </section>
      </main>

      <footer className="bg-white border-t border-violet-100">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-7 flex flex-col md:flex-row items-center justify-between gap-3">
          <Brand />
          <PalmyraWordmark className="h-4 w-auto shrink-0 mr-1" />
          <p className="text-[9px] text-slate-500 text-center">· Business OS · Gestión empresarial simple y profesional</p>
          <p className="text-[9px] text-slate-500">© {new Date().getFullYear()} PALMYRA</p>
        </div>
      </footer>
    </div>
  );
}
