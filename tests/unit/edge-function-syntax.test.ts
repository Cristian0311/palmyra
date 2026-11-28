/**
 * Puerta de sintaxis para las edge functions.
 *
 * `tsconfig.json` excluye `supabase/functions/**`, así que `npx tsc --noEmit` jamás
 * mira este código: un error de sintaxis o un `await` fuera de función async solo se
 * veía al desplegar (`supabase functions deploy device-access`), es decir tarde y
 * fuera de los gates. Aquí se transforma cada archivo con esbuild —solo sintaxis, sin
 * resolver los importadores `npm:`/`jsr:` de Deno— para que falle el test y no el deploy.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import esbuild from "esbuild";

const FUNCTIONS_DIR = join("supabase", "functions");

function tsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(full));
    else if (extname(entry.name) === ".ts") out.push(full);
  }
  return out;
}

const files = tsFiles(FUNCTIONS_DIR);
const functions = existsSync(FUNCTIONS_DIR)
  ? readdirSync(FUNCTIONS_DIR, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  : [];

test("cada edge function tiene su index.ts", () => {
  assert.ok(functions.length >= 8, `se esperaban al menos las 8 funciones publicadas, se vieron ${functions.length}`);
  const sinEntrada = functions.filter((name) => !existsSync(join(FUNCTIONS_DIR, name, "index.ts")));
  assert.deepEqual(sinEntrada, [], `carpetas de función sin index.ts: ${sinEntrada.join(", ")}`);
});

test("todas las edge functions se transforman sin errores de sintaxis", () => {
  assert.equal(files.length >= functions.length, true, "cada función aporta al menos un archivo");
  const broken: string[] = [];

  for (const file of files) {
    try {
      esbuild.transformSync(readFileSync(file, "utf8"), { loader: "ts", format: "esm", target: "esnext" });
    } catch (error: any) {
      const detail = (error?.errors || []).map((item: any) => `${item.lineNumber}:${item.column}: ${item.text}`);
      broken.push(`${file}${detail.length ? ` -> ${detail.join(" | ")}` : ` -> ${error?.message}`}`);
    }
  }

  assert.deepEqual(broken, [], `edge functions rotas:\n${broken.join("\n")}`);
});

test("device-access provee en un módulo propio y sin dependencias de Deno", () => {
  const provision = readFileSync(join(FUNCTIONS_DIR, "device-access", "provision.ts"), "utf8");
  assert.ok(!/from "npm:|from "jsr:|Deno\./.test(provision), "provision.ts debe poder probarse en Node");
  assert.match(provision, /company_memberships/);
  const memberships = provision.indexOf('"company_memberships"');
  assert.ok(memberships >= 0 && memberships < provision.indexOf('"profiles"'), "la membresía va antes que el perfil");
  assert.ok(memberships < provision.indexOf('"user_roles"'), "la membresía va antes que los roles");
});
