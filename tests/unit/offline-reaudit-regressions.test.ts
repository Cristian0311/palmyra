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

test("signup navigation stays inside React until the new-company credential is consumed", () => {
  const auth = source("src/pages/SaaSAuth.tsx");
  const onboarding = source("src/pages/SaaSOnboarding.tsx");
  assert.ok(auth.includes('navigate(ctx.membershipStatus && ctx.membershipStatus !== "active" ? "/account-status" : "/onboarding", { replace: true });'));
  assert.ok(onboarding.includes("consumePendingOfflineCredential(context)"));
});

test("the new-company signup flow binds the pending offline verifier after onboarding", () => {
  const auth = source("src/pages/SaaSAuth.tsx");
  const onboarding = source("src/pages/SaaSOnboarding.tsx");
  const offlineAuth = source("src/services/offlineSaaSAuth.ts");
  assert.match(auth, /rememberPendingOfflineCredential\(credentialEmail, credentialPassword\)/);
  assert.match(onboarding, /loadSaaSContext\(true\)[\s\S]*?consumePendingOfflineCredential\(context\)/);
  assert.match(offlineAuth, /PENDING_CREDENTIAL_TTL_MS/);
  // The onboarding credential may survive a tab reload, but it must stay in
  // sessionStorage and never reach localStorage (which outlives the session).
  assert.match(offlineAuth, /never[\s\S]{0,40}written to localStorage/);
  assert.match(offlineAuth, /sessionStorage\.setItem\(PENDING_CREDENTIAL_KEY/);
  assert.doesNotMatch(offlineAuth, /localStorage\.setItem\(PENDING_CREDENTIAL_KEY/);
});

test("password reset invalidates the older offline password verifier", () => {
  const auth = source("src/pages/SaaSAuth.tsx");
  const offlineAuth = source("src/services/offlineSaaSAuth.ts");
  assert.ok(auth.includes("forgetOfflineSaaSCredential(authData.session.user.id)"));
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
  assert.match(notifications, /serverSubscription\?\.enabled !== true[\s\S]*?await subscription\.unsubscribe\(\)/);
  assert.match(notifications, /await subscription\.unsubscribe\(\)[\s\S]*?subscription = null/);
  assert.match(notifications, /if \(!subscription\)[\s\S]*?registration\.pushManager\.subscribe/);
  // Ninguna de las dos ramas puede continuar en silencio: aborta la activación y
  // reporta la causa real (PUSH_FAILURE_TEXT), no un genérico "revisa permisos".
  assert.match(notifications, /catch \(unsubscribeError\)[\s\S]{0,300}?return void failWith\([\s\S]{0,200}?expired subscription/);
  assert.match(notifications, /if \(serverCheckError\)[\s\S]{0,300}?return void failWith\(/);
  assert.match(notifications, /const failWith = \(info: PushFailureInfo\)[\s\S]{0,120}?setError\(pushFailureMessage\(info\)\)/);
});
