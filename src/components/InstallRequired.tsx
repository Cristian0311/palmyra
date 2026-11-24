import { useEffect, useRef, useState } from "react";
import { useStore } from "../store/useStore";
import { useDocumentScrollPage } from "../hooks/useDocumentScrollPage";
import { currentAppSurface } from "../lib/appSurface";
import {
  Monitor,
  Smartphone,
  Tablet,
  ShieldCheck,
  WifiOff,
  RefreshCw,
  Network,
  CheckCircle2,
  ArrowRight,
  Download,
  LockKeyhole,
  HelpCircle,
  CreditCard,
  UserRoundCheck,
  ClipboardList,
  MousePointerClick,
  FolderOpen,
  LogIn,
  ShieldAlert
} from "lucide-react";

// La web ya no ofrece la operación. El instalador y el APK se sirven desde el
// mismo origen; las publicaciones oficiales quedan como respaldo verificable.
const DESKTOP_DOWNLOAD_URL =
  (import.meta.env.VITE_DESKTOP_DOWNLOAD_URL as string | undefined)?.trim() || "/download/windows";
const ANDROID_DOWNLOAD_URL =
  (import.meta.env.VITE_ANDROID_DOWNLOAD_URL as string | undefined)?.trim() || "/download/android";
const OFFICIAL_RELEASES_URL = "https://github.com/Cristian0311/palmyra/releases/latest";

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9B7BE8] focus-visible:ring-offset-2 focus-visible:ring-offset-[#F7F5FC]";

const APP_SURFACE = currentAppSurface();

const DOWNLOADS = [
  {
    id: "windows",
    name: "Windows",
    subtitle: "PC y laptop",
    requirement: "Windows 10 u 11 · 64 bits",
    icon: Monitor,
    href: DESKTOP_DOWNLOAD_URL,
    cta: "Descargar instalador",
    note: "Instalador .exe con asistente. Si SmartScreen avisa por ser un programa nuevo, pulsa «Más información → Ejecutar de todas formas».",
    highlights: ["Programa completo y acceso directo", "Funciona sin internet", "Actualizaciones firmadas"]
  },
  {
    id: "android",
    name: "Android",
    subtitle: "Teléfono y tablet",
    requirement: "Android 7 o superior",
    icon: Smartphone,
    href: ANDROID_DOWNLOAD_URL,
    cta: "Descargar APK",
    note: "El APK oficial de PALMYRA. Android pedirá permitir «instalar apps desconocidas» para este archivo.",
    highlights: ["Instalación directa, sin tienda", "Caja y almacén en tu móvil", "Sincroniza con tus equipos"]
  }
] as const;

const STEPS = [
  {
    id: "windows",
    name: "Windows",
    icon: Monitor,
    intro: "Para la PC del negocio (Windows 10 u 11, 64 bits). Tarda unos 3 minutos.",
    steps: [
      {
        icon: Download,
        title: "Descarga el instalador",
        text: "Pulsa «Descargar instalador» en la tarjeta de Windows. El archivo queda en tu carpeta Descargas."
      },
      {
        icon: FolderOpen,
        title: "Abre el archivo descargado",
        text: "Haz doble clic en PALMYRA-POS-Setup.exe. Si el navegador lo muestra abajo, pulsa «Abrir»."
      },
      {
        icon: ShieldAlert,
        title: "Si Windows dice «Windows protegió tu PC»",
        text: "Pulsa «Más información» y después «Ejecutar de todas formas». Es el aviso normal para programas nuevos."
      },
      {
        icon: MousePointerClick,
        title: "Sigue el asistente",
        text: "Acepta la carpeta que propone, deja marcado el acceso directo y pulsa «Instalar». Al terminar, pulsa «Finalizar»."
      },
      {
        icon: LogIn,
        title: "Abre PALMYRA e inicia sesión",
        text: "Doble clic en el icono PALMYRA del escritorio. Entra con el mismo correo y contraseña con que creaste tu cuenta."
      }
    ]
  },
  {
    id: "android",
    name: "Android",
    icon: Smartphone,
    intro: "Para el teléfono o la tablet del negocio (Android 7 o superior).",
    steps: [
      {
        icon: Download,
        title: "Descarga el APK",
        text: "Pulsa «Descargar APK» en la tarjeta de Android. El archivo se guarda en la carpeta Descargas del teléfono."
      },
      {
        icon: FolderOpen,
        title: "Abre el archivo",
        text: "Entra a Descargas y toca PALMYRA-Android.apk. Si no aparece, ábrelo desde el gestor de archivos del teléfono."
      },
      {
        icon: ShieldAlert,
        title: "Permite instalar esta app",
        text: "Android pedirá permitir «instalar apps desconocidas» para el navegador o el gestor de archivos: activa el permiso y vuelve atrás."
      },
      {
        icon: MousePointerClick,
        title: "Toca «Instalar»",
        text: "Espera unos segundos y pulsa «Abrir» al terminar."
      },
      {
        icon: LogIn,
        title: "Entra con tu cuenta",
        text: "Inicia sesión con el mismo correo de tu registro. Verás tu empresa, inventario y caja tal como están en tu PC."
      }
    ]
  }
] as const;

const ANNOUNCEMENTS = [
  {
    icon: WifiOff,
    title: "Sigue vendiendo sin internet",
    text: "En la app instalada, caja, inventario y reportes guardan los datos en tu propio equipo y funcionan aunque la señal se caiga."
  },
  {
    icon: RefreshCw,
    title: "Actualizaciones firmadas",
    text: "Cada versión se publica con SHA-256 y se verifica antes de instalarse. Nunca instales copias de terceros."
  },
  {
    icon: Network,
    title: "Varios equipos en tu red",
    text: "Une caja, almacén y administración en la misma red local. Tu plan define cuántos almacenes y equipos puedes usar."
  }
];

export default function InstallRequired() {
  useDocumentScrollPage();
  const currentUser = useStore((state) => state.currentUser);
  const isInitialized = useStore((state) => state.isInitialized);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    titleRef.current?.focus({ preventScroll: true });
    setEntered(true);
  }, []);

  const reveal = entered
    ? "motion-safe:opacity-100 motion-safe:translate-y-0"
    : "motion-safe:opacity-0 motion-safe:translate-y-2";

  return (
    <main className="palmyra-landing-page min-h-dvh overflow-x-hidden bg-[#F7F5FC] text-[#21182F]">
      <div className="relative isolate">
        <div aria-hidden="true" className="pointer-events-none absolute -right-32 -top-40 h-[26rem] w-[26rem] rounded-full bg-[#EFE8FF] blur-3xl" />
        <div aria-hidden="true" className="pointer-events-none absolute -left-40 top-64 h-[22rem] w-[22rem] rounded-full bg-[#EFE8FF]/80 blur-3xl" />

        <div className={`relative mx-auto w-full max-w-6xl px-4 pb-16 pt-6 sm:px-6 lg:px-8 motion-safe:transition motion-safe:duration-300 ${reveal}`}>
          <header className="flex flex-wrap items-center justify-between gap-3 border-b border-violet-100 pb-4">
            <a href="/landing" className={`flex items-center gap-2.5 rounded-xl ${FOCUS_RING}`}>
              <img src="/palmyra-mark-exact.svg" alt="" aria-hidden="true" className="h-10 w-10 object-contain" />
              <span className="leading-tight">
                <span className="block text-sm font-black tracking-wide text-[#3B1B78]">PALMYRA</span>
                <span className="block text-[9px] font-bold uppercase tracking-[.2em] text-slate-500">Punto de venta</span>
              </span>
            </a>
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-violet-200 bg-white px-3 py-1.5 text-[9px] font-black uppercase tracking-[.14em] text-[#5B2DBA]">
                <LockKeyhole className="h-3 w-3" aria-hidden="true" />
                Acceso web descontinuado
              </span>
              <a href="/landing" className={`hidden h-9 items-center rounded-xl border border-violet-200 bg-white px-3 text-[10px] font-bold text-[#5B2DBA] hover:bg-[#EFE8FF] sm:inline-flex ${FOCUS_RING}`}>
                Inicio
              </a>
            </div>
          </header>

          <section className="mt-10 grid items-start gap-8 lg:mt-14 lg:grid-cols-[1.1fr_.9fr]" aria-labelledby="blocked-title">
            <div>
              <p className="text-[10px] font-black uppercase tracking-[.22em] text-[#5B2DBA]">Cambio importante</p>
              <h1
                id="blocked-title"
                ref={titleRef}
                tabIndex={-1}
                className="mt-3 text-[2rem] font-black leading-[1.05] tracking-[-.03em] text-[#3B1B78] outline-none sm:text-[2.8rem]"
              >
                PALMYRA ya no funciona desde el navegador.
                <span className="mt-2 block text-[#5B2DBA]">Descarga la app y sigue trabajando.</span>
              </h1>
              <p className="mt-5 max-w-xl text-sm leading-7 text-slate-600 sm:text-base">
                La caja, el inventario, los clientes y los reportes viven únicamente en la aplicación instalada. La web
                queda solo para <strong className="font-bold text-[#3B1B78]">crear la cuenta y descargar el programa</strong>.
              </p>

              <div className="mt-6 rounded-3xl border border-emerald-200 bg-emerald-50 p-4 sm:p-5" role="status">
                <div className="flex items-start gap-3">
                  <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-emerald-100 text-emerald-700">
                    <CheckCircle2 className="h-5 w-5" aria-hidden="true" />
                  </span>
                  <div className="min-w-0">
                    {currentUser ? (
                      <>
                        <p className="text-sm font-black text-emerald-900">Tu cuenta ya está activa{currentUser.name ? `, ${currentUser.name.split(" ")[0]}` : ""}.</p>
                        <p className="mt-1 text-xs leading-5 text-emerald-800/90">
                          Solo falta instalar PALMYRA en tu PC o Android para empezar a vender. Tu empresa, tu plan y tu
                          historial siguen guardados en la nube; no tienes que registrarte otra vez: inicia sesión dentro
                          de la app con el mismo correo.
                        </p>
                      </>
                    ) : !isInitialized ? (
                      <>
                        <p className="text-sm font-black text-emerald-900">Tu cuenta sigue guardada en la nube.</p>
                        <p className="mt-1 text-xs leading-5 text-emerald-800/90">
                          Descarga la app e inicia sesión con el mismo correo y contraseña: tu empresa, tu plan y tu
                          historial aparecen tal como los dejaste.
                        </p>
                      </>
                    ) : (
                      <>
                        <p className="text-sm font-black text-emerald-900">Tu cuenta y tu empresa se crean en la web.</p>
                        <p className="mt-1 text-xs leading-5 text-emerald-800/90">
                          Al terminar el registro, vuelve a esta pantalla y descarga la app. Inicia sesión dentro del
                          programa con el mismo correo y contraseña.
                        </p>
                      </>
                    )}
                  </div>
                </div>
              </div>

              <div className="mt-5 flex flex-wrap gap-2">
                {[
                  "Funciona sin internet",
                  "Datos en tu equipo",
                  "Actualizaciones firmadas",
                  "Caja, inventario y reportes"
                ].map((item) => (
                  <span key={item} className="inline-flex items-center gap-1.5 rounded-full border border-violet-100 bg-white px-3 py-1.5 text-[10px] font-bold text-[#5B2DBA]">
                    <ShieldCheck className="h-3 w-3 text-emerald-600" aria-hidden="true" />
                    {item}
                  </span>
                ))}
              </div>
            </div>

            <aside className="rounded-3xl border border-violet-100 bg-white p-5 shadow-[0_18px_50px_-30px_rgba(59,27,110,.35)] sm:p-6" aria-labelledby="start-title">
              <h2 id="start-title" className="flex items-center gap-2 text-[10px] font-black uppercase tracking-[.18em] text-[#5B2DBA]">
                <ClipboardList className="h-4 w-4" aria-hidden="true" />
                Empieza en 3 pasos
              </h2>
              <ol className="mt-4 space-y-4">
                {[
                  { icon: Download, title: "Descarga la app", text: "Elige Windows o Android en esta página." },
                  { icon: UserRoundCheck, title: "Instálala", text: "Abre el instalador o el APK y sigue las indicaciones." },
                  { icon: CreditCard, title: "Entra con tu cuenta", text: "Inicia sesión dentro de la app con el mismo correo." }
                ].map(({ icon: Icon, title, text }, index) => (
                  <li key={title} className="flex gap-3">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-[#EFE8FF] text-[#5B2DBA]">
                      <Icon className="h-4 w-4" aria-hidden="true" />
                    </span>
                    <div className="min-w-0">
                      <p className="text-xs font-black text-[#3B1B78]">
                        <span className="mr-1.5 text-[#5B2DBA]">{index + 1}.</span>
                        {title}
                      </p>
                      <p className="mt-0.5 text-[11px] leading-5 text-slate-500">{text}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </aside>
          </section>

          <section className="mt-8 rounded-2xl border border-violet-100 bg-[#EFE8FF]/60 px-4 py-3" aria-labelledby="changes-title">
            <h2 id="changes-title" className="text-[9px] font-black uppercase tracking-[.18em] text-[#5B2DBA]">Qué cambia</h2>
            <ul className="mt-2 grid gap-x-6 gap-y-1.5 text-[11px] leading-5 text-slate-600 sm:grid-cols-2">
              <li className="flex gap-2"><span aria-hidden="true" className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[#9B7BE8]" />La web deja de abrir la caja, el inventario y los reportes.</li>
              <li className="flex gap-2"><span aria-hidden="true" className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[#9B7BE8]" />Tu cuenta, tu plan y tus datos no se borran.</li>
              <li className="flex gap-2"><span aria-hidden="true" className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[#9B7BE8]" />Solo se admiten Windows, Android y (próximamente) Apple.</li>
              <li className="flex gap-2"><span aria-hidden="true" className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[#9B7BE8]" />La instalación desde el navegador (PWA) deja de ofrecerse.</li>
            </ul>
          </section>

          <section className="mt-12" aria-labelledby="platforms-title">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 id="platforms-title" className="text-xl font-black tracking-[-.02em] text-[#3B1B78] sm:text-2xl">Descarga PALMYRA</h2>
                <p className="mt-1 text-xs text-slate-500">Misma cuenta y mismos datos en todos tus dispositivos.</p>
              </div>
              <a href={OFFICIAL_RELEASES_URL} target="_blank" rel="noopener noreferrer" className={`rounded-lg text-[10px] font-bold text-[#5B2DBA] underline decoration-violet-300 underline-offset-4 hover:text-[#3B1B78] ${FOCUS_RING}`}>
                Publicaciones oficiales
              </a>
            </div>

            <div className="mt-5 grid items-stretch gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {DOWNLOADS.map((platform) => (
                <a
                  key={platform.id}
                  href={platform.href}
                  className={`group relative flex h-full flex-col overflow-hidden rounded-3xl border border-violet-100 bg-white p-5 shadow-[0_18px_50px_-38px_rgba(59,27,110,.4)] transition-colors hover:border-violet-300 sm:p-6 ${FOCUS_RING}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[#5B2DBA] text-white">
                      <platform.icon className="h-6 w-6" aria-hidden="true" />
                    </span>
                    <span className="rounded-full border border-violet-100 bg-[#F7F5FC] px-2.5 py-1 text-[8px] font-black uppercase tracking-wider text-[#5B2DBA]">
                      {platform.subtitle}
                    </span>
                  </div>
                  <h3 className="mt-4 text-xl font-black text-[#3B1B78]">{platform.name}</h3>
                  <p className="mt-0.5 text-[11px] font-semibold text-slate-500">{platform.requirement}</p>
                  <ul className="mt-4 space-y-1.5">
                    {platform.highlights.map((item) => (
                      <li key={item} className="flex items-center gap-2 text-[11px] text-slate-600">
                        <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600" aria-hidden="true" />
                        {item}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-4 text-[10px] leading-5 text-slate-500">{platform.note}</p>
                  <div className="mt-auto pt-5">
                    <span className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-[#5B2DBA] px-4 text-[11px] font-black uppercase tracking-wider text-white transition-colors group-hover:bg-[#4B239B]">
                      <Download className="h-4 w-4" aria-hidden="true" />
                      {platform.cta}
                      <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
                    </span>
                  </div>
                </a>
              ))}

              <div className="flex h-full flex-col rounded-3xl border border-dashed border-violet-200 bg-[#F7F5FC] p-5 sm:p-6 md:col-span-2 lg:col-span-1" aria-label="PALMYRA para iPhone y iPad: próximamente">
                <div className="flex items-start justify-between gap-3">
                  <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[#EFE8FF] text-[#5B2DBA]">
                    <Tablet className="h-6 w-6" aria-hidden="true" />
                  </span>
                  <span className="rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-[8px] font-black uppercase tracking-wider text-amber-700">
                    Próximamente
                  </span>
                </div>
                <h3 className="mt-4 text-xl font-black text-[#3B1B78]">iPhone / iPad</h3>
                <p className="mt-0.5 text-[11px] font-semibold text-slate-500">App para Apple · en preparación</p>
                <ul className="mt-4 space-y-1.5">
                  {["Misma cuenta, empresa y datos", "Sincronizará con tu PC y Android", "Aviso publicado en esta página"].map((item) => (
                    <li key={item} className="flex items-center gap-2 text-[11px] text-slate-500">
                      <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />
                      {item}
                    </li>
                  ))}
                </ul>
                <p className="mt-4 text-[10px] leading-5 text-slate-500">
                  Estamos preparando la versión para Apple. Mientras tanto, trabaja desde Windows o Android: todo se
                  sincroniza igual.
                </p>
                <div className="mt-auto pt-5">
                  <span aria-disabled="true" className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-violet-200 bg-white px-4 text-[11px] font-black uppercase tracking-wider text-[#5B2DBA]/70">
                    Disponible próximamente
                  </span>
                </div>
              </div>
            </div>
          </section>

          <section className="mt-12" aria-labelledby="steps-title">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 id="steps-title" className="text-xl font-black tracking-[-.02em] text-[#3B1B78] sm:text-2xl">Instalación paso por paso</h2>
                <p className="mt-1 text-xs text-slate-500">Cinco pasos, sin conocimientos técnicos. Entre 3 y 5 minutos.</p>
              </div>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-violet-200 bg-white px-3 py-1.5 text-[9px] font-black uppercase tracking-[.14em] text-[#5B2DBA]">
                <CheckCircle2 className="h-3 w-3 text-emerald-600" aria-hidden="true" />
                Guía oficial
              </span>
            </div>

            <div className="mt-5 grid items-start gap-4 md:grid-cols-2">
              {STEPS.map((platform) => (
                <article
                  key={platform.id}
                  className="rounded-3xl border border-violet-100 bg-white p-5 shadow-[0_18px_50px_-38px_rgba(59,27,110,.4)] sm:p-6"
                  aria-labelledby={`steps-${platform.id}`}
                >
                  <div className="flex items-start gap-3">
                    <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-[#5B2DBA] text-white">
                      <platform.icon className="h-5 w-5" aria-hidden="true" />
                    </span>
                    <div className="min-w-0">
                      <h3 id={`steps-${platform.id}`} className="text-base font-black text-[#3B1B78]">Cómo instalar en {platform.name}</h3>
                      <p className="mt-0.5 text-[11px] leading-5 text-slate-500">{platform.intro}</p>
                    </div>
                  </div>
                  <ol className="mt-5 space-y-4">
                    {platform.steps.map((step, index) => (
                      <li key={step.title} className="flex gap-3">
                        <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#EFE8FF] text-[#5B2DBA]">
                          <step.icon className="h-4 w-4" aria-hidden="true" />
                          <span aria-hidden="true" className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-white text-[9px] font-black text-[#5B2DBA] ring-1 ring-violet-200">
                            {index + 1}
                          </span>
                        </span>
                        <div className="min-w-0">
                          <p className="text-xs font-black text-[#3B1B78]">{step.title}</p>
                          <p className="mt-0.5 text-[11px] leading-5 text-slate-500">{step.text}</p>
                        </div>
                      </li>
                    ))}
                  </ol>
                </article>
              ))}
            </div>

            <div className="mt-4 flex items-start gap-3 rounded-2xl border border-violet-100 bg-[#EFE8FF]/60 px-4 py-3">
              <Network className="mt-0.5 h-4 w-4 shrink-0 text-[#5B2DBA]" aria-hidden="true" />
              <p className="text-[11px] leading-5 text-slate-600">
                <strong className="font-bold text-[#3B1B78]">¿Varios equipos?</strong> Instala PALMYRA en cada PC o Android
                con la misma cuenta y únelos al Wi-Fi del negocio. Una PC queda como principal y las demás se conectan a
                ella; los datos se sincronizan solos.
              </p>
            </div>

            <p className="mt-3 text-[10px] leading-5 text-slate-500">
              ¿Poco espacio o señal? El instalador de Windows pesa aproximadamente 84 MB y el APK unos 2 MB.
            </p>
          </section>

          <section className="mt-12" aria-labelledby="news-title">
            <h2 id="news-title" className="text-xl font-black tracking-[-.02em] text-[#3B1B78] sm:text-2xl">Lo que ganas con la app instalada</h2>
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              {ANNOUNCEMENTS.map((item) => (
                <article key={item.title} className="rounded-3xl border border-violet-100 bg-white p-4 sm:p-5">
                  <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#EFE8FF] text-[#5B2DBA]">
                    <item.icon className="h-4 w-4" aria-hidden="true" />
                  </span>
                  <h3 className="mt-3 text-sm font-black text-[#3B1B78]">{item.title}</h3>
                  <p className="mt-1.5 text-[11px] leading-5 text-slate-500">{item.text}</p>
                </article>
              ))}
            </div>
          </section>

          <section className="mt-12" aria-labelledby="faq-title">
            <h2 id="faq-title" className="flex items-center gap-2 text-xl font-black tracking-[-.02em] text-[#3B1B78] sm:text-2xl">
              <HelpCircle className="h-5 w-5 text-[#5B2DBA]" aria-hidden="true" />
              Preguntas frecuentes
            </h2>
            <div className="mt-4 space-y-2">
              {[
                {
                  q: "¿Puedo seguir usando la web?",
                  a: "No. La web solo permite crear la cuenta y descargar el programa. La caja y el inventario se abren únicamente en la app instalada."
                },
                {
                  q: "¿Pierdo mi cuenta, mi empresa o mis datos?",
                  a: "No. Todo sigue en la nube. Al instalar la app e iniciar sesión con el mismo correo, recuperas tu empresa, tu plan y tu historial."
                },
                {
                  q: "¿Necesito internet para vender con la app?",
                  a: "No. La app guarda los datos en tu equipo y funciona sin conexión. Cuando vuelve internet, sincroniza lo pendiente."
                },
                {
                  q: "¿Puedo usar varios equipos?",
                  a: "Sí. Puedes unir varias cajas o almacenes en la misma red local. El plan activo define cuántos equipos y almacenes admite."
                },
                {
                  q: "¿Habrá app para iPhone y iPad?",
                  a: "Está en preparación. Publicaremos el aviso en esta misma página; mientras tanto puedes usar Windows o Android con la misma cuenta."
                },
                {
                  q: "¿Por dónde descargo de forma segura?",
                  a: "Siempre desde esta pantalla o desde las publicaciones oficiales. Cada archivo incluye su SHA-256; no instales copias de terceros."
                }
              ].map((item) => (
                <details key={item.q} className="group rounded-2xl border border-violet-100 bg-white">
                  <summary className={`flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-4 py-2.5 text-xs font-bold text-[#3B1B78] marker:hidden [&::-webkit-details-marker]:hidden ${FOCUS_RING}`}>
                    {item.q}
                    <span aria-hidden="true" className="text-[#5B2DBA] transition-transform group-open:rotate-180">▾</span>
                  </summary>
                  <p className="px-4 pb-4 text-[11px] leading-5 text-slate-500">{item.a}</p>
                </details>
              ))}
            </div>
          </section>

          <footer className="mt-12 flex flex-col gap-4 border-t border-violet-100 pt-6 sm:flex-row sm:items-center sm:justify-between">
            <p className="max-w-xl text-[10px] leading-5 text-slate-500">
              Descargas oficiales:{" "}
              <a href={OFFICIAL_RELEASES_URL} target="_blank" rel="noopener noreferrer" className={`rounded font-bold text-[#5B2DBA] underline decoration-violet-300 underline-offset-4 hover:text-[#3B1B78] ${FOCUS_RING}`}>
                github.com/Cristian0311/palmyra/releases
              </a>
              . Si ya instalaste PALMYRA, ábrela desde el escritorio o el menú de aplicaciones; no vuelvas a crear la cuenta.
            </p>
            <a href="/landing" className={`inline-flex h-10 items-center rounded-xl border border-violet-200 bg-white px-3 text-[10px] font-black uppercase tracking-wider text-[#5B2DBA] hover:bg-[#EFE8FF] ${FOCUS_RING}`}>
              Volver al inicio
            </a>
          </footer>
        </div>
      </div>
    </main>
  );
}
