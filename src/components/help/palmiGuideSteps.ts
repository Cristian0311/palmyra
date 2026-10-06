import type { User } from "../../types";

export interface NumaGuideStep {
  id: string;
  eyebrow: string;
  title: string;
  message: string;
  tip?: string;
  permission?: string;
  mobileOnly?: boolean;
}

const STEPS: NumaGuideStep[] = [
  {
    id: "welcome",
    eyebrow: "BIENVENIDA",
    title: "Conoce PALMYRA",
    message: "Este recorrido te muestra cómo trabajar con PALMYRA de forma ordenada. Puedes avanzar sin modificar datos.",
    tip: "Primero aprende el flujo y después empieza a operar."
  },
  {
    id: "dashboard",
    eyebrow: "CONTROL",
    title: "Dashboard",
    message: "Consulta la actividad de tu negocio, los indicadores principales y los accesos rápidos disponibles para tu rol.",
    tip: "Úsalo para detectar cambios antes de entrar a una operación."
  },
  {
    id: "pos",
    eyebrow: "VENTAS",
    title: "Punto de Venta",
    message: "Aquí realizas las ventas, cobras, eliges vendedor, aplicas pagos y trabajas incluso cuando el dispositivo queda sin conexión.",
    permission: "pos.access",
    tip: "En offline, las operaciones deben quedar visibles como pendientes hasta sincronizarse."
  },
  {
    id: "inventory",
    eyebrow: "INVENTARIO",
    title: "Inventario",
    message: "Administra productos, existencias y alertas del almacén autorizado por tu cuenta.",
    permission: "inventory.manage",
    tip: "Evita modificar inventario desde lugares no autorizados."
  },
  {
    id: "transfers",
    eyebrow: "ABASTECIMIENTO",
    title: "Transferencias",
    message: "Consulta y gestiona movimientos de mercancía entre almacenes cuando tu rol tenga permiso.",
    permission: "inventory.manage",
    tip: "Antes de mover mercancía, confirma origen, destino y cantidades."
  },
  {
    id: "customers",
    eyebrow: "CLIENTES",
    title: "Clientes",
    message: "Registra y consulta clientes para asociar sus operaciones cuando tu rol lo permita.",
    permission: "customers.manage"
  },
  {
    id: "reports",
    eyebrow: "ANÁLISIS",
    title: "Reportes",
    message: "Revisa ventas, caja y actividad histórica para controlar el negocio.",
    permission: "reports.view",
    tip: "Los reportes deben coincidir con las operaciones que aparecen en caja."
  },
  {
    id: "team",
    eyebrow: "PERSONAL",
    title: "Equipo",
    message: "Administra empleados, roles y accesos a almacenes desde la sección correspondiente.",
    permission: "employees.manage",
    tip: "Asigna solo los permisos que cada trabajador necesita."
  },
  {
    id: "settings",
    eyebrow: "CONFIGURACIÓN",
    title: "Configuración",
    message: "Personaliza la empresa y las opciones operativas disponibles para administradores.",
    permission: "settings.manage"
  },
  {
    id: "security",
    eyebrow: "PROTECCIÓN",
    title: "Centro de atención y Seguridad",
    message: "Desde el Centro de atención puedes revisar sesiones, dispositivos y revocar accesos que ya no deban permanecer activos."
  },
  {
    id: "offline",
    eyebrow: "CONTINUIDAD",
    title: "Trabajar sin Internet",
    message: "PALMYRA conserva el estado local y las operaciones pendientes para que puedas continuar trabajando mientras la conexión no está disponible.",
    tip: "Cuando vuelva Internet, revisa el indicador de sincronización y confirma que no queden operaciones pendientes."
  },
  {
    id: "finish",
    eyebrow: "LISTO",
    title: "Ya puedes empezar",
    message: "Terminaste el recorrido. PALMYRA puede instalarse como aplicación en tu teléfono para abrirla más rápido y continuar trabajando.",
    tip: "La instalación no cierra tu sesión."
  }
];

export function getAccessibleNumaTourSteps(user: User | null | undefined, _isMobile = false): NumaGuideStep[] {
  return STEPS.filter((step) => {
    if (step.mobileOnly && !_isMobile) return false;
    if (!step.permission) return true;
    if (user?.role === "admin") return true;
    return Boolean(user?.permissions?.includes(step.permission));
  });
}
