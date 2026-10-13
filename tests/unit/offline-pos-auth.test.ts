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

test("authorized company access preloads only provisioned offline POS verifiers", () => {
  const auth = source("src/services/offlinePosAuth.ts");
  const saas = source("src/services/saas.ts");
  const migration = source("supabase/migrations/20261013190000_offline_pos_credential_verifiers.sql");
  assert.match(auth, /palmyra_get_offline_pos_verifiers/);
  assert.match(auth, /MAX_CREDENTIAL_AGE_MS/);
  assert.match(saas, /permissions\.includes\("employees\.manage"\)/);
  assert.match(saas, /syncOfflinePosCredentials\(companyId\)/);
  assert.match(migration, /private\.employee_pos_offline_verifiers/);
  assert.match(migration, /private\.has_permission\(p_company_id, 'employees\.manage'\)/);
  assert.match(migration, /offline_credential_does_not_match_server/);
  assert.match(migration, /revoke all on table private\.employee_pos_offline_verifiers from public, anon, authenticated/i);
});

test("legacy POS-only PIN hashes can be validated offline without exposing web-account hashes", () => {
  const auth = source("src/services/offlinePosAuth.ts");
  const migration = source("supabase/migrations/20261013200000_sync_legacy_pos_pin_verifiers.sql");
  const pkg = JSON.parse(source("package.json"));
  assert.equal(pkg.dependencies.bcryptjs, "^3.0.3");
  assert.match(auth, /compare as compareBcrypt from "bcryptjs"/);
  assert.match(auth, /stored\.version === 3 && stored\.kind === "bcrypt"/);
  assert.match(auth, /row\.kind === "bcrypt"/);
  assert.match(migration, /join private\.employee_pos_credentials c on c\.employee_id=e\.id/);
  assert.match(migration, /e\.user_id is null/);
  assert.match(migration, /'bcrypt_hash',c\.password_hash/);
  assert.doesNotMatch(migration, /auth\.users|encrypted_password/i);
});

test("new and queued employee POS passwords provision local and server verifiers after sync", () => {
  const team = source("src/services/team.ts");
  const queue = source("src/services/offline/processQueueItem.ts");
  assert.match(team, /rememberOfflinePosCredential\(input\.companyId, employeeId, input\.posPassword\.trim\(\)\)/);
  assert.match(queue, /rememberOfflinePosCredential\(String\(d\.companyId\), String\(d\.localEmployeeId\)/);
  assert.match(queue, /rememberOfflinePosCredential\(String\(d\.companyId\), String\(d\.employeeId\)/);
});
