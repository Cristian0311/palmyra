import { motion } from "motion/react";
import {
  BarChart3, Boxes, ClipboardCheck, CreditCard, Landmark, LineChart, Receipt,
  Settings2, ShoppingCart, Truck, UserRound, Users, WalletCards, WifiOff,
} from "lucide-react";

export type LandingModule = {
  id: string;
  label: string;
  title: string;
  description: string;
  icon: typeof BarChart3;
  eyebrow: string;
};

const icons = {
  dashboard: BarChart3, pos: ShoppingCart, inventory: Boxes, purchases: Receipt,
  suppliers: Users, audit: ClipboardCheck, bank: Landmark, transfers: Truck,
  customers: Users, reports: LineChart, team: UserRound, cash: WalletCards,
  settings: Settings2, plan: CreditCard,
} as const;

export const landingModules: LandingModule[] = [
  { id: "dashboard", label: "Dashboard", title: "Una vista clara de tu negocio.", description: "Ventas, inventario, caja y actividad reunidos en una sola lectura.", icon: icons.dashboard, eyebrow: "Resumen ejecutivo" },
  { id: "pos", label: "Punto de Venta", title: "Cobra rápido. Sigue operando.", description: "Un punto de venta pensado para jornadas reales y conexión intermitente.", icon: icons.pos, eyebrow: "Venta diaria" },
  { id: "inventory", label: "Inventario", title: "Existencias que se entienden.", description: "Productos, movimientos y almacenes organizados alrededor de una misma fuente.", icon: icons.inventory, eyebrow: "Control de stock" },
  { id: "purchases", label: "Compras", title: "De la compra al inventario.", description: "Ordena, recibe y refleja la mercancía sin romper el flujo operativo.", icon: icons.purchases, eyebrow: "Abastecimiento" },
  { id: "suppliers", label: "Proveedores", title: "La relación comercial, en contexto.", description: "Contactos e historial accesibles cuando realmente hacen falta.", icon: icons.suppliers, eyebrow: "Relación comercial" },
  { id: "audit", label: "Auditoría de stock", title: "Ajusta con control.", description: "Conteos, variaciones y aprobación antes de tocar existencias.", icon: icons.audit, eyebrow: "Trazabilidad" },
  { id: "bank", label: "Cuentas bancarias", title: "Finanzas con una sola lectura.", description: "Cuentas y movimientos preparados para crecer con el negocio.", icon: icons.bank, eyebrow: "Control financiero" },
  { id: "transfers", label: "Transferencias", title: "Mercancía donde hace falta.", description: "Movimiento entre almacenes con origen, destino y trazabilidad.", icon: icons.transfers, eyebrow: "Operación multi-almacén" },
  { id: "customers", label: "Clientes", title: "Cada relación tiene memoria.", description: "Historial y datos útiles sin convertir el CRM en un laberinto.", icon: icons.customers, eyebrow: "Relación con clientes" },
  { id: "reports", label: "Reportes", title: "Información para decidir.", description: "Indicadores comerciales y operativos listos para interpretar.", icon: icons.reports, eyebrow: "Inteligencia del negocio" },
  { id: "team", label: "Equipo", title: "Roles que se entienden.", description: "Cada persona trabaja con el acceso que realmente necesita.", icon: icons.team, eyebrow: "Personas y permisos" },
  { id: "cash", label: "Caja", title: "El efectivo también deja huella.", description: "Turnos, movimientos y cierres con trazabilidad.", icon: icons.cash, eyebrow: "Control de caja" },
  { id: "settings", label: "Configuración", title: "Todo listo para trabajar.", description: "Empresa, almacenes, POS, seguridad y preferencias en un mismo lugar.", icon: icons.settings, eyebrow: "Configuración" },
  { id: "plan", label: "Plan", title: "Crece sin cambiar de sistema.", description: "Tu plan evoluciona contigo y mantiene el mismo espacio de trabajo.", icon: icons.plan, eyebrow: "Cuenta y crecimiento" },
];

