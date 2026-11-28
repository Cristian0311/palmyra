import { useEffect, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  ArrowUpRight,
  BadgeCheck,
  BarChart3,
  BookOpen,
  Building2,
  CalendarClock,
  Coins,
  Droplets,
  Factory,
  FileText,
  FlaskConical,
  Globe2,
  GraduationCap,
  HardHat,
  HeartPulse,
  Landmark,
  Link2,
  ListChecks,
  Palette,
  Plane,
  Scale,
  ScrollText,
  Ship,
  Sparkles,
  Sprout,
  Store,
  TrendingUp,
  Truck,
  Users,
  Wifi,
  Zap,
} from "lucide-react";
import {
  DEFAULT_WHATSAPP_CHANNEL_URL,
  FacebookMark,
  WhatsAppMark,
} from "../components/SocialLinks";
import { DEFAULT_FACEBOOK_URL, loadPublicSocialLinks } from "../services/platformSupport";

type Contenido = {
  icon: LucideIcon;
  titulo: string;
  detalle: string;
};

type Entidad = {
  sigla: string;
  nombre: string;
  detalle: string;
  icon: LucideIcon;
  tono: string;
};

const CONTENIDOS: Contenido[] = [
  {
    icon: ScrollText,
    titulo: "Leyes y resoluciones",
    detalle: "Gacetas, decretos y resoluciones explicadas en lenguaje claro para tu negocio.",
  },
  {
    icon: FileText,
    titulo: "Plantillas editables",
    detalle: "Modelos de declaraciones, contratos, solicitudes y cartas listas para completar.",
  },
  {
    icon: ListChecks,
    titulo: "Guías paso a paso",
    detalle: "Requisitos, orden de trámites y documentos que debes presentar en cada entidad.",
  },
  {
    icon: CalendarClock,
    titulo: "Calendario de obligaciones",
    detalle: "Fechas límite de declaración, liquidación y pago para no quedarte atrás.",
  },
  {
    icon: BadgeCheck,
    titulo: "Requisitos oficiales",
    detalle: "Qué exige cada organismo antes de aprobar un permiso, licencia o registro.",
  },
  {
    icon: Link2,
    titulo: "Enlaces y contactos",
    detalle: "Portales oficiales, direcciones y canales de atención de cada institución.",
  },
];

const TONOS = [
  "bg-violet-50 text-[#5B2DBA] ring-violet-200 dark:bg-violet-950/40 dark:text-violet-200 dark:ring-violet-900/60",
  "bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-950/40 dark:text-sky-200 dark:ring-sky-900/60",
  "bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-200 dark:ring-emerald-900/60",
  "bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-900/60",
  "bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-950/40 dark:text-rose-200 dark:ring-rose-900/60",
];

