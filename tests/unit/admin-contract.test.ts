import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function files(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

test("Admin nunca contiene service_role ni una secret key", () => {
  const adminRoot = join(process.cwd(), "admin");
  const sourceFiles = files(adminRoot).filter((path) => /\.(ts|tsx|js|jsx|html)$/i.test(path));
  const forbidden = /service_role|sb_secret_/i;
  for (const path of sourceFiles) {
    const content = readFileSync(path, "utf8");
    assert.equal(forbidden.test(content), false, `No se permite secreto de Supabase en Admin: ${path}`);
  }
});

test("Admin tiene contrato de build independiente", () => {
  const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
  assert.equal(typeof packageJson.scripts?.["build:admin"], "string");
  assert.equal(packageJson.scripts["build:admin"], "vite build --config admin/vite.config.ts");

  const viteConfig = readFileSync(join(process.cwd(), "admin/vite.config.ts"), "utf8");
  assert.match(viteConfig, /dist-admin/);
});