const rowsById: Record<string, string[]> = {
  dashboard: ["Ventas", "Inventario", "Caja", "Actividad"],
  pos: ["Buscar producto", "Carrito", "Cliente", "Cobrar"],
  inventory: ["Productos", "Stock", "Movimientos", "Almacenes"],
  purchases: ["Proveedores", "Órdenes", "Recepciones", "Costos"],
  suppliers: ["Contactos", "Compras", "Historial", "Pendientes"],
  audit: ["Conteo físico", "Variación", "Recuento", "Aprobación"],
  bank: ["Cuentas", "Entradas", "Salidas", "Conciliación"],
  transfers: ["Origen", "Destino", "Mercancía", "Seguimiento"],
  customers: ["Perfil", "Compras", "Historial", "Actividad"],
  reports: ["Ventas", "Caja", "Inventario", "Equipo"],
  team: ["Usuarios", "Roles", "Almacenes", "Dispositivos"],
  cash: ["Apertura", "Movimientos", "Cierre", "Descuadres"],
  settings: ["Empresa", "Almacenes", "POS", "Seguridad"],
  plan: ["Plan actual", "Límites", "Método de pago", "Renovación"],
};

function SceneRows({ module }: { module: LandingModule }) {
  return (rowsById[module.id] || rowsById.dashboard).map((row, index) => (
    <motion.div
      key={row}
      className={"landing-scene__row" + (index === 0 ? " is-active" : "")}
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: index * .045, duration: .22 }}
    >
      <span>{String(index + 1).padStart(2, "0")}</span>
      <strong>{row}</strong>
      <i />
    </motion.div>
  ));
}

export function ProductScene({ module, compact = false }: { module: LandingModule; compact?: boolean }) {
  const Icon = module.icon;
  return (
    <motion.div
      className={"landing-scene" + (compact ? " landing-scene--compact" : "")}
      initial={{ opacity: 0, y: 18, rotateX: 5 }}
      animate={{ opacity: 1, y: 0, rotateX: 0 }}
      transition={{ type: "spring", stiffness: 90, damping: 18 }}
    >
      <div className="landing-scene__glow" />
      <div className="landing-scene__window">
        <div className="landing-scene__chrome">
          <span /><span /><span />
          <strong>PALMYRA · {module.label}</strong>
          <small>LIVE</small>
        </div>
        <div className="landing-scene__body">
          <aside className="landing-scene__rail">
            <div className="landing-scene__brand-mark">✦</div>
            {landingModules.slice(0, 6).map((item) => {
              const ItemIcon = item.icon;
              return <span className={item.id === module.id ? "is-active" : ""} key={item.id}><ItemIcon size={12} /></span>;
            })}
          </aside>
          <div className="landing-scene__content">
            <div className="landing-scene__intro">
              <div><span>{module.eyebrow}</span><h3>{module.title}</h3></div>
              <button type="button" tabIndex={-1}>+ NUEVO</button>
            </div>
            <div className="landing-scene__workspace">
              <div className="landing-scene__panel landing-scene__panel--wide">
                <div className="landing-scene__panel-heading"><span>FLUJO DE TRABAJO</span><i /></div>
                <div className="landing-scene__rows"><SceneRows module={module} /></div>
              </div>
              <div className="landing-scene__panel landing-scene__panel--side">
                <div className="landing-scene__feature-icon"><Icon size={17} /></div>
                <span>{module.label}</span>
                <strong>Claro por diseño.</strong>
                <div className="landing-scene__meter"><i /></div>
                <small>Información organizada para trabajar.</small>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div className="landing-scene__floating landing-scene__floating--left"><WifiOff size={13} /><span>Offline preparado</span></div>
      <div className="landing-scene__floating landing-scene__floating--right"><span>Empresa aislada</span><b>●</b></div>
    </motion.div>
  );
}
