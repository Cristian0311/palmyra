// Runs a read-only SQL query through the Supabase Management API and prints JSON.
// Credentials are read from .secrets/supabase.env and never printed.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const secretsPath = process.env.PALMYRA_SUPABASE_ENV
  || "C:/Users/R3ZERO/Documents/Qoder/2026-11-17/aeac25cf/.secrets/supabase.env";

const env = Object.fromEntries(
  readFileSync(secretsPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const index = line.indexOf("=");
      return [line.slice(0, index).trim(), line.slice(index + 1).trim().replace(/^['"]|['"]$/g, "")];
    }),
);

const file = process.argv[2];
if (!file) {
  console.error("SQL file argument is required.");
  process.exit(1);
}

const sql = readFileSync(resolve(file), "utf8");
if (!/^\s*(select|with)\b/i.test(sql)) {
  console.error("Only read-only SELECT/WITH queries are allowed.");
  process.exit(1);
}

const ref = env.SUPABASE_PROJECT_REF;
const token = env.SUPABASE_ACCESS_TOKEN;
if (!ref || !token) {
  console.error("SUPABASE_PROJECT_REF / SUPABASE_ACCESS_TOKEN missing in secrets file.");
  process.exit(1);
}

const response = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ query: sql }),
});

const body = await response.text();
if (!response.ok) {
  console.error(`HTTP ${response.status}: ${body}`);
  process.exit(1);
}
console.log(body);
