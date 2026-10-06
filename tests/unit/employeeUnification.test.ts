import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const settings = readFileSync("src/pages/Settings.tsx", "utf8");
const layout = readFileSync("src/components/Layout.tsx", "utf8");

test("employee management is surfaced only through Team", () => {
  assert.doesNotMatch(settings, /id:\s*['"]employees['"]\s*,\s*label:\s*['"]Empleados['"]/);
  assert.match(settings, /navigate\(["']\/team["']\)/);
  assert.match(layout, /name:\s*["']Equipo["'],\s*href:\s*["']\/team["']/);
});
