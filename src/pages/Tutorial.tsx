import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  AlertTriangle, ArrowLeft, ArrowLeftRight, ArrowRight, BarChart3, BookOpen,
  CheckCircle2, ChevronRight, ClipboardCheck, Clock, CreditCard, Download,
  ExternalLink, FileBarChart2, FileText, GraduationCap, Headphones, Home, KeyRound, Lightbulb,
  MapPin, Package, RotateCcw, Search, Settings, ShieldCheck, ShoppingCart,
  Sparkles, Target, Truck, Users, WifiOff, X,
  type LucideIcon,
} from "lucide-react";
import { cn } from "../lib/utils";

type Level = "Básico" | "Intermedio" | "Avanzado";

type ScreenZone = {
  n: number;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
};

type LessonStep = {
  title: string;
  detail: string;
  where?: string;
  note?: string;
  zone?: number;
};

type Lesson = {
  id: string;
  title: string;
  short: string;
  icon: LucideIcon;
  level: Level;
  minutes: number;
  summary: string;
  objective: string;
  prereq?: string;
  result: string;
  route?: string;
  routeLabel?: string;
  figureTitle: string;
  shell?: "app" | "modal" | "network";
  flow: string[];
  zones: ScreenZone[];
  steps: LessonStep[];
  mistakes: string[];
  related: string[];
};

const PROGRESS_KEY = "palmyra.school.progress.v1";

