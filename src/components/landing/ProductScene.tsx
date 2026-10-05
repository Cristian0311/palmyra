import { motion } from "motion/react";
import {
  BarChart3, Boxes, ClipboardCheck, CreditCard, Landmark, LineChart, Receipt,
  Settings2, ShoppingCart, UserRound, Users, WalletCards, WifiOff,
} from "lucide-react";

export type LandingModule = {
  id: string;
  label: string;
  title: string;
  description: string;
  icon: typeof BarChart3;
  eyebrow: string;
  screenSrc?: string;
  screenLabel?: string;
};

const icons = {
  dashboard: BarChart3, pos: ShoppingCart, inventory: Boxes, purchases: Receipt,
  suppliers: Users, audit: ClipboardCheck, bank: Landmark, transfers: ShoppingCart,
  customers: Users, reports: LineChart, team: UserRound, cash: WalletCards,
  settings: Settings2, plan: CreditCard,
} as const;

const screen = {
  dashboard: "/landing/crm/dashboard.jpg",
  cash: "/landing/crm/cash.jpg",
  customers: "/landing/crm/customers.jpg",
  inventory: "/landing/crm/inventory.jpg",
  audit: "/landing/crm/audit.jpg",
  suppliers: "/landing/crm/suppliers.jpg",
  bank: "/landing/crm/bank.jpg",
  reports: "/landing/crm/reports.jpg",
  settings: "/landing/crm/settings.jpg",
  team: "/landing/crm/team.jpg",
  plan: "/landing/crm/plan.jpg",
} as const;

export const landingModules: LandingModule[] = [
  { id: "dashboard", label: "Dashboard", title: "Una vista clara de tu negocio.", description: "Ventas, inventario, caja y actividad reunidos en una sola lectura.", icon: icons.dashboard, eyebrow: "Resumen ejecutivo", screenSrc: screen.dashboard, screenLabel: "Captura real · Dashboard" },
  { id: "pos", label: "Punto de Venta", title: "Cobra rápido. Sigue operando.", description: "Un punto de venta pensado para jornadas reales y conexión intermitente.", icon: icons.pos, eyebrow: "Venta diaria", screenSrc: screen.dashboard, screenLabel: "Vista del ecosistema · POS" },
  { id: "inventory", label: "Inventario", title: "Existencias que se entienden.", description: "Productos, movimientos y almacenes organizados alrededor de una misma fuente.", icon: icons.inventory, eyebrow: "Control de stock", screenSrc: screen.inventory, screenLabel: "Captura real · Inventario" },
  { id: "cash", label: "Caja", title: "Cada turno deja huella.", description: "Aperturas, movimientos, cierres y descuadres dentro del mismo contexto operativo.", icon: icons.cash, eyebrow: "Control de caja", screenSrc: screen.cash, screenLabel: "Captura real · Caja" },
  { id: "customers", label: "Clientes", title: "Cada relación tiene memoria.", description: "Historial y datos útiles sin convertir el CRM en un laberinto.", icon: icons.customers, eyebrow: "Relación con clientes", screenSrc: screen.customers, screenLabel: "Captura real · Clientes" },
  { id: "suppliers", label: "Proveedores", title: "La relación comercial, en contexto.", description: "Contactos e historial accesibles cuando realmente hacen falta.", icon: icons.suppliers, eyebrow: "Relación comercial", screenSrc: screen.suppliers, screenLabel: "Captura real · Proveedores" },
  { id: "audit", label: "Auditoría", title: "Ajusta con control.", description: "Conteos, variaciones y aprobación antes de tocar existencias.", icon: icons.audit, eyebrow: "Trazabilidad", screenSrc: screen.audit, screenLabel: "Captura real · Auditoría" },
  { id: "bank", label: "Cuentas bancarias", title: "Finanzas con una sola lectura.", description: "Cuentas y movimientos preparados para crecer con el negocio.", icon: icons.bank, eyebrow: "Control financiero", screenSrc: screen.bank, screenLabel: "Captura real · Bancos" },
  { id: "reports", label: "Reportes", title: "Información para decidir.", description: "Indicadores comerciales y operativos listos para interpretar.", icon: icons.reports, eyebrow: "Inteligencia del negocio", screenSrc: screen.reports, screenLabel: "Captura real · Reportes" },
  { id: "settings", label: "Configuración", title: "Todo listo para trabajar.", description: "Empresa, almacenes, POS, seguridad y preferencias en un mismo lugar.", icon: icons.settings, eyebrow: "Configuración", screenSrc: screen.settings, screenLabel: "Captura real · Configuración" },
  { id: "team", label: "Equipo", title: "Roles que se entienden.", description: "Cada persona trabaja con el acceso que realmente necesita.", icon: icons.team, eyebrow: "Personas y permisos", screenSrc: screen.team, screenLabel: "Captura real · Equipo" },
  { id: "plan", label: "Plan", title: "Crece sin cambiar de sistema.", description: "Tu plan evoluciona contigo y mantiene el mismo espacio de trabajo.", icon: icons.plan, eyebrow: "Cuenta y crecimiento", screenSrc: screen.plan, screenLabel: "Captura real · Plan" },
];

export function ProductScene({ module, compact = false }: { module: LandingModule; compact?: boolean }) {
  const Icon = module.icon;
  return (
    <motion.div className={"landing-scene" + (compact ? " landing-scene--compact" : "")}
      initial={{ opacity: 0, y: 24, rotateX: 7 }} animate={{ opacity: 1, y: 0, rotateX: 0 }}
      transition={{ type: "spring", stiffness: 90, damping: 20 }}>
      <div className="landing-scene__halo" />
      <div className="landing-scene__device landing-scene__device--back" />
      <div className="landing-scene__window">
        <div className="landing-scene__chrome"><span /><span /><span /><strong>PALMYRA · {module.label}</strong><small>REAL CRM</small></div>
        <div className="landing-scene__screen-wrap">
          <div className="landing-scene__screen-glow" />
          <div className="landing-scene__screen"><img src={module.screenSrc || screen.dashboard} alt={module.screenLabel || ("Captura de " + module.label + " de PALMYRA")} loading="lazy" /></div>
        </div>
        <div className="landing-scene__bottom-bar">
          <div><Icon size={15} /><span>{module.eyebrow}</span></div>
          <strong>{module.title}</strong>
        </div>
      </div>
      <div className="landing-scene__floating landing-scene__floating--left"><WifiOff size={15} /><span>Offline preparado</span></div>
      <div className="landing-scene__floating landing-scene__floating--right"><span>Captura real</span><b>●</b></div>
    </motion.div>
  );
}