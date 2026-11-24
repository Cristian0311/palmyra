import assert from "node:assert/strict";
import test from "node:test";
import { fetchJsonWithRetry, HttpPayloadError } from "../../src/lib/http";

function stubFetch(handler: () => Response) {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => handler()) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

test("Una página HTML nunca se entrega como JSON válido", async () => {
  const restore = stubFetch(() => new Response("<html><body>Render despertando</body></html>", {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" }
  }));
  try {
    await assert.rejects(
      () => fetchJsonWithRetry("/api/exchange-rates"),
      (error: unknown) => error instanceof HttpPayloadError && /página web/.test(error.message)
    );
  } finally {
    restore();
  }
});

test("Un JSON mal formado también se reporta con contexto", async () => {
  const restore = stubFetch(() => new Response('{"ok": true', {
    status: 200,
    headers: { "content-type": "application/json" }
  }));
  try {
    await assert.rejects(
      () => fetchJsonWithRetry("/api/context"),
      (error: unknown) => error instanceof HttpPayloadError && /no válida/.test(error.message)
    );
  } finally {
    restore();
  }
});

test("El JSON válido y el cuerpo vacío conservan el contrato actual", async () => {
  let restore = stubFetch(() => new Response('{"ok":true}', {
    status: 200,
    headers: { "content-type": "application/json" }
  }));
  try {
    const { body } = await fetchJsonWithRetry<{ ok: boolean }>("/api/ok");
    assert.deepEqual(body, { ok: true });
  } finally {
    restore();
  }

  restore = stubFetch(() => new Response(null, { status: 204 }));
  try {
    const { body } = await fetchJsonWithRetry("/api/empty");
    assert.equal(body, null);
  } finally {
    restore();
  }
});
