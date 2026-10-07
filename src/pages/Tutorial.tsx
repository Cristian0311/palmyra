import { useMemo, useState } from "react";
import {
  ArrowLeftRight, ArrowRight, BarChart3, BookOpen, Boxes, Building2, CheckCircle2,
  ChevronDown, CircleDollarSign, ClipboardCheck, CreditCard, Database, FileBarChart2,
  Headphones, HelpCircle, Home, Package, Printer, Receipt, RotateCcw, Search,
  Settings, ShoppingCart, Smartphone, Store, Tags, Truck, Users, Wifi, WifiOff
} from "lucide-react";

type TutorialSection = {
  id: string;
  title: string;
  icon: typeof Home;
  summary: string;
  steps: Array<{ title: string; detail: string; tip?: string }>;
};

const sections: TutorialSection[] = [
  {
    id: "inicio", title: "Cómo empezar", icon: Home,
    summary: "Configura tu empresa una sola vez y después trabaja desde el Dashboard.",
    steps: [
      { title: "1. Empresa y almacén", detail: "Registra el nombre de la empresa, crea el almacén o sucursal inicial y verifica que el contexto de trabajo sea el correcto.", tip: "La empresa y el almacén determinan dónde se guardan y consultan tus operaciones." },
      { title: "2. Configuración inicial", detail: "Revisa categorías, unidades, métodos de pago, impresora térmica, bancos y demás preferencias desde Configuración." },
      { title: "3. Equipo", detail: "Invita a trabajadores y asigna únicamente los permisos que necesitan para su función." },
      { title: "4. Primer producto", detail: "Crea productos con sus datos básicos, variantes, precios y existencias antes de comenzar a vender." }
    ]
  },
  {
    id: "dashboard", title: "Dashboard", icon: BarChart3,
    summary: "Es el resumen operativo de tu negocio.",
    steps: [
      { title: "Revisar el estado", detail: "Usa los indicadores para conocer ventas, actividad, inventario y señales importantes sin entrar en cada módulo." },
      { title: "Cambiar de sección", detail: "El sidebar organiza Operación, Gestión, Finanzas y Administración para llegar rápidamente a cada herramienta." },
      { title: "Trabajar por sucursal", detail: "Cuando tengas más de una sucursal o almacén, verifica siempre el contexto seleccionado antes de hacer movimientos." }
    ]
  },
  {
    id: "pos", title: "Punto de Venta (POS)", icon: ShoppingCart,
    summary: "Registra ventas, cobra, imprime comprobantes y controla la caja.",
    steps: [
      { title: "1. Abrir turno", detail: "Abre el turno de caja antes de vender. El turno queda asociado al operador y conserva su numeración histórica." },
      { title: "2. Agregar productos", detail: "Busca o escanea el producto, revisa cantidad, variante, precio y vendedor antes de cobrar." },
      { title: "3. Cobrar", detail: "Selecciona uno o varios métodos de pago, como efectivo, transferencia u otros configurados, y confirma el total." },
      { title: "4. Ticket", detail: "Después de confirmar la venta puedes generar el comprobante y enviarlo a la impresora térmica configurada." },
      { title: "5. Movimientos de caja", detail: "Los ingresos, egresos y gastos de caja se registran como movimientos independientes para no mezclarlos con los tickets de productos." },
      { title: "6. Cerrar turno", detail: "Al cerrar, PALMYRA calcula los movimientos del turno y permite emitir el comprobante de cierre." }
    ]
  },
  {
    id: "offline", title: "Modo Offline", icon: WifiOff,
    summary: "Permite continuar operaciones cuando la conexión se pierde.",
    steps: [
      { title: "Trabajar sin internet", detail: "Las operaciones compatibles se guardan localmente en una cola durable para evitar que una venta desaparezca al recargar." },
      { title: "Continuidad", detail: "El estado local permite recuperar operaciones pendientes después de cerrar o volver a abrir la aplicación." },
      { title: "Volver a conectar", detail: "Cuando vuelve internet, PALMYRA procesa la cola y sincroniza las operaciones con la nube." },
      { title: "Verificar sincronización", detail: "Si quedan operaciones pendientes o conflictos, revisa el estado de sincronización antes de asumir que todo está enviado." }
    ]
  },
  {
    id: "inventario", title: "Inventario", icon: Package,
    summary: "Administra productos, existencias, categorías y variantes.",
    steps: [
      { title: "1. Filtrar", detail: "Usa Sucursal, Categoría y Stock para encontrar rápidamente los productos que necesitas revisar." },
      { title: "2. Agregar producto", detail: "Organiza el alta en Datos del producto, Variantes y Precios y extras. Mantén SKU y código de barras consistentes." },
      { title: "3. Variantes", detail: "Utiliza variantes para productos que comparten una ficha pero necesitan diferencias como talla o color y stock independiente." },
      { title: "4. Existencias", detail: "Revisa el stock por almacén y utiliza los movimientos de inventario para mantener trazabilidad." },
      { title: "5. Herramientas", detail: "Excel, Etiquetas y Análisis ABC aparecen en la barra de acciones. En móvil puedes deslizar horizontalmente para ver más opciones." }
    ]
  },
  {
    id: "transferencias", title: "Transferencias", icon: ArrowLeftRight,
    summary: "Mueve mercancía entre sucursales o almacenes manteniendo trazabilidad.",
    steps: [
      { title: "Origen y destino", detail: "Selecciona el almacén de origen y el destino y verifica que sean los correctos antes de confirmar." },
      { title: "Productos y cantidades", detail: "Agrega los productos y cantidades que realmente van a salir del almacén de origen." },
      { title: "Control", detail: "Revisa el historial de transferencias para identificar qué operación se realizó, cuándo y sobre qué productos." }
    ]
  },
  {
    id: "clientes", title: "Clientes", icon: Users,
    summary: "Centraliza la información de las personas que compran.",
    steps: [
      { title: "Crear ficha", detail: "Guarda los datos necesarios del cliente para poder identificarlo en ventas y consultas posteriores." },
      { title: "Asociar a ventas", detail: "Selecciona el cliente durante el proceso de venta cuando necesites conservar esa relación comercial." },
      { title: "Consultar historial", detail: "Usa la ficha del cliente como punto de referencia para revisar su relación con el negocio." }
    ]
  },
  {
    id: "proveedores", title: "Proveedores", icon: Truck,
    summary: "Organiza tus proveedores y la información que necesitas para abastecerte.",
    steps: [
      { title: "Registrar proveedor", detail: "Crea una ficha con los datos de contacto y comerciales que utilizará tu equipo." },
      { title: "Relacionar compras", detail: "Mantén la información del proveedor conectada con las operaciones de abastecimiento y sus registros." },
      { title: "Consultar", detail: "Busca por nombre o datos disponibles para encontrar rápidamente al proveedor correcto." }
    ]
  },
  {
    id: "bancos", title: "Bancos", icon: CreditCard,
    summary: "Controla cuentas y movimientos bancarios dentro del negocio.",
    steps: [
      { title: "Crear cuenta", detail: "Registra las cuentas bancarias que utiliza la empresa y revisa sus datos antes de operar." },
      { title: "Registrar movimientos", detail: "Mantén separados los movimientos bancarios de los movimientos de caja para conservar claridad financiera." },
      { title: "Conciliar", detail: "Utiliza los reportes y detalles disponibles para comparar lo registrado con los movimientos reales." }
    ]
  },
  {
    id: "reportes", title: "Reportes", icon: FileBarChart2,
    summary: "Convierte las operaciones en información para tomar decisiones.",
    steps: [
      { title: "Ventas", detail: "Consulta las ventas y sus detalles, incluyendo productos, pagos y contexto del turno." },
      { title: "Caja", detail: "Revisa turnos, movimientos, ingresos, egresos y diferencias para detectar descuadres." },
      { title: "Inventario", detail: "Analiza movimientos y existencias para entender entradas, salidas y ajustes." },
      { title: "Filtros", detail: "Usa filtros compactos para acotar fechas, sucursales, operadores y demás criterios disponibles." },
      { title: "Detalle", detail: "Cuando una cifra requiera explicación, abre el detalle de la operación en lugar de trabajar únicamente con el total." }
    ]
  },
  {
    id: "auditoria", title: "Auditoría de inventario", icon: ClipboardCheck,
    summary: "Comprueba existencias físicas contra lo registrado.",
    steps: [
      { title: "Iniciar auditoría", detail: "Selecciona el contexto correcto y comienza el conteo desde el módulo de Auditoría." },
      { title: "Contar", detail: "Registra la cantidad física encontrada y compara con la cantidad esperada." },
      { title: "Diferencias", detail: "Revisa los productos con descuadre antes de aplicar cualquier ajuste." },
      { title: "Trazabilidad", detail: "Los ajustes deben conservar el motivo y el contexto de la operación para que posteriormente puedan revisarse." }
    ]
  },
  {
    id: "garantias", title: "Garantías y devoluciones", icon: RotateCcw,
    summary: "Gestiona devoluciones y garantías sin perder la relación con la venta.",
    steps: [
      { title: "Localizar la operación", detail: "Identifica la venta o producto involucrado antes de procesar una devolución o garantía." },
      { title: "Validar", detail: "Comprueba las condiciones y permisos aplicables a la operación." },
      { title: "Registrar", detail: "Guarda la devolución o garantía con su motivo y resultado para que quede disponible en los reportes." }
    ]
  },
  {
    id: "configuracion", title: "Configuración", icon: Settings,
    summary: "Aquí se define cómo trabaja tu empresa dentro de PALMYRA.",
    steps: [
      { title: "Almacenes", detail: "Crea y administra sucursales o almacenes. Verifica nombre y estado antes de usarlos en operaciones." },
      { title: "Categorías", detail: "Organiza el catálogo para que productos y reportes puedan filtrarse de forma consistente." },
      { title: "Impresora térmica", detail: "Configura la conexión disponible, tamaño del ticket y comportamiento de reconexión según el equipo." },
      { title: "Preferencias", detail: "Revisa las opciones de funcionamiento y apariencia antes de entregarle el sistema al equipo." }
    ]
  },
  {
    id: "equipo", title: "Equipo y permisos", icon: Users,
    summary: "Cada trabajador debe tener solamente el acceso que necesita.",
    steps: [
      { title: "Invitar", detail: "Envía una invitación al correo del trabajador. La persona debe completar el flujo de invitación para entrar al espacio correcto." },
      { title: "Rol", detail: "Asigna el rol adecuado según la responsabilidad del trabajador." },
      { title: "Permisos", detail: "Los permisos controlan qué módulos y acciones puede ejecutar cada persona." },
      { title: "Revisión", detail: "Cuando cambie una responsabilidad, revisa el acceso del trabajador para evitar permisos innecesarios." }
    ]
  },
  {
    id: "plan", title: "Plan y límites", icon: CircleDollarSign,
    summary: "El plan determina las capacidades y límites disponibles.",
    steps: [
      { title: "Consultar plan", detail: "Revisa el plan actual y sus características desde la sección Plan." },
      { title: "Límites", detail: "PALMYRA valida límites importantes también en la base de datos para evitar que una interfaz alterada los salte." },
      { title: "Cambios", detail: "Cuando un cambio de plan sea aprobado por administración, el contexto del CRM se actualiza sin exigir un proceso manual al trabajador." }
    ]
  },
  {
    id: "impresion", title: "Tickets e impresión", icon: Printer,
    summary: "Los comprobantes de venta, movimientos y cierre tienen funciones diferenciadas.",
    steps: [
      { title: "Ticket de venta", detail: "Representa los productos vendidos y sus pagos." },
      { title: "Comprobante de movimiento", detail: "Representa ingresos, egresos o gastos de caja y se mantiene separado del ticket de productos." },
      { title: "Cierre de caja", detail: "Resume el turno y puede generar su comprobante de cierre." },
      { title: "Formatos", detail: "La configuración de impresora contempla tickets térmicos compactos y tamaños mayores según el equipo." }
    ]
  }
];

