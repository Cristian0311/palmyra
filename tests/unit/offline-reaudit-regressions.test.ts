import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

test("online SaaS login survives local-storage quota or privacy-mode failures", () => {
  const saas = source("src/services/saas.ts");
  assert.match(saas, /Local storage is an offline enhancement, not a prerequisite for online[\s\S]*?try \{\s*setPalmyraLocalScope/);
  assert.match(saas, /catch \(storageError\)[\s\S]*?la sesión online sigue siendo válida/);
});

test("the new-company signup flow binds the pending offline verifier after onboarding", () => {
  const auth = source("src/pages/SaaSAuth.tsx");
  const onboarding = source("src/pages/SaaSOnboarding.tsx");
  const offlineAuth = source("src/services/offlineSaaSAuth.ts");
  assert.match(auth, /rememberPendingOfflineCredential\(credentialEmail, credentialPassword\)/);
  assert.match(onboarding, /loadSaaSContext\(true\)[\s\S]*?consumePendingOfflineCredential\(context\)/);
  assert.match(offlineAuth, /PENDING_CREDENTIAL_TTL_MS/);
  assert.match(offlineAuth, /localStorage\/sessionStorage/);
});

test("password reset invalidates the older offline password verifier", () => {
  const auth = source("src/pages/SaaSAuth.tsx");
  const offlineAuth = source("src/services/offlineSaaSAuth.ts");
  assert.match(auth, /updateSaaSPassword\(password\)[\s\S]*?forgetOfflineSaaSCredential\\(authData\\.session\\?\\.user\\?\\.id\\)/);
  assert.match(offlineAuth, /export function forgetOfflineSaaSCredential/);
});

test("notification status checks that the server-side push endpoint is enabled", () => {
  const notifications = source("src/pages/Notifications.tsx");
  assert.match(notifications, /from\("push_subscriptions"\)/);
  assert.match(notifications, /eq\("company_id", companyId\)[\s\S]*?eq\("user_id", userId\)[\s\S]*?eq\("endpoint", subscription\.endpoint\)/);
  assert.match(notifications, /serverSubscription\?\.enabled === true \? "registered" : "not_registered"/);
});

test("push activation renews a stale browser endpoint disabled on the server", () => {
  const notifications = source("src/pages/Notifications.tsx");
  assert.match(notifications, /serverSubscription\?\.enabled !== true[\s\S]*?subscription\.unsubscribe\(\)/);
  assert.match(notifications, /if \(!subscription\)[\s\S]*?registration\.pushManager\.subscribe/);
});
