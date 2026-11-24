/**
 * Pruebas de las señales de actualización del servidor.
 *
 * - `isNewerBuild` decide si una señal de `public.system_update_signals` habla
 *   de un build más nuevo que el que corre en este dispositivo (dedupe por
 *   build, comparación semver).
 * - `buildUpdateSignalRequest` fija la forma exacta del POST del servidor a la
 *   RPC `signal_system_update` (URL, cabeceras y cuerpo), sin red.
 *
 * server.ts se importa con PALMYRA_SKIP_SERVER_BOOT=1: no se abre el puerto.
 */
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  compareVersions,
  isNewerBuild,
  normalizeSignalRow,
  parseVersion
} from "../../src/services/updateSignals.ts";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

process.env.PALMYRA_SKIP_SERVER_BOOT = "1";
const serverModule = await import(pathToFileURL(path.join(ROOT, "server.ts")).href);
const buildUpdateSignalRequest = serverModule.buildUpdateSignalRequest as (input: {
  supabaseUrl?: string | null;
  anonKey?: string | null;
  version?: string | null;
  buildId?: string | null;
}) => { url: string; headers: Record<string, string>; body: Record<string, string> } | null;

test("parseVersion acepta semver simple, con prefijo v y pre-release", () => {
  assert.deepEqual(parseVersion("1.3.5"), { core: [1, 3, 5], pre: null });
  assert.deepEqual(parseVersion(" v1.3"), { core: [1, 3, 0], pre: null });
  assert.deepEqual(parseVersion("1.3.5-beta.2"), { core: [1, 3, 5], pre: ["beta", "2"] });
  assert.equal(parseVersion(""), null);
  assert.equal(parseVersion("n/a"), null);
});

test("compareVersions ordena por núcleo y trata el pre-release como anterior", () => {
  assert.equal(compareVersions("1.3.5", "1.3.4"), 1);
  assert.equal(compareVersions("1.3.4", "1.3.5"), -1);
  assert.equal(compareVersions("1.4.0", "1.3.9"), 1);
  assert.equal(compareVersions("1.3.5", "1.3.5"), 0);
  assert.equal(compareVersions("1.3.5-beta.1", "1.3.5"), -1);
  assert.equal(compareVersions("1.3.5-beta.2", "1.3.5-beta.1"), 1);
  assert.equal(compareVersions("1.3.5-beta.10", "1.3.5-beta.9"), 1);
  // Un valor ilegible nunca gana a uno legible.
  assert.equal(compareVersions("desconocida", "1.3.5"), -1);
  assert.equal(compareVersions("1.3.5", "desconocida"), 1);
});

test("isNewerBuild avisa de versión mayor y calla con versión menor o igual build", () => {
  assert.equal(isNewerBuild({ version: "1.3.6", build_id: "abc" }, "abc", "1.3.5"), true);
  assert.equal(isNewerBuild({ version: "1.3.4", build_id: "def" }, "abc", "1.3.5"), false);
  // Misma versión, build distinto: redespliegue de Render.
  assert.equal(isNewerBuild({ version: "1.3.5", build_id: "def" }, "abc", "1.3.5"), true);
  // Mismo build que el que corre: se ignora (sin burbuja fantasma).
  assert.equal(isNewerBuild({ version: "1.3.5", build_id: "abc" }, "abc", "1.3.5"), false);
  assert.equal(isNewerBuild({ version: "1.3.5", build_id: "  abc  " }, "abc", "1.3.5"), false);
});

test("isNewerBuild tolera señales incompletas o sin build local conocido", () => {
  assert.equal(isNewerBuild(null, "abc", "1.3.5"), false);
  assert.equal(isNewerBuild({ version: "1.3.6", build_id: "" }, "abc", "1.3.5"), false);
  // Sin marca local no se puede afirmar que el build sea distinto.
  assert.equal(isNewerBuild({ version: "1.3.5", build_id: "def" }, null, "1.3.5"), false);
  assert.equal(isNewerBuild({ version: "1.3.5", build_id: "def" }, "  ", "1.3.5"), false);
});

test("normalizeSignalRow recorta y valida la fila de Realtime", () => {
  assert.deepEqual(
    normalizeSignalRow({ id: " s1 ", version: " 1.3.6 ", build_id: " abc ", created_at: " 2026-11-24T00:00:00Z " }),
    { id: "s1", version: "1.3.6", build_id: "abc", created_at: "2026-11-24T00:00:00Z" }
  );
  assert.deepEqual(normalizeSignalRow({ version: "1.3.6", build_id: "abc" }), {
    version: "1.3.6",
    build_id: "abc"
  });
  assert.equal(normalizeSignalRow({ version: " ", build_id: "abc" }), null);
  assert.equal(normalizeSignalRow({ version: "1.3.6", build_id: "   " }), null);
  assert.equal(normalizeSignalRow(null), null);
  assert.equal(normalizeSignalRow([]), null);
});

test("buildUpdateSignalRequest construye el POST exacto a la RPC", () => {
  const request = buildUpdateSignalRequest({
    supabaseUrl: "https://demo.supabase.co/",
    anonKey: "anon-key",
    version: "1.3.6",
    buildId: "commit-abc"
  });
  assert.ok(request);
  assert.equal(request.url, "https://demo.supabase.co/rest/v1/rpc/signal_system_update");
  assert.equal(request.headers["content-type"], "application/json");
  assert.equal(request.headers.apikey, "anon-key");
  assert.equal(request.headers.authorization, "Bearer anon-key");
  assert.equal(request.headers.prefer, "return=minimal");
  assert.deepEqual(request.body, { p_version: "1.3.6", p_build_id: "commit-abc" });
  // El cuerpo es el contrato de signal_system_update(p_version, p_build_id).
  assert.deepEqual(Object.keys(request.body).sort(), ["p_build_id", "p_version"]);
});

test("buildUpdateSignalRequest devuelve null si falta URL, clave, versión o build", () => {
  const base = {
    supabaseUrl: "https://demo.supabase.co",
    anonKey: "anon-key",
    version: "1.3.6",
    buildId: "commit-abc"
  };
  assert.equal(buildUpdateSignalRequest({ ...base, supabaseUrl: "" }), null);
  assert.equal(buildUpdateSignalRequest({ ...base, anonKey: "   " }), null);
  assert.equal(buildUpdateSignalRequest({ ...base, version: "" }), null);
  assert.equal(buildUpdateSignalRequest({ ...base, buildId: " " }), null);
  assert.equal(buildUpdateSignalRequest({}), null);
});
