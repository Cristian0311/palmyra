import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const dist = join(process.cwd(), "dist");
const swPath = join(dist, "sw.js");
assert.ok(existsSync(swPath), "Production service worker is missing; run npm run build first.");
const sw = readFileSync(swPath, "utf8");
const checks = [
  ["navigation fallback cached", /createHandlerBoundToURL\(["']index\.html["']\)/.test(sw)],
  ["offline navigation route", /NavigationRoute/.test(sw)],
  ["Supabase endpoints never cached as API responses", /NetworkOnly/.test(sw) && /supabase-network-only/.test(sw)],
  ["POS startup screen precached", /POSStartupScreen-[A-Za-z0-9_-]+\.js/.test(sw)],
  ["cash management modal precached", /POSCashManagementModal-[A-Za-z0-9_-]+\.js/.test(sw)],
  ["Reports route precached", /Reports-[A-Za-z0-9_-]+\.js/.test(sw)],
  ["Reports discrepancy modal precached", /ReportsDiscrepancyDetailModal-[A-Za-z0-9_-]+\.js/.test(sw)],
  ["Report close-session modal precached", /ReportsCloseSessionModal-[A-Za-z0-9_-]+\.js/.test(sw)],
];
const failures = checks.filter(([, ok]) => !ok);
const precacheEntries = (sw.match(/\{url:/g) || []).length;
console.log(`PALMYRA PWA offline build smoke: ${checks.length - failures.length}/${checks.length} checks passed; ${precacheEntries} precache entries.`);
for (const [label, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
assert.equal(failures.length, 0, `Missing offline build requirements: ${failures.map(([label]) => label).join(", ")}`);
assert.ok(precacheEntries >= 60, `Expected a broad application precache; found ${precacheEntries}.`);
