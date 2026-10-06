import type { User } from "../../types";

export interface NumaTourStep {
  id: string;
  eyebrow: string;
  title: string;
  message: string;
  action?: string;
  tip?: string;
  permission?: string;
  route?: string;
  target?: string[];
  contentTarget?: string[];
  navTarget?: boolean;
}

const STEPS: NumaTourStep[] = [
  {
    id: "welcome",
    eyebrow: "BIENVENIDA",
    title: "Soy NUMA",
    message:
      "Soy la guía de PALMYRA. Te explico qué hace cada área y te acompaño con instrucciones concretas, sin quitarte el control.",
    tip:
      "En cada paso verás primero qué debes tocar y, después, qué puedes hacer dentro de esa sección."
  },
  {
    id: "dashboard",
    eyebrow: "CONTROL",
    title: "Dashboard",
    action: "Toca “Dashboard” en el menú lateral.",
    message:
      "Ya estás en Dashboard. Aquí obtienes una vista rápida del negocio: indicadores, actividad reciente y accesos importantes para saber qué necesita atención.",
    tip:
      "Úsalo para orientarte antes de entrar en una operación concreta.",
    permission: "reports.view",
    route: "/",
    navTarget: true,
    target: ['[data-palmy-nav="/"]'],
    contentTarget: [
      '[data-palmi-content="dashboard"]',
      '[data-palmi-heading="dashboard"]'
    ]
  },
  {
    id: "pos",
    eyebrow: "VENTAS",
    title: "Punto de Venta",
    action: "Toca “Punto de Venta” en el menú lateral.",
    message:
      "Ya estás en Punto de Venta. Aquí puedes crear la venta, buscar productos, revisar el carrito, seleccionar el vendedor, cobrar y continuar trabajando cuando la conexión falle.",
    tip:
      "La venta debe quedar controlada desde el carrito hasta el comprobante final.",
    permission: "pos.access",
    route: "/pos",
    navTarget: true,
    target: ['[data-palmy-nav="/pos"]'],
    contentTarget: ['[data-palmi-content="pos"]']
  },
  {
    id: "inventory",
    eyebrow: "INVENTARIO",
    title: "Inventario",
    action: "Toca “Inventario” en el menú lateral.",
    message:
      "Ya estás en Inventario. Aquí controlas productos, existencias y movimientos del almacén autorizado para saber qué hay disponible y qué necesita reposición.",
    tip:
      "Las existencias son la referencia para compras, ventas y movimientos entre almacenes.",
    permission: "inventory.manage",
    route: "/inventory",
    navTarget: true,
    target: ['[data-palmy-nav="/inventory"]'],
    contentTarget: ['[data-palmi-content="inventory"]']
  },
  {
    id: "transfers",
    eyebrow: "ABASTECIMIENTO",
    title: "Transferencias",
    action: "Toca “Transferencias” en el menú lateral.",
    message:
      "Ya estás en Transferencias. Aquí registras los movimientos de mercancía entre almacenes a los que tienes acceso y puedes revisar su historial operativo.",
    tip:
      "Antes de registrar un movimiento, confirma siempre el almacén de origen y el de destino.",
    permission: "inventory.manage",
    route: "/transfers",
    navTarget: true,
    target: ['[data-palmy-nav="/transfers"]'],
    contentTarget: ['[data-palmi-content="transfers"]']
  },
  {
    id: "customers",
    eyebrow: "CLIENTES",
    title: "Clientes",
    action: "Toca “Clientes” en el menú lateral.",
    message:
      "Ya estás en Clientes. Aquí puedes registrar, consultar y mantener la información de las personas o negocios que se relacionan con tus operaciones.",
    tip:
      "Mantener los datos limpios evita duplicados y facilita las consultas posteriores.",
    permission: "customers.manage",
    route: "/customers",
    navTarget: true,
    target: ['[data-palmy-nav="/customers"]'],
    contentTarget: ['[data-palmi-content="customers"]']
  },
  {
    id: "reports",
    eyebrow: "RESULTADOS",
    title: "Reportes",
    action: "Toca “Reportes” en el menú lateral.",
    message:
      "Ya estás en Reportes. Aquí conviertes las operaciones en información para revisar ventas, caja, inventario y otros resultados del negocio.",
    tip:
      "Los reportes sirven para revisar lo ocurrido; las operaciones se realizan en sus módulos correspondientes.",
    permission: "reports.view",
    route: "/reports",
    navTarget: true,
    target: ['[data-palmy-nav="/reports"]'],
    contentTarget: ['[data-palmi-content="reports"]']
  },
  {
    id: "team",
    eyebrow: "PERSONAL",
    title: "Equipo",
    action: "Toca “Equipo” en el menú lateral.",
    message:
      "Ya estás en Equipo. Aquí administras empleados, roles y permisos para que cada persona vea y haga únicamente lo que corresponde a su trabajo.",
    tip:
      "Los permisos determinan qué áreas puede utilizar cada trabajador.",
    permission: "employees.manage",
    route: "/team",
    navTarget: true,
    target: ['[data-palmy-nav="/team"]'],
    contentTarget: ['[data-palmi-content="team"]']
  },
  {
    id: "settings",
    eyebrow: "CONFIGURACIÓN",
    title: "Configuración",
    action: "Toca “Configuración” en el menú lateral.",
    message:
      "Ya estás en Configuración. Aquí defines opciones de la empresa y de la operación para adaptar PALMYRA a la forma en que trabaja tu negocio.",
    tip:
      "Haz cambios de configuración con cuidado porque pueden afectar el comportamiento del sistema.",
    permission: "settings.manage",
    route: "/settings",
    navTarget: true,
    target: ['[data-palmy-nav="/settings"]'],
    contentTarget: ['[data-palmi-content="settings"]']
  },
  {
    id: "help",
    eyebrow: "AYUDA",
    title: "Centro de atención",
    action: "Toca “Centro de atención” en el menú lateral.",
    message:
      "Ya estás en Centro de atención. Aquí encuentras el tutorial, soporte, seguridad y política de privacidad; también puedes volver a abrir NUMA cuando necesites orientación.",
    tip:
      "Este es el punto de ayuda cuando una función no está clara o necesitas contactar con soporte.",
    route: "/help",
    navTarget: true,
    target: ['[data-palmy-nav="/help"]', '[data-palmy-nav="/help-center"]'],
    contentTarget: ['[data-palmi-content="help-center"]']
  },
  {
    id: "offline",
    eyebrow: "CONTINUIDAD",
    title: "Estado offline",
    message:
      "El indicador de conexión te muestra si PALMYRA está online o offline y, cuando corresponde, cuántas operaciones quedan pendientes de sincronización.",
    tip:
      "Cuando vuelva la conexión, revisa el estado de sincronización antes de considerar el trabajo completamente enviado.",
    target: ['[data-tour="offline-status"]', '[data-tour="offline-status-mobile"]']
  },
  {
    id: "finish",
    eyebrow: "LISTO",
    title: "NUMA está contigo",
    message:
      "Terminaste el recorrido. Desde ahora puedes abrir NUMA desde el menú de PALMYRA y recibir una explicación contextual sin perder de vista lo que estás haciendo.",
    tip:
      "NUMA se adapta a móvil, tablet y PC y no mueve tu contenido ni modifica una operación por su cuenta."
  }
];

export const NUMA_TOUR_STEPS = STEPS;

export function getAccessibleNumaTourSteps(
  user: User | null | undefined
): NumaTourStep[] {
  return STEPS.filter((step) => {
    if (!step.permission) return true;
    if (user?.role === "admin") return true;
    return Boolean(user?.permissions?.includes(step.permission));
  });
}
