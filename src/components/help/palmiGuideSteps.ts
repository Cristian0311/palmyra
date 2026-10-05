import type { User } from "../../types";

export type PalmiTourStep = {
  id: string; path?: string; selector?: string; eyebrow: string; title: string; message: string; tip?: string; permission?: string;
};

export const PALMI_TOUR_STEPS: PalmiTourStep[] = [
  { id:"welcome", eyebrow:"Guía PALMYRA", title:"Soy Palmi", message:"Voy a acompañarte por PALMYRA para que conozcas el sistema sin tener que aprender informática. Puedes moverme donde te resulte más cómodo.", tip:"Durante el recorrido avanzaré por cada área disponible para tu usuario." },
  { id:"dashboard", path:"/", selector:'a[href="/"]', eyebrow:"01 · Vista general", title:"Dashboard", message:"Aquí comienzas cada día. El Dashboard reúne los indicadores principales del negocio para saber rápidamente qué está pasando.", tip:"Úsalo para revisar el estado general antes de entrar a una operación." },
  { id:"pos", path:"/pos", selector:'a[href="/pos"]', eyebrow:"02 · Operación", title:"Punto de Venta", message:"Aquí se realizan las ventas. El trabajador selecciona productos, cobra, imprime el ticket y puede continuar trabajando cuando la conexión falla gracias al modo offline.", tip:"Caja, cobro, selección de vendedor y ticket forman parte de este flujo." },
  { id:"transfers", path:"/transfers", selector:'a[href="/transfers"]', eyebrow:"03 · Logística", title:"Transferencias", message:"Aquí gestionas movimientos de mercancía entre almacenes para mantener el stock organizado.", permission:"inventory.manage" },
  { id:"customers", path:"/customers", selector:'a[href="/customers"]', eyebrow:"04 · Clientes", title:"Clientes", message:"Aquí registras y consultas clientes. La información complementa el Punto de Venta y mantiene ordenada la relación con cada cliente.", permission:"customers.manage" },
  { id:"inventory", path:"/inventory", selector:'a[href="/inventory"]', eyebrow:"05 · Control", title:"Inventario", message:"Aquí controlas existencias, precios y movimientos. Es el lugar donde sabes qué tienes disponible y dónde está cada producto.", tip:"La información se mantiene organizada por almacén.", permission:"inventory.manage" },
  { id:"inventory-audit", path:"/inventory-audit", selector:'a[href="/inventory-audit"]', eyebrow:"06 · Verificación", title:"Auditoría de Stock", message:"Esta área sirve para comprobar físicamente el inventario y detectar diferencias antes de tomar decisiones sobre el stock.", permission:"inventory.manage" },
  { id:"suppliers", path:"/suppliers", selector:'a[href="/suppliers"]', eyebrow:"07 · Abastecimiento", title:"Proveedores", message:"Aquí gestionas los proveedores con los que trabaja tu empresa y mantienes organizado el abastecimiento.", permission:"suppliers.manage" },
  { id:"banks", path:"/banks", selector:'a[href="/banks"]', eyebrow:"08 · Finanzas", title:"Cuentas Bancarias", message:"Aquí controlas cuentas, tarjetas y movimientos bancarios que forman parte de la operación administrativa de la empresa.", permission:"settings.manage" },
  { id:"returns", path:"/returns", selector:'a[href="/returns"]', eyebrow:"09 · Atención", title:"Devoluciones", message:"Aquí controlas devoluciones y operaciones relacionadas con ventas, manteniendo el historial para que las decisiones queden registradas.", permission:"pos.access" },
  { id:"reports", path:"/reports", selector:'a[href="/reports"]', eyebrow:"10 · Análisis", title:"Reportes", message:"Aquí conviertes la operación diaria en información útil: ventas, caja, inventario y resultados.", permission:"reports.view" },
  { id:"team", path:"/team", selector:'a[href="/team"]', eyebrow:"11 · Personas", title:"Equipo", message:"Esta es la única vista para administrar trabajadores. Aquí creas empleados, los invitas, asignas rol, salario, almacenes y permisos, y puedes activar o desactivar su acceso.", tip:"No necesitas ir a Configuración para crear empleados.", permission:"employees.manage" },
  { id:"settings", path:"/settings", selector:'a[href="/settings"]', eyebrow:"12 · Sistema", title:"Configuración", message:"Aquí personalizas la empresa, monedas, almacenes, impresión, conectividad, apariencia y opciones avanzadas.", tip:"La administración de empleados se concentra en Equipo.", permission:"settings.manage" },
  { id:"subscription", path:"/subscription", selector:'a[href="/subscription"]', eyebrow:"13 · Plan", title:"Plan", message:"Aquí puedes revisar el plan contratado, sus límites y el estado de la suscripción de tu negocio.", permission:"settings.manage" },
  { id:"security", path:"/security", selector:'a[href="/security"]', eyebrow:"14 · Seguridad", title:"Seguridad", message:"Esta área protege el acceso operativo cuando está disponible para tu perfil y permite gestionar controles de seguridad del dispositivo.", permission:"security.manage" },
  { id:"offline", path:"/", selector:'[data-tour="offline-status"]', eyebrow:"15 · Continuidad", title:"Estado de conexión", message:"PALMYRA muestra si está online u offline y cuántas operaciones pendientes existen. Cuando vuelve la conexión, las operaciones pueden sincronizarse con la nube.", tip:"No borres la cola offline para intentar recuperar una venta." },
  { id:"finish", eyebrow:"Recorrido completado", title:"Ya conoces PALMYRA", message:"Puedes volver a abrir esta guía cuando quieras. Palmi queda disponible como ayuda rápida y puedes moverlo a otra esquina de la pantalla.", tip:"El recorrido se adapta a los permisos de cada usuario." }
];

export function getAccessiblePalmiTourSteps(currentUser: Pick<User, "role" | "permissions"> | null | undefined) {
  const isAdmin = currentUser?.role === "admin";
  return PALMI_TOUR_STEPS.filter(step => !step.permission || isAdmin || currentUser?.permissions?.includes(step.permission));
}
