import type React from "react";
import React, { useMemo, useState } from "react";
import {
  ArrowRight, BarChart3, Boxes, Check, ChevronRight, CloudOff, CreditCard,
  MonitorSmartphone, PackageCheck, Users, WifiOff, ShoppingCart, Truck,
  RotateCcw, Settings2, LineChart, WalletCards, Menu, X, UserRound,
  ShieldCheck, Building2, Warehouse, Sparkles, Globe2, Clock3, Receipt,
  CircleDollarSign, LockKeyhole, Landmark, Caravan, Castle
} from "lucide-react";
import { useNavigate } from "react-router-dom";

const CITY_IMAGE = "https://live.staticflickr.com/5016/5514619147_c7d54849af_o.jpg";
const CITY_CREDIT = "Palmyra histórica · Erik Hermans / Institute for the Study of the Ancient World · CC BY 2.0";
const CaravanIcon = Caravan;
const CitadelIcon = Castle;

const modules = [
  { id: "dashboard", label: "Dashboard", icon: BarChart3, title: "Una vista clara de tu negocio.", text: "Ventas, inventario, caja y alertas importantes en una sola pantalla.", stats: [["Ventas", "$ 12,480"], ["Tickets", "248"], ["Stock bajo", "12"], ["Equipo", "8"]] },
  { id: "pos", label: "Punto de Venta", icon: ShoppingCart, title: "Cobrar rápido, incluso sin conexión.", text: "Un POS pensado para jornadas reales: simple para el trabajador y potente para el dueño.", stats: [["Caja", "$ 8,420"], ["Tickets", "24"], ["Pendientes", "0"], ["Estado", "Offline listo"]] },
  { id: "inventory", label: "Inventario", icon: Boxes, title: "Existencias por almacén, sin confusión.", text: "Controla stock, movimientos, mínimos y entradas desde cualquier dispositivo.", stats: [["Productos", "284"], ["Stock bajo", "12"], ["Almacenes", "3"], ["Movimientos", "1,248"]] },
  { id: "purchases", label: "Compras", icon: Receipt, title: "Compras y recepción en un solo flujo.", text: "Registra proveedores, órdenes y recepciones sin separar la información del inventario.", stats: [["Órdenes", "18"], ["Pendientes", "4"], ["Recibidas", "14"], ["Proveedores", "26"]] },
  { id: "suppliers", label: "Proveedores", icon: Users, title: "Proveedores siempre a mano.", text: "Consulta contactos, compras y relación comercial desde una vista sencilla.", stats: [["Proveedores", "26"], ["Activos", "21"], ["Compras", "$ 42K"], ["Pendientes", "4"]] },
  { id: "audit", label: "Auditoría de stock", icon: ClipboardCheck, title: "Auditoría de stock controlada.", text: "Conteo físico, variación, recuento y aprobación antes de ajustar existencias.", stats: [] },
  { id: "bank", label: "Cuentas bancarias", icon: Landmark, title: "Movimientos bancarios centralizados.", text: "Cuentas y movimientos confirmados en un solo lugar.", stats: [] },
  { id: "transfers", label: "Transferencias", icon: Truck, title: "Mueve mercancía con contexto.", text: "Consulta qué salió, desde dónde, hacia qué almacén y qué cantidad.", stats: [["Hoy", "8"], ["En tránsito", "3"], ["Completadas", "24"], ["Almacenes", "3"]] },
  { id: "customers", label: "Clientes", icon: Users, title: "La relación con tus clientes, ordenada.", text: "Historial de compras y datos útiles sin convertir el CRM en un laberinto.", stats: [["Clientes", "1,284"], ["Nuevos", "18"], ["Compras", "$ 24.8K"], ["Activos", "942"]] },
  { id: "reports", label: "Reportes", icon: LineChart, title: "Decisiones con información real.", text: "Indicadores comerciales y operativos para saber dónde estás y qué mejorar.", stats: [["Ventas", "$ 84K"], ["Margen", "28.4%"], ["Ticket", "$ 32.80"], ["Stock", "$ 124K"]] },
  { id: "team", label: "Equipo", icon: UserRound, title: "Personas, roles y permisos claros.", text: "Cada trabajador tiene su propia cuenta y ve solo lo que necesita.", stats: [["Empleados", "8"], ["Accesos", "6"], ["Roles", "5"], ["Invitaciones", "2"]] },
  { id: "cash", label: "Caja", icon: WalletCards, title: "Turnos y efectivo bajo control.", text: "Apertura, movimientos, cierres y descuadres con trazabilidad.", stats: [["Caja", "$ 8,420"], ["Turno", "04"], ["Descuadre", "$ 0.00"], ["Cierres", "18"]] },
  { id: "settings", label: "Configuración", icon: Settings2, title: "Todo en su lugar.", text: "Empresa, almacenes, equipo, POS, seguridad, monedas y plan.", stats: [["Empresa", "Activa"], ["Almacenes", "3"], ["POS", "2"], ["Plan", "Caravana"]] },
  { id: "plan", label: "Plan", icon: CreditCard, title: "Plan y facturación claros.", text: "Consulta el plan actual, método de pago y opciones de crecimiento.", stats: [] }
];

