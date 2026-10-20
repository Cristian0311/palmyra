import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

test("offline POS credentials use PBKDF2 verifier records and never persist plaintext passwords", () => {
  const auth = source("src/services/offlinePosAuth.ts");
  assert.match(auth, /PBKDF2_ITERATIONS\s*=\s*310_000/);
  assert.match(auth, /name:\s*"PBKDF2".*iterations/s);
  assert.match(auth, /version:\s*2/);
  assert.match(auth, /localStorage\.setItem\(key\(cleanCompanyId, cleanUserId\), JSON\.stringify\(credential\)\)/);
  assert.match(auth, /p_password:\s*password/);
  assert.doesNotMatch(auth, /localStorage\.setItem\([^\n]*cleanPassword/);
});

test("authorized POS users preload scoped offline verifiers after online authentication", () => {
  const auth = source("src/services/offlinePosAuth.ts");
  const saas = source("src/services/saas.ts");
  const legacyMigration = source("supabase/migrations/20261013190000_offline_pos_credential_verifiers.sql");
  const syncMigration = source("supabase/migrations/20261020170000_allow_pos_access_offline_credential_sync.sql");
  assert.match(auth, /palmyra_get_offline_pos_verifiers/);
  assert.match(auth, /Do not expire valid offline credentials based on age/);
  assert.match(auth, /activeSyncs/);
  assert.match(saas, /permissions\.includes\("employees\.manage"\)/);
  assert.match(saas, /permissions\.includes\("pos\.access"\)/);
  assert.match(saas, /syncOfflinePosCredentials\(companyId\)/);
  assert.match(legacyMigration, /private\.employee_pos_offline_verifiers/);
  assert.match(legacyMigration, /private\.has_permission\(p_company_id, 'employees\.manage'\)/);
  assert.match(legacyMigration, /offline_credential_does_not_match_server/);
  assert.match(legacyMigration, /revoke all on table private\.employee_pos_offline_verifiers from public, anon, authenticated/i);
  assert.match(syncMigration, /private\.has_permission\(p_company_id, 'pos\.access'\)/);
  assert.match(syncMigration, /private\.has_permission\(p_company_id, 'employees\.manage'\)/);
  assert.match(syncMigration, /auth\.jwt\(\)->>'email'/);
});

test("new and queued employee POS passwords provision local and server verifiers after sync", () => {
  const team = source("src/services/team.ts");
  const queue = source("src/services/offline/processQueueItem.ts");
  assert.match(team, /cacheEmployeePosPassword\(input\.companyId, employeeId, input\.posPassword\.trim\(\)\)/);
  assert.match(queue, /rememberOfflinePosCredential\(String\(d\.companyId\), String\(d\.localEmployeeId\)/);
  assert.match(queue, /rememberOfflinePosCredential\(String\(d\.companyId\), String\(d\.employeeId\)/);
});

test("inventory adjustment allows an exact zero regardless of minimum-stock alert threshold", () => {
  const migration = source("supabase/migrations/20261013230000_fix_zero_inventory_quantity.sql");
  assert.ok(migration.includes("v_next:=greatest(0::numeric,v_current+p_delta);"));
  assert.ok(migration.includes("v_next:=greatest(0::numeric,v_current+p_delta);"));
});

test("offline POS verifiers survive app updates and incomplete remote snapshots", () => {
  const auth = source("src/services/offlinePosAuth.ts");
  assert.ok(auth.includes("function isFresh(savedAt: number): boolean {") && auth.includes("return Number.isFinite(savedAt) && savedAt > 0;"));
  assert.match(auth, /Never delete device-local verifiers just because a server snapshot omitted/);
  assert.doesNotMatch(auth, /localStorage\.removeItem\(localKey\)/);
  assert.match(auth, /localStorage\.setItem\(key\(cleanCompanyId, subjectId\), JSON\.stringify\(record\)\)/);
});
