import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Contrato de layout de Edición Masiva (Inventario) en el teléfono.
 *
 * La raíz de la página mide exactamente el alto de la ventana, así que el panel
 * reparte lo que sobra. En un teléfono de 390×844 el encabezado, los KPIs, la barra
 * de filtros, las categorías y las pestañas consumen ~690 px de 767: con «flex-1
 * min-h-0» y «overflow-hidden» el panel quedaba en 20 px y su área de scroll en 0,
 * es decir, las 214 tarjetas existían pero no se veía ningún producto.
 *
 * Las dos variantes tienen que ser excluyentes (`max-md:` / `md:`) porque Tailwind
 * ordena `flex-shrink` después del atajo `flex`, y una pareja base+md compite mal.
 */

const source = readFileSync(join(process.cwd(), "src/pages/Inventory.tsx"), "utf8");
const lines = source.split("\n");

function classLine(marker: string, label: string): string {
  const line = lines.find(entry => entry.includes(marker));
  assert.ok(line, `Falta ${label} en Inventory.tsx`);
  return line;
}

const panel = classLine('className="inventory-bulk-panel', "el panel de Edición Masiva");
const scrollArea = classLine('className="inventory-bulk-scroll', "el área de scroll de Edición Masiva");

test("Edición Masiva: en móvil el panel crece con su contenido en vez de recortarse", () => {
  assert.match(panel, /max-md:flex-none/, "sin max-md:flex-none el panel vuelve a colapsar a 0 px en el teléfono");
  assert.doesNotMatch(panel, /(?<![\w:.-])flex-1(?!\S*-\[)/, "el panel no debe llevar un flex-1 sin variante: se lo come la altura de la página");
  assert.doesNotMatch(panel, /(?<![\w:.-])min-h-0/, "el panel no debe llevar un min-h-0 sin variante");
});

test("Edición Masiva: en escritorio conserva el scroll interno del panel", () => {
  assert.match(panel, /(?<!max-)md:flex-1/, "sin md:flex-1 el panel deja de llenar la ventana en PC");
  assert.match(scrollArea, /(?<![\w:.-])flex-1/, "el área de scroll debe seguir creciendo dentro del panel");
  assert.match(scrollArea, /(?<![\w:.-])min-h-0/, "sin min-h-0 el área de scroll no puede recortarse y rompe el scroll interno");
});

test("Edición Masiva: móvil usa tarjetas y escritorio usa tabla", () => {
  const cards = classLine('aria-label="Productos en edición masiva"', "la tabla de Edición Masiva");
  assert.match(cards, /hidden md:table/, "la tabla de escritorio debe quedar oculta en el teléfono");
  const grid = lines.find(entry => /grid grid-cols-1 gap-3 p-3 md:hidden/.test(entry));
  assert.ok(grid, "sin la rama md:hidden no hay tarjetas editables en el teléfono");
  assert.equal(lines.filter(entry => entry.includes("bulkVisibleProducts.map")).length, 2, "tarjetas y tabla deben recorrer la misma lista");
});