const ENTIDADES: Entidad[] = [
  {
    sigla: "ONAT",
    nombre: "Oficina Nacional de Administración Tributaria",
    detalle: "Declaraciones, liquidaciones, modelos de formularios y régimen tributario.",
    icon: Landmark,
    tono: TONOS[0],
  },
  {
    sigla: "MFP",
    nombre: "Ministerio de Finanzas y Precios",
    detalle: "Normas contables, formación de precios y resoluciones financieras.",
    icon: Coins,
    tono: TONOS[3],
  },
  {
    sigla: "MTSS",
    nombre: "Ministerio de Trabajo y Seguridad Social",
    detalle: "Nómina, contribuciones, contratos de trabajo y seguridad social.",
    icon: Users,
    tono: TONOS[2],
  },
  {
    sigla: "GO",
    nombre: "Gaceta Oficial de la República de Cuba",
    detalle: "Leyes, decretos-leyes, resoluciones y normas publicadas oficialmente.",
    icon: ScrollText,
    tono: TONOS[4],
  },
  {
    sigla: "MEP",
    nombre: "Ministerio de Economía y Planificación",
    detalle: "Planificación, indicadores económicos y regulaciones del sector.",
    icon: TrendingUp,
    tono: TONOS[1],
  },
  {
    sigla: "MINCIN",
    nombre: "Ministerio de Comercio Interior",
    detalle: "Comercio minorista, precios, inventarios y regulaciones de venta.",
    icon: Store,
    tono: TONOS[2],
  },
  {
    sigla: "MINCEX",
    nombre: "Ministerio de Comercio Exterior y la Inversión Extranjera",
    detalle: "Exportación, importación, inversión extranjera y comercio exterior.",
    icon: Globe2,
    tono: TONOS[1],
  },
  {
    sigla: "BCC",
    nombre: "Banco Central de Cuba",
    detalle: "Tasas de cambio, normativa bancaria y operaciones financieras.",
    icon: Landmark,
    tono: TONOS[3],
  },
  {
    sigla: "MINJUS",
    nombre: "Ministerio de Justicia",
    detalle: "Constitución de empresas, notarías, registro mercantil y poderes.",
    icon: Scale,
    tono: TONOS[4],
  },
  {
    sigla: "MINSAP",
    nombre: "Ministerio de Salud Pública",
    detalle: "Regulaciones sanitarias, permisos y productos de salud.",
    icon: HeartPulse,
    tono: TONOS[0],
  },
  {
    sigla: "CITMA",
    nombre: "Ministerio de Ciencia, Tecnología y Medio Ambiente",
    detalle: "Permisos ambientales, licencias y regulaciones científicas.",
    icon: FlaskConical,
    tono: TONOS[2],
  },
  {
    sigla: "AGR",
    nombre: "Aduana General de la República",
    detalle: "Trámites aduaneros, importación, exportación y aranceles.",
    icon: Ship,
    tono: TONOS[1],
  },
  {
    sigla: "ONEI",
    nombre: "Oficina Nacional de Estadísticas e Información",
    detalle: "Censos, indicadores y datos oficiales de la economía cubana.",
    icon: BarChart3,
    tono: TONOS[3],
  },
  {
    sigla: "OCPI",
    nombre: "Oficina Cubana de la Propiedad Industrial",
    detalle: "Registro de marcas, patentes y modelos industriales.",
    icon: BadgeCheck,
    tono: TONOS[4],
  },
  {
    sigla: "CCC",
    nombre: "Cámara de Comercio de la República de Cuba",
    detalle: "Afiliación, ferias, misiones comerciales y contactos empresariales.",
    icon: Building2,
    tono: TONOS[0],
  },
  {
    sigla: "MITRANS",
    nombre: "Ministerio de Transporte",
    detalle: "Licencias de transporte, carga y regulaciones de movilidad.",
    icon: Truck,
    tono: TONOS[1],
  },
  {
    sigla: "MINEM",
    nombre: "Ministerio de Energía y Minas",
    detalle: "Combustibles, electricidad y permisos del sector energético.",
    icon: Zap,
    tono: TONOS[3],
  },
  {
    sigla: "MINCOM",
    nombre: "Ministerio de Comunicaciones",
    detalle: "Telecomunicaciones, internet y licencias de radiodifusión.",
    icon: Wifi,
    tono: TONOS[1],
  },
  {
    sigla: "MINAG",
    nombre: "Ministerio de Agricultura",
    detalle: "Producción agrícola, semillas, tierras y regulaciones del agro.",
    icon: Sprout,
    tono: TONOS[2],
  },
  {
    sigla: "MINDUS",
    nombre: "Ministerio de Industrias",
    detalle: "Producción industrial, normas técnicas y regulaciones sectoriales.",
    icon: Factory,
    tono: TONOS[4],
  },
  {
    sigla: "MINTUR",
    nombre: "Ministerio de Turismo",
    detalle: "Licencias turísticas, hospedaje y regulaciones del sector.",
    icon: Plane,
    tono: TONOS[0],
  },
  {
    sigla: "MINCULT",
    nombre: "Ministerio de Cultura",
    detalle: "Registros culturales, derechos de autor y propiedad intelectual.",
    icon: Palette,
    tono: TONOS[4],
  },
  {
    sigla: "MICONS",
    nombre: "Ministerio de la Construcción",
    detalle: "Permisos de obra, materiales y normativa de la construcción.",
    icon: HardHat,
    tono: TONOS[3],
  },
  {
    sigla: "INRH",
    nombre: "Instituto Nacional de Recursos Hidráulicos",
    detalle: "Permisos de agua, vertimientos y regulaciones hidráulicas.",
    icon: Droplets,
    tono: TONOS[1],
  },
  {
    sigla: "MINED",
    nombre: "Ministerio de Educación",
    detalle: "Educación, capacitación y certificaciones del personal.",
    icon: GraduationCap,
    tono: TONOS[2],
  },
  {
    sigla: "MES",
    nombre: "Ministerio de Educación Superior",
    detalle: "Educación superior, convenios y programas de formación.",
    icon: BookOpen,
    tono: TONOS[0],
  },
];