const plans = [
  {
    code: "starter", icon: Sparkles, name: "Oasis", price: "$10", note: "Inicio esencial", warehouses: "1 almacén", employees: "2 empleados", products: "50 productos",
    description: "Para comenzar a vender y controlar lo esencial sin complicaciones.",
    features: ["Punto de venta", "Inventario y caja", "Clientes y proveedores", "Reportes básicos", "Modo offline"], featured: false
  },
  {
    code: "growth", icon: CaravanIcon, name: "Caravana", price: "$15", note: "Operación en expansión", warehouses: "3 almacenes", employees: "4 empleados", products: "150 productos",
    description: "Para negocios que ya mueven mercancía entre varios puntos y necesitan más control.",
    features: ["Compras y recepción", "Transferencias entre almacenes", "Reportes avanzados", "Equipo con roles", "Operación multi-almacén"], featured: true
  },
  {
    code: "pro", icon: CitadelIcon, name: "Ciudadela", price: "$25", note: "Control empresarial", warehouses: "7 almacenes", employees: "10 empleados", products: "300 productos",
    description: "Para empresas con mayor estructura, más ubicaciones y análisis profundo.",
    features: ["Analítica avanzada", "7 almacenes operativos", "10 empleados + administrador", "300 productos/SKUs", "Soporte prioritario"], featured: false
  }
];

