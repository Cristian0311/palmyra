import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

const migration = "supabase/migrations/20261124190000_editable_employee_role.sql";

test("upsert_company_role allows editing the system employee role only", () => {
  const sql = source(migration);

  // La excepción es explícita: cualquier rol de sistema cuya key no sea
  // 'employee' queda bloqueado (admin, owner y futuros roles de sistema).
  assert.match(sql, /v_existing_is_system and v_existing_key <> 'employee'/);
  assert.match(sql, /raise exception 'system_role_locked'/);

  // El UPDATE solo puede tocar roles de la empresa que no son de sistema o
  // el empleado (que conserva is_system=true en el override por empresa).
  assert.match(sql, /and \(is_system=false or key='employee'\)/);

  // company_id e is_system son inmutables: el UPDATE no los asigna.
  const updateBlock = sql.slice(sql.indexOf("update public.roles"), sql.indexOf("insert into public.role_permissions"));
  const setClause = updateBlock.slice(0, updateBlock.indexOf("where"));
  assert.doesNotMatch(setClause, /\bcompany_id\b/);
  assert.doesNotMatch(setClause, /\bis_system\b/);
  assert.match(setClause, /\bset name=v_name/);

  // La key es inmutable para roles existentes.
  assert.match(sql, /v_key <> v_existing_key/);
});

test("upsert_company_role keeps the plan gate, privilege guard and grants", () => {
  const sql = source(migration);
  assert.match(sql, /company_has_plan_feature\(p_company_id,'roles'\)/);
  assert.match(sql, /permission_grant_denied/);
  assert.match(sql, /private\.has_permission\(p_company_id,k\)/);
  assert.match(sql, /revoke all on function public\.upsert_company_role\(uuid,uuid,text,text,text,text\[\]\) from public, anon;/);
  assert.match(sql, /grant execute on function public\.upsert_company_role\(uuid,uuid,text,text,text,text\[\]\) to authenticated;/);
});

test("global employee role is overridden per company without touching the template", () => {
  const sql = source(migration);
  // Solo se clona el employee global y el clon queda ligado a la empresa.
  assert.match(sql, /v_existing_is_system and v_existing_company is null/);
  assert.match(sql, /v_clone_from_global := true/);
  assert.match(sql, /values\(v_target_id,p_company_id,v_key,v_name,nullif\(trim\(p_description\),''\),true\)/);
  assert.match(sql, /where e\.company_id = p_company_id/);
  // La plantilla global no recibe ningún UPDATE de nombre/permisos.
  assert.doesNotMatch(sql, /update public\.roles[\s\S]*?where id=p_role_id/);
});

test("team service sends the role id and maps the new SQL errors to Spanish", () => {
  const team = source("src/services/team.ts");
  assert.match(team, /p_role_id: input\.roleId \?\? null/);
  assert.match(team, /system_role_locked:/);
  assert.match(team, /role_key_immutable:/);
  assert.match(team, /permission_grant_denied:/);
  assert.match(team, /companyRoleKeys/);
});