function Flow({ labels }: { labels: string[] }) {
  return (
    <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
      {labels.map((label, index) => (
        <div key={label} className="flex shrink-0 items-center gap-1.5">
          <div className="rounded-xl border border-violet-100 bg-white px-2.5 py-2 text-[8px] font-black uppercase tracking-wide text-violet-700 shadow-sm">
            {label}
          </div>
          {index < labels.length - 1 ? <ArrowRight className="h-3.5 w-3.5 shrink-0 text-violet-300" /> : null}
        </div>
      ))}
    </div>
  );
}

function TutorialCard({ section, open, onToggle }: { section: TutorialSection; open: boolean; onToggle: () => void }) {
  const Icon = section.icon;
  return (
    <article className="overflow-hidden rounded-2xl border border-violet-100 bg-white shadow-sm">
      <button type="button" onClick={onToggle} className="flex w-full items-center gap-3 p-4 text-left transition hover:bg-violet-50/40">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-violet-100 text-violet-700"><Icon className="h-5 w-5" /></span>
        <span className="min-w-0 flex-1">
          <span className="block text-[11px] font-black text-slate-900">{section.title}</span>
          <span className="mt-1 block text-[9px] font-medium leading-4 text-slate-500">{section.summary}</span>
        </span>
        <ChevronDown className={`h-4 w-4 shrink-0 text-slate-400 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open ? (
        <div className="border-t border-violet-50 bg-violet-50/20 p-4">
          <div className="space-y-2.5">
            {section.steps.map((step) => (
              <div key={step.title} className="flex gap-3 rounded-xl border border-white bg-white/90 p-3">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                <div className="min-w-0">
                  <p className="text-[9px] font-black text-slate-800">{step.title}</p>
                  <p className="mt-1 text-[9px] leading-4 text-slate-500">{step.detail}</p>
                  {step.tip ? <p className="mt-2 rounded-lg bg-amber-50 px-2.5 py-2 text-[8px] font-bold leading-4 text-amber-800">Consejo: {step.tip}</p> : null}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </article>
  );
}

export default function Tutorial() {
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState("inicio");
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sections;
    return sections.filter((section) => [section.title, section.summary, ...section.steps.map((step) => step.title + " " + step.detail)].join(" ").toLowerCase().includes(q));
  }, [query]);

  return (
    <div className="min-h-full w-full bg-primary p-3 sm:p-5">
      <div className="mx-auto w-full max-w-6xl space-y-4">
        <header className="overflow-hidden rounded-3xl border border-violet-200 bg-gradient-to-br from-violet-700 via-indigo-600 to-violet-500 p-5 text-white shadow-xl sm:p-7">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <div className="flex items-center gap-2 text-violet-100">
                <BookOpen className="h-4 w-4" />
                <span className="text-[8px] font-black uppercase tracking-[.2em]">Guía completa de PALMYRA</span>
              </div>
              <h1 className="mt-2 text-2xl font-black tracking-tight sm:text-4xl">Aprende cómo funciona cada sección.</h1>
              <p className="mt-2 max-w-2xl text-[10px] font-semibold leading-5 text-violet-50 sm:text-[11px]">
                Un recorrido práctico para entender qué hace cada módulo, qué pasos seguir y cómo se conectan las operaciones.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:min-w-[260px]">
              <div className="rounded-2xl border border-white/15 bg-white/10 p-3 backdrop-blur-sm"><strong className="block text-xl">{sections.length}</strong><span className="text-[7px] font-black uppercase tracking-wider text-violet-100">Secciones</span></div>
              <div className="rounded-2xl border border-white/15 bg-white/10 p-3 backdrop-blur-sm"><strong className="block text-xl">{sections.reduce((n, s) => n + s.steps.length, 0)}</strong><span className="text-[7px] font-black uppercase tracking-wider text-violet-100">Pasos guiados</span></div>
            </div>
          </div>
        </header>

        <section className="rounded-2xl border border-violet-100 bg-white p-3 shadow-sm sm:p-4">
          <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5">
            <Search className="h-4 w-4 shrink-0 text-slate-400" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar cómo hacer algo en PALMYRA..." className="w-full bg-transparent text-[10px] font-bold text-slate-800 outline-none placeholder:text-slate-400" />
          </div>
        </section>

        <section className="rounded-2xl border border-emerald-100 bg-emerald-50/70 p-4">
          <div className="flex items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white text-emerald-600 shadow-sm"><Smartphone className="h-4 w-4" /></span>
            <div>
              <h2 className="text-[10px] font-black uppercase tracking-wider text-emerald-800">Flujo recomendado para comenzar</h2>
              <p className="mt-1 text-[9px] leading-4 text-emerald-700">Sigue este orden para dejar la empresa lista antes de vender.</p>
              <div className="mt-3"><Flow labels={["Empresa", "Almacén", "Categorías", "Productos", "Equipo", "POS", "Reportes"]} /></div>
            </div>
          </div>
        </section>

        <section className="grid gap-3 lg:grid-cols-2">
          {filtered.map((section) => (
            <TutorialCard key={section.id} section={section} open={openId === section.id} onToggle={() => setOpenId(openId === section.id ? "" : section.id)} />
          ))}
        </section>

        {filtered.length === 0 ? (
          <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center">
            <HelpCircle className="mx-auto h-7 w-7 text-violet-500" />
            <h3 className="mt-2 text-[11px] font-black text-slate-800">No encontramos esa guía</h3>
            <p className="mt-1 text-[9px] text-slate-500">Prueba con POS, inventario, ventas, caja, productos, equipo o reportes.</p>
          </div>
        ) : null}

        <footer className="rounded-2xl border border-violet-100 bg-white p-4 text-center">
          <p className="text-[8px] font-black uppercase tracking-[.16em] text-violet-600">¿Necesitas ayuda adicional?</p>
          <p className="mt-1 text-[9px] text-slate-500">Abre Soporte desde el menú para enviar una solicitud al equipo de PALMYRA.</p>
        </footer>
      </div>
    </div>
  );
}
