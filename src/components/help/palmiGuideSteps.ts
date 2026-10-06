import type { User } from "../../types";

export interface NumaTourStep {
  id: string;
  eyebrow: string;
  title: string;
  message: string;
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
    message: "Soy la guía de PALMYRA. Te acompaño por el sistema sin bloquear la pantalla y te llevo hasta el lugar exacto que necesitas.",
    tip: "Puedes cerrar NUMA en cualquier momento y volver a abrirla desde el menú."
  },
  {
    id: "dashboard",
    eyebrow: "CONTROL",
    title: "Dashboard",
    message: "Aquí ves la actividad principal del negocio, sus indicadores y accesos rápidos.",
    permission: "reports.view",
    route: "/",
    navTarget: true,
    target: ['[data-palmy-nav="/"]'],
    contentTarget: ['[data-palmi-content="dashboard"]', '[data-palmi-heading="dashboard"]']
  },
  {
    id: "pos",
    eyebrow: "VENTAS",
    title: "Punto de Venta",
    message: "Este es el centro de ventas. Desde aquí puedes cobrar, gestionar el carrito y continuar trabajando con el modo offline.",
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
    message: "Consulta existencias, productos y alertas del almacén autorizado.",
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
    message: "Gestiona movimientos de mercancía entre los almacenes a los que tienes acceso.",
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
    message: "Registra y consulta clientes para asociarlos a las operaciones que correspondan.",
    permission: "customers.manage",
    route: "/customers",
    navTarget: true,
    target: ['[data-palmy-nav="/customers"]'],
    contentTarget: ['[data-palmi-content="customers"]']
  },
  {
    id: "reports",
    eyebrow: "ANÁLISIS",
    title: "Reportes",
    message: "Aquí revisas ventas, caja e historial para controlar lo que ocurre en el negocio.",
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
    message: "Administra empleados, roles y los accesos que necesita cada trabajador.",
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
    message: "Configura la empresa y las opciones operativas de tu cuenta.",
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
    message: "Aquí viven el tutorial, soporte, seguridad y política de privacidad. NUMA también se abre desde este lugar.",
    route: "/help",
    navTarget: true,
    target: ['[data-palmy-nav="/help"]', '[data-palmy-nav="/help-center"]'],
    contentTarget: ['[data-palmi-content="help-center"]']
  },
  {
    id: "offline",
    eyebrow: "CONTINUIDAD",
    title: "Estado offline",
    message: "El indicador de conexión te muestra si estás online y cuántas operaciones permanecen pendientes de sincronización.",
    target: ['[data-tour="offline-status"]', '[data-tour="offline-status-mobile"]']
  },
  {
    id: "finish",
    eyebrow: "LISTO",
    title: "NUMA está contigo",
    message: "Terminaste el recorrido. A partir de ahora NUMA puede ayudarte desde cualquier sección sin esconder la información que necesitas.",
    tip: "La guía recuerda tu progreso y respeta el tamaño de la pantalla."
  }
];

export function getAccessibleNumaTourSteps(user: User | null | undefined): NumaTourStep[] {
  return STEPS.filter((step) => {
    if (!step.permission) return true;
    if (user?.role === "admin") return true;
    return Boolean(user?.permissions?.includes(step.permission));
  });
}
