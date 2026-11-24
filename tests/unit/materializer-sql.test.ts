import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-ignore: script local en ESM puro, sin declaraciones de tipos
import { MATERIALIZER_FILE, validateMaterializer } from "../../scripts/validate-materializer.mjs";
import {
  MATERIALIZABLE_LOCAL_TABLES,
  MATERIALIZE_MAP
} from "../../src/services/cloudSync/materializeMapping";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MIGRATION_PATH = join(ROOT, "supabase/migrations", MATERIALIZER_FILE);

test("el validador aprueba el repositorio real", () => {
  const result = validateMaterializer();
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
  assert.equal(result.branches.size, 23);
  assert.equal(result.stats.mapped, Object.keys(MATERIALIZE_MAP).length);
  assert.equal(result.stats.tables > 0, true);
  assert.equal(result.stats.writes > 0, true);
});

test("el mapa cubre toda tabla materializable y coincide con su rama", () => {
  const result = validateMaterializer();
  assert.deepEqual(
    [...result.mapping.localKeys].sort(),
    [...MATERIALIZABLE_LOCAL_TABLES].sort(),
    "MATERIALIZE_MAP y MATERIALIZABLE_LOCAL_TABLES deben coincidir"
  );
  for (const [local, target] of result.mapping.targets) {
    assert.equal(result.branches.get(local), target, `rama incoherente para ${local}`);
  }
});

test("una columna inventada en una tabla existente falla", () => {
  const fixture = `begin;
create or replace function public.materialize_local_change_inbox(p_limit integer default 200)
returns jsonb language plpgsql as $$
begin
  update public.products set precio_inventado = 1 where id is not null;
  insert into public.products (id, company_id, columna_falsa)
  values (gen_random_uuid(), gen_random_uuid(), 1);
  v_cloud := case v_change.table_name when 'products' then 'products' end;
  return '{}'::jsonb;
end;
$$;
commit;`;
  const result = validateMaterializer({
    materializerSql: fixture,
    migrations: [
      {
        name: "fixture_schema.sql",
        sql: "create table public.products (id uuid primary key, company_id uuid not null);"
      }
    ],
    clientSources: []
  });
  assert.equal(result.ok, false);
  assert.equal(
    result.errors.some((error: string) =>
      error.includes("columna inexistente: public.products.precio_inventado")
    ),
    true,
    `no detectó la columna inventada: ${result.errors.join(" | ")}`
  );
  assert.equal(
    result.errors.some((error: string) =>
      error.includes("columna inexistente: public.products.columna_falsa")
    ),
    true
  );
});

test("una tabla inexistente falla", () => {
  const fixture = `begin;
create or replace function public.materialize_local_change_inbox(p_limit integer default 200)
returns jsonb language plpgsql as $$
begin
  insert into public.tabla_falsa (id) values (gen_random_uuid());
  return '{}'::jsonb;
end;
$$;
commit;`;
  const result = validateMaterializer({
    materializerSql: fixture,
    migrations: [],
    clientSources: []
  });
  assert.equal(result.ok, false);
  assert.equal(
    result.errors.some((error: string) => error.includes("tabla desconocida: public.tabla_falsa")),
    true,
    `no detectó la tabla inexistente: ${result.errors.join(" | ")}`
  );
});

test("la migración es una sola transacción y solo service_role la ejecuta", () => {
  const sql = readFileSync(MIGRATION_PATH, "utf8");
  assert.equal((sql.match(/^begin;$/gm) ?? []).length, 1);
  assert.equal((sql.match(/^commit;$/gm) ?? []).length, 1);
  assert.match(
    sql,
    /grant execute on function public\.materialize_local_change_inbox\(integer\) to service_role;/
  );
  assert.doesNotMatch(
    sql,
    /grant execute on function public\.materialize_local_change_inbox\(integer\) to (anon|authenticated|public)/
  );
  assert.match(
    sql,
    /revoke all on function public\.materialize_local_change_inbox\(integer\) from public, anon, authenticated;/
  );
});
