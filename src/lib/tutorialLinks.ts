/**
 * Enlaces de bajo acoplamiento hacia la Escuela PALMYRA (/tutorial).
 *
 * Cualquier página puede pedir «ir a la lección X» sin conocer la estructura
 * interna de Tutorial.tsx: basta con llamar a `tutorialPath(id)` y usar el
 * resultado en un <Link to> o en un navigate().
 *
 * La página /tutorial acepta tres formas equivalentes de indicar la lección:
 *   /tutorial?lesson=<id>   (canónica, la que genera esta función)
 *   /tutorial?section=<id>  (alias legible, también soportado)
 *   /tutorial#<id>          (respaldos y enlaces antiguos)
 */
export const TUTORIAL_ROUTE = "/tutorial";

/** Ids de lección conocidos de la Escuela PALMYRA (mantener en orden con Tutorial.tsx). */
export const TUTORIAL_LESSON_IDS = [
  "inicio",
  "dashboard",
  "pos-apertura",
  "pos-venta",
  "cierre",
  "inventario",
  "transferencias",
  "auditoria",
  "clientes",
  "proveedores",
  "cotizaciones",
  "devoluciones",
  "bancos",
  "reportes",
  "equipo",
  "offline",
  "configuracion",
  "plan",
  "auditoria-ajuste",
  "inventario-limpio",
  "transferencias-transito",
  "tasa-cambio",
  "soporte",
  "descargas",
  "primer-producto",
  "acceso-dispositivo",
  "actualizaciones",
  "licencia",
] as const;

export type TutorialLessonId = (typeof TUTORIAL_LESSON_IDS)[number];

export function isTutorialLessonId(value: string | null | undefined): value is TutorialLessonId {
  return typeof value === "string" && (TUTORIAL_LESSON_IDS as readonly string[]).includes(value);
}

/**
 * Ruta a la lección indicada. Devuelve la ruta canónica con query `?lesson=`.
 * Si el id no es una lección conocida, devuelve la portada de la escuela.
 */
export function tutorialPath(sectionId: string): string {
  const clean = sectionId.replace(/^#/, "").trim();
  if (!clean) return TUTORIAL_ROUTE;
  return `${TUTORIAL_ROUTE}?lesson=${encodeURIComponent(clean)}`;
}

/**
 * Variante con hash para contextos donde no se puede usar query (por ejemplo,
 * enlaces estáticos o impresos). La página también la entiende.
 */
export function tutorialHashPath(sectionId: string): string {
  const clean = sectionId.replace(/^#/, "").trim();
  if (!clean) return TUTORIAL_ROUTE;
  return `${TUTORIAL_ROUTE}#${encodeURIComponent(clean)}`;
}
