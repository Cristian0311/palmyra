import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const dist = join(process.cwd(), "dist");
const swPath = join(dist, "sw.js");
assert.ok(existsSync(swPath), "Production service worker is missing; run npm run build first.");
const sw = readFileSync(swPath, "utf8");
const manifestPath = join(dist, "manifest.webmanifest");
assert.ok(existsSync(manifestPath), "Web app manifest is missing; run npm run build first.");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const icons = Array.isArray(manifest.icons) ? manifest.icons : [];
const pngBytes = (name) => {
  const file = join(dist, name);
  return existsSync(file) ? readFileSync(file).length : 0;
};
const checks = [
  ["navigation fallback cached", /createHandlerBoundToURL\(["']index\.html["']\)/.test(sw)],
  ["offline navigation route", /NavigationRoute/.test(sw)],
  ["Supabase endpoints never cached as API responses", /NetworkOnly/.test(sw) && /supabase-network-only/.test(sw)],
  ["POS startup screen precached", /POSStartupScreen-[A-Za-z0-9_-]+\.js/.test(sw)],
  ["cash management modal precached", /POSCashManagementModal-[A-Za-z0-9_-]+\.js/.test(sw)],
  ["Reports route precached", /Reports-[A-Za-z0-9_-]+\.js/.test(sw)],
  ["Reports discrepancy modal precached", /ReportsDiscrepancyDetailModal-[A-Za-z0-9_-]+\.js/.test(sw)],
  ["Tutorial route precached", /Tutorial-[A-Za-z0-9_-]+\.js/.test(sw)],
  ["real PNG 192 icon", pngBytes("pwa-192.png") > 1000],
  ["real PNG 512 icon", pngBytes("pwa-512.png") > 1000],
  ["maskable icon declared", icons.some(icon => icon.purpose === "maskable" && icon.type === "image/png")],
  ["any-purpose PNG icon declared", icons.some(icon => icon.purpose === "any" && icon.type === "image/png")],
  ["theme color matches brand", manifest.theme_color === "#32145F"],
  ["apple touch icon generated", pngBytes("apple-touch-icon.png") > 1000],
];
const failures = checks.filter(([, ok]) => !ok);
const precacheEntries = (sw.match(/\{url:/g) || []).length;
console.log(`PALMYRA PWA offline build smoke: ${checks.length - failures.length}/${checks.length} checks passed; ${precacheEntries} precache entries.`);
for (const [label, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
assert.equal(failures.length, 0, `Missing offline build requirements: ${failures.map(([label]) => label).join(", ")}`);
assert.ok(precacheEntries >= 60, `Expected a broad application precache; found ${precacheEntries}.`);
