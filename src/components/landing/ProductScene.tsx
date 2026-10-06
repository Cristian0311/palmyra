import { motion } from "motion/react";
import { BarChart3, Boxes, ClipboardCheck, CreditCard, Landmark, LineChart, Receipt, Settings2, ShoppingCart, UserRound, Users, WalletCards, WifiOff } from "lucide-react";

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
  suppliers: "/landing/crm/suppliers.jpg",
  audit: "/landing/crm/audit.jpg",
  bank: "/landing/crm/bank.jpg",
  reports: "/landing/crm/reports.jpg",
  settings: "/landing/crm/settings.jpg",
  team: "/landing/crm/team.jpg",
  plan: "/landing/crm/plan.jpg",
  menu: "/landing/crm/menu.jpg",
} as const;

export const landingModules: LandingModule[] = [
  { id: "dashboard", label: "Dashboard", title: "Una vista clara de tu negocio.", description: "Ventas, inventario, caja y actividad reunidos en una sola lectura.", icon: icons.dashboard, eyebrow: "Resumen ejecutivo", screenSrc: screen.dashboard, screenLabel: "Captura real · Dashboard" },
  { id: "menu", label: "Menú y navegación", title: "Todo parte de un mismo espacio.", description: "El acceso central reúne las áreas de trabajo sin obligar al equipo a perderse entre pantallas.", icon: icons.settings, eyebrow: "Arquitectura del producto", screenSrc: screen.menu, screenLabel: "Captura real · Menú PALMYRA" },
  { id: "cash", label: "Caja", title: "Cada turno deja huella.", description: "Aperturas, movimientos, cierres y descuadres dentro del mismo contexto operativo.", icon: icons.cash, eyebrow: "Control de caja", screenSrc: screen.cash, screenLabel: "Captura real · Caja" },
  { id: "inventory", label: "Inventario", title: "Existencias que se entienden.", description: "Productos, stock, filtros y almacenes organizados alrededor de una misma fuente.", icon: icons.inventory, eyebrow: "Control de stock", screenSrc: screen.inventory, screenLabel: "Captura real · Inventario" },
  { id: "suppliers", label: "Proveedores", title: "La compra siempre tiene contexto.", description: "Relaciones comerciales e historial accesibles desde el flujo de abastecimiento.", icon: icons.suppliers, eyebrow: "Abastecimiento", screenSrc: screen.suppliers, screenLabel: "Captura real · Proveedores" },
  { id: "customers", label: "Clientes", title: "Cada relación tiene memoria.", description: "Consulta clientes sin convertir la relación comercial en otro sistema separado.", icon: icons.customers, eyebrow: "Relación comercial", screenSrc: screen.customers, screenLabel: "Captura real · Clientes" },
  { id: "reports", label: "Reportes", title: "Lo ocurrido se convierte en decisión.", description: "Ventas, cajas, movimientos y desempeño reunidos para leer el negocio con contexto.", icon: icons.reports, eyebrow: "Inteligencia del negocio", screenSrc: screen.reports, screenLabel: "Captura real · Reportes" },
  { id: "settings", label: "Configuración", title: "El sistema se adapta al negocio.", description: "Empresa, almacenes, ticket, conexión y preferencias en un mismo centro de control.", icon: icons.settings, eyebrow: "Configuración", screenSrc: screen.settings, screenLabel: "Captura real · Configuración" },
  { id: "team", label: "Equipo", title: "Personas y permisos en orden.", description: "Roles, trabajadores y accesos organizados para que cada persona sepa qué puede hacer.", icon: icons.team, eyebrow: "Personas y permisos", screenSrc: screen.team, screenLabel: "Captura real · Equipo" },
  { id: "plan", label: "Plan", title: "Crece sin cambiar de sistema.", description: "El espacio de trabajo acompaña el crecimiento y deja visibles los límites del plan.", icon: icons.plan, eyebrow: "Cuenta y crecimiento", screenSrc: screen.plan, screenLabel: "Captura real · Plan" },
];

export function ProductScene({ module, compact = false }: { module: LandingModule; compact?: boolean }) {
  const src = module.screenSrc || screen.dashboard;
  const Icon = module.icon;

  return (
    <motion.div className={"landing-scene" + (compact ? " landing-scene--compact" : "")} initial={{ opacity: 0, y: 30, rotateX: 8 }} animate={{ opacity: 1, y: 0, rotateX: 0 }} transition={{ type: "spring", stiffness: 82, damping: 21 }}>
      <div className="landing-scene__halo" aria-hidden="true" />
      <div className="landing-scene__device landing-scene__device--back" aria-hidden="true" />
      <div className="landing-scene__window">
        <div className="landing-scene__chrome"><span /><span /><span /><strong>PALMYRA · {module.label}</strong><small>PRODUCTO REAL</small></div>
        <div className="landing-scene__screen-wrap">
          <div className="landing-scene__screen-glow" aria-hidden="true" />
          <div className="landing-scene__screen">
            <div className="landing-scene__screen-crop">
              <img src={src} alt={module.screenLabel || ("Captura real de " + module.label + " de PALMYRA")} loading="lazy" />
            </div>
          </div>
        </div>
        <div className="landing-scene__bottom-bar">
          <div><Icon size={15} /><span>{module.eyebrow}</span></div>
          <strong>{module.title}</strong>
        </div>
      </div>
      <div className="landing-scene__floating landing-scene__floating--left"><WifiOff size={15} /><span>Offline preparado</span></div>
      <div className="landing-scene__floating landing-scene__floating--right"><span>CRM real</span><b>●</b></div>
    </motion.div>
  );
}