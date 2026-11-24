// Misma versión que package.json; el BUILD_ID solo detecta despliegues nuevos.
export const ADMIN_PRODUCT_VERSION =
  typeof __ADMIN_VERSION__ === "string" && __ADMIN_VERSION__.trim() ? __ADMIN_VERSION__.trim() : "0.0.0";
