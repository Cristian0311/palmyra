import type { User } from "../../types";

export type PalmiTourStep = {
  id: string; path?: string; selector?: string; eyebrow: string; title: string; message: string; tip?: string; permission?: string;
};

export const PALMI_TOUR_STEPS: PalmiTourStep[] = [
  { id:"welcome", eyebrow:"Guía PALMYRA", title:"Soy Palmi", message:"Voy a acompañarte por PALMYRA para que conozcas el sistema sin tener que aprender informática. Puedes moverme donde te resulte más cómodo.", tip:"Durante el recorrido avanzaré por cada área disponible para tu usuario." },
  { id:"dashboard", path:"/", selector:'a[href="/"]', eyebrow:"01 · Vista general", title:"Dashboard", message:"Aquí comienzas cada día. El Dashboard reúne los indicadores principales del negocio para saber rápidamente qué está pasando.", tip:"Úsalo para revisar el estado general antes de entrar a una operación." },
  { id:"pos", path:"/pos", selector:'a[href="/pos"]', eyebrow:"02 · Operación", title:"Punto de Venta", message:"Aquí se realizan las ventas. El trabajador selecciona productos, cobra, imprime el ticket y puede continuar trabajando cuando la conexión falla gracias al modo offline." },
  { id:"inventory", path:"/inventory", selector:'a[href="/inventory"]', eyebrow:"03 · Control", title:"Inventario", message:"Aquí controlas existencias, precios y movimientos. Es el lugar donde sabes qué tienes disponible y dónde está cada producto.", tip:"La información se mantiene organizada por almacén.", permission:"inventory.manage" },
  { id:"transfers", path:"/transfers", selector:'a[href="/transfers"]', eyebrow:"04 · Logística", title:"Transferencias", message:"Aquí gestionas movimientos de mercancía entre almacenes para mantener el stock organizado.", permission:"inventory.manage" },
  { id:"customers", path:"/customers", selector:'a[href="/customers"]', eyebrow:"05 · Clientes", title:"Clientes", message:"Aquí registras y consultas clientes. La información complementa el Punto de Venta y mantiene ordenada la relación con cada cliente.", permission:"customers.manage" },
  { id:"suppliers", path:"/suppliers", selector:'a[href="/suppliers"]', eyebrow:"06 · Abastecimiento", title:"Proveedores", message:"Aquí gestionas los proveedores con los que trabaja tu empresa y mantienes organizado el abastecimiento.", permission:"suppliers.manage" },
  { id:"returns", path:"/returns", selector:'a[href="/returns"]', eyebrow:"07 · Atención", title:"Devoluciones", message:"Aquí controlas devoluciones y operaciones relacionadas con ventas, manteniendo el historial para que las decisiones queden registradas.", permission:"pos.access" },
  { id:"reports", path:"/reports", selector:'a[href="/reports"]', eyebrow:"08 · Análisis", title:"Reportes", message:"Aquí conviertes la operación diaria en información útil: ventas, caja, inventario y resultados.", permission:"reports.view" },
  { id:"team", path:"/team", selector:'a[href="/team"]', eyebrow:"09 · Personas", title:"Equipo", message:"Esta es la única vista para administrar trabajadores. Aquí creas empleados, los invitas, asignas rol, salario, almacenes y permisos, y puedes activar o desactivar su acceso.", permission:"employees.manage" },
  { id:"settings", path:"/settings", selector:'a[href="/settings"]', eyebrow:"10 · Sistema", title:"Configuración", message:"Aquí personalizas la empresa, monedas, almacenes, impresión, conectividad, apariencia y opciones avanzadas.", tip:"La administración de empleados se concentra en Equipo.", permission:"settings.manage" },
  { id:"subscription", path:"/subscription", selector:'a[href="/subscription"]', eyebrow:"11 · Plan", title:"Plan", message:"Aquí puedes revisar el plan contratado, sus límites y el estado de la suscripción de tu negocio.", permission:"settings.manage" },
  { id:"offline", path:"/", selector:'[data-tour="offline-status"]', eyebrow:"12 · Continuidad", title:"Estado de conexión", message:"PALMYRA muestra si está online u offline y cuántas operaciones pendientes existen. Cuando vuelve la conexión, las operaciones pueden sincronizarse con la nube.", tip:"No borres la cola offline para intentar recuperar una venta." },
  { id:"finish", eyebrow:"Recorrido completado", title:"Ya conoces PALMYRA", message:"Puedes volver a abrir esta guía cuando quieras. Palmi queda disponible como ayuda rápida y recuerda dónde te encontrabas.", tip:"Puedes arrastrarme a otra esquina para que no estorbe mientras trabajas." }
];

export function getAccessiblePalmiTourSteps(currentUser: Pick<User, "role" | "permissions"> | null | undefined) {
  const isAdmin = currentUser?.role === "admin";
  return PALMI_TOUR_STEPS.filter(step => !step.permission || isAdmin || currentUser?.permissions?.includes(step.permission));
}