const lessons: Lesson[] = [
  {
    id: "inicio",
    title: "Preparar tu negocio antes de vender",
    short: "Preparar el negocio",
    icon: Home,
    level: "Básico",
    minutes: 6,
    summary: "Empresa, almacén, monedas, categorías, impresora y primer producto: la base de todo lo demás.",
    objective: "Dejar la cuenta lista para que las ventas, el stock y los tickets salgan correctos desde el primer día.",
    result: "Un almacén activo, monedas configuradas y al menos un producto con existencia.",
    route: "/settings",
    routeLabel: "Abrir Configuración",
    figureTitle: "Configuración inicial de la empresa",
    flow: ["Empresa", "Almacén", "Monedas", "Categorías", "Impresora", "Producto"],
    zones: [
      { n: 1, label: "Datos de la empresa", x: 18, y: 10, w: 38, h: 20 },
      { n: 2, label: "Almacenes y sucursales", x: 58, y: 10, w: 40, h: 20 },
      { n: 3, label: "Monedas y tasas", x: 18, y: 32, w: 38, h: 20 },
      { n: 4, label: "Categorías", x: 58, y: 32, w: 40, h: 20 },
      { n: 5, label: "Impresora y tickets", x: 18, y: 54, w: 38, h: 18 },
      { n: 6, label: "Crear el primer producto", x: 58, y: 54, w: 40, h: 18 },
    ],
    steps: [
      {
        title: "Completa los datos de la empresa",
        detail: "Entra al menú lateral y abre Configuración. En Empresa revisa el nombre comercial, la dirección y el teléfono: esos datos aparecen impresos en cada ticket y en los comprobantes de cierre.",
        where: "Menú lateral → Configuración → Empresa",
        zone: 1,
      },
      {
        title: "Crea el almacén donde vas a operar",
        detail: "En Configuración → Almacenes crea tu sucursal o almacén principal. Todo el stock, las ventas y los cierres pertenecen a un almacén; si operas en el equivocado, los reportes saldrán separados y ningún traslado cuadrará.",
        where: "Configuración → Almacenes → Nuevo almacén",
        note: "Si ya tienes varias sucursales, deja creadas todas antes de cargar inventario.",
        zone: 2,
      },
      {
        title: "Revisa las monedas y sus tasas",
        detail: "PALMYRA guarda los precios en la moneda base (normalmente CUP) y usa la tasa de cada divisa solo para convertir en el momento del cobro. La pantalla Tasa de cambio muestra el mercado, pero no modifica los precios de tus productos.",
        where: "Configuración → Monedas · Menú lateral → Tasa de cambio",
        zone: 3,
      },
      {
        title: "Organiza las categorías",
        detail: "Crea las categorías que usarás para agrupar productos: bebidas, alimentos, aseo, etc. Las categorías alimentan los filtros de Inventario y los reportes por línea de producto.",
        where: "Configuración → Categorías",
        zone: 4,
      },
      {
        title: "Configura la impresora del ticket",
        detail: "En Configuración → Impresora y comprobantes elige el ancho (58 mm u 80 mm), añade logo, dirección, teléfono y pie de ticket. Puedes vincular una impresora Bluetooth BLE o por cable USB/Serie y activar «Siempre conectar».",
        where: "Configuración → Impresora y comprobantes",
        zone: 5,
      },
      {
        title: "Crea el primer producto",
        detail: "Abre Inventario → Agregar producto y completa datos, precio y existencia del almacén. Sin productos con stock no se puede vender, aunque el turno esté abierto.",
        where: "Inventario → Agregar producto",
        note: "Guarda el código de barras: acelera muchísimo la venta en el POS.",
        zone: 6,
      },
    ],
    mistakes: [
      "Vender en un almacén distinto al que tiene la mercancía.",
      "Cambiar la tasa de cambio esperando que los precios se actualicen solos: los precios son independientes.",
      "Empezar a vender sin impresora configurada y descubrirlo al cerrar la primera venta.",
    ],
    related: ["inventario", "pos-apertura", "configuracion"],
  },
  {
    id: "dashboard",
    title: "Leer el Dashboard y moverte por PALMYRA",
    short: "Dashboard y menú",
    icon: BarChart3,
    level: "Básico",
    minutes: 4,
    summary: "El Dashboard resume el negocio; el menú lateral agrupa todo por Operación, Gestión, Finanzas y Administración.",
    objective: "Encontrar cualquier módulo en segundos y entender qué significan los indicadores principales.",
    result: "Sabes dónde está cada herramienta y cómo revisar el pulso diario del negocio.",
    route: "/",
    routeLabel: "Abrir Dashboard",
    figureTitle: "Mapa del Dashboard",
    flow: ["Menú", "Sucursal", "Indicadores", "Actividad", "Módulo"],
    zones: [
      { n: 1, label: "Menú por áreas", x: 1, y: 10, w: 12, h: 82 },
      { n: 2, label: "Indicadores del día", x: 18, y: 10, w: 80, h: 22 },
      { n: 3, label: "Accesos rápidos", x: 18, y: 34, w: 38, h: 26 },
      { n: 4, label: "Sucursal activa", x: 58, y: 34, w: 40, h: 12 },
      { n: 5, label: "Actividad reciente", x: 58, y: 48, w: 40, h: 32 },
    ],
    steps: [
      {
        title: "Usa el menú por áreas, no de memoria",
        detail: "El menú lateral está agrupado: Operación (POS, cotizaciones, transferencias, devoluciones), Gestión (clientes, inventario, auditoría, proveedores), Finanzas (bancos, reportes) y Administración (configuración, equipo, plan, tutorial).",
        where: "Barra lateral izquierda",
        zone: 1,
      },
      {
        title: "Confirma la sucursal antes de mirar cifras",
        detail: "Los indicadores y reportes responden a la sucursal activa. Si tienes más de un almacén, revisa el selector antes de sacar conclusiones: un total bajo puede ser simplemente otra sucursal seleccionada.",
        where: "Selector de sucursal en la cabecera",
        note: "El cajero solo trabaja con su turno y almacén asignado.",
        zone: 4,
      },
      {
        title: "Lee los indicadores como señales, no como contabilidad",
        detail: "Ventas del día, ticket promedio y productos con stock bajo te avisan dónde mirar. La ganancia real se confirma en Reportes, restando costo y movimientos.",
        where: "Tarjetas superiores del Dashboard",
        zone: 2,
      },
      {
        title: "Salta a la tarea desde los accesos rápidos",
        detail: "Cada acceso abre el módulo relacionado. Si vas a vender, entra por POS; si vas a reponer, por Inventario. Así evitas navegar sección por sección.",
        where: "Accesos rápidos del Dashboard",
        zone: 3,
      },
      {
        title: "Revisa la actividad reciente",
        detail: "La lista muestra las últimas operaciones registradas. Úsala para confirmar que una venta o un cierre quedó guardado antes de cerrar el navegador.",
        where: "Panel de actividad",
        zone: 5,
      },
    ],
    mistakes: [
      "Comparar dos días sin fijarse en la sucursal o el filtro de fecha activo.",
      "Confundir facturación con ganancia: la ganancia descuenta costo y devoluciones.",
      "Cerrar la app sin verificar que la venta aparece en la actividad reciente.",
    ],
    related: ["reportes", "inicio"],
  },
  {
    id: "pos-apertura",
    title: "Abrir el turno de caja",
    short: "Abrir turno",
    icon: KeyRound,
    level: "Básico",
    minutes: 5,
    summary: "El turno es la unidad de control de la caja: empleado, almacén y fondo inicial. Sin turno abierto no hay ventas.",
    objective: "Abrir un turno correcto, con el empleado y el almacén reales.",
    prereq: "Empleados creados y almacén configurado.",
    result: "Una caja abierta, asignada a un empleado y lista para cobrar.",
    route: "/pos",
    routeLabel: "Abrir POS",
    figureTitle: "Pantalla Abrir Caja",
    shell: "modal",
    flow: ["Empleado", "Contraseña", "Sucursal", "Fondo", "Abrir caja"],
    zones: [
      { n: 1, label: "Empleado del turno", x: 18, y: 16, w: 34, h: 14 },
      { n: 2, label: "Contraseña", x: 54, y: 16, w: 28, h: 14 },
      { n: 3, label: "Sucursal / almacén", x: 18, y: 34, w: 34, h: 14 },
      { n: 4, label: "Fondo inicial", x: 54, y: 34, w: 28, h: 14 },
      { n: 5, label: "Abrir Caja y Comenzar", x: 18, y: 60, w: 64, h: 12 },
      { n: 6, label: "Resumen del turno anterior", x: 18, y: 76, w: 64, h: 10 },
    ],
    steps: [
      {
        title: "Elige el empleado que realmente cobra",
        detail: "En «Empleado del turno» selecciona a la persona que estará frente a la caja. El vendedor de todas las ventas queda fijado aquí: no se elige producto por producto más adelante.",
        where: "POS → Abrir Caja → Empleado del turno",
        zone: 1,
      },
      {
        title: "Confirma con la contraseña correcta",
        detail: "Escribe la contraseña del empleado o la contraseña de administrador de PALMYRA. Si el empleado no tiene contraseña, el administrador debe asignarla desde Equipo.",
        where: "POS → Abrir Caja → Contraseña",
        note: "No compartas contraseñas: cada turno debe quedar asociado a la persona que opera.",
        zone: 2,
      },
      {
        title: "Selecciona la sucursal que vas a operar",
        detail: "La caja solo puede vender del almacén seleccionado. Si el turno se abre en otra sucursal, las ventas y el cierre quedarán en el lugar equivocado.",
        where: "POS → Abrir Caja → Sucursal / Almacén a Operar",
        zone: 3,
      },
      {
        title: "Cuenta el fondo y regístralo",
        detail: "Escribe el efectivo real con el que comienza la caja (Fondo Inicial en CUP). Ese monto será la base del arqueo: si pones un número inventado, el cierre mostrará una diferencia que no existe.",
        where: "POS → Abrir Caja → Fondo Inicial (CUP)",
        zone: 4,
      },
      {
        title: "Abre la caja",
        detail: "Pulsa «Abrir Caja y Comenzar». PALMYRA crea el turno, lo asocia al empleado y almacén, y habilita la venta. Si ya existe un turno abierto en esa caja, el sistema lo bloquea.",
        where: "POS → Abrir Caja y Comenzar",
        zone: 5,
      },
      {
        title: "Revisa cómo quedó el turno anterior",
        detail: "Antes de abrir puedes consultar «Ver Resumen de Turno Anterior» para comprobar el cierre previo. Si la app se cerró de golpe, al volver pedirá la contraseña para reanudar el mismo turno.",
        where: "POS → Ver Resumen de Turno Anterior",
        zone: 6,
      },
    ],
    mistakes: [
      "Abrir el turno con un fondo que no coincide con el efectivo contado.",
      "Seleccionar otra sucursal porque «se veía más cómoda»: el stock y el cierre quedarán separados.",
      "Intentar vender sin turno: el POS muestra «No existe un turno de caja activo».",
    ],
    related: ["pos-venta", "cierre", "equipo"],
  },
  {
    id: "pos-venta",
    title: "Vender, cobrar y entregar el ticket",
    short: "Vender en el POS",
    icon: ShoppingCart,
    level: "Básico",
    minutes: 7,
    summary: "Buscar, agregar, identificar al cliente, cobrar en una o varias formas de pago y entregar el comprobante.",
    objective: "Registrar una venta completa sin dejar productos, pagos ni cliente por fuera.",
    prereq: "Turno abierto y productos con stock.",
    result: "Venta confirmada, pago conciliado y ticket impreso o compartido.",
    route: "/pos",
    routeLabel: "Abrir POS",
    figureTitle: "Pantalla de venta del POS",
    flow: ["Buscar", "Carrito", "Cliente", "Cobrar", "Pago", "Ticket"],
    zones: [
      { n: 1, label: "Buscador / código", x: 17, y: 10, w: 56, h: 10 },
      { n: 2, label: "Catálogo de productos", x: 17, y: 22, w: 56, h: 52 },
      { n: 3, label: "Ticket de Venta", x: 75, y: 10, w: 23, h: 64 },
      { n: 4, label: "Consumidor Final / Cliente", x: 17, y: 76, w: 28, h: 16 },
      { n: 5, label: "Cobrar", x: 47, y: 76, w: 26, h: 16 },
      { n: 6, label: "Imprimir / WhatsApp", x: 75, y: 76, w: 23, h: 16 },
    ],
    steps: [
      {
        title: "Busca por nombre o escanea el código",
        detail: "Usa el buscador para encontrar el producto por nombre, SKU o código de barras. Con lector, el producto entra directo al carrito y se evita el error de teclear el precio.",
        where: "POS → Buscador superior",
        note: "Si el producto no aparece, revisa que tenga stock en la sucursal del turno.",
        zone: 1,
      },
      {
        title: "Confirma cantidad y variante",
        detail: "Agrega el producto y revisa en el catálogo el stock, la variante (talla, color) y la cantidad. Los productos con variantes descuentan existencias de la variante exacta.",
        where: "POS → Catálogo → Tarjeta del producto",
        zone: 2,
      },
      {
        title: "Revisa el carrito antes de cobrar",
        detail: "El panel derecho «Ticket de Venta» muestra líneas, cantidades, descuentos y total. Es tu última oportunidad para quitar una línea o corregir cantidad sin dejar rastro contable.",
        where: "POS → Ticket de Venta",
        zone: 3,
      },
      {
        title: "Identifica al cliente si hace falta",
        detail: "Por defecto la venta va a «Consumidor Final». Si necesitas historial o garantía, usa «Registrar Cliente» o selecciona una ficha existente. La venta quedará vinculada para devoluciones y reportes.",
        where: "POS → Consumidor Final / Registrar Cliente",
        zone: 4,
      },
      {
        title: "Cobra con uno o varios métodos",
        detail: "Pulsa «Cobrar», elige Efectivo o Transferencia y la moneda. Puedes combinar pagos si el cliente entrega parte en efectivo y parte por transferencia; PALMYRA calcula el cambio y valida el total.",
        where: "POS → Cobrar",
        zone: 5,
      },
      {
        title: "Entrega el ticket",
        detail: "Al confirmar el pago se abre el comprobante. Puedes imprimirlo en la térmica configurada o compartirlo por WhatsApp. El ticket de venta es independiente del comprobante de un ingreso o egreso de caja.",
        where: "Ticket → Imprimir Ticket / WhatsApp",
        note: "Si la impresora no responde, comparte el ticket y no repitas la venta: ya quedó registrada.",
        zone: 6,
      },
    ],
    mistakes: [
      "Buscar por nombre cuando el código de barras está disponible y es más rápido y seguro.",
      "Cobrar sin revisar cantidad o variante en el carrito.",
      "Repetir la venta porque la impresora falló: el ticket ya existe y se duplicaría la operación.",
      "Intentar vender con un turno de otro empleado: el sistema lo bloquea.",
    ],
    related: ["pos-apertura", "cierre", "clientes", "devoluciones"],
  },
  {
    id: "cierre",
    title: "Arqueo y cierre de turno (POS y Reportes)",
    short: "Cerrar turno",
    icon: CheckCircle2,
    level: "Intermedio",
    minutes: 6,
    summary: "Cuenta el efectivo y las transferencias, compara con lo esperado, documenta diferencias y cierra el turno.",
    objective: "Cerrar el turno sin dejar la caja abierta ni diferencias sin explicación.",
    prereq: "Turno abierto con ventas o movimientos registrados.",
    result: "Turno cerrado, comprobante de cierre y descuadre documentado si existe.",
    route: "/reports",
    routeLabel: "Cerrar desde Reportes",
    figureTitle: "Pantalla Caja y Ventas del Turno",
    shell: "modal",
    flow: ["Cerrar Caja", "Ventas", "Movimientos", "Arqueo", "Diferencia", "Cerrar"],
    zones: [
      { n: 1, label: "Pestañas del turno", x: 18, y: 10, w: 64, h: 8 },
      { n: 2, label: "Ventas del Turno", x: 18, y: 22, w: 30, h: 14 },
      { n: 3, label: "Movimientos de caja", x: 50, y: 22, w: 30, h: 14 },
      { n: 4, label: "Arqueo: efectivo y esperado", x: 18, y: 38, w: 62, h: 14 },
      { n: 5, label: "Cerrar Turno y Finalizar", x: 18, y: 58, w: 64, h: 12 },
      { n: 6, label: "Forzar Cierre (con diferencia)", x: 18, y: 74, w: 64, h: 10 },
    ],
    steps: [
      {
        title: "Abre el cierre desde POS o desde Reportes",
        detail: "En el POS pulsa «Cerrar Caja». También puedes cerrar desde Reportes → pestaña Cajas → botón «Cerrar» del turno abierto, o desde Ventas → Por Turnos. Ambos caminos usan el mismo arqueo.",
        where: "POS → Cerrar Caja · Reportes → Cajas → Cerrar",
        note: "Si el turno no aparece en Reportes, revisa el filtro de Estado: debe estar en «Abiertos» o «Todos».",
        zone: 1,
      },
      {
        title: "Revisa las ventas del turno",
        detail: "La pestaña «Ventas del Turno» muestra Tickets, Productos y Egreso y gasto, además de tarjetas por forma de pago. Úsala para detectar una venta que no debería estar o un gasto sin comprobante.",
        where: "Caja y Ventas del Turno → Ventas del Turno",
        zone: 2,
      },
      {
        title: "Registra los movimientos antes de cerrar",
        detail: "En «Movimientos» añade ingresos y egresos con moneda, monto y descripción. Hazlo antes del cierre: después el turno queda cerrado y no admite movimientos nuevos.",
        where: "Caja y Ventas del Turno → Movimientos",
        zone: 3,
      },
      {
        title: "Cuenta el efectivo real y decláralo",
        detail: "En «Arqueo y Cierre» escribe lo que realmente hay en caja por moneda y método. El sistema muestra «Esperado en arqueo» al lado. No escribas lo que crees que debería haber: cuenta billetes y monedas.",
        where: "Arqueo y Cierre → Efectivo CUP / Transferencias",
        zone: 4,
      },
      {
        title: "Decide qué hacer si hay diferencia",
        detail: "Si lo declarado no coincide, aparece «Discrepancia Detectada». Puedes volver a revisar el conteo o «Forzar Cierre». Si el faltante es del empleado, el sistema permite descontarlo del salario; el cierre quedará en Descuadres para conciliación.",
        where: "Discrepancia Detectada → Volver a Revisar / Forzar Cierre",
        zone: 6,
      },
      {
        title: "Confirma el cierre y guarda el comprobante",
        detail: "Pulsa «Cerrar Turno y Finalizar» (o desde Reportes: «Confirmar y cerrar turno»). El turno pasa a cerrado, se calcula la liquidación y puedes imprimir el comprobante. Si la nube no responde, el cierre se guarda en el dispositivo y se sincroniza al reconectar.",
        where: "Cerrar Turno y Finalizar · Confirmar y cerrar turno",
        note: "Desde Reportes, declara también las transferencias: dejarlas en blanco se registra como faltante.",
        zone: 5,
      },
    ],
    mistakes: [
      "Declarar solo el efectivo y dejar las transferencias vacías: el sistema lo interpreta como faltante.",
      "Cerrar sin revisar «Ventas del Turno» y descubrir un gasto mal registrado después.",
      "Olvidar que el turno ya no acepta movimientos una vez cerrado.",
      "Cerrar un turno ajeno desde la caja del empleado: cada cuenta opera su propio turno.",
    ],
    related: ["reportes", "pos-venta", "bancos"],
  },
  {
    id: "inventario",
    title: "Inventario: productos, stock y herramientas",
    short: "Inventario",
    icon: Package,
    level: "Básico",
    minutes: 7,
    summary: "Filtra, crea productos con variantes, controla existencias por almacén y usa Excel, etiquetas y análisis ABC.",
    objective: "Mantener un catálogo limpio y existencias confiables para vender sin sorpresas.",
    prereq: "Almacén y categorías creados.",
    result: "Productos con precio, variantes y stock correcto en cada almacén.",
    route: "/inventory",
    routeLabel: "Abrir Inventario",
    figureTitle: "Pantalla de Inventario",
    flow: ["Filtrar", "Producto", "Variantes", "Precio", "Stock", "Herramientas"],
    zones: [
      { n: 1, label: "Buscador", x: 17, y: 10, w: 30, h: 9 },
      { n: 2, label: "Filtros de sucursal/stock", x: 49, y: 10, w: 49, h: 9 },
      { n: 3, label: "Agregar producto", x: 17, y: 21, w: 26, h: 10 },
      { n: 4, label: "Tabla de stock", x: 17, y: 33, w: 56, h: 55 },
      { n: 5, label: "Excel · Etiquetas · ABC", x: 75, y: 21, w: 23, h: 22 },
      { n: 6, label: "Lista / Cuadrícula", x: 75, y: 45, w: 23, h: 10 },
    ],
    steps: [
      {
        title: "Filtra antes de tocar cualquier cosa",
        detail: "Selecciona Sucursal, Categoría y Stock (con stock, bajos o cero). El filtro evita editar el producto equivocado cuando tienes cientos de referencias.",
        where: "Inventario → Filtros superiores",
        zone: 2,
      },
      {
        title: "Crea el producto con sus datos completos",
        detail: "«Agregar producto» abre tres bloques: Datos del producto, Variantes y Precios y extras. Nombre, SKU, código de barras, categoría y costo deben quedar bien desde el inicio.",
        where: "Inventario → Agregar producto",
        zone: 3,
      },
      {
        title: "Usa un solo eje de variantes",
        detail: "Si un producto se vende en talla o color con existencias separadas, crea variantes en un único eje: tallas o colores, nunca ambos. Si comparten stock y precio, no dupliques la ficha, y recuerda que el SKU debe ser único.",
        where: "Agregar producto → Variantes",
        zone: 3,
      },
      {
        title: "Verifica precio y existencia por almacén",
        detail: "La tabla muestra el stock del almacén filtrado. Si el conteo físico no coincide, no edites la cantidad a mano: abre Inventario → Auditoría, cuenta y aprueba; el ajuste se aplica por variante y conserva el historial.",
        where: "Inventario → Tabla de productos · Inventario → Auditoría",
        note: "El stock bajo o en cero aparece con señales de color y en los filtros rápidos.",
        zone: 4,
      },
      {
        title: "Aprovecha Excel, etiquetas y ABC",
        detail: "La barra de acciones abre exportación/importación Excel, impresión de etiquetas y análisis ABC (productos que más rotan). En móvil desliza la barra horizontalmente para ver todas las opciones.",
        where: "Inventario → Excel / Etiquetas / Análisis ABC",
        zone: 5,
      },
      {
        title: "Cambia entre lista y cuadrícula",
        detail: "La vista Lista es mejor para revisar datos y la Cuadrícula para reconocer productos por imagen. También existe Edición Masiva para actualizar precios o categorías en lote.",
        where: "Inventario → Vistas / Edición Masiva",
        zone: 6,
      },
    ],
    mistakes: [
      "Crear dos fichas para el mismo producto y repartir el stock entre ambas.",
      "Olvidar la variante y descontar existencias del producto equivocado.",
      "Ajustar stock a mano en vez de usar Auditoría, perdiendo la trazabilidad.",
      "Exportar Excel o imprimir etiquetas sin el plan Ciudadela.",
    ],
    related: ["auditoria", "transferencias", "proveedores"],
  },
  {
    id: "transferencias",
    title: "Transferencias entre almacenes",
    short: "Transferencias",
    icon: ArrowLeftRight,
    level: "Intermedio",
    minutes: 5,
    summary: "Mueve mercancía en dos fases: envío (sale del origen) y recepción (entra al destino), con seguimiento en tránsito.",
    objective: "Mover stock sin perder trazabilidad ni dejar mercancía «en el aire».",
    prereq: "Dos almacenes creados y plan Caravana.",
    result: "Mercancía descontada del origen y sumada al destino con historial.",
    route: "/transfers",
    routeLabel: "Abrir Transferencias",
    figureTitle: "Pantalla de Transferencias",
    flow: ["Origen", "Destino", "Productos", "Confirmar envío", "Tránsito", "Recibir"],
    zones: [
      { n: 1, label: "Origen de mercancía", x: 17, y: 10, w: 38, h: 20 },
      { n: 2, label: "Destino de mercancía", x: 57, y: 10, w: 41, h: 20 },
      { n: 3, label: "Productos y cantidades", x: 17, y: 32, w: 56, h: 42 },
      { n: 4, label: "Confirmar Envío", x: 17, y: 76, w: 30, h: 14 },
      { n: 5, label: "Mercancía en tránsito", x: 49, y: 76, w: 24, h: 14 },
      { n: 6, label: "Recibir mercancía", x: 75, y: 32, w: 23, h: 42 },
    ],
    steps: [
      {
        title: "Elige origen y destino correctos",
        detail: "Selecciona «Origen de Mercancía» y «Destino de Mercancía». El origen es el almacén que entrega y el destino el que recibe; invertirlos mueve el stock en dirección contraria.",
        where: "Transferencias → Origen / Destino",
        zone: 1,
      },
      {
        title: "Agrega productos y cantidades reales",
        detail: "Busca productos y define cuánto sale físicamente. No puedes enviar más de lo que existe en el origen; si el sistema lo permite, estás operando en el almacén equivocado.",
        where: "Transferencias → Buscador de productos",
        zone: 3,
      },
      {
        title: "Confirma el envío",
        detail: "«Confirmar Envío» descuenta el stock del origen y deja la mercancía en tránsito. Todavía no pertenece al destino hasta que alguien la reciba.",
        where: "Transferencias → Confirmar Envío",
        zone: 4,
      },
      {
        title: "Recibe contando la mercancía",
        detail: "En el destino abre «Recibir mercancía» y confirma lo que llegó. Si falta algo, no lo recibas completo: la diferencia debe quedar documentada en el origen.",
        where: "Transferencias → Mercancía en tránsito → Recibir",
        note: "La recepción es la que suma stock al destino. Sin recepción, el stock queda en tránsito.",
        zone: 6,
      },
      {
        title: "Revisa el historial y el estado",
        detail: "Cada transferencia conserva origen, destino, productos, fecha y estado. Consulta el historial cuando un almacén reporte faltantes o diferencias.",
        where: "Transferencias → Historial",
        zone: 5,
      },
    ],
    mistakes: [
      "Invertir origen y destino.",
      "Recibir sin contar y descubrir el faltante días después.",
      "Cancelar una transferencia ya recibida en lugar de corregir con una devolución o auditoría.",
    ],
    related: ["inventario", "auditoria", "plan"],
  },
  {
    id: "auditoria",
    title: "Auditoría de inventario",
    short: "Auditoría",
    icon: ClipboardCheck,
    level: "Avanzado",
    minutes: 6,
    summary: "Compara el conteo físico con el sistema mediante snapshot, recuento y revisión antes de ajustar.",
    objective: "Detectar y corregir diferencias de stock con evidencia y trazabilidad.",
    prereq: "Inventario cargado y plan Crecimiento.",
    result: "Auditoría aprobada con el stock ajustado y documentado.",
    route: "/inventory-audit",
    routeLabel: "Abrir Auditoría",
    figureTitle: "Pantalla de Auditoría",
    flow: ["Sucursal", "Tipo de conteo", "Iniciar", "Revisión", "Aprobar"],
    zones: [
      { n: 1, label: "Sucursal a auditar", x: 17, y: 10, w: 30, h: 10 },
      { n: 2, label: "Tipo de conteo", x: 49, y: 10, w: 30, h: 10 },
      { n: 3, label: "Iniciar conteo y snapshot", x: 17, y: 22, w: 81, h: 10 },
      { n: 4, label: "Conteo de cantidades", x: 17, y: 36, w: 81, h: 16 },
      { n: 5, label: "Enviar a revisión", x: 17, y: 56, w: 38, h: 12 },
      { n: 6, label: "Aprobar y ajustar stock", x: 57, y: 56, w: 41, h: 12 },
    ],
    steps: [
      {
        title: "Selecciona la sucursal y el tipo de conteo",
        detail: "Elige la sucursal correcta. «Conteo cíclico» audita una parte del catálogo; «Inventario físico» revisa todo. Solo puede existir una auditoría abierta por sucursal.",
        where: "Auditoría → Sucursal / Tipo de conteo",
        zone: 1,
      },
      {
        title: "Inicia el conteo y toma el snapshot",
        detail: "«Iniciar conteo y tomar snapshot» congela la referencia del stock en ese momento. Las ventas que ocurran después se detectan y pueden invalidar la aprobación si cambian el stock.",
        where: "Auditoría → Iniciar conteo y tomar snapshot",
        note: "Evita vender o recibir mercancía durante el conteo del mismo almacén.",
        zone: 3,
      },
      {
        title: "Registra las cantidades contadas",
        detail: "Entra a cada producto y escribe la cantidad física. Si algo no cuadra, puedes pedir un recuento antes de enviar a revisión; no ajustes el stock todavía.",
        where: "Auditoría → Productos → Cantidad contada",
        zone: 4,
      },
      {
        title: "Envía el conteo a revisión",
        detail: "«Enviar conteo a revisión» bloquea la captura y deja la auditoría lista para que un responsable revise diferencias y evidencias.",
        where: "Auditoría → Enviar conteo a revisión",
        zone: 5,
      },
      {
        title: "Aprueba y ajusta el stock",
        detail: "«Aprobar y ajustar stock» aplica los ajustes. Si el stock cambió desde el snapshot, la aprobación se rechaza y debes repetir el conteo para no inventar existencias.",
        where: "Auditoría → Aprobar y ajustar stock",
        zone: 6,
      },
    ],
    mistakes: [
      "Auditar mientras se vende en el mismo almacén.",
      "Ajustar manualmente sin aprobar la auditoría, perdiendo la evidencia.",
      "Intentar abrir dos auditorías en la misma sucursal.",
    ],
    related: ["inventario", "reportes", "plan"],
  },
  {
    id: "clientes",
    title: "Clientes e historial de compras",
    short: "Clientes",
    icon: Users,
    level: "Básico",
    minutes: 4,
    summary: "Crea fichas, asígnalas a las ventas y consulta el historial sin perder la relación comercial.",
    objective: "Identificar a los clientes y conservar sus compras para consultas, garantías y reportes.",
    result: "Fichas limpias vinculadas a las ventas correctas.",
    route: "/customers",
    routeLabel: "Abrir Clientes",
    figureTitle: "Pantalla de Clientes",
    flow: ["Nuevo cliente", "Buscar", "Ficha", "Historial", "Acciones"],
    zones: [
      { n: 1, label: "Nuevo cliente", x: 17, y: 10, w: 24, h: 10 },
      { n: 2, label: "Buscador", x: 43, y: 10, w: 38, h: 10 },
      { n: 3, label: "Ficha / tabla", x: 17, y: 22, w: 56, h: 62 },
      { n: 4, label: "Historial de tickets", x: 75, y: 22, w: 23, h: 30 },
      { n: 5, label: "Editar / Eliminar", x: 75, y: 54, w: 23, h: 14 },
    ],
    steps: [
      {
        title: "Crea la ficha con datos útiles",
        detail: "«Nuevo cliente» pide los datos de contacto. Nombre y teléfono son suficientes para identificar; el correo ayuda a enviar tickets o PDFs.",
        where: "Clientes → Nuevo cliente",
        zone: 1,
      },
      {
        title: "Busca antes de crear",
        detail: "Usa el buscador por nombre o teléfono. Duplicar clientes hace que el historial quede partido y que las garantías busquen la venta equivocada.",
        where: "Clientes → Buscador",
        zone: 2,
      },
      {
        title: "Asócialo a la venta",
        detail: "En el POS, en lugar de «Consumidor Final», registra o selecciona al cliente. La venta guarda la relación y aparece en su ficha.",
        where: "POS → Registrar Cliente",
        zone: 3,
      },
      {
        title: "Consulta el historial",
        detail: "Abre la ficha para ver tickets, fechas, montos y estado. Es la ruta más rápida ante una devolución o una garantía.",
        where: "Clientes → Ficha → Historial",
        zone: 4,
      },
      {
        title: "Edita con cuidado; elimina solo si no hay ventas",
        detail: "Puedes actualizar los datos en cualquier momento. Si el cliente tiene ventas registradas, el sistema impide eliminarlo para no romper el historial.",
        where: "Clientes → Acciones",
        note: "Si necesita «desaparecer», edita sus datos en lugar de eliminar la ficha.",
        zone: 5,
      },
    ],
    mistakes: [
      "Crear un cliente nuevo por cada compra.",
      "Poner el nombre del negocio en lugar de la persona que compra.",
      "Intentar borrar un cliente con ventas: el sistema lo bloquea y está bien.",
    ],
    related: ["pos-venta", "devoluciones", "reportes"],
  },
  {
    id: "proveedores",
    title: "Proveedores y órdenes de compra",
    short: "Proveedores",
    icon: Truck,
    level: "Intermedio",
    minutes: 6,
    summary: "Registra proveedores, crea órdenes, recibe mercancía y controla los estados de cada compra.",
    objective: "Abastecer el negocio con órdenes trazables y stock actualizado al recibir.",
    prereq: "Plan Caravana (Compras).",
    result: "Orden recibida, proveedor vinculado y stock sumado al almacén.",
    route: "/suppliers",
    routeLabel: "Abrir Proveedores",
    figureTitle: "Pantalla de Proveedores y Compras",
    flow: ["Proveedor", "Orden", "Estado", "Recibir", "Stock"],
    zones: [
      { n: 1, label: "Pestañas Proveedores / Órdenes", x: 17, y: 10, w: 40, h: 8 },
      { n: 2, label: "Nuevo proveedor", x: 17, y: 20, w: 24, h: 10 },
      { n: 3, label: "Nueva orden", x: 43, y: 20, w: 24, h: 10 },
      { n: 4, label: "Estados de órdenes", x: 17, y: 32, w: 40, h: 14 },
      { n: 5, label: "Recibir mercancía", x: 59, y: 32, w: 39, h: 14 },
      { n: 6, label: "Cancelar orden", x: 59, y: 48, w: 39, h: 10 },
    ],
    steps: [
      {
        title: "Crea la ficha del proveedor",
        detail: "En Proveedores → «Nuevo proveedor» guarda nombre, contacto y datos comerciales. Sin ficha no puedes asociar la orden ni comparar compras.",
        where: "Proveedores → Nuevo proveedor",
        zone: 2,
      },
      {
        title: "Crea la orden de compra",
        detail: "«Nueva orden» define proveedor, productos y cantidades esperadas. La orden queda en Borrador o Pendiente hasta que la envíes o recibas mercancía.",
        where: "Proveedores → Órdenes → Nueva orden",
        zone: 3,
      },
      {
        title: "Sigue el estado de cada orden",
        detail: "Filtra por Pendientes, Recibidas, Canceladas o Borradores. El estado te dice si la mercancía sigue en camino o si ya entró al inventario.",
        where: "Proveedores → Órdenes → Estados",
        zone: 4,
      },
      {
        title: "Recibe contando la mercancía",
        detail: "Al recibir, verifica cantidades y costos reales. «Recibir mercancía» suma el stock al almacén y cambia la orden a Recibida.",
        where: "Proveedores → Recibir mercancía",
        note: "Si llega menos de lo pedido, recibe lo real y documenta la diferencia con el proveedor.",
        zone: 5,
      },
      {
        title: "Cancela solo lo que no llegó",
        detail: "«Cancelar orden» se usa cuando la compra no se va a recibir. Una orden ya recibida no se cancela: cualquier corrección se hace con devolución o ajuste documentado.",
        where: "Proveedores → Cancelar orden",
        zone: 6,
      },
    ],
    mistakes: [
      "Recibir sin contar y sumar stock que no existe.",
      "Cancelar una orden que ya entró al inventario.",
      "Borrar un proveedor con órdenes: el sistema lo impide.",
      "Crear órdenes sin plan Compras activo.",
    ],
    related: ["inventario", "plan", "reportes"],
  },
  {
    id: "cotizaciones",
    title: "Cotizaciones y PDF",
    short: "Cotizaciones",
    icon: FileText,
    level: "Intermedio",
    minutes: 5,
    summary: "Prepara presupuestos, controla vencimientos, genera PDF y convierte una cotización en venta en el POS.",
    objective: "Cotizar rápido y convertir la cotización aceptada en una venta sin repetir productos.",
    result: "Cotización enviada en PDF y, si se acepta, cargada en el POS.",
    route: "/quotes",
    routeLabel: "Abrir Cotizaciones",
    figureTitle: "Pantalla de Cotizaciones",
    flow: ["Nueva", "Cliente", "Productos", "PDF", "Cobrar en POS"],
    zones: [
      { n: 1, label: "Nueva cotización", x: 17, y: 10, w: 26, h: 10 },
      { n: 2, label: "Cliente y productos", x: 17, y: 22, w: 56, h: 58 },
      { n: 3, label: "Estados / vencimiento", x: 75, y: 10, w: 23, h: 18 },
      { n: 4, label: "Generar PDF", x: 75, y: 30, w: 23, h: 14 },
      { n: 5, label: "Cobrar en POS", x: 75, y: 46, w: 23, h: 14 },
    ],
    steps: [
      {
        title: "Crea la cotización",
        detail: "«Nueva cotización» abre la ficha con cliente, productos, cantidades y precios. Puedes guardar un borrador y completarlo después.",
        where: "Cotizaciones → Nueva cotización",
        zone: 1,
      },
      {
        title: "Revisa vencimiento y estado",
        detail: "Las cotizaciones pendientes y vencidas se agrupan por estado. Una cotización vencida sigue visible, pero deja claro que el precio ya no está garantizado.",
        where: "Cotizaciones → Estados",
        zone: 3,
      },
      {
        title: "Genera y envía el PDF",
        detail: "«PDF» produce el documento con los datos de tu empresa y el detalle. Envíalo al cliente y conserva el archivo como respaldo de lo cotizado.",
        where: "Cotización → PDF",
        zone: 4,
      },
      {
        title: "Cobra la cotización en el POS",
        detail: "Si el cliente acepta, «Cobrar en POS» abre el punto de venta. El empleado elige su nombre y almacén, y el carrito se llena automáticamente con los productos cotizados.",
        where: "Cotización → Cobrar en POS → POS",
        note: "La cotización no descuenta stock: la venta sí.",
        zone: 5,
      },
    ],
    mistakes: [
      "Cobrar una cotización vencida sin revisar precios.",
      "Abrir el POS desde la cotización sin elegir empleado y almacén.",
      "Duplicar la cotización en lugar de editarla.",
    ],
    related: ["pos-venta", "clientes"],
  },
  {
    id: "devoluciones",
    title: "Devoluciones y garantías",
    short: "Devoluciones",
    icon: RotateCcw,
    level: "Intermedio",
    minutes: 5,
    summary: "Vincula la devolución a la venta original, controla estados de garantía y decide reembolso o reposición.",
    objective: "Resolver una devolución sin romper el historial de ventas ni el inventario.",
    prereq: "Plan Ciudadela (Garantías y devoluciones).",
    result: "Caso registrado con la venta original y el resultado documentado.",
    route: "/returns",
    routeLabel: "Abrir Devoluciones",
    figureTitle: "Pantalla de Garantías y Devoluciones",
    flow: ["Pestaña", "Venta original", "Motivo", "Estado", "Resultado"],
    zones: [
      { n: 1, label: "Devoluciones / Garantías", x: 17, y: 10, w: 40, h: 8 },
      { n: 2, label: "Registrar devolución", x: 17, y: 20, w: 30, h: 10 },
      { n: 3, label: "Venta original", x: 49, y: 20, w: 30, h: 10 },
      { n: 4, label: "Estados de garantía", x: 17, y: 32, w: 81, h: 22 },
      { n: 5, label: "Reembolso / reposición", x: 17, y: 56, w: 38, h: 12 },
    ],
    steps: [
      {
        title: "Elige devolución o garantía",
        detail: "Son dos pestañas distintas. Una devolución devuelve dinero o cambia producto; una garantía atiende un defecto dentro del período. El estado del caso cambia según la decisión.",
        where: "Garantías y devoluciones → Pestañas",
        zone: 1,
      },
      {
        title: "Localiza la venta original",
        detail: "Busca por ticket o cliente. Sin la venta original no se puede validar precio, fecha ni condiciones; por eso el POS debe registrar al cliente cuando haya garantía.",
        where: "Devoluciones → Venta original",
        zone: 3,
      },
      {
        title: "Registra motivo y evidencia",
        detail: "Escribe el motivo real y adjunta la información disponible. El motivo alimenta los reportes y ayuda a detectar productos problemáticos.",
        where: "Registro de devolución → Motivo",
        zone: 2,
      },
      {
        title: "Decide el resultado",
        detail: "Puedes reembolsar, reponer el producto o cambiar el estado de la garantía (Vigente, Reclamada, Cambiada, Reembolsada, Expirada). Si devuelves al inventario, el stock se repone.",
        where: "Caso → Reembolso / Reposición",
        note: "Una devolución sin venta original se registra como ajuste manual, no como devolución.",
        zone: 5,
      },
    ],
    mistakes: [
      "Devolver sin localizar el ticket y perder el vínculo con la venta.",
      "Reponer stock de un producto dañado que no debe volver a venderse.",
      "Dejar el caso en Vigente después de reembolsar.",
    ],
    related: ["pos-venta", "clientes", "inventario"],
  },
  {
    id: "bancos",
    title: "Bancos, cuentas y transferencias",
    short: "Bancos",
    icon: CreditCard,
    level: "Intermedio",
    minutes: 5,
    summary: "Registra cuentas (BPA, BANDEC, BANMET, EnZona), mueve dinero y concilia sin mezclarlo con la caja.",
    objective: "Saber qué dinero está en banco y qué dinero está en caja, sin confusiones.",
    prereq: "Plan Caravana (Bancos).",
    result: "Movimientos bancarios registrados y conciliados con la realidad.",
    route: "/banks",
    routeLabel: "Abrir Bancos",
    figureTitle: "Pantalla de Bancos",
    flow: ["Cuenta", "Transferir", "Filtro", "Movimiento", "Conciliar"],
    zones: [
      { n: 1, label: "Nueva Cuenta / Tarjeta", x: 17, y: 10, w: 24, h: 10 },
      { n: 2, label: "Transferir", x: 43, y: 10, w: 24, h: 10 },
      { n: 3, label: "Filtro entradas/salidas", x: 69, y: 10, w: 29, h: 10 },
      { n: 4, label: "Movimientos bancarios", x: 17, y: 22, w: 56, h: 62 },
      { n: 5, label: "Conciliación", x: 75, y: 22, w: 23, h: 30 },
    ],
    steps: [
      {
        title: "Crea la cuenta correcta",
        detail: "«Nueva Cuenta / Tarjeta» registra banco (BPA, BANDEC, BANMET, EnZona), número y titular. Una cuenta por cada cuenta real evita movimientos cruzados.",
        where: "Bancos → Nueva Cuenta / Tarjeta",
        zone: 1,
      },
      {
        title: "Registra entradas y salidas",
        detail: "«Transferir» crea el movimiento entre cuentas o hacia un tercero. Guarda monto, moneda y referencia. Este movimiento es bancario: no modifica el efectivo del turno.",
        where: "Bancos → Transferir",
        zone: 2,
      },
      {
        title: "Filtra para auditar",
        detail: "Usa Todas, Entradas o Salidas y el rango de fechas para encontrar un movimiento. Revisa la referencia antes de concluir que falta dinero.",
        where: "Bancos → Filtros",
        zone: 3,
      },
      {
        title: "Concilia con el estado real",
        detail: "Compara el saldo de PALMYRA con el banco. Si no coincide, registra el movimiento faltante o corrige el existente; nunca ajustes la caja para «cuadrar» el banco.",
        where: "Bancos → Movimientos / Conciliación",
        zone: 5,
      },
    ],
    mistakes: [
      "Registrar una transferencia bancaria como ingreso de caja del turno.",
      "Mezclar varias cuentas reales en una sola cuenta de PALMYRA.",
      "Ajustar el cierre de caja para compensar un error bancario.",
    ],
    related: ["reportes", "cierre", "plan"],
  },
  {
    id: "reportes",
    title: "Reportes: leer, filtrar y cerrar turnos",
    short: "Reportes",
    icon: FileBarChart2,
    level: "Intermedio",
    minutes: 7,
    summary: "Resumen, ventas, cajas, descuadres, movimientos y nómina; filtros por fecha, almacén y personal; cierre de turno y Excel.",
    objective: "Encontrar la explicación de cualquier cifra y cerrar un turno abierto sin ir al POS.",
    prereq: "Permiso para ver reportes.",
    result: "Reportes filtrados correctamente y turnos cerrados desde Reportes cuando haga falta.",
    route: "/reports",
    routeLabel: "Abrir Reportes",
    figureTitle: "Pantalla de Reportes",
    flow: ["Pestaña", "Filtros", "Indicador", "Detalle", "Acción", "Excel"],
    zones: [
      { n: 1, label: "Pestañas de reportes", x: 17, y: 10, w: 81, h: 8 },
      { n: 2, label: "Filtros de fecha y almacén", x: 17, y: 20, w: 81, h: 8 },
      { n: 3, label: "Indicadores del periodo", x: 17, y: 30, w: 81, h: 16 },
      { n: 4, label: "Detalle de operaciones", x: 17, y: 48, w: 56, h: 36 },
      { n: 5, label: "Botón Cerrar del turno", x: 75, y: 48, w: 23, h: 14 },
      { n: 6, label: "Exportar a Excel", x: 75, y: 64, w: 23, h: 14 },
    ],
    steps: [
      {
        title: "Elige la pestaña según la pregunta",
        detail: "Resumen para totales, Ventas para tickets, Nómina para liquidaciones, Cajas para turnos, Descuadres para diferencias, Movimientos para ingresos/egresos y Transferencias para stock entre almacenes.",
        where: "Reportes → Pestañas superiores",
        zone: 1,
      },
      {
        title: "Acota con filtros antes de interpretar",
        detail: "Selecciona almacén, personal, fecha (Hoy, Ayer o un día concreto) y estado (Abiertos, Cerrados, Anulados). Un total sin filtro puede incluir varias sucursales o periodos.",
        where: "Reportes → Filtros",
        zone: 2,
      },
      {
        title: "Baja del indicador al detalle",
        detail: "Si una cifra no cuadra, abre el detalle del ticket o del turno. El detalle explica el porqué y permite acciones: «Eliminar venta» reintegra al almacén las unidades exactas por variante, revierte los cobros bancarios y guarda el motivo con el usuario.",
        where: "Reportes → Detalle / Imprimir",
        zone: 4,
      },
      {
        title: "Cierra un turno desde Reportes",
        detail: "En Cajas localiza el turno abierto y pulsa «Cerrar». También desde Ventas → Por Turnos. Se abre el modal «Cerrar Turno desde Reportes»: elige fecha, declara efectivo y transferencias por moneda, añade notas y pulsa «Confirmar y cerrar turno».",
        where: "Reportes → Cajas → Cerrar",
        note: "Si hay diferencia, el turno aparece en Descuadres. Si la nube falla, el cierre queda local y se sincroniza después.",
        zone: 5,
      },
      {
        title: "Documenta las diferencias",
        detail: "La pestaña Descuadres filtra faltantes, sobrantes, con descuento y pendientes. Úsala para conciliar la caja y explicar cada diferencia en lugar de dejarla sin revisar.",
        where: "Reportes → Descuadres",
        zone: 3,
      },
      {
        title: "Exporta a Excel cuando lo necesites",
        detail: "El botón Excel ofrece «Reporte completo (8 hojas)» y secciones sueltas: Ventas, Cajas, Nómina, Inventario, Resumen, Cuentas, Devoluciones, Descuadres, Movimientos y Traslados. Es una función del plan Ciudadela.",
        where: "Reportes → Excel",
        zone: 6,
      },
    ],
    mistakes: [
      "Comparar dos periodos con filtros distintos.",
      "Ver un turno «Cobrado» pero no cerrarlo: sigue abierto hasta que se cierra.",
      "Buscar el turno en Cajas con el filtro «Cerrados» puesto.",
      "Intentar exportar Excel sin plan Ciudadela.",
    ],
    related: ["cierre", "dashboard", "bancos", "plan"],
  },
  {
    id: "equipo",
    title: "Equipo, roles y permisos",
    short: "Equipo",
    icon: ShieldCheck,
    level: "Intermedio",
    minutes: 5,
    summary: "Crea empleados, asigna roles, define permisos y controla la liquidación del equipo.",
    objective: "Dar a cada persona solo el acceso que necesita para su trabajo.",
    result: "Empleados con rol correcto y permisos mínimos necesarios.",
    route: "/team",
    routeLabel: "Abrir Equipo",
    figureTitle: "Pantalla de Equipo",
    flow: ["Empleados", "Rol", "Permisos", "Pago", "Revisión"],
    zones: [
      { n: 1, label: "Empleados / Roles / Pago", x: 17, y: 10, w: 40, h: 8 },
      { n: 2, label: "Crear rol", x: 17, y: 20, w: 24, h: 10 },
      { n: 3, label: "Permisos del rol", x: 43, y: 20, w: 40, h: 30 },
      { n: 4, label: "Pago del equipo", x: 17, y: 32, w: 24, h: 18 },
      { n: 5, label: "Invitación por correo", x: 17, y: 52, w: 81, h: 12 },
    ],
    steps: [
      {
        title: "Crea el empleado y su contraseña",
        detail: "En Equipo → Empleados registra nombre, almacén y contraseña. El cajero usará esa contraseña al abrir el turno y solo podrá operar su turno y almacén.",
        where: "Equipo → Empleados",
        zone: 1,
      },
      {
        title: "Asigna un rol base",
        detail: "Los roles determinan módulos y acciones. Usa Administrador para control total, Vendedor para POS y consultas, e Inventario para gestión de stock. No des administración a quien solo cobra.",
        where: "Equipo → Empleados → Rol",
        zone: 2,
      },
      {
        title: "Ajusta permisos finos",
        detail: "Si necesitas un rol propio, «Crear rol» permite marcar permisos por área. Los roles personalizados requieren plan Caravana. Cambiar un rol afecta de inmediato al empleado.",
        where: "Equipo → Roles y permisos → Crear rol",
        zone: 3,
      },
      {
        title: "Configura el pago del equipo",
        detail: "En Pago del equipo define salario base y comisiones (por producto o por porcentaje de ventas). El cierre de turno calcula la liquidación y la deja pendiente.",
        where: "Equipo → Pago del equipo",
        zone: 4,
      },
      {
        title: "Invita y revisa accesos",
        detail: "La invitación llega por correo y debe aceptarse desde el enlace. Al cambiar una responsabilidad, revisa los permisos para retirar accesos que ya no correspondan.",
        where: "Equipo → Invitaciones",
        note: "Una invitación enviada a Gmail debe abrirse desde esa misma cuenta para entrar a la empresa correcta.",
        zone: 5,
      },
    ],
    mistakes: [
      "Compartir la contraseña del administrador con los cajeros.",
      "Dar permisos de administración para «evitar problemas».",
      "Cambiar un rol sin avisar al empleado.",
      "Invitar con un correo distinto al que usará la persona.",
    ],
    related: ["inicio", "pos-apertura", "plan"],
  },
  {
    id: "offline",
    title: "Trabajar sin internet: offline y LAN",
    short: "Offline y LAN",
    icon: WifiOff,
    level: "Avanzado",
    minutes: 6,
    summary: "Qué se guarda localmente, cómo sincronizar, qué significan los conflictos y qué es (y qué no es) la LAN.",
    objective: "Operar sin conexión sin perder ventas ni cierres.",
    prereq: "App instalada o abierta al menos una vez con conexión.",
    result: "Operaciones guardadas localmente y sincronizadas al reconectar.",
    route: "/settings",
    routeLabel: "Abrir Configuración",
    figureTitle: "Cómo viaja una operación",
    shell: "network",
    flow: ["Dispositivo", "Cola local", "Internet", "Nube", "Verificar"],
    zones: [
      { n: 1, label: "Este dispositivo", x: 6, y: 62, w: 26, h: 22 },
      { n: 2, label: "Cola local", x: 38, y: 62, w: 24, h: 22 },
      { n: 3, label: "Wi-Fi del negocio", x: 6, y: 10, w: 26, h: 20 },
      { n: 4, label: "Nube PALMYRA", x: 74, y: 10, w: 20, h: 18 },
      { n: 5, label: "Estado de sincronización", x: 38, y: 24, w: 24, h: 18 },
      { n: 6, label: "Conflictos", x: 38, y: 46, w: 24, h: 12 },
    ],
    steps: [
      {
        title: "Entiende qué pasa al perder internet",
        detail: "PALMYRA sigue operando: la venta, el movimiento o el cierre se guarda en este dispositivo en una cola durable. Si recargas o cierras la app, la operación no desaparece.",
        where: "Automático",
        zone: 1,
      },
      {
        title: "No borres datos del navegador con cola pendiente",
        detail: "La cola vive en el almacenamiento local. Limpiar datos del sitio, usar modo incógnito o cambiar de dispositivo elimina las operaciones pendientes de ese equipo.",
        where: "Navegador / app instalada",
        note: "Revisa la cola antes de limpiar, actualizar o cambiar de equipo.",
        zone: 2,
      },
      {
        title: "Revisa la Salud offline",
        detail: "En Configuración → Conexión y datos → Salud offline verás pendientes, conflictos, último sync y almacenamiento. «Sincronizar ahora» fuerza el envío.",
        where: "Configuración → Conexión y datos",
        zone: 5,
      },
      {
        title: "Resuelve conflictos, no los ignores",
        detail: "Un conflicto aparece cuando dos dispositivos modificaron lo mismo. Si queda pendiente, la operación no se consolida en la nube; revisa el panel de conflictos y decide.",
        where: "Salud offline → Conflictos",
        zone: 6,
      },
      {
        title: "Sincronización manual: solo si está configurada",
        detail: "Si tu negocio usa «Sincronización Manual», el sistema no sube datos automáticamente: debes pulsar «Sincronizar ahora» cuando tengas conexión. Confirma esta política con el administrador.",
        where: "Configuración → Administración avanzada",
        zone: 2,
      },
      {
        title: "La LAN es una vista previa, no un servidor compartido",
        detail: "El servidor LAN permite abrir PALMYRA desde otros dispositivos en la misma Wi-Fi mediante una URL. Cada dispositivo guarda sus propios datos: la sincronización compartida por LAN todavía no está activa.",
        where: "Configuración → Conexión y datos → Servidor LAN",
        zone: 3,
      },
    ],
    mistakes: [
      "Pensar que la LAN comparte automáticamente las ventas entre cajas: aún no lo hace.",
      "Limpiar los datos del navegador con operaciones pendientes.",
      "Asumir que todo se sincronizó sin revisar la Salud offline.",
    ],
    related: ["configuracion", "cierre", "inicio"],
  },
  {
    id: "configuracion",
    title: "Configuración, impresora y tasa de cambio",
    short: "Configuración",
    icon: Settings,
    level: "Intermedio",
    minutes: 5,
    summary: "Empresa, almacenes, impresora, apariencia, notificaciones, conexión y administración avanzada.",
    objective: "Ajustar el sistema al negocio sin romper operaciones existentes.",
    result: "Preferencias correctas y comprobantes listos para entregar.",
    route: "/settings",
    routeLabel: "Abrir Configuración",
    figureTitle: "Pantalla de Configuración",
    flow: ["Sección", "Empresa", "Impresora", "Conexión", "Tasa"],
    zones: [
      { n: 1, label: "Secciones de configuración", x: 17, y: 10, w: 20, h: 78 },
      { n: 2, label: "Empresa y almacenes", x: 39, y: 10, w: 59, h: 18 },
      { n: 3, label: "Impresora y comprobantes", x: 39, y: 30, w: 59, h: 18 },
      { n: 4, label: "Conexión y datos", x: 39, y: 50, w: 59, h: 14 },
      { n: 5, label: "Tasa de cambio", x: 39, y: 66, w: 29, h: 14 },
      { n: 6, label: "Apariencia y notificaciones", x: 70, y: 66, w: 28, h: 14 },
    ],
    steps: [
      {
        title: "Entra con el permiso correcto",
        detail: "Solo los administradores ven todas las secciones. Un empleado sin permiso de configuración únicamente puede abrir Notificaciones.",
        where: "Menú lateral → Configuración",
        zone: 1,
      },
      {
        title: "Revisa empresa y almacenes con cuidado",
        detail: "Cambiar el nombre de la empresa afecta tickets. Crear o renombrar almacenes afecta stock y reportes: hazlo antes de operar o con el negocio detenido.",
        where: "Configuración → Empresa / Almacenes",
        zone: 2,
      },
      {
        title: "Deja la impresora probada",
        detail: "Configura ancho 58/80 mm, logo, dirección, teléfono, pie y autoimprimir. Prueba un ticket de verdad antes de abrir la caja al público.",
        where: "Configuración → Impresora y comprobantes",
        zone: 3,
      },
      {
        title: "Revisa conexión y respaldo",
        detail: "En Conexión y datos están la Salud offline, la sincronización manual y el servidor LAN. No actives ni limpies nada sin entender el estado de la cola.",
        where: "Configuración → Conexión y datos",
        zone: 4,
      },
      {
        title: "La tasa de cambio informa, no fija precios",
        detail: "La pantalla Tasa de cambio muestra elTOQUE para divisas y criptoactivos en distintos periodos. No altera automáticamente los precios de los productos: actualiza precios en Inventario.",
        where: "Menú lateral → Tasa de cambio",
        note: "La tasa sirve para convertir al cobrar; el precio del producto se define en su ficha.",
        zone: 5,
      },
    ],
    mistakes: [
      "Renombrar un almacén en plena operación y confundir reportes.",
      "Cambiar la tasa y esperar que los precios cambien solos.",
      "Probar la impresora con la caja ya abierta y clientes esperando.",
    ],
    related: ["inicio", "offline", "pos-venta"],
  },
  {
    id: "plan",
    title: "Plan, límites y funciones premium",
    short: "Plan y premium",
    icon: Sparkles,
    level: "Básico",
    minutes: 4,
    summary: "Qué incluye cada plan, qué funciones están bloqueadas y cómo se solicita una extensión.",
    objective: "Entender qué puedes usar hoy y qué necesitas para desbloquear lo demás.",
    result: "Sabes tu plan actual y cómo solicitar una ampliación sin perder acceso.",
    route: "/subscription",
    routeLabel: "Abrir Plan",
    figureTitle: "Pantalla de Plan",
    flow: ["Plan actual", "Límites", "Extender", "Solicitud", "Aprobación"],
    zones: [
      { n: 1, label: "Plan actual", x: 17, y: 10, w: 81, h: 22 },
      { n: 2, label: "Extender plan", x: 17, y: 34, w: 40, h: 14 },
      { n: 3, label: "Solicitud de pago", x: 59, y: 34, w: 39, h: 14 },
      { n: 4, label: "Límites de la cuenta", x: 17, y: 50, w: 38, h: 30 },
      { n: 5, label: "Funciones premium", x: 57, y: 50, w: 41, h: 30 },
    ],
    steps: [
      {
        title: "Consulta el plan actual",
        detail: "La sección Plan muestra el nivel activo, su vencimiento y el período de gracia. El plan Gratis no vence; en los planes de pago, al vencer y agotarse la gracia PALMYRA pasa a modo lectura: puedes consultar, pero no operar hasta renovar.",
        where: "Menú lateral → Plan",
        zone: 1,
      },
      {
        title: "Identifica las funciones premium",
        detail: "El plan Gratis (permanente) incluye 1 almacén, el propietario, 1 empleado y 25 tipos de producto. Transferencias, compras, auditoría, bancos, clientes/proveedores y estilo visual requieren plan Caravana. Excel, etiquetas, ABC, garantías y analítica avanzada requieren Ciudadela. Verás una pantalla «Función premium» con el botón de planes.",
        where: "Cualquier módulo bloqueado → Ver planes y actualizar",
        zone: 5,
      },
      {
        title: "Solicita la extensión o renovación",
        detail: "«Extender plan» o «Solicitar o renovar» abre la solicitud. «Enviar solicitud de pago» registra la petición; la aprobación es manual por administración.",
        where: "Plan → Extender / Solicitar",
        zone: 2,
      },
      {
        title: "Espera la aprobación sin duplicar solicitudes",
        detail: "Una vez enviada, la solicitud queda registrada. La aprobación actualiza el plan sin que el trabajador tenga que hacer nada. Enviar varias solicitudes no acelera el proceso.",
        where: "Plan → Solicitudes",
        note: "Los límites se validan también en la base de datos: no se saltan alterando la interfaz.",
        zone: 3,
      },
    ],
    mistakes: [
      "Dejar vencer el plan y descubrir el modo lectura en plena venta.",
      "Enviar la misma solicitud varias veces.",
      "Confundir «extender» con cambiar de plan.",
    ],
    related: ["transferencias", "auditoria", "reportes", "equipo"],
  },
  {
    id: "auditoria-ajuste",
    title: "Auditorías de inventario que ajustan stock",
    short: "Auditoría con ajuste",
    icon: ClipboardCheck,
    level: "Avanzado",
    minutes: 6,
    summary: "Flujo completo: conteo físico, recuento, revisión y aprobación que ajusta el stock real por variante, incluso sin conexión.",
    objective: "Ejecutar una auditoría desde el primer conteo hasta la aprobación sin perder trazabilidad.",
    prereq: "Plan con Auditoría y stock cargado en el almacén.",
    result: "Auditoría aprobada, stock real ajustado por variante y cola sincronizada.",
    route: "/inventory-audit",
    routeLabel: "Abrir Auditoría",
    figureTitle: "Auditoría: del conteo al ajuste",
    flow: ["Sucursal", "Conteo", "Recuento", "Revisión", "Aprobación", "Ajuste"],
    zones: [
      { n: 1, label: "Sucursal a auditar", x: 17, y: 10, w: 24, h: 10 },
      { n: 2, label: "Tipo de conteo", x: 43, y: 10, w: 26, h: 10 },
      { n: 3, label: "Iniciar y snapshot", x: 17, y: 24, w: 81, h: 10 },
      { n: 4, label: "Cantidad física por variante", x: 17, y: 38, w: 81, h: 14 },
      { n: 5, label: "Solicitar recuento", x: 17, y: 56, w: 38, h: 10 },
      { n: 6, label: "Enviar a revisión", x: 57, y: 56, w: 41, h: 10 },
      { n: 7, label: "Aprobar y ajustar", x: 17, y: 70, w: 81, h: 10 },
      { n: 8, label: "Salud offline", x: 17, y: 84, w: 81, h: 10 },
    ],
    steps: [
      {
        title: "Elige la sucursal y el tipo de conteo",
        detail: "La auditoría pertenece a una sucursal: si eliges la equivocada, el ajuste cae en el almacén equivocado. «Conteo cíclico» audita una parte del catálogo y «Inventario físico» revisa todo, con una sola auditoría abierta por sucursal.",
        where: "Auditoría → Nueva auditoría → Sucursal / Tipo de conteo",
        zone: 1,
      },
      {
        title: "Inicia el conteo y congela el snapshot",
        detail: "«Iniciar conteo y tomar snapshot» guarda la referencia del stock en ese instante. Si después se vende o se recibe mercancía, el sistema lo detecta y puede rechazar la aprobación.",
        where: "Auditoría → Iniciar conteo y tomar snapshot",
        note: "Evita vender en el almacén auditado mientras dure el conteo.",
        zone: 3,
      },
      {
        title: "Cuenta cada variante por separado",
        detail: "Registra la cantidad física de cada etiqueta: una talla o un color es una línea con su propio stock. Ajustar solo el producto deja las variantes descuadradas.",
        where: "Auditoría → Productos → Cantidad física",
        note: "Puedes marcar las líneas que coinciden con el sistema para avanzar más rápido.",
        zone: 4,
      },
      {
        title: "Solicita recuento si algo no cuadra",
        detail: "«Solicitar recuento» reabre el conteo sin aplicar ningún ajuste y conserva la evidencia anterior. Úsalo cuando una diferencia parezca un error de tecleo o cuando el stock cambió desde el snapshot.",
        where: "Auditoría → Revisión → Solicitar recuento",
        zone: 5,
      },
      {
        title: "Envía el conteo a revisión",
        detail: "«Enviar conteo a revisión» bloquea la captura y muestra faltantes, sobrantes, exactitud y valor de la diferencia. El responsable revisa antes de aprobar y todavía no se ha ajustado nada.",
        where: "Auditoría → Enviar conteo a revisión",
        zone: 6,
      },
      {
        title: "Aprueba y ajusta el stock real",
        detail: "«Aprobar y ajustar stock» fija la cantidad contada como stock real por variante, contra el stock vigente al aprobar. Si algo cambió después del envío, la aprobación se rechaza y debes pedir recuento.",
        where: "Auditoría → Aprobar y ajustar stock",
        zone: 7,
      },
      {
        title: "Opera sin conexión y sincroniza",
        detail: "Iniciar, contar, pedir recuento y aprobar se guardan en este equipo si la red falla, y suben al reconectar. No borres los datos del navegador ni cambies de equipo con la cola pendiente.",
        where: "Automático · Configuración → Conexión y datos → Salud offline",
        zone: 8,
      },
    ],
    mistakes: [
      "Contar el producto y no cada variante: el ajuste queda incompleto.",
      "Aprobar mientras se vende en el mismo almacén: el stock cambió y la aprobación se rechaza.",
      "Ajustar cantidades a mano en Inventario en lugar de aprobar la auditoría.",
      "Abrir dos auditorías a la vez en la misma sucursal.",
      "Borrar los datos del navegador con un conteo pendiente de sincronizar.",
    ],
    related: ["auditoria", "inventario", "offline"],
  },
  {
    id: "inventario-limpio",
    title: "Inventario sin errores: variantes, SKU y bajo stock",
    short: "Inventario sin errores",
    icon: Package,
    level: "Intermedio",
    minutes: 6,
    summary: "Un solo eje de variantes, avisos de SKU duplicado, edición masiva que aguanta sin red y un umbral de bajo stock que no limita existencias.",
    objective: "Evitar los errores de catálogo que descuadran stock, precios y reportes.",
    prereq: "Productos creados y un almacén activo.",
    result: "Catálogo consistente, alertas de stock reales y ediciones masivas confirmadas.",
    route: "/inventory",
    routeLabel: "Abrir Inventario",
    figureTitle: "Inventario: controles que evitan errores",
    flow: ["Variante", "SKU", "Edición masiva", "Categorías", "Umbral", "KPIs"],
    zones: [
      { n: 1, label: "Un eje: tallas o colores", x: 17, y: 10, w: 40, h: 12 },
      { n: 2, label: "SKU y código de barras", x: 59, y: 10, w: 39, h: 12 },
      { n: 3, label: "Edición masiva", x: 17, y: 26, w: 40, h: 12 },
      { n: 4, label: "Categorías en uso", x: 59, y: 26, w: 39, h: 12 },
      { n: 5, label: "Stock mínimo · alerta", x: 17, y: 42, w: 40, h: 12 },
      { n: 6, label: "KPIs y Ganancia", x: 59, y: 42, w: 39, h: 12 },
      { n: 7, label: "Gestionar stock", x: 17, y: 58, w: 81, h: 12 },
    ],
    steps: [
      {
        title: "Usa un solo eje de variantes",
        detail: "Al escribir tallas el campo de colores se deshabilita, y al revés: el stock se indexa por una sola etiqueta. Si necesitas ambos datos, crea una variante combinada como «M / Rojo».",
        where: "Inventario → Agregar producto → Variantes",
        note: "Dos ejes a la vez hacen que el POS descuente una variante que no existe.",
        zone: 1,
      },
      {
        title: "Respeta el aviso de SKU duplicado",
        detail: "PALMYRA no guarda un producto con un SKU o un nombre ya registrado y te dice cuál coincide. Corrige el código o edita el producto existente en lugar de duplicar la ficha.",
        where: "Inventario → Agregar producto → SKU",
        zone: 2,
      },
      {
        title: "Edita en masa sin depender de la red",
        detail: "En la pestaña «Edición Masiva» cambia nombre, precio, costo o comisión por producto y pulsa Guardar. Se aplica en el equipo y, si la red falla, queda en cola; un error permanente conserva el borrador completo.",
        where: "Inventario → Edición Masiva",
        zone: 3,
      },
      {
        title: "No borres categorías en uso",
        detail: "Configuración → Categorías impide eliminar una categoría con productos y avisa cuántos la usan. Reasígnalos a otra categoría y luego elimínala.",
        where: "Configuración → Categorías",
        zone: 4,
      },
      {
        title: "Trata el mínimo como umbral de aviso",
        detail: "«Stock mínimo · alerta» solo avisa cuando la existencia baja de ese número; no limita ni impide guardar cantidades menores. La alerta compara el stock del almacén filtrado, no el total de la empresa.",
        where: "Producto → Stock mínimo · alerta · Inventario → Alertas",
        zone: 5,
      },
      {
        title: "Lee los KPIs y la columna Ganancia",
        detail: "Las tarjetas superiores responden a la sucursal activa, no a la búsqueda de la tabla. La «Ganancia» por producto es venta − costo − salario o comisión del personal.",
        where: "Inventario → Indicadores / Tabla → Ganancia",
        zone: 6,
      },
      {
        title: "Mueve existencias con las herramientas correctas",
        detail: "El stock se mueve desde «Gestionar stock», las transferencias y las auditorías; crear el producto ya no genera existencias. Ajustar a mano rompe la trazabilidad.",
        where: "Inventario → Gestionar stock",
        zone: 7,
      },
    ],
    mistakes: [
      "Marcar tallas y colores a la vez: el POS descuenta una variante que no existe.",
      "Reutilizar un SKU o un nombre ya registrado y no entender por qué no guarda.",
      "Borrar una categoría en uso en lugar de reasignar sus productos.",
      "Confundir el stock mínimo con un tope de venta.",
      "Editar cantidades a mano en lugar de usar auditoría o transferencias.",
    ],
    related: ["inventario", "auditoria-ajuste", "reportes"],
  },
  {
    id: "transferencias-transito",
    title: "Transferencias: rutas, en tránsito y recepción",
    short: "Transferencias y tránsito",
    icon: ArrowLeftRight,
    level: "Intermedio",
    minutes: 5,
    summary: "Envía mercancía entre almacenes, sigue la ruta y la cantidad de cada lote y confirma la recepción que suma el stock al destino.",
    objective: "Mover stock entre sucursales sabiendo en todo momento dónde está la mercancía.",
    prereq: "Dos almacenes creados y permiso de inventario.",
    result: "Envío descontado del origen y stock confirmado en el destino.",
    route: "/transfers",
    routeLabel: "Abrir Transferencias",
    figureTitle: "Envío, tránsito y recepción",
    flow: ["Origen", "Destino", "Constructor masivo", "Envío", "Tránsito", "Recepción"],
    zones: [
      { n: 1, label: "Origen de mercancía", x: 17, y: 10, w: 38, h: 12 },
      { n: 2, label: "Destino de mercancía", x: 57, y: 10, w: 41, h: 12 },
      { n: 3, label: "Productos y cantidades", x: 17, y: 26, w: 56, h: 24 },
      { n: 4, label: "Confirmar envío", x: 75, y: 26, w: 23, h: 24 },
      { n: 5, label: "Columnas Ruta y Cantidad", x: 17, y: 54, w: 56, h: 14 },
      { n: 6, label: "Recibir mercancía", x: 75, y: 54, w: 23, h: 14 },
      { n: 7, label: "Historial por lote", x: 17, y: 72, w: 81, h: 12 },
    ],
    steps: [
      {
        title: "Confirma origen y destino",
        detail: "El origen entrega y el destino recibe; invertirlos mueve el stock en dirección contraria. Si trabajas con sucursal restringida, solo verás los almacenes permitidos.",
        where: "Transferencias → Nuevo traslado → Origen / Destino",
        zone: 1,
      },
      {
        title: "Prepara el envío con el constructor masivo",
        detail: "Busca por producto o variante, escribe la cantidad y repite: un solo envío puede llevar muchas líneas con su variante exacta. El constructor avisa si pides más de lo que existe en el origen.",
        where: "Transferencias → Nuevo traslado → Productos y cantidades",
        zone: 3,
      },
      {
        title: "Confirma el envío",
        detail: "«Confirmar envío» descuenta el stock del origen y deja el lote en tránsito. Todavía no pertenece al destino: eso ocurre solo con la recepción.",
        where: "Transferencias → Confirmar envío",
        zone: 4,
      },
      {
        title: "Lee Ruta y Cantidad en el historial",
        detail: "Cada fila muestra la fecha y hora, la ruta origen → destino y la cantidad total en unidades. Los envíos con varias líneas se agrupan como lote y puedes expandirlos.",
        where: "Transferencias → Historial de movimientos",
        zone: 5,
      },
      {
        title: "Recibe en el destino",
        detail: "«Recibir» confirma que la mercancía llegó y suma el stock al almacén de destino. Revisa la ruta y la cantidad antes de confirmar: una recepción apresurada esconde faltantes.",
        where: "Transferencias → Mercancía en tránsito → Recibir",
        zone: 6,
      },
      {
        title: "Un traslado sin conexión",
        detail: "Si confirmas el envío sin red, queda en la cola local y solo descuenta el origen hasta que el destino reciba. Al reconectar se sincroniza; no repitas el traslado ni borres la cola.",
        where: "Automático · Configuración → Conexión y datos → Salud offline",
        zone: 7,
      },
    ],
    mistakes: [
      "Recibir sin contar: el faltante se descubre cuando el stock ya no cuadra.",
      "Corregir un envío en tránsito creando otro traslado en sentido contrario.",
      "Confirmar la recepción en el almacén de origen en lugar del destino.",
      "Borrar la cola local antes de sincronizar un traslado pendiente.",
    ],
    related: ["transferencias", "auditoria-ajuste", "offline"],
  },
  {
    id: "tasa-cambio",
    title: "Tasa de cambio: elTOQUE, variación e historial",
    short: "Tasa de cambio",
    icon: CreditCard,
    level: "Básico",
    minutes: 4,
    summary: "Tasas por divisa, variación, minigráficos e historial de 24 h, 7 y 30 días; aviso claro si falta la credencial de elTOQUE.",
    objective: "Interpretar la cotización del mercado informal sin alterar los precios del negocio.",
    result: "Sabes leer la tasa, su tendencia y de dónde sale cada número.",
    route: "/exchange-rate",
    routeLabel: "Abrir Tasa de cambio",
    figureTitle: "Pantalla de Tasa de cambio",
    flow: ["Divisa", "Tasa", "Variación", "Historial", "Aviso"],
    zones: [
      { n: 1, label: "Divisas / Criptoactivos", x: 17, y: 10, w: 26, h: 10 },
      { n: 2, label: "Tasa por divisa", x: 45, y: 10, w: 38, h: 10 },
      { n: 3, label: "Variación", x: 85, y: 10, w: 13, h: 10 },
      { n: 4, label: "Historial 24 h / 7 d / 30 d", x: 17, y: 24, w: 81, h: 12 },
      { n: 5, label: "Aviso de credencial", x: 17, y: 40, w: 81, h: 12 },
    ],
    steps: [
      {
        title: "Elige divisa o criptoactivo",
        detail: "Las pestañas «Divisas» y «Criptoactivos» separan los mercados cuando la fuente publica ambos. Cada tarjeta corresponde a una moneda con su tasa de referencia en CUP.",
        where: "Tasa de cambio → Divisas / Criptoactivos",
        zone: 1,
      },
      {
        title: "Lee la tasa y la compra/venta",
        detail: "La tarjeta muestra la tasa en CUP por unidad y, si elTOQUE la publica, compra y venta. Cuando la fuente no trae una moneda, la tarjeta lo indica: PALMYRA no inventa ni sustituye tasas.",
        where: "Tasa de cambio → Tarjeta de la divisa",
        zone: 2,
      },
      {
        title: "Interpreta la variación y el minigráfico",
        detail: "El indicador de variación y la línea de la tarjeta resumen el movimiento reciente. Sirven para decidir cuándo cambiar, no para fijar precios.",
        where: "Tasa de cambio → Variación",
        note: "La cotización es del mercado informal y se actualiza cada 5 minutos con la pantalla abierta.",
        zone: 3,
      },
      {
        title: "Cambia el periodo del historial",
        detail: "Selecciona 24 h, 7 días, 30 días o todo el historial y revisa las estadísticas de la divisa. La serie combina lo publicado por la fuente y las consultas guardadas en este dispositivo.",
        where: "Tasa de cambio → Evolución → Periodo",
        zone: 4,
      },
      {
        title: "Atiende el aviso de credencial",
        detail: "Si el servidor no tiene ELTOQUE_API_TOKEN, la pantalla avisa y muestra la última consulta guardada. Pide al administrador que publique la credencial; la tasa nunca se reemplaza por datos inventados.",
        where: "Tasa de cambio → Aviso de la fuente",
        zone: 5,
      },
    ],
    mistakes: [
      "Esperar que la tasa cambie los precios del inventario por sí sola.",
      "Tomar la referencia del mercado informal como tasa oficial del banco.",
      "Confundir la fecha de la consulta con la fecha de publicación del proveedor.",
    ],
    related: ["configuracion", "inicio", "pos-venta"],
  },
  {
    id: "soporte",
    title: "Soporte y centro de ayuda",
    short: "Soporte",
    icon: Headphones,
    level: "Básico",
    minutes: 4,
    summary: "Preguntas frecuentes buscables, solicitudes con diagnóstico automático, canales de WhatsApp y correo, y ayuda que sobrevive sin conexión.",
    objective: "Resolver una duda o abrir un caso con toda la información que el equipo necesita.",
    result: "Solicitud registrada con empresa, versión y estado de conexión.",
    route: "/help-center",
    routeLabel: "Abrir Centro de atención",
    figureTitle: "Pantalla del Centro de atención",
    flow: ["Preguntas", "Sección", "Diagnóstico", "Solicitud", "Canal"],
    zones: [
      { n: 1, label: "Buscador de preguntas", x: 17, y: 10, w: 56, h: 10 },
      { n: 2, label: "Secciones de ayuda", x: 75, y: 10, w: 23, h: 10 },
      { n: 3, label: "Crear solicitud", x: 17, y: 24, w: 38, h: 12 },
      { n: 4, label: "Diagnóstico copiable", x: 57, y: 24, w: 41, h: 12 },
      { n: 5, label: "WhatsApp y correo", x: 17, y: 40, w: 81, h: 12 },
    ],
    steps: [
      {
        title: "Busca antes de escribir",
        detail: "El buscador de preguntas frecuentes filtra por pregunta, respuesta y etiqueta. Si no hay coincidencia, el propio resultado te lleva a crear una solicitud.",
        where: "Centro de atención → Ayuda → Preguntas frecuentes",
        zone: 1,
      },
      {
        title: "Recorre las secciones",
        detail: "Ayuda, Tutorial, Atención al cliente, Seguridad y Privacidad. La sección Tutorial abre esta escuela y Seguridad muestra los dispositivos y sesiones de la cuenta.",
        where: "Centro de atención → Secciones",
        zone: 2,
      },
      {
        title: "Crea la solicitud con contexto",
        detail: "En «Atención al cliente» elige el tipo (error, acceso, función, facturación), escribe el detalle y envía. La solicitud guarda empresa, versión, conexión y operaciones pendientes, y queda encolada si no hay red.",
        where: "Centro de atención → Atención al cliente → Crear solicitud",
        zone: 3,
      },
      {
        title: "Copia el diagnóstico",
        detail: "El bloque «Contexto que se adjuntará» muestra empresa, versión, estado de conexión y pendientes; «Copiar» lo lleva al portapapeles por si debes enviarlo por otra vía.",
        where: "Atención al cliente → Contexto → Copiar",
        zone: 4,
      },
      {
        title: "Elige WhatsApp o correo",
        detail: "Si el administrador publicó los canales verás «Escribir por WhatsApp» o el correo con el diagnóstico incluido. Sin canal configurado la solicitud se registra igual y puedes usar el correo de soporte.",
        where: "Atención al cliente → WhatsApp / Correo",
        zone: 5,
      },
    ],
    mistakes: [
      "Enviar varias solicitudes iguales: no aceleran la respuesta.",
      "Omitir el detalle del caso pensando que el diagnóstico lo explica todo.",
      "Limpiar los datos del navegador con una solicitud pendiente de envío.",
    ],
    related: ["offline", "configuracion", "plan"],
  },
  {
    id: "descargas-lan",
    title: "Descargas y modo LAN: varios equipos sin internet",
    short: "Descargas y LAN",
    icon: Download,
    level: "Avanzado",
    minutes: 5,
    summary: "Instala PALMYRA en Windows o en el móvil y abre el sistema desde varios equipos conectados al mismo Wi-Fi del negocio.",
    objective: "Dejar cada equipo listo para operar y entender qué hace —y qué no— la red local.",
    prereq: "App abierta al menos una vez con conexión y equipos en la misma red.",
    result: "Equipos instalados, acceso LAN activo y máquinas reconocidas por nombre.",
    route: "/settings",
    routeLabel: "Abrir Configuración",
    figureTitle: "Red local del negocio",
    shell: "network",
    flow: ["Instalador", "Móvil", "Wi-Fi", "URL local", "Equipos"],
    zones: [
      { n: 1, label: "Instalador Windows", x: 4, y: 8, w: 28, h: 16 },
      { n: 2, label: "App móvil", x: 4, y: 72, w: 28, h: 16 },
      { n: 3, label: "Wi-Fi del negocio", x: 36, y: 8, w: 28, h: 14 },
      { n: 4, label: "Dirección local", x: 68, y: 8, w: 28, h: 14 },
      { n: 5, label: "Equipos conectados", x: 36, y: 72, w: 28, h: 16 },
      { n: 6, label: "Permitir acceso LAN", x: 68, y: 36, w: 28, h: 14 },
    ],
    steps: [
      {
        title: "Instala la versión de Windows",
        detail: "Descarga el instalador .exe desde la sección Descargas del sitio de PALMYRA y ejecútalo con el asistente. Abre la app una vez con internet para que la cola offline quede habilitada en ese equipo.",
        where: "Sitio PALMYRA → Descargas → Instalador Windows",
        zone: 1,
      },
      {
        title: "Instala en el móvil o la tablet",
        detail: "Descarga el APK para Android o instala la aplicación desde el navegador. El mismo usuario puede operar desde varios equipos, pero cada uno guarda su propia cola.",
        where: "Sitio PALMYRA → Descargas → App móvil",
        zone: 2,
      },
      {
        title: "Comparte el mismo Wi-Fi",
        detail: "Los equipos deben estar en la red del negocio; la LAN no sustituye internet para sincronizar. Con la red local activa puedes abrir PALMYRA aunque el proveedor de internet falle.",
        where: "Wi-Fi del negocio",
        zone: 3,
      },
      {
        title: "Activa el acceso desde otros equipos",
        detail: "En Configuración → Sistema → Red local activa «Permitir acceso LAN». La pantalla muestra la dirección y un código QR para abrir el sistema en otro equipo.",
        where: "Configuración → Sistema → Red local",
        zone: 6,
      },
      {
        title: "Abre la URL local en el otro equipo",
        detail: "Escribe esa dirección en el navegador del móvil, tablet o PC; nunca uses localhost desde otro dispositivo porque apunta a sí mismo.",
        where: "Navegador del otro equipo → Dirección local",
        zone: 4,
      },
      {
        title: "Reconoce y ordena las máquinas",
        detail: "En «Máquinas conectadas» revisa las que están en línea, renómbralas por caja o área y olvida las que ya no se usan.",
        where: "Configuración → Sistema → Red local → Máquinas conectadas",
        note: "La LAN comparte el acceso, no los turnos: cada caja abre y cierra su propio turno.",
        zone: 5,
      },
    ],
    mistakes: [
      "Abrir la URL local desde otra red o con el equipo principal apagado.",
      "Escribir localhost en el móvil: apunta al propio teléfono.",
      "Intentar operar dos cajas con el mismo turno.",
      "Limpiar los datos del equipo principal con operaciones pendientes.",
    ],
    related: ["offline", "configuracion", "inicio"],
  },
];

