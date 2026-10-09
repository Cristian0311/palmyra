import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const settings = readFileSync("src/pages/Settings.tsx", "utf8");
const layout = readFileSync("src/components/Layout.tsx", "utf8");
const payrollMutations = readFileSync("src/services/supabaseSync/mutations.ts", "utf8");
const cashActions = readFileSync("src/store/actions/cashActions.ts", "utf8");
const queueProcessor = readFileSync("src/services/offline/processQueueItem.ts", "utf8");
const offlineSync = readFileSync("src/services/offlineSync.ts", "utf8");

test("employee management is surfaced only through Team", () => {
  assert.doesNotMatch(settings, /id:\s*['"]employees['"]\s*,\s*label:\s*['"]Empleados['"]/);
  assert.match(settings, /navigate\(["']\/team["']\)/);
  assert.match(layout, /name:\s*["']Equipo["'],\s*href:\s*["']\/team["']/);
});


test("administrator-only cash sessions do not require an employee payroll record", () => {
  assert.match(payrollMutations, /export async function hasPayrollEmployeeForSettlement/);
  assert.match(payrollMutations, /employeeEligibilityChecked/);
  assert.equal(
    [...cashActions.matchAll(/const shouldPersistSalary = await hasPayrollEmployeeForSettlement\(settlement\)/g)].length,
    2,
    "both ordinary and report-based cash closure must apply the employee gate"
  );
  assert.match(queueProcessor, /case 'salary_settlement':[\s\S]*hasPayrollEmployeeForSettlement/);
  assert.match(queueProcessor, /company admin[\s\S]*salarySettlements/);
  assert.match(offlineSync, /employee_not_found[\s\S]*cash-close:/);
});
