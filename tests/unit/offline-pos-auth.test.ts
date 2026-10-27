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

test("team-wide offline POS login allows POS operators to preload active employee verifiers without alias corruption", () => {
  const migration = source("supabase/migrations/20261027100000_allow_pos_team_offline_auth.sql");
  const auth = source("src/services/offlinePosAuth.ts");
  assert.match(migration, /private\.has_permission\(p_company_id, 'pos\.access'\)/);
  assert.match(migration, /private\.has_permission\(p_company_id, 'employees\.manage'\)/);
  assert.match(migration, /e\.active = true/);
  assert.match(migration, /'subject_id', v\.subject_id/);
  assert.doesNotMatch(migration, /cross join lateral/i);
  assert.match(auth, /PBKDF2_ITERATIONS = 310_000/);
  assert.match(auth, /recordOfflineCredentialFailure/);
  assert.match(auth, /isOfflineCredentialBlocked/);
});

test("offline POS sync removes credentials only when the server explicitly revokes them", () => {
  const auth = source("src/services/offlinePosAuth.ts");
  const migration = source("supabase/migrations/20261027110000_propagate_offline_pos_credential_revocations.sql");
  assert.match(auth, /row\?\.revoked === true/);
  assert.match(auth, /Never delete device-local verifiers just because a server snapshot omitted/);
  assert.match(migration, /employee_pos_offline_credential_revocations/);
  assert.match(migration, /true as revoked/);
  assert.match(migration, /false as revoked/);
});

test("transient offline queue failures back off exponentially while retaining durable operations", () => {
  const sync = source("src/services/offlineSync.ts");
  const types = source("src/services/offlineQueueTypes.ts");
  assert.match(types, /nextRetryAt\?: number/);
  assert.match(sync, /Math\.min\(15 \* 60_000, 30_000 \* \(2 \*\* Math\.min\(5, item\.retryCount - 1\)\)\)/);
  assert.match(sync, /item\.status === 'failed' && Number\(item\.nextRetryAt \|\| 0\) > Date\.now\(\)/);
});

test("offline employee credentials never expire merely because time passed", () => {
  const auth = source("src/services/offlinePosAuth.ts");
  assert.match(auth, /function isFresh\(savedAt: number\): boolean\s*\{\s*\/\/ Do not expire valid offline credentials based on age\.\s*return Number\.isFinite\(savedAt\) && savedAt > 0;/);
  assert.doesNotMatch(auth, /savedAt\s*\+\s*\d+\s*\*\s*24\s*\*\s*60\s*\*\s*60/);
});

test("PWA updates wait for user confirmation instead of swapping the app shell mid-render", () => {
  const vite = source("vite.config.ts");
  const main = source("src/main.tsx");
  assert.match(vite, /registerType: 'prompt'/);
  assert.match(vite, /skipWaiting: false/);
  assert.match(main, /registration\.waiting \|\| registration\.installing/);
  assert.match(main, /worker\.postMessage\(\{ type: 'SKIP_WAITING' \}\)/);
  assert.match(main, /worker\.state !== 'activated'/);
});
