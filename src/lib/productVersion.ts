// La versión visible sale del mismo package.json que usan el instalador, el
// APK y /version.json. Vite la inyecta como __APP_VERSION__; fuera de Vite
// (tests o scripts) se usa un valor neutro para no romper la importación.
export const PRODUCT_VERSION =
  typeof __APP_VERSION__ === "string" && __APP_VERSION__.trim() ? __APP_VERSION__.trim() : "0.0.0";
// Etiqueta visible acordada con el dueño. La versión técnica de arriba sigue
// mandando en el actualizador y en los artefactos; esta solo se pinta.
export const PRODUCT_DISPLAY_VERSION = "1.1.1";
export const PRODUCT_VERSION_LABEL = `Versión ${PRODUCT_DISPLAY_VERSION}`;
export const PRODUCT_VERSION_SHORT = `V ${PRODUCT_DISPLAY_VERSION}`;
