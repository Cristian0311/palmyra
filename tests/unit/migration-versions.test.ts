import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

test("Supabase migration versions are unique", () => {
  const directory = join(process.cwd(), "supabase/migrations");
  const files = readdirSync(directory).filter(file => file.endsWith(".sql"));
  const byVersion = new Map<string, string[]>();
  for (const file of files) {
    const match = file.match(/^(\d{14})_.+\.sql$/);
    assert.ok(match, "Migration file must start with a 14-digit version: " + file);
    const current = byVersion.get(match[1]) || [];
    current.push(file);
    byVersion.set(match[1], current);
  }
  const duplicates = [...byVersion.entries()].filter(([, names]) => names.length > 1);
  assert.deepEqual(duplicates, [], "Duplicate migration versions can make migration history ambiguous");
});

test("the unique-version migration renames preserve the idempotent SQL operations", () => {
  const dropLegacy = readFileSync(join(process.cwd(), "supabase/migrations/20261003091100_remove_legacy_invitation_overload.sql"), "utf8");
  const grants = readFileSync(join(process.cwd(), "supabase/migrations/20261008113100_harden_offline_sync_root_causes.sql"), "utf8");
  assert.match(dropLegacy, /drop function if exists/i);
  assert.match(grants, /grant execute on function private\.plan_entity_limit_ok/i);
  assert.match(grants, /grant execute on function public\.palmyra_record_salary_settlement/i);
});
