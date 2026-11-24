import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// bankActions no puede importarse headless (su cadena lee `import.meta.env`
// en módulos de SaaS), así que la regresión se fija sobre el código fuente,
// igual que offline-reaudit-regressions.test.ts.
const source = () => readFileSync(join(process.cwd(), "src/store/actions/bankActions.ts"), "utf8");

test("addBankCard dedup tolera cuentas sin name ni bankName (la nube puede traerlos null)", () => {
  // Antes: `c.name.toLowerCase()` lanzaba TypeError al añadir una cuenta cuando
  // cualquier tarjeta existente no tenía `name`.
  assert.doesNotMatch(source(), /c\.name\.toLowerCase\(\)/);
  assert.match(source(), /const nameOf = \(value\?: string\) => \(value \?\? ''\)\.trim\(\)\.toLowerCase\(\);/);
});

test("la deduplicación por nombre exige un nombre no vacío y usa bank como respaldo de bankName", () => {
  assert.match(source(), /const bankOf = \(value: import\('\.\.\/\.\.\/types'\)\.BankCard\) => nameOf\(value\.bankName \?\? value\.bank\);/);
  // Sin esta guarda, dos cuentas sin nombre se considerarían duplicadas entre sí.
  assert.match(source(), /cName !== '' && cName === nameOf\(card\.name\) && bankOf\(c\) === bankOf\(card\)/);
});
