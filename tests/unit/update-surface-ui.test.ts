/**
 * Regresiones de la UI del botón «Actualizar software» (Configuración →
 * Sistema) y del aviso flotante público.
 *
 * Se prueban los helpers puros exportados por los componentes para fijar los
 * bugs de superficie:
 *   - El aviso mostraba la versión de ETIQUETA (1.1.1) en lugar de la versión
 *     real disponible (p. ej. 1.3.11).
 *   - El botón de escritorio decía «Reiniciando…» mientras la descarga aún
 *     estaba en curso (status available/downloading).
 *   - El botón de aplicar quedaba en «Actualizando…» para siempre si el
 *     instalador no respondía.
 *   - La línea de progreso de escritorio decía «Descargando 0%…» durante
 *     «available» (verificación de firma).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

// saas.ts (cadena de imports de SettingsSystemSection) lee import.meta.env en
// el ámbito del módulo y tsx no lo define; mismo puente que el resto de tests.
(globalThis as any).__VITE_ENV__ = {};
const LOADER = [
  'export async function load(url, context, nextLoad) {',
  '  const r = await nextLoad(url, context);',
  '  if (url.includes("/src/") && r && r.source) {',
  '    const text = r.source.toString();',
  '    if (text.includes("import.meta.env")) {',
  '      return { ...r, source: text.replaceAll("import.meta.env", "(import.meta.env ?? globalThis.__VITE_ENV__)") };',
  '    }',
  '  }',
  '  return r;',
  '}'
].join('\n');
register('data:text/javascript;charset=utf-8,' + encodeURIComponent(LOADER));

const { applyButtonLabel, desktopCopy } = await import(
  "../../src/components/settings/SettingsSystemSection.tsx"
);
const { updateBannerHeadline, desktopBannerPrimaryLabel } = await import(
  "../../src/components/PublicUpdateBanner.tsx"
);

// ─── Titular del aviso (regresión: mostraba PRODUCT_DISPLAY_VERSION) ────────

test("el titular del aviso muestra la versión real disponible, no la etiqueta local", () => {
  assert.equal(updateBannerHeadline("1.3.11"), "La versión 1.3.11 de PALMYRA está lista.");
  // La etiqueta de la app instalada (1.1.1) no puede colarse en el aviso.
  assert.ok(!updateBannerHeadline("1.3.11").includes("1.1.1"));
  assert.equal(updateBannerHeadline("1.4.0"), "La versión 1.4.0 de PALMYRA está lista.");
});

test("el titular sin versión usa el texto genérico", () => {
  assert.equal(updateBannerHeadline(""), "Una nueva versión de PALMYRA está lista.");
});

// ─── Etiqueta del botón principal del aviso de escritorio ──────────────────

test("el botón de escritorio NUNCA dice «Reiniciando…» durante available/downloading", () => {
  const label = (status: string, percent: number, installing = false) =>
    desktopBannerPrimaryLabel({ installing, status, percent });

  assert.equal(label("available", 0), "Verificando… 0%");
  assert.equal(label("available", 12), "Verificando… 12%");
  assert.equal(label("downloading", 42), "Descargando… 42%");
  assert.ok(!label("available", 0).includes("Reiniciando"));
  assert.ok(!label("downloading", 42).includes("Reiniciando"));
  assert.ok(!label("available", 0).includes("Preparando"));
});

test("«Reiniciando…» solo aparece cuando el instalador ya se lanzó", () => {
  assert.equal(
    desktopBannerPrimaryLabel({ installing: true, status: "downloaded", percent: 100 }),
    "Reiniciando…"
  );
  assert.equal(
    desktopBannerPrimaryLabel({ installing: false, status: "downloaded", percent: 100 }),
    "Reiniciar y actualizar"
  );
});

test("error y bloqueo ofrecen reintentar en el aviso de escritorio", () => {
  assert.equal(
    desktopBannerPrimaryLabel({ installing: false, status: "error", percent: 0 }),
    "Reintentar"
  );
  assert.equal(
    desktopBannerPrimaryLabel({ installing: false, status: "blocked", percent: 0 }),
    "Reintentar"
  );
  // Aunque el estado local crea que está instalando, un error manda.
  assert.equal(
    desktopBannerPrimaryLabel({ installing: true, status: "blocked", percent: 0 }),
    "Reintentar"
  );
});

test("estados desconocidos del aviso de escritorio muestran preparación, no reinicio", () => {
  assert.equal(
    desktopBannerPrimaryLabel({ installing: false, status: "checking", percent: 5 }),
    "Preparando… 5%"
  );
  assert.equal(
    desktopBannerPrimaryLabel({ installing: true, status: "checking", percent: 5 }),
    "Reiniciando…"
  );
});

// ─── Botón de aplicar en Configuración → Sistema ───────────────────────────

test("«Actualizando…» solo mientras se aplica; nunca se queda tras terminar", () => {
  assert.equal(applyButtonLabel(true, "downloaded"), "Actualizando…");
  assert.equal(applyButtonLabel(true, "error"), "Actualizando…");
  assert.equal(applyButtonLabel(false, "downloaded"), "Reiniciar y actualizar");
  assert.equal(applyButtonLabel(false, "available"), "Actualizar ahora");
  assert.equal(applyButtonLabel(false, "error"), "Actualizar ahora");
  assert.equal(applyButtonLabel(false, "unsupported"), "Actualizar ahora");
});

// ─── Copia del estado de escritorio (línea de progreso) ────────────────────

test("la línea de progreso de escritorio no miente durante «available»", () => {
  // Regresión: antes decía «Descargando 0%…» mientras solo se verificaba la firma.
  assert.equal(desktopCopy("available", 0).label, "Preparando la descarga…");
  assert.equal(desktopCopy("available", 0).tone, "warn");
});

test("desktopCopy describe cada estado en español", () => {
  assert.equal(desktopCopy("checking", 0).label, "Comprobando…");
  assert.equal(desktopCopy("downloading", 37).label, "Descargando actualización 37%…");
  assert.equal(desktopCopy("downloaded", 100).label, "Actualización lista para instalar");
  assert.equal(desktopCopy("not-available", 0).label, "Ya tienes la última versión");
  assert.equal(desktopCopy("not-available", 0).tone, "ok");
  assert.equal(desktopCopy("blocked", 0).label, "La descarga está bloqueada; vuelve a intentarlo");
  assert.equal(desktopCopy("blocked", 0).tone, "bad");
  assert.equal(desktopCopy("error", 0).label, "No se pudo completar la actualización");
  assert.equal(desktopCopy("error", 0).tone, "bad");
  assert.equal(
    desktopCopy("unsupported", 0).label,
    "Esta instalación no permite actualizar desde la app"
  );
});

test("desktopCopy degrada a «sin comprobar» para estados desconocidos", () => {
  assert.equal(desktopCopy("idle", 0).label, "Sin comprobar todavía");
  assert.equal(desktopCopy("desconocido", 0).label, "Sin comprobar todavía");
});