const rolePaths: Array<{ label: string; icon: LucideIcon; hint: string; ids: string[] }> = [
  {
    label: "Vender hoy",
    icon: ShoppingCart,
    hint: "Cajero y vendedor",
    ids: ["pos-apertura", "pos-venta", "cierre", "clientes"],
  },
  {
    label: "Controlar inventario",
    icon: Package,
    hint: "Encargado de almacén",
    ids: ["inventario", "transferencias", "auditoria", "proveedores"],
  },
  {
    label: "Administrar el negocio",
    icon: ShieldCheck,
    hint: "Dueño y administrador",
    ids: ["inicio", "equipo", "reportes", "configuracion", "plan"],
  },
];

const TOTAL_MINUTES = lessons.reduce((sum, lesson) => sum + lesson.minutes, 0);
const TOTAL_STEPS = lessons.reduce((sum, lesson) => sum + lesson.steps.length, 0);

function loadCompleted(): string[] {
  try {
    const raw = localStorage.getItem(PROGRESS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function FigureShell({ kind }: { kind: "app" | "modal" | "network" }) {
  if (kind === "network") {
    return (
      <svg
        className="absolute inset-0 h-full w-full text-violet-400/70 dark:text-violet-500/50"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        {[
          [19, 73, 50, 73],
          [50, 62, 50, 42],
          [50, 24, 84, 19],
          [19, 20, 50, 24],
          [50, 46, 50, 42],
        ].map(([x1, y1, x2, y2], index) => (
          <line
            key={index}
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
            stroke="currentColor"
            strokeWidth={1.25}
            strokeDasharray="3 2.5"
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
    );
  }

  return (
    <>
      <div className="absolute inset-x-0 top-0 h-[8%] border-b border-base bg-subtle/90" />
      <div className="absolute left-0 top-[8%] bottom-0 w-[14%] border-r border-base bg-subtle/70" />
      <div className="absolute left-[2%] top-[10.5%] h-1.5 w-[10%] rounded-full bg-violet-400/50" />
      <div className="absolute left-[2%] top-[15%] h-1.5 w-[8%] rounded-full bg-violet-400/30" />
      <div className="absolute left-[2%] top-[19%] h-1.5 w-[9%] rounded-full bg-violet-400/30" />
      <div className="absolute right-[3%] top-[3%] h-2.5 w-[28%] rounded-full bg-violet-400/30" />
      {kind === "modal" && (
        <div className="absolute inset-0 bg-slate-950/35">
          <div className="absolute left-[13%] right-[13%] top-[5%] bottom-[5%] rounded-xl border border-base bg-secondary shadow-lg" />
        </div>
      )}
    </>
  );
}

function LessonFigure({
  lesson,
  activeZone,
  onZone,
}: {
  lesson: Lesson;
  activeZone: number | null;
  onZone: (zone: number) => void;
}) {
  const shell = lesson.shell || "app";
  return (
    <figure className="min-w-0 rounded-2xl border border-base bg-secondary p-3 shadow-sm sm:p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 pb-2.5">
        <span className="inline-flex items-center gap-1.5 text-[11px] font-black uppercase tracking-[0.14em] text-muted">
          <BookOpen size={13} aria-hidden="true" />
          Pantalla ilustrada
        </span>
        <span className="max-w-[62%] truncate rounded-full border border-base bg-subtle px-2 py-0.5 text-[10px] font-black text-primary" title={lesson.figureTitle}>
          {lesson.figureTitle}
        </span>
      </div>
      <div className="relative aspect-[5/4] w-full overflow-hidden rounded-xl border border-base bg-subtle sm:aspect-[16/9]">
        <FigureShell kind={shell} />
        {lesson.zones.map((zone) => {
          const active = activeZone === zone.n;
          return (
            <button
              key={zone.n}
              type="button"
              onClick={() => onZone(zone.n)}
              aria-pressed={active}
              title={zone.label}
              className={cn(
                "absolute flex flex-row items-center gap-1.5 overflow-hidden rounded-lg border border-dashed p-1.5 text-left transition-all",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500",
                active
                  ? "z-10 border-solid border-violet-500 bg-violet-100/90 shadow-md dark:bg-violet-900/50"
                  : "border-violet-300 bg-secondary/95 hover:border-violet-500 hover:bg-violet-50 dark:border-violet-800 dark:hover:bg-violet-950/40",
              )}
              style={{ left: `${zone.x}%`, top: `${zone.y}%`, width: `${zone.w}%`, height: `${zone.h}%` }}
            >
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-[#6535C5] text-[10px] font-black text-white">
                {zone.n}
              </span>
              <span className="min-w-0 flex-1 truncate text-[11px] font-bold leading-[1.2] text-primary">
                {zone.label}
              </span>
            </button>
          );
        })}
      </div>
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {lesson.zones.map((zone) => (
          <button
            key={zone.n}
            type="button"
            onClick={() => onZone(zone.n)}
            aria-pressed={activeZone === zone.n}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[11px] font-bold transition-colors",
              activeZone === zone.n
                ? "border-[#6535C5] bg-[#6535C5] text-white"
                : "border-base bg-subtle text-secondary hover:border-violet-400 hover:text-[#6535C5] dark:hover:text-violet-300",
            )}
          >
            <span className={cn("font-black", activeZone === zone.n ? "text-white" : "text-[#6535C5] dark:text-violet-300")}>{zone.n}</span>
            {zone.label}
          </button>
        ))}
      </div>
      <figcaption className="mt-2 text-[11px] font-semibold leading-4 text-muted">
        Toca un punto o una etiqueta para marcarlo; el mismo número aparece en el paso correspondiente.
      </figcaption>
    </figure>
  );
}

function FlowMap({ flow }: { flow: string[] }) {
  return (
    <div className="min-w-0">
      <p className="mb-1.5 text-[11px] font-black uppercase tracking-[0.14em] text-muted">Mapa del proceso</p>
      <div className="flex snap-x items-stretch gap-1.5 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {flow.map((node, index) => (
          <div key={node} className="flex snap-start items-center gap-1.5">
            <div className="flex min-h-10 items-center gap-1.5 rounded-xl border border-base bg-subtle px-2.5 py-1.5">
              <span className="text-[10px] font-black text-[#6535C5] dark:text-violet-300">{String(index + 1).padStart(2, "0")}</span>
              <span className="whitespace-nowrap text-[11px] font-bold text-primary">{node}</span>
            </div>
            {index < flow.length - 1 ? <ChevronRight size={13} className="shrink-0 text-muted" aria-hidden="true" /> : null}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Tutorial() {
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState("");
  const [completed, setCompleted] = useState<Set<string>>(() => new Set(loadCompleted()));
  const [activeZone, setActiveZone] = useState<number | null>(null);
  const figureRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const requestedId = params.get("lesson");
  const currentLesson = lessons.find((lesson) => lesson.id === requestedId) || lessons[0];
  const currentIndex = lessons.findIndex((lesson) => lesson.id === currentLesson.id);
  const completedCount = lessons.filter((lesson) => completed.has(lesson.id)).length;
  const progressPct = Math.round((completedCount / lessons.length) * 100);
  const nextIncomplete = lessons.find((lesson) => !completed.has(lesson.id)) || lessons[0];
  const currentCompleted = completed.has(currentLesson.id);
  const previousLesson = currentIndex > 0 ? lessons[currentIndex - 1] : null;
  const nextLesson = currentIndex < lessons.length - 1 ? lessons[currentIndex + 1] : null;
  const searchActive = normalize(query.trim()).length > 1;

  const searchMatches = useMemo(() => {
    const needle = normalize(query.trim());
    if (needle.length < 2) return [];
    return lessons
      .map((lesson, index) => ({
        lesson,
        index,
        haystack: normalize([
          lesson.title,
          lesson.short,
          lesson.summary,
          lesson.objective,
          lesson.result,
          ...lesson.flow,
          ...lesson.zones.map((zone) => zone.label),
          ...lesson.steps.flatMap((step) => [step.title, step.detail, step.where || "", step.note || ""]),
          ...lesson.mistakes,
        ].join(" ")),
      }))
      .filter((entry) => entry.haystack.includes(needle));
  }, [query]);

  useEffect(() => {
    try {
      localStorage.setItem(PROGRESS_KEY, JSON.stringify([...completed]));
    } catch {
      // El progreso es local y opcional; si el navegador lo bloquea, la escuela sigue funcionando.
    }
  }, [completed]);

  useEffect(() => {
    setActiveZone(null);
  }, [currentLesson.id]);

  const goToLesson = (id: string) => {
    setQuery("");
    setParams({ lesson: id }, { replace: true });
    rootRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const toggleCompleted = (id: string) => {
    setCompleted((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const activateZone = (zone: number) => {
    setActiveZone(zone);
    const step = document.getElementById(`paso-${currentLesson.id}-${zone}`);
    step?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const focusZoneOnFigure = (zone: number) => {
    setActiveZone(zone);
    figureRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const relatedLessons = currentLesson.related
    .map((id) => lessons.find((lesson) => lesson.id === id))
    .filter((lesson): lesson is Lesson => Boolean(lesson));

  return (
    <div ref={rootRef} className="mx-auto w-full min-w-0 max-w-7xl space-y-4 pb-10">
      <section className="relative overflow-hidden rounded-3xl border border-violet-300/40 bg-gradient-to-br from-[#4F249D] via-[#6535C5] to-[#8B63E6] p-4 text-white shadow-lg sm:p-6">
        <div className="pointer-events-none absolute -right-10 -top-16 h-48 w-48 rounded-full bg-white/10 blur-2xl" aria-hidden="true" />
        <div className="pointer-events-none absolute -bottom-20 left-1/3 h-40 w-40 rounded-full bg-white/10 blur-2xl" aria-hidden="true" />
        <div className="relative flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0 max-w-3xl">
            <div className="flex items-center gap-2 text-violet-100">
              <GraduationCap size={16} aria-hidden="true" />
              <span className="text-[10px] font-black uppercase tracking-[0.2em]">Escuela PALMYRA</span>
            </div>
            <h1 className="mt-1.5 text-xl font-black leading-tight tracking-tight sm:text-3xl">
              Aprende el sistema como en una escuela
            </h1>
            <p className="mt-1.5 max-w-2xl text-sm font-semibold leading-5 text-violet-50">
              {lessons.length} lecciones con pantallas marcadas, pasos numerados y conexiones entre módulos.
              Avanza a tu ritmo y guarda tu progreso en este dispositivo.
            </p>
            <div className="mt-3 flex flex-wrap gap-1.5 text-[11px] font-bold">
              <span className="rounded-full border border-white/20 bg-white/10 px-2.5 py-1">{lessons.length} lecciones</span>
              <span className="rounded-full border border-white/20 bg-white/10 px-2.5 py-1">{TOTAL_STEPS} pasos guiados</span>
              <span className="rounded-full border border-white/20 bg-white/10 px-2.5 py-1">≈ {TOTAL_MINUTES} min</span>
              <span className="rounded-full border border-white/20 bg-white/10 px-2.5 py-1">{progressPct}% completado</span>
            </div>
          </div>
          <div className="w-full min-w-0 rounded-2xl border border-white/20 bg-white/10 p-3 backdrop-blur-sm lg:w-[280px]">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[10px] font-black uppercase tracking-[0.14em] text-violet-100">Tu progreso</span>
              <span className="text-sm font-black">{completedCount} / {lessons.length}</span>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-white/20" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progressPct}>
              <div className="h-full rounded-full bg-white transition-all" style={{ width: `${progressPct}%` }} />
            </div>
            <button
              type="button"
              onClick={() => goToLesson(nextIncomplete.id)}
              className="mt-2.5 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-white px-3 text-[12px] font-black uppercase tracking-wide text-[#4F249D] transition hover:bg-violet-50"
            >
              {completedCount === lessons.length ? "Repasar desde el inicio" : `Continuar: ${nextIncomplete.short}`}
              <ArrowRight size={15} aria-hidden="true" />
            </button>
          </div>
        </div>
      </section>

      <section className="rounded-2xl border border-base bg-secondary p-3 shadow-sm">
        <label htmlFor="school-search" className="sr-only">Buscar en la escuela</label>
        <div className="flex items-center gap-2 rounded-xl border border-base bg-subtle px-3 focus-within:border-violet-500">
          <Search size={16} className="shrink-0 text-muted" aria-hidden="true" />
          <input
            id="school-search"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Buscar: cierre, arqueo, transferencia…"
            className="min-h-11 w-full bg-transparent text-sm font-semibold text-primary outline-none placeholder:text-muted"
          />
          {query ? (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="Limpiar búsqueda"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-secondary hover:text-[#6535C5] dark:hover:text-violet-300"
            >
              <X size={16} />
            </button>
          ) : null}
        </div>
      </section>

      <section className="rounded-2xl border border-base bg-secondary p-3 shadow-sm sm:p-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-[11px] font-black uppercase tracking-[0.16em] text-muted">Rutas por rol</h2>
          <span className="text-[11px] font-semibold text-muted">Elige por dónde empezar</span>
        </div>
        <div className="mt-2 grid gap-2 lg:grid-cols-3">
          {rolePaths.map((path) => {
            const Icon = path.icon;
            return (
              <div key={path.label} className="min-w-0 rounded-xl border border-base bg-subtle/60 p-2.5">
                <div className="flex items-center gap-2">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-violet-100 text-[#6535C5] dark:bg-violet-900/40 dark:text-violet-300">
                    <Icon size={14} aria-hidden="true" />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-[12px] font-black text-primary">{path.label}</p>
                    <p className="truncate text-[10px] font-semibold text-muted">{path.hint}</p>
                  </div>
                </div>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {path.ids.map((id, index) => {
                    const lesson = lessons.find((item) => item.id === id);
                    if (!lesson) return null;
                    return (
                      <button
                        key={id}
                        type="button"
                        onClick={() => goToLesson(id)}
                        className="inline-flex min-h-8 max-w-full items-center gap-1 rounded-full border border-base bg-secondary px-2 py-1 text-[10px] font-bold text-secondary transition-colors hover:border-violet-400 hover:text-[#6535C5] dark:hover:text-violet-300"
                      >
                        <span className="font-black text-[#6535C5] dark:text-violet-300">{index + 1}</span>
                        <span className="truncate">{lesson.short}</span>
                        {completed.has(id) ? <CheckCircle2 size={11} className="shrink-0 text-emerald-600" aria-hidden="true" /> : null}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {searchActive ? (
        <section className="rounded-2xl border border-base bg-secondary p-4 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-black text-primary">
              {searchMatches.length} resultado{searchMatches.length === 1 ? "" : "s"} para «{query.trim()}»
            </h2>
            <button
              type="button"
              onClick={() => setQuery("")}
              className="inline-flex min-h-9 items-center gap-1 rounded-lg border border-base bg-subtle px-2.5 text-[11px] font-black text-secondary hover:text-[#6535C5] dark:hover:text-violet-300"
            >
              <X size={13} /> Limpiar
            </button>
          </div>
          {searchMatches.length === 0 ? (
            <p className="mt-3 rounded-xl border border-base bg-subtle p-3 text-[13px] font-semibold text-secondary">
              No encontramos esa palabra. Prueba con «turno», «stock», «impresora», «garantía» o «plan».
            </p>
          ) : (
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {searchMatches.map(({ lesson, index }) => (
                <button
                  key={lesson.id}
                  type="button"
                  onClick={() => goToLesson(lesson.id)}
                  className="flex min-w-0 items-start gap-2.5 rounded-xl border border-base bg-subtle/60 p-3 text-left transition-colors hover:border-violet-400 hover:bg-violet-50 dark:hover:bg-violet-950/30"
                >
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-violet-100 text-[11px] font-black text-[#6535C5] dark:bg-violet-900/40 dark:text-violet-300">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[13px] font-black text-primary">{lesson.title}</span>
                    <span className="mt-0.5 block text-[12px] leading-5 text-secondary">{lesson.summary}</span>
                    <span className="mt-1 block text-[10px] font-bold uppercase tracking-wide text-muted">
                      {lesson.level} · {lesson.minutes} min {completed.has(lesson.id) ? "· Completada" : ""}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>
      ) : (
        <div className="grid min-w-0 gap-3 lg:grid-cols-[290px_minmax(0,1fr)] lg:items-start">
          <aside className="hidden min-w-0 lg:sticky lg:top-4 lg:block lg:max-h-[calc(100dvh-2rem)] lg:overflow-y-auto">
            <nav aria-label="Lecciones de la Escuela PALMYRA" className="rounded-2xl border border-base bg-secondary p-3 shadow-sm">
              <div className="flex items-center justify-between gap-2 px-1">
                <span className="text-[10px] font-black uppercase tracking-[0.16em] text-muted">Ruta de aprendizaje</span>
                <span className="text-[10px] font-black text-primary">{completedCount}/{lessons.length}</span>
              </div>
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-subtle">
                <div className="h-full rounded-full bg-[#6535C5] transition-all dark:bg-violet-400" style={{ width: `${progressPct}%` }} />
              </div>
              <ol className="mt-2 space-y-1">
                {lessons.map((lesson, index) => {
                  const Icon = lesson.icon;
                  const active = lesson.id === currentLesson.id;
                  const done = completed.has(lesson.id);
                  return (
                    <li key={lesson.id}>
                      <button
                        type="button"
                        onClick={() => goToLesson(lesson.id)}
                        aria-current={active ? "page" : undefined}
                        className={cn(
                          "flex w-full min-w-0 items-center gap-2 rounded-xl border px-2 py-1.5 text-left transition-colors",
                          active
                            ? "border-violet-300 bg-violet-50 dark:border-violet-800 dark:bg-violet-950/40"
                            : "border-transparent hover:border-base hover:bg-subtle",
                        )}
                      >
                        <span
                          className={cn(
                            "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[10px] font-black",
                            done
                              ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                              : active
                                ? "bg-[#6535C5] text-white"
                                : "bg-subtle text-muted",
                          )}
                        >
                          {done ? <CheckCircle2 size={14} aria-hidden="true" /> : String(index + 1).padStart(2, "0")}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className={cn("block truncate text-[12px] font-bold", active ? "text-primary" : "text-secondary")}>
                            {lesson.short}
                          </span>
                          <span className="block text-[10px] font-semibold text-muted">
                            {lesson.level} · {lesson.minutes} min
                          </span>
                        </span>
                        <Icon size={13} className={cn("shrink-0", active ? "text-primary" : "text-muted")} aria-hidden="true" />
                      </button>
                    </li>
                  );
                })}
              </ol>
              <div className="mt-2 border-t border-base pt-2">
                <button
                  type="button"
                  onClick={() => {
                    if (window.confirm("¿Reiniciar el progreso de la Escuela PALMYRA en este dispositivo?")) {
                      setCompleted(new Set());
                    }
                  }}
                  className="w-full rounded-lg px-2 py-1.5 text-left text-[10px] font-bold text-muted hover:bg-subtle hover:text-[#6535C5] dark:hover:text-violet-300"
                >
                  Reiniciar mi progreso
                </button>
              </div>
            </nav>
          </aside>

          <div className="min-w-0 space-y-3">
            <div className="lg:hidden">
              <label htmlFor="school-lesson-select" className="mb-1 block text-[10px] font-black uppercase tracking-[0.14em] text-muted">
                Ir a una lección
              </label>
              <select
                id="school-lesson-select"
                value={currentLesson.id}
                onChange={(event) => goToLesson(event.target.value)}
                className="min-h-11 w-full rounded-xl border border-base bg-secondary px-3 text-[13px] font-bold text-primary outline-none focus:border-violet-500"
              >
                {lessons.map((lesson, index) => (
                  <option key={lesson.id} value={lesson.id}>
                    {String(index + 1).padStart(2, "0")} · {lesson.short}
                    {completed.has(lesson.id) ? " ✓" : ""}
                  </option>
                ))}
              </select>
            </div>

            <article className="min-w-0 overflow-hidden rounded-2xl border border-base bg-secondary shadow-sm">
              <header className="border-b border-base p-4 sm:p-5">
                <div className="flex flex-wrap items-center gap-1.5 text-[10px] font-black uppercase tracking-[0.12em] text-muted">
                  <span>Módulo {String(currentIndex + 1).padStart(2, "0")} / {lessons.length}</span>
                  <span aria-hidden="true">·</span>
                  <span>{currentLesson.level}</span>
                  <span aria-hidden="true">·</span>
                  <span className="inline-flex items-center gap-1"><Clock size={11} aria-hidden="true" /> {currentLesson.minutes} min</span>
                </div>
                <div className="mt-1 flex flex-wrap items-start justify-between gap-2">
                  <h2 className="min-w-0 text-lg font-black leading-tight text-primary sm:text-xl">{currentLesson.title}</h2>
                  <span className={cn(
                    "inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-1 text-[10px] font-black uppercase tracking-wide",
                    currentCompleted
                      ? "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300"
                      : "border-base bg-subtle text-muted",
                  )}>
                    {currentCompleted ? <CheckCircle2 size={12} aria-hidden="true" /> : <CircleDashedMark />}
                    {currentCompleted ? "Completada" : "Pendiente"}
                  </span>
                </div>
                <p className="mt-1.5 max-w-3xl text-sm font-semibold leading-6 text-secondary">{currentLesson.summary}</p>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {currentLesson.route ? (
                    <Link
                      to={currentLesson.route}
                      className="inline-flex min-h-10 items-center gap-1.5 rounded-xl border border-base bg-subtle px-3 text-[11px] font-black uppercase tracking-wide text-primary transition-colors hover:border-violet-400"
                    >
                      <ExternalLink size={13} aria-hidden="true" />
                      {currentLesson.routeLabel || "Abrir sección"}
                    </Link>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => toggleCompleted(currentLesson.id)}
                    className={cn(
                      "inline-flex min-h-10 items-center gap-1.5 rounded-xl px-3 text-[11px] font-black uppercase tracking-wide transition-colors",
                      currentCompleted
                        ? "border border-base bg-secondary text-secondary hover:text-[#6535C5] dark:hover:text-violet-300"
                        : "bg-gradient-to-r from-[#6535C5] to-indigo-600 text-white shadow-sm hover:opacity-95",
                    )}
                  >
                    <CheckCircle2 size={14} aria-hidden="true" />
                    {currentCompleted ? "Quitar completada" : "Marcar completada"}
                  </button>
                  {nextLesson ? (
                    <button
                      type="button"
                      onClick={() => goToLesson(nextLesson.id)}
                      className="inline-flex min-h-10 items-center gap-1.5 rounded-xl border border-base bg-secondary px-3 text-[11px] font-black uppercase tracking-wide text-secondary transition-colors hover:border-violet-400 hover:text-[#6535C5] dark:hover:text-violet-300"
                    >
                      Siguiente <ArrowRight size={13} aria-hidden="true" />
                    </button>
                  ) : null}
                </div>
              </header>

              <div className="space-y-3 p-4 sm:p-5">
                <div className="grid gap-2 sm:grid-cols-3">
                  <div className="min-w-0 rounded-xl border border-base bg-subtle/60 p-2.5">
                    <p className="flex items-center gap-1 text-[10px] font-black uppercase tracking-wide text-primary">
                      <Target size={12} aria-hidden="true" /> Objetivo
                    </p>
                    <p className="mt-1 text-[13px] font-semibold leading-5 text-secondary">{currentLesson.objective}</p>
                  </div>
                  <div className="min-w-0 rounded-xl border border-base bg-subtle/60 p-2.5">
                    <p className="flex items-center gap-1 text-[10px] font-black uppercase tracking-wide text-primary">
                      <CheckCircle2 size={12} aria-hidden="true" /> Al terminar
                    </p>
                    <p className="mt-1 text-[13px] font-semibold leading-5 text-secondary">{currentLesson.result}</p>
                  </div>
                  <div className={cn(
                    "min-w-0 rounded-xl border p-2.5",
                    currentLesson.prereq
                      ? "border-amber-200 bg-amber-50/70 dark:border-amber-900/60 dark:bg-amber-950/30"
                      : "border-emerald-200 bg-emerald-50/70 dark:border-emerald-900/60 dark:bg-emerald-950/30",
                  )}>
                    <p className={cn(
                      "flex items-center gap-1 text-[10px] font-black uppercase tracking-wide",
                      currentLesson.prereq ? "text-amber-800 dark:text-amber-200" : "text-emerald-800 dark:text-emerald-200",
                    )}>
                      <AlertTriangle size={12} aria-hidden="true" /> Antes de empezar
                    </p>
                    <p className={cn(
                      "mt-1 text-[13px] font-semibold leading-5",
                      currentLesson.prereq ? "text-amber-900 dark:text-amber-100" : "text-emerald-800 dark:text-emerald-200",
                    )}>
                      {currentLesson.prereq || "No necesitas nada especial para esta lección."}
                    </p>
                  </div>
                </div>

                <div ref={figureRef}>
                  <LessonFigure lesson={currentLesson} activeZone={activeZone} onZone={activateZone} />
                </div>

                <FlowMap flow={currentLesson.flow} />

                <section aria-label="Pasos de la lección">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-[11px] font-black uppercase tracking-[0.14em] text-muted">Paso a paso</h3>
                    <span className="text-[11px] font-semibold text-muted">{currentLesson.steps.length} pasos</span>
                  </div>
                  <ol className="mt-2 space-y-2.5">
                    {currentLesson.steps.map((step, index) => {
                      const number = index + 1;
                      const highlighted = step.zone != null && activeZone === step.zone;
                      return (
                        <li
                          key={step.title}
                          id={`paso-${currentLesson.id}-${number}`}
                          className={cn(
                            "relative min-w-0 rounded-xl border p-3 pl-12 transition-colors",
                            highlighted ? "border-violet-400 bg-violet-50/80 dark:border-violet-700 dark:bg-violet-950/30" : "border-base bg-subtle/40",
                          )}
                        >
                          <span
                            className={cn(
                              "absolute left-3 top-3 flex h-7 w-7 items-center justify-center rounded-lg text-[11px] font-black",
                              highlighted ? "bg-[#6535C5] text-white" : "bg-violet-100 text-[#6535C5] dark:bg-violet-900/40 dark:text-violet-300",
                            )}
                          >
                            {number}
                          </span>
                          {index < currentLesson.steps.length - 1 ? (
                            <span className="absolute left-[1.6rem] top-11 bottom-[-0.7rem] w-px border-l border-dashed border-base" aria-hidden="true" />
                          ) : null}
                          <div className="flex flex-wrap items-start justify-between gap-1.5">
                            <p className="min-w-0 text-[13px] font-black text-primary">{step.title}</p>
                            {step.zone ? (
                              <button
                                type="button"
                                onClick={() => focusZoneOnFigure(step.zone as number)}
                                className="inline-flex shrink-0 items-center gap-1 rounded-full border border-base bg-secondary px-2 py-0.5 text-[10px] font-bold text-secondary transition-colors hover:border-violet-400 hover:text-[#6535C5] dark:hover:text-violet-300"
                              >
                                <MapPin size={10} aria-hidden="true" /> Ver punto {step.zone}
                              </button>
                            ) : null}
                          </div>
                          <p className="mt-1 text-sm leading-6 text-secondary">{step.detail}</p>
                          {step.where ? (
                            <p className="mt-1.5 inline-flex items-center gap-1 text-[12px] font-bold text-[#6535C5] dark:text-violet-300">
                              <MapPin size={11} aria-hidden="true" /> {step.where}
                            </p>
                          ) : null}
                          {step.note ? (
                            <p className="mt-2 flex items-start gap-1.5 rounded-lg border border-amber-200 bg-amber-50/80 p-2 text-[12px] font-semibold leading-5 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100">
                              <Lightbulb size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
                              <span>{step.note}</span>
                            </p>
                          ) : null}
                        </li>
                      );
                    })}
                  </ol>
                </section>

                <section className="rounded-2xl border border-red-200 bg-red-50/70 p-3 dark:border-red-900/60 dark:bg-red-950/25">
                  <h3 className="flex items-center gap-1.5 text-[11px] font-black uppercase tracking-[0.14em] text-red-800 dark:text-red-200">
                    <AlertTriangle size={13} aria-hidden="true" /> Errores comunes
                  </h3>
                  <ul className="mt-1.5 space-y-1">
                    {currentLesson.mistakes.map((mistake) => (
                      <li key={mistake} className="flex items-start gap-1.5 text-[13px] font-semibold leading-5 text-red-900/90 dark:text-red-100/90">
                        <span className="mt-[0.45rem] h-1 w-1 shrink-0 rounded-full bg-red-500" aria-hidden="true" />
                        <span>{mistake}</span>
                      </li>
                    ))}
                  </ul>
                </section>

                {relatedLessons.length > 0 ? (
                  <section>
                    <h3 className="text-[11px] font-black uppercase tracking-[0.14em] text-muted">Conecta con</h3>
                    <p className="mt-0.5 text-[11px] font-semibold text-secondary">
                      Esta lección se enlaza con otros módulos. Síguelos en este orden para entender el flujo completo.
                    </p>
                    <div className="mt-1.5 grid gap-2 sm:grid-cols-2">
                      {relatedLessons.map((lesson) => {
                        const Icon = lesson.icon;
                        const index = lessons.findIndex((item) => item.id === lesson.id);
                        return (
                          <button
                            key={lesson.id}
                            type="button"
                            onClick={() => goToLesson(lesson.id)}
                            className="flex min-w-0 items-center gap-2 rounded-xl border border-base bg-subtle/50 p-2.5 text-left transition-colors hover:border-violet-400 hover:bg-violet-50 dark:hover:bg-violet-950/30"
                          >
                            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-violet-100 text-[#6535C5] dark:bg-violet-900/40 dark:text-violet-300">
                              <Icon size={15} aria-hidden="true" />
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-[12px] font-black text-primary">{lesson.short}</span>
                              <span className="block text-[10px] font-semibold text-muted">
                                Módulo {String(index + 1).padStart(2, "0")} · {lesson.level}
                              </span>
                            </span>
                            <ChevronRight size={14} className="shrink-0 text-muted" aria-hidden="true" />
                          </button>
                        );
                      })}
                    </div>
                  </section>
                ) : null}

                <footer className="flex flex-wrap items-center gap-2 border-t border-base pt-3">
                  {previousLesson ? (
                    <button
                      type="button"
                      onClick={() => goToLesson(previousLesson.id)}
                      className="inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-xl border border-base bg-secondary px-3 text-[11px] font-black uppercase tracking-wide text-secondary transition-colors hover:border-violet-400 hover:text-[#6535C5] dark:hover:text-violet-300"
                    >
                      <ArrowLeft size={14} aria-hidden="true" /> {previousLesson.short}
                    </button>
                  ) : null}
                  {nextLesson ? (
                    <button
                      type="button"
                      onClick={() => {
                        if (!completed.has(currentLesson.id)) toggleCompleted(currentLesson.id);
                        goToLesson(nextLesson.id);
                      }}
                      className="inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-xl bg-gradient-to-r from-[#6535C5] to-indigo-600 px-3 text-[11px] font-black uppercase tracking-wide text-white shadow-sm transition-opacity hover:opacity-95"
                    >
                      {nextLesson.short} <ArrowRight size={14} aria-hidden="true" />
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => goToLesson("inicio")}
                      className="inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-xl bg-gradient-to-r from-[#6535C5] to-indigo-600 px-3 text-[11px] font-black uppercase tracking-wide text-white shadow-sm transition-opacity hover:opacity-95"
                    >
                      Escuela completada · volver al inicio <ArrowRight size={14} aria-hidden="true" />
                    </button>
                  )}
                </footer>
              </div>
            </article>

            <p className="px-1 text-center text-[11px] font-semibold leading-5 text-muted">
              ¿Te quedó una duda? Abre <Link to="/help-center?section=support" className="font-black text-[#6535C5] underline decoration-violet-300 underline-offset-2 dark:text-violet-300">Soporte</Link> y envía tu solicitud al equipo PALMYRA.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function CircleDashedMark() {
  return <span className="h-2.5 w-2.5 rounded-full border border-current" aria-hidden="true" />;
}