export default function CnglTem() {
  const [facebookUrl, setFacebookUrl] = useState(DEFAULT_FACEBOOK_URL);
  const [whatsappUrl, setWhatsappUrl] = useState(DEFAULT_WHATSAPP_CHANNEL_URL);

  useEffect(() => {
    let alive = true;
    loadPublicSocialLinks()
      .then((links) => {
        if (!alive) return;
        setFacebookUrl(links.facebook_url || DEFAULT_FACEBOOK_URL);
        setWhatsappUrl(links.whatsapp_channel_url || DEFAULT_WHATSAPP_CHANNEL_URL);
      })
      .catch(() => {
        /* Los enlaces oficiales por defecto siguen disponibles. */
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="mx-auto w-full max-w-[1280px] min-w-0 space-y-7 px-3 pb-14 pt-1 text-primary sm:px-5">
      <header className="relative overflow-hidden rounded-3xl border border-violet-200/70 bg-[radial-gradient(circle_at_15%_0%,rgba(142,104,231,.22),transparent_45%),linear-gradient(135deg,#F8F4FF,#EFE7FF_55%,#FDFBFF)] px-5 py-6 shadow-[0_18px_50px_rgba(51,30,80,.08)] dark:border-violet-900/50 dark:bg-[radial-gradient(circle_at_15%_0%,rgba(142,104,231,.24),transparent_45%),linear-gradient(135deg,#241833,#1B1226_55%,#221A2E)] sm:px-8 sm:py-8">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-16 -top-20 h-56 w-56 rounded-full bg-violet-300/30 blur-3xl dark:bg-violet-700/25"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-24 right-24 h-48 w-48 rounded-full bg-fuchsia-200/40 blur-3xl dark:bg-fuchsia-900/20"
        />

        <div className="relative flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-violet-300/70 bg-white/80 px-2.5 py-1 text-[9px] font-black uppercase tracking-[0.16em] text-[#5B2DBA] dark:border-violet-800 dark:bg-violet-950/50 dark:text-violet-200">
                <Sparkles className="h-3 w-3" aria-hidden="true" />
                Próximamente
              </span>
              <span className="inline-flex items-center rounded-full bg-[#5B2DBA] px-2.5 py-1 text-[9px] font-black uppercase tracking-[0.16em] text-white">
                CNGL-TEM
              </span>
            </div>

            <h1 className="mt-3 max-w-[24ch] text-[clamp(24px,4.4vw,40px)] font-black leading-[1.06] tracking-[-0.03em] text-[#3B1B78] dark:text-violet-50">
              Centro Nacional de Gestión Legal Tributaria y Empresarial de Cuba
            </h1>
            <p className="mt-3 max-w-[70ch] text-[13px] font-medium leading-6 text-slate-600 dark:text-violet-100/75">
              Estamos construyendo la sección que reunirá en un solo lugar la información, las
              plantillas y los trámites que necesita todo negocio cubano. Se agregará a PALMYRA en
              una futura actualización y estará organizada por organismos, con sus siglas y
              requisitos oficiales.
            </p>

            <div className="mt-5 flex flex-wrap gap-2">
              {["Información oficial", "Plantillas", "Resoluciones", "Guías", "Calendario"].map((item) => (
                <span
                  key={item}
                  className="inline-flex items-center rounded-lg border border-violet-200/80 bg-white/70 px-2.5 py-1 text-[10px] font-black uppercase tracking-wide text-[#5B2DBA] dark:border-violet-900/50 dark:bg-white/5 dark:text-violet-200"
                >
                  {item}
                </span>
              ))}
            </div>
          </div>

          <div className="relative shrink-0 self-start lg:self-center">
            <div className="flex h-32 w-32 flex-col items-center justify-center gap-1 rounded-[28px] border border-white/70 bg-white/85 shadow-[0_16px_40px_rgba(91,45,186,.18)] backdrop-blur dark:border-violet-800/60 dark:bg-violet-950/50 sm:h-40 sm:w-40">
              <ScrollText className="h-10 w-10 text-[#5B2DBA] dark:text-violet-300" aria-hidden="true" />
              <span className="text-[9px] font-black uppercase tracking-[0.18em] text-slate-500 dark:text-violet-200/70">
                En preparación
              </span>
              <span className="text-[11px] font-black text-[#3B1B78] dark:text-violet-100">CNGL-TEM</span>
            </div>
          </div>
        </div>
      </header>

      <section aria-labelledby="cngl-contenidos" className="space-y-3">
        <div className="flex items-end justify-between gap-3">
          <div>
            <p className="text-[9px] font-black uppercase tracking-[0.2em] text-[#6535C5] dark:text-violet-300">
              Todo en un solo lugar
            </p>
            <h2 id="cngl-contenidos" className="mt-1 text-lg font-black tracking-tight sm:text-xl">
              Qué traerá esta sección
            </h2>
          </div>
        </div>

        <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
          {CONTENIDOS.map(({ icon: Icon, titulo, detalle }, index) => (
            <article
              key={titulo}
              className="group rounded-2xl border border-base bg-secondary p-3.5 shadow-sm transition-colors hover:border-violet-300/80 dark:hover:border-violet-800"
            >
              <div className="flex items-start gap-3">
                <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ring-1 ${TONOS[index % TONOS.length]}`}>
                  <Icon className="h-4 w-4" aria-hidden="true" />
                </span>
                <div className="min-w-0">
                  <h3 className="text-[12px] font-black leading-tight text-primary">{titulo}</h3>
                  <p className="mt-1 text-[11px] font-medium leading-5 text-muted">{detalle}</p>
                </div>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section aria-labelledby="cngl-entidades" className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-[9px] font-black uppercase tracking-[0.2em] text-[#6535C5] dark:text-violet-300">
              Organismos y entidades
            </p>
            <h2 id="cngl-entidades" className="mt-1 text-lg font-black tracking-tight sm:text-xl">
              Portales y trámites que podrás consultar
            </h2>
          </div>
          <span className="inline-flex items-center rounded-full border border-violet-200 bg-violet-50 px-2.5 py-1 text-[9px] font-black uppercase tracking-wide text-[#5B2DBA] dark:border-violet-900/60 dark:bg-violet-950/40 dark:text-violet-200">
            {ENTIDADES.length} entidades
          </span>
        </div>

        <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
          {ENTIDADES.map(({ sigla, nombre, detalle, icon: Icon, tono }) => (
            <article
              key={sigla}
              className="rounded-2xl border border-base bg-secondary p-3.5 shadow-sm transition-colors hover:border-violet-300/80 dark:hover:border-violet-800"
            >
              <div className="flex items-center gap-2.5">
                <span className={`inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-[10px] font-black uppercase tracking-wide ring-1 ${tono}`}>
                  <Icon className="h-3 w-3" aria-hidden="true" />
                  {sigla}
                </span>
                <h3 className="min-w-0 text-[11px] font-black leading-tight text-primary">{nombre}</h3>
              </div>
              <p className="mt-2 text-[11px] font-medium leading-5 text-muted">{detalle}</p>
            </article>
          ))}
        </div>

        <p className="rounded-xl border border-dashed border-base bg-subtle/60 px-3 py-2 text-[10.5px] font-medium leading-5 text-muted">
          La lista seguirá creciendo con otras entidades y organismos que publican información,
          plantillas y requisitos útiles para la gestión de tu empresa.
        </p>
      </section>

      <section
        aria-labelledby="cngl-sigue"
        className="rounded-3xl border border-violet-200/80 bg-[linear-gradient(120deg,#F6F0FF,#FFFFFF_60%)] p-4 shadow-sm dark:border-violet-900/50 dark:bg-[linear-gradient(120deg,#251A33,#1C1426_60%)] sm:p-6"
      >
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <p className="text-[9px] font-black uppercase tracking-[0.2em] text-[#6535C5] dark:text-violet-300">
              Mientras llega
            </p>
            <h2 id="cngl-sigue" className="mt-1 text-base font-black tracking-tight sm:text-lg">
              Síguenos y entérate cuando abramos CNGL-TEM
            </h2>
            <p className="mt-1.5 max-w-[60ch] text-[11.5px] font-medium leading-5 text-muted">
              Publicaremos avances, adelantos de plantillas y el anuncio de lanzamiento en nuestros
              canales oficiales.
            </p>
          </div>

          <div className="grid gap-2 sm:grid-cols-2 lg:w-[430px] lg:shrink-0">
            <a
              href={facebookUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="group flex items-center gap-2.5 rounded-2xl bg-[#1877F2] px-3.5 py-3 text-white shadow-sm transition-transform active:scale-[.985]"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/20">
                <FacebookMark className="h-5 w-5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[8.5px] font-black uppercase tracking-[0.14em] text-white/80">
                  Únete a nuestra página
                </span>
                <span className="block text-[12px] font-black leading-tight">Facebook oficial</span>
              </span>
              <ArrowUpRight className="h-4 w-4 shrink-0 opacity-80 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" aria-hidden="true" />
            </a>

            <a
              href={whatsappUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="group flex items-center gap-2.5 rounded-2xl bg-[#128C4A] px-3.5 py-3 text-white shadow-sm transition-transform active:scale-[.985]"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/20">
                <WhatsAppMark className="h-5 w-5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[8.5px] font-black uppercase tracking-[0.14em] text-white/80">
                  Únete a nuestro canal
                </span>
                <span className="block text-[12px] font-black leading-tight">Canal de WhatsApp</span>
              </span>
              <ArrowUpRight className="h-4 w-4 shrink-0 opacity-80 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" aria-hidden="true" />
            </a>
          </div>
        </div>
      </section>

      <p className="text-center text-[10px] font-bold uppercase tracking-[0.14em] text-muted">
        Esta sección se agregará en una futura actualización de PALMYRA
      </p>
    </div>
  );
}