const palette = [
  ["#3B1B78", "Violeta profundo"], ["#5B2DBA", "Índigo"], ["#5B2DBA", "PALMYRA"], ["#7C4DDE", "Activo"],
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

function MiniSidebar({ active }: { active: string }) {
  return (
    <aside className="hidden sm:block w-[116px] shrink-0 border-r border-violet-100 bg-white/80 p-2.5">
      <Brand compact />
      <div className="mt-4 space-y-1.5">
        {modules.map(({ id, label, icon: Icon }) => (
          <div key={id} className={"flex items-center gap-1.5 px-2 py-2 rounded-lg text-[8px] font-bold " + (active === id ? "bg-[#EFE8FF] text-[#5B2DBA]" : "text-slate-500")}>
            <Icon className="w-3 h-3" /> <span className="truncate">{label}</span>
          </div>
        ))}
      </div>
      <div className="mt-4 p-2 rounded-xl bg-[#F7F5FC] border border-violet-100">
        <p className="text-[7px] font-black uppercase tracking-wider text-slate-400">Empresa</p>
        <p className="text-[8px] font-black text-[#3B1B78] mt-1 truncate">Mi Empresa</p>
        <p className="text-[7px] text-slate-500 mt-1">Almacén Principal</p>
      </div>
    </aside>
  );
}

function MiniTopbar({ title }: { title: string }) {
  return (
    <div className="h-8 border-b border-violet-100 bg-white flex items-center justify-between px-3">
      <div className="flex items-center gap-1.5">
        <span className="w-2 h-2 rounded-full bg-violet-200" />
        <span className="w-2 h-2 rounded-full bg-violet-300" />
        <span className="w-2 h-2 rounded-full bg-violet-400" />
      </div>
      <span className="text-[7px] font-black text-[#5B2DBA] uppercase tracking-[.2em]">{title}</span>
      <div className="w-8 h-2 rounded-full bg-[#F0EBFA]" />
    </div>
  );
}

function RealModulePreview({ id }: { id: string }) {
  const side = ["Dashboard","Punto de venta","Transferencias","Clientes (POS)","Inventario","Auditoría stock","Proveedores","Cuentas bancarias","Devoluciones","Reportes","Configuración","Equipo","Plan"];
  const active = id === "audit" ? "Auditoría stock" : id === "bank" ? "Cuentas bancarias" : id === "plan" ? "Plan" : id === "settings" ? "Configuración" : id === "transfers" ? "Transferencias" : "Reportes";
  const labels: Record<string,string> = {
    audit: "AUDITORÍA DE STOCK", bank: "CUENTAS BANCARIAS", reports: "REPORTES", plan: "Facturación y plan",
    settings: "CONFIGURACIÓN", transfers: "TRANSFERENCIAS"
  };
  const Stat=({title,value}:{title:string,value:string}) => <div className="rounded-xl border border-violet-100 bg-white px-3 py-2"><p className="text-[6px] uppercase tracking-wider text-slate-400 font-black">{title}</p><p className="text-sm font-black text-[#3B1B78] mt-1">{value}</p></div>;
  const Box=({children,className=""}:{children:React.ReactNode,className?:string}) => <div className={"rounded-2xl border border-violet-100 bg-white "+className}>{children}</div>;
  return <div className="rounded-[18px] overflow-hidden border border-violet-100 bg-[#F7F5FC]">
    <div className="flex min-h-[330px]">
      <aside className="hidden sm:block w-[112px] shrink-0 bg-white border-r border-violet-100 p-2">
        <Brand compact />
        <div className="mt-3 space-y-0.5">{side.map(x => <div key={x} className={"px-2 py-1.5 rounded-md text-[6px] font-bold "+(x===active?"bg-[#7C3AED] text-white":"text-slate-500")}>{x}</div>)}</div>
        <div className="mt-3 rounded-lg bg-emerald-50 px-2 py-1 text-[6px] font-black text-emerald-600">● ONLINE</div>
      </aside>
      <div className="flex-1 min-w-0 p-3 md:p-4">
        <div className="flex items-center justify-between gap-2"><div><p className="text-[6px] uppercase tracking-[.18em] text-slate-400 font-black">PALMYRA</p><h4 className="text-sm md:text-base font-black text-[#251536]">{labels[id] || "MÓDULO"}</h4></div><button className="h-6 px-2 rounded-lg bg-[#5B2DBA] text-white text-[6px] font-black">{id==="audit"?"+ NUEVA AUDITORÍA":id==="bank"?"+ NUEVA CUENTA":id==="reports"?"EXCEL":id==="plan"?"Actualizar":id==="settings"?"SINCRONIZAR NUBE":"+ TRASLADO INDIVIDUAL"}</button></div>
        {id==="audit" && <div className="mt-3 space-y-2"><div className="h-6 rounded-lg bg-[#5B2DBA] text-white text-[6px] font-black flex items-center justify-center">+ NUEVA AUDITORÍA</div><div className="grid grid-cols-2 gap-2"><Stat title="Total auditorías" value="0"/><Stat title="En conteo" value="0"/><Stat title="Pendientes revisión" value="0"/><Stat title="Aprobadas" value="0"/></div><Box className="p-3"><p className="text-[7px] font-black text-[#3B1B78]">HISTORIAL Y CONTROL</p><div className="mt-3 h-20 rounded-lg bg-[#F8F6FC] flex items-center justify-center text-[6px] text-slate-400">NO HAY AUDITORÍAS REGISTRADAS.</div></Box></div>}
        {id==="bank" && <div className="mt-3 space-y-2"><Box className="w-36 h-14 flex items-center justify-center text-[6px] text-slate-500">＋<br/>AGREGAR CUENTA</Box><Box className="p-3 h-28"><p className="text-[7px] font-black text-[#3B1B78]">MOVIMIENTOS BANCARIOS</p><div className="h-full flex items-center justify-center text-[6px] text-slate-400">No hay movimientos</div></Box></div>}
        {id==="reports" && <div className="mt-3 space-y-2"><div className="flex gap-1.5 overflow-hidden">{["VENTAS","NÓMINA","CAJAS","DESCUADRES","MOVIMIENTOS","TRANSFERENCIAS"].map((x,i)=><span key={x} className={"shrink-0 px-2 py-1 rounded-lg text-[6px] font-black "+(i===0?"bg-[#7C3AED] text-white":"bg-[#F0EBFA] text-slate-500")}>{x}</span>)}</div><Box className="p-3 h-28"><p className="text-[7px] font-black">VENTAS POR HORARIO</p><div className="mt-3 h-16 border-b border-dashed border-violet-100"/></Box><Box className="p-3 h-24"><p className="text-[7px] font-black">TOP CATEGORÍAS</p></Box><div className="grid grid-cols-2 gap-2"><Stat title="Ingresos ventas" value="$ 0"/><Stat title="Gastos / egresos" value="$ 0"/><Stat title="Flujo neto" value="$ 0"/><Stat title="Transacciones totales" value="0"/></div></div>}
        {id==="plan" && <div className="mt-3 space-y-2"><Box className="p-3"><p className="text-[7px] font-black">PLAN ACTUAL</p><div className="grid grid-cols-3 gap-2 mt-2"><Stat title="Plan" value="Oasis"/><Stat title="Estado" value="Activo"/><Stat title="Vencimiento" value="1/1/2027"/></div></Box><div className="grid grid-cols-3 gap-2">{[["Oasis","10.00 USD"],["Caravana","15.00 USD"],["Ciudadela","25.00 USD"]].map(([n,p])=><Box key={n} className="p-3"><p className="text-[9px] font-black text-[#3B1B78]">{n}</p><p className="text-xs font-black mt-2">{p}<span className="text-[6px] text-slate-400"> /mes</span></p><div className="mt-3 h-6 rounded-lg bg-[#F0EBFA]"/></Box>)}</div></div>}
        {id==="settings" && <div className="mt-3 space-y-2"><div className="flex gap-1 overflow-hidden">{["CONEXIÓN","EMPRESA","MONEDAS","ALMACENES","CATEGORÍAS","EMPLEADOS","ESTILO VISUAL"].map((x,i)=><span key={x} className={"shrink-0 px-2 py-1.5 rounded-lg text-[6px] font-black "+(i===0?"bg-[#7C3AED] text-white":"bg-[#F0EBFA] text-slate-500")}>{x}</span>)}</div><Box className="p-3"><p className="text-[8px] font-black">CONECTIVIDAD Y NUBE</p><div className="grid grid-cols-2 gap-2 mt-3"><div className="h-20 rounded-xl bg-[#F7F5FC]"/><div className="h-20 rounded-xl bg-[#F7F5FC]"/></div></Box><Box className="p-3 h-20"><p className="text-[7px] font-black">COPIA DE SEGURIDAD OFFLINE</p></Box></div>}
        {id==="transfers" && <div className="mt-3 space-y-2"><Box className="p-3"><div className="flex items-center justify-between"><p className="text-[8px] font-black">HISTORIAL DE MOVIMIENTOS</p><span className="text-[6px] text-slate-400">0 OPERACIONES</span></div><div className="h-24 flex items-center justify-center text-[6px] text-slate-400">SIN REGISTROS DE TRANSFERENCIA</div></Box><Box className="p-3"><p className="text-[7px] font-black">MÉTRICAS DE OPERACIÓN</p><div className="grid grid-cols-2 gap-2 mt-2"><Stat title="Transferencias totales" value="0"/><Stat title="Puntos de distribución" value="1"/></div></Box><div className="rounded-xl bg-[#10182F] p-3 text-white"><p className="text-[7px] font-black">SEGURIDAD DE INVENTARIO</p><p className="text-[6px] mt-2 text-emerald-200">● VALIDACIÓN ATÓMICA</p><p className="text-[6px] mt-1 text-emerald-200">● TRAZABILIDAD TOTAL</p></div></div>}
      </div>
    </div>
  </div>;
}

function ModuleScreen({ module }: { module: typeof modules[number] }) {
  if (["audit","bank","reports","plan","settings","transfers"].includes(module.id)) {
    return <RealModulePreview id={module.id} />;
  }
  const Icon = module.icon;
  const moduleInfo: Record<string, { eyebrow: string; steps: string[]; controls: string[]; accent: string }> = {
    audit: { eyebrow: "Control físico · Variación · Recuento", steps: ["Nueva auditoría", "Contar existencias", "Aprobar ajuste"], controls: ["Total auditorías", "En conteo", "Pendientes revisión", "Aprobadas"], accent: "Auditoría controlada" },
    bank: { eyebrow: "Todos los movimientos", steps: ["Agregar cuenta", "Registrar movimiento", "Reconciliar"], controls: ["Cuentas", "Movimientos", "Reconciliación", "Base de datos"], accent: "Control financiero" },
    plan: { eyebrow: "Cuenta", steps: ["Revisar plan", "Elegir método", "Solicitar cambio"], controls: ["Plan actual", "Estado", "Vencimiento", "Método de pago"], accent: "Facturación" },
    dashboard: { eyebrow: "Resumen ejecutivo", steps: ["Revisar ventas", "Detectar alertas", "Tomar decisiones"], controls: ["Ventas del día", "Caja", "Stock", "Actividad del equipo"], accent: "Visión general" },
    pos: { eyebrow: "Venta rápida", steps: ["Buscar producto", "Cobrar", "Cerrar ticket"], controls: ["Productos", "Clientes", "Métodos de pago", "Caja y recibo"], accent: "Pensado para el mostrador" },
    inventory: { eyebrow: "Control de existencias", steps: ["Consultar stock", "Registrar movimiento", "Reponer a tiempo"], controls: ["Existencias", "Mínimos", "Almacenes", "Historial"], accent: "Menos pérdidas, más control" },
    purchases: { eyebrow: "Abastecimiento", steps: ["Crear compra", "Recibir mercancía", "Actualizar inventario"], controls: ["Órdenes", "Recepciones", "Costos", "Proveedores"], accent: "De la compra al inventario" },
    suppliers: { eyebrow: "Relación comercial", steps: ["Guardar proveedor", "Consultar compras", "Dar seguimiento"], controls: ["Contactos", "Historial", "Compras", "Pendientes"], accent: "Información en un solo lugar" },
    transfers: { eyebrow: "Movimiento interno", steps: ["Elegir origen", "Elegir destino", "Registrar cantidades"], controls: ["Almacenes", "Mercancía", "Historial", "Estado"], accent: "Mercancía donde hace falta" },
    customers: { eyebrow: "Clientes", steps: ["Registrar cliente", "Consultar historial", "Atender mejor"], controls: ["Datos", "Compras", "Historial", "Actividad"], accent: "Relaciones que permanecen" },
    reports: { eyebrow: "Información para decidir", steps: ["Elegir período", "Analizar indicadores", "Actuar"], controls: ["Ventas", "Margen", "Caja", "Inventario"], accent: "Datos que ayudan a decidir" },
    team: { eyebrow: "Equipo y permisos", steps: ["Invitar trabajador", "Asignar rol", "Definir acceso"], controls: ["Usuarios", "Roles", "Almacenes", "Dispositivos"], accent: "Cada persona ve lo necesario" },
    cash: { eyebrow: "Control de caja", steps: ["Abrir turno", "Registrar movimientos", "Cerrar y revisar"], controls: ["Turnos", "Entradas", "Salidas", "Descuadres"], accent: "Trazabilidad de efectivo" },
    settings: { eyebrow: "Configuración", steps: ["Definir empresa", "Configurar operación", "Administrar seguridad"], controls: ["Empresa", "Almacenes", "POS", "Seguridad"], accent: "Todo preparado desde un lugar" }
  };
  const info = moduleInfo[module.id] || moduleInfo.dashboard;
  return (
    <div className="rounded-[22px] border border-violet-100 bg-white overflow-hidden shadow-[0_24px_70px_-46px_rgba(59,27,110,.4)]">
      <div className="h-10 border-b border-violet-100 bg-[#FBFAFD] flex items-center justify-between px-4">
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-violet-200"/><span className="w-2 h-2 rounded-full bg-violet-300"/><span className="w-2 h-2 rounded-full bg-violet-400"/>
        </div>
        <span className="text-[8px] font-black uppercase tracking-[.18em] text-[#5B2DBA]">PALMYRA · {module.label}</span>
        <span className="text-[7px] font-black text-slate-400">{info.accent}</span>
      </div>
      <div className="p-4 md:p-6 min-h-[300px] md:min-h-[370px] bg-white">
        <div className="flex items-start gap-4">
          <div className="w-12 h-12 rounded-2xl bg-[#EFE8FF] text-[#5B2DBA] flex items-center justify-center shrink-0"><Icon className="w-6 h-6"/></div>
          <div className="min-w-0">
            <p className="text-[8px] font-black uppercase tracking-[.18em] text-[#7C4DDE]">{info.eyebrow}</p>
            <h4 className="text-lg md:text-xl font-black text-[#251536] mt-1">{module.title}</h4>
            <p className="text-[10px] md:text-xs leading-5 text-slate-500 mt-2 max-w-2xl">{module.text}</p>
          </div>
        </div>
        <div className="grid md:grid-cols-3 gap-2 mt-6">
          {info.steps.map((step, index) => (
            <div key={step} className="rounded-2xl border border-violet-100 bg-[#F8F6FC] p-3">
              <div className="flex items-center justify-between"><span className="w-6 h-6 rounded-lg bg-white border border-violet-100 text-[#5B2DBA] flex items-center justify-center text-[8px] font-black">{index + 1}</span><ChevronRight className="w-3.5 h-3.5 text-violet-300"/></div>
              <p className="text-[10px] font-black text-[#3B1B78] mt-3">{step}</p>
            </div>
          ))}
        </div>
        <div className="mt-3 rounded-2xl bg-[#3B1B78] p-4 text-white">
          <p className="text-[8px] font-black uppercase tracking-[.18em] text-violet-200">Qué puedes controlar</p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-3">
            {info.controls.map(control => (
              <div key={control} className="flex items-center gap-2 rounded-xl bg-white/10 border border-white/10 px-2.5 py-2">
                <Check className="w-3 h-3 text-violet-200 shrink-0"/><span className="text-[8px] font-bold text-white/90">{control}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function LandingPage() {
  const navigate = useNavigate();
  const [active, setActive] = useState("dashboard");
  const [mobileMenu, setMobileMenu] = useState(false);
  const current = useMemo(() => modules.find(item => item.id === active) || modules[0], [active]);

  return (
    <div className="palmyra-landing-page min-h-screen bg-[#F7F5FC] text-[#21182F]">
      <header className="sticky top-0 z-50 border-b border-violet-100 bg-[#F7F5FC]/90 backdrop-blur-xl">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-[68px] flex items-center justify-between gap-4">
          <button onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })} aria-label="Ir al inicio"><Brand /></button>
          <nav className="hidden lg:flex items-center gap-7 text-[12px] font-bold text-slate-600">
            <a href="#producto">Producto</a><a href="#modulos">Módulos</a><a href="#planes">Planes</a><a href="#historia">Historia</a>
          </nav>
          <div className="flex items-center gap-2">
            <button onClick={() => navigate("/auth")} className="hidden sm:inline-flex h-10 px-4 rounded-xl items-center justify-center text-xs font-black text-[#5B2DBA] hover:bg-white">Entrar</button>
            <button onClick={() => navigate("/auth?mode=signup")} className="h-10 px-4 sm:px-5 rounded-xl bg-[#5B2DBA] text-white text-xs font-black shadow-[0_12px_28px_-12px_rgba(101,53,197,.65)]">Crear cuenta</button>
            <button onClick={() => setMobileMenu(v => !v)} className="lg:hidden w-10 h-10 rounded-xl border border-violet-100 bg-white text-[#5B2DBA]" aria-label="Menú">{mobileMenu ? <X className="w-4 h-4 mx-auto" /> : <Menu className="w-4 h-4 mx-auto" />}</button>
          </div>
        </div>
        {mobileMenu && <div className="lg:hidden border-t border-violet-100 bg-white px-4 py-3"><div className="flex flex-col gap-3 text-xs font-bold text-slate-600"><a href="#producto" onClick={() => setMobileMenu(false)}>Producto</a><a href="#modulos" onClick={() => setMobileMenu(false)}>Módulos</a><a href="#planes" onClick={() => setMobileMenu(false)}>Planes</a><a href="#historia" onClick={() => setMobileMenu(false)}>Historia</a></div></div>}
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
                <ModuleScreen module={current} />
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
              <p className="text-sm text-slate-500 mt-3 leading-6">Selecciona una sección para entender qué resuelve, cómo se utiliza y qué información puedes controlar. Las capturas reales incorporadas muestran cómo se ve PALMYRA en sus módulos; iremos completando las restantes con sus capturas correspondientes.</p>
            </div>
            <div className="mt-6 flex gap-1.5 overflow-x-auto pb-1">
              {modules.map(({ id, label, icon: Icon }) => (
                <button key={id} onClick={() => setActive(id)} className={"shrink-0 h-9 px-3 rounded-xl flex items-center gap-2 text-[10px] font-black transition " + (active === id ? "bg-[#5B2DBA] text-white shadow-md" : "bg-[#F7F5FC] text-slate-500 hover:bg-[#EFE8FF] hover:text-[#5B2DBA]")}>
                  <Icon className="w-3.5 h-3.5"/>{label}
                </button>
              ))}
            </div>
            <div className="grid lg:grid-cols-[.33fr_.67fr] gap-7 mt-6 items-center">
              <div className="rounded-3xl border border-violet-100 bg-[#F7F5FC] p-5">
                <div className="w-10 h-10 rounded-2xl bg-[#EFE8FF] text-[#5B2DBA] flex items-center justify-center"><current.icon className="w-5 h-5"/></div>
                <p className="text-[9px] font-black uppercase tracking-[.18em] text-[#7C4DDE] mt-5">{current.label}</p>
                <h3 className="text-xl font-black text-[#3B1B78] mt-2 tracking-[-.02em]">{current.title}</h3>
                <p className="text-xs text-slate-500 mt-3 leading-6">{current.text}</p>
                <div className="mt-5 text-[9px] font-black text-[#5B2DBA] flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500"/> Interfaz diseñada para uso diario</div>
              </div>
              <ModuleScreen module={current} />
            </div>
          </div>
        </section>

        <section className="bg-[#3B1B78] text-white">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12 grid lg:grid-cols-[1fr_auto] gap-7 items-center">
            <div>
              <p className="text-[10px] font-black uppercase tracking-[.2em] text-violet-200">Lenguaje visual</p>
              <h2 className="text-2xl sm:text-4xl font-black tracking-[-.04em] mt-2">Morado para la marca. Claridad para trabajar.</h2>
              <p className="text-sm text-violet-100/75 mt-3 max-w-2xl leading-6">La paleta nace del logo: profundidad para navegación y encabezados, violeta para acciones, lavanda para superficies y contrastes suaves para largas jornadas frente a la pantalla.</p>
            </div>
            <div className="flex items-center gap-1.5 rounded-2xl bg-white/5 border border-white/10 p-3 overflow-x-auto">
              {palette.map(([hex, name]) => <div key={hex} className="text-center shrink-0"><span style={{backgroundColor:hex}} className="block w-8 h-8 rounded-full border border-white/15"/><span className="block text-[6px] text-violet-200 mt-1 w-10 leading-3">{name}</span></div>)}
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
            <div className="grid md:grid-cols-3 gap-3 mt-8">
              {plans.map(plan => {
                const Icon = plan.icon;
                return (
                  <article key={plan.code} className={"relative rounded-2xl p-4 border " + (plan.featured ? "border-[#8B63E6] bg-white shadow-[0_25px_60px_-34px_rgba(101,53,197,.55)] md:-translate-y-2" : "border-violet-100 bg-white/80")}>
                    {plan.featured && <div className="absolute -top-2.5 left-4 px-2.5 py-1 rounded-full bg-[#5B2DBA] text-white text-[8px] font-black uppercase tracking-wider">Más elegido</div>}
                    <div className="flex items-center justify-between gap-2"><div className="flex items-center gap-2"><span className="w-8 h-8 rounded-xl bg-[#EFE8FF] text-[#5B2DBA] flex items-center justify-center"><Icon className="w-4 h-4"/></span><div><p className="text-[9px] uppercase tracking-wider text-slate-400 font-black">{plan.note}</p><h3 className="text-base font-black text-[#3B1B78]">{plan.name}</h3></div></div><p className="text-xl font-black text-[#3B1B78]">{plan.price}<span className="text-[8px] text-slate-400 font-bold">/mes</span></p></div>
                    <div className="grid grid-cols-3 gap-1.5 mt-4">{[plan.warehouses, plan.employees, plan.products].map((value, index) => <div key={index} className="rounded-lg bg-[#F7F5FC] border border-violet-50 px-2 py-2 text-center"><p className="text-[7px] text-slate-400 uppercase font-black">{["Almacenes","Empleados","Productos"][index]}</p><p className="text-[10px] font-black text-[#5B2DBA] mt-0.5">{value}</p></div>)}</div>
                    <p className="text-[9px] text-slate-500 leading-5 mt-3">{plan.description}</p>
                    <div className="space-y-1.5 mt-4">{plan.features.map(f => <div key={f} className="flex items-center gap-2 text-[9px] text-slate-500"><span className="w-4 h-4 rounded-md bg-[#EFE8FF] text-[#5B2DBA] flex items-center justify-center shrink-0"><Check className="w-2.5 h-2.5"/></span>{f}</div>)}</div>
                    <button onClick={() => { sessionStorage.setItem("palmyra_signup_plan", plan.code); navigate("/auth?mode=signup"); }} className={"w-full h-10 mt-5 rounded-xl text-[10px] font-black " + (plan.featured ? "bg-[#5B2DBA] text-white" : "bg-[#F0EBFA] text-[#5B2DBA]")}>{plan.code === "starter" ? "Comenzar gratis" : "Elegir plan"}</button>
                    <p className="text-[7px] text-center text-slate-400 mt-2">Cuba: efectivo o transferencia bancaria</p>
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
                  <div className="absolute inset-0 opacity-35">
                    <div className="absolute bottom-0 left-[9%] w-[5%] h-[42%] bg-white/30 rounded-t-sm"/>
                    <div className="absolute bottom-0 left-[18%] w-[4%] h-[58%] bg-white/25 rounded-t-sm"/>
                    <div className="absolute bottom-0 left-[27%] w-[6%] h-[50%] bg-white/20 rounded-t-sm"/>
                    <div className="absolute bottom-0 left-[40%] w-[4%] h-[68%] bg-white/25 rounded-t-sm"/>
                    <div className="absolute bottom-0 left-[49%] w-[7%] h-[46%] bg-white/20 rounded-t-sm"/>
                    <div className="absolute bottom-0 left-[65%] w-[4%] h-[62%] bg-white/25 rounded-t-sm"/>
                    <div className="absolute bottom-0 left-[74%] w-[6%] h-[51%] bg-white/20 rounded-t-sm"/>
                  </div>
              <img src={CITY_IMAGE} alt="Ruinas de la antigua ciudad de Palmyra, Siria" className="absolute inset-0 w-full h-full object-cover" loading="eager" referrerPolicy="no-referrer" onError={(e) => { e.currentTarget.style.display = "none"; }} />
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
            <div><p className="text-[10px] font-black uppercase tracking-[.2em] text-[#7C4DDE]">PALMYRA</p><h2 className="text-2xl sm:text-3xl font-black text-[#3B1B78] mt-2">Tu negocio merece un sistema que no estorbe.</h2><p className="text-xs text-slate-500 mt-2">Claro para trabajar. Potente para crecer.</p></div>
            <button onClick={() => navigate("/auth?mode=signup")} className="h-12 px-5 rounded-2xl bg-[#5B2DBA] text-white font-black text-sm flex items-center gap-2 shadow-[0_18px_40px_-20px_rgba(101,53,197,.7)]">Crear cuenta <ArrowRight className="w-4 h-4"/></button>
          </div>
        </section>
      </main>

      <footer className="bg-white border-t border-violet-100">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-7 flex flex-col md:flex-row items-center justify-between gap-3">
          <Brand />
          <p className="text-[9px] text-slate-400 text-center">PALMYRA · Business OS · Gestión empresarial simple y profesional</p>
          <p className="text-[9px] text-slate-400">© {new Date().getFullYear()} PALMYRA</p>
        </div>
      </footer>
    </div>
  );
}
