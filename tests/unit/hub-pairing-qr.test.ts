import test from "node:test";
import assert from "node:assert/strict";
import { joinHub } from "../../src/services/lanHub/pairing";
import {
  PairingPayloadError,
  decodePairingPayload,
  encodePairingPayload,
  hubStatusToPairingPayload,
  isWildcardHost,
  normalizeFingerprint,
  normalizeHubBaseUrl,
  parseManualHubAddress,
  parseManualPairingInput
} from "../../src/services/lanHub/pairingQr";

const CODE = "48219307";
const BASE_URL = "http://192.168.1.10:48900";
const FP = "a1b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4d5e6f708192a3b4c5d6e7f809";
const FP_UPPER = FP.toUpperCase().replace(/(.{2})(?=.)/g, "$1:");
const COMPANY = "co-1";

function expectPairingError(fn: () => unknown, code: string, message?: RegExp): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof PairingPayloadError);
    assert.equal(error.code, code);
    if (message) assert.match(error.message, message);
    return true;
  });
}

test("encode y decode hacen ida y vuelta sin huella ni empresa", () => {
  const payload = encodePairingPayload({ baseUrl: BASE_URL, code: CODE });
  assert.ok(payload.startsWith("palmyra://hub?v=1&url="));
  assert.ok(payload.includes(`code=${CODE}`));
  assert.equal(payload.includes("fp="), false);
  assert.equal(payload.includes("company="), false);

  const decoded = decodePairingPayload(payload);
  assert.equal(decoded.baseUrl, BASE_URL);
  assert.equal(decoded.code, CODE);
  assert.equal(decoded.fingerprint, "");
  assert.equal(decoded.companyId, "");
});

test("encode normaliza la dirección y la huella, y añade empresa", () => {
  const payload = encodePairingPayload({
    baseUrl: "https://192.168.1.10:48900/",
    code: ` ${CODE} `,
    fingerprint: FP_UPPER,
    companyId: COMPANY
  });
  assert.ok(payload.includes(`fp=${FP}`));
  assert.ok(payload.includes(`company=${COMPANY}`));

  const decoded = decodePairingPayload(payload);
  assert.equal(decoded.baseUrl, "https://192.168.1.10:48900");
  assert.equal(decoded.fingerprint, FP);
  assert.equal(decoded.companyId, COMPANY);
});

test("encode rechaza códigos de 7 y 9 dígitos y huellas inválidas", () => {
  expectPairingError(() => encodePairingPayload({ baseUrl: BASE_URL, code: "4821930" }), "invalid_code");
  expectPairingError(() => encodePairingPayload({ baseUrl: BASE_URL, code: "482193077" }), "invalid_code");
  expectPairingError(() => encodePairingPayload({ baseUrl: BASE_URL, code: "4821930a" }), "invalid_code");
  expectPairingError(
    () => encodePairingPayload({ baseUrl: BASE_URL, code: CODE, fingerprint: "abc123" }),
    "invalid_fingerprint"
  );
  expectPairingError(
    () => encodePairingPayload({ baseUrl: BASE_URL, code: CODE, fingerprint: `${FP}00` }),
    "invalid_fingerprint"
  );
  expectPairingError(
    () => encodePairingPayload({ baseUrl: BASE_URL, code: CODE, companyId: "empresa con espacios" }),
    "invalid_payload"
  );
});

test("decode rechaza esquemas ajenos, credenciales, query extraña y huella rota", () => {
  expectPairingError(() => decodePairingPayload(""), "invalid_payload");
  expectPairingError(() => decodePairingPayload("hola mundo"), "invalid_payload");
  expectPairingError(() => decodePairingPayload(`ftp://192.168.1.10/pair?code=${CODE}`), "invalid_payload");
  expectPairingError(
    () => decodePairingPayload(`palmyra://hub?v=1&url=${encodeURIComponent("ftp://192.168.1.10")}&code=${CODE}`),
    "invalid_url"
  );
  expectPairingError(
    () =>
      decodePairingPayload(
        `palmyra://hub?v=1&url=${encodeURIComponent("http://user:pass@192.168.1.10:48900")}&code=${CODE}`
      ),
    "invalid_url"
  );
  expectPairingError(
    () => decodePairingPayload(`palmyra://hub?v=1&url=${encodeURIComponent(BASE_URL)}&code=${CODE}&extra=1`),
    "invalid_payload"
  );
  expectPairingError(
    () => decodePairingPayload(`palmyra://hub?v=2&url=${encodeURIComponent(BASE_URL)}&code=${CODE}`),
    "invalid_payload"
  );
  expectPairingError(() => decodePairingPayload(`palmyra://hub?v=1&url=${encodeURIComponent(BASE_URL)}`), "invalid_code");
  expectPairingError(
    () =>
      decodePairingPayload(
        `palmyra://hub?v=1&url=${encodeURIComponent(BASE_URL)}&code=${CODE}&fp=zz${FP.slice(2)}`
      ),
    "invalid_fingerprint"
  );
});

test("decode acepta una URL http(s) con los mismos parámetros", () => {
  const decoded = decodePairingPayload(
    `http://192.168.1.10:48900/?url=${encodeURIComponent(BASE_URL)}&code=${CODE}&fp=${FP}`
  );
  assert.equal(decoded.baseUrl, BASE_URL);
  assert.equal(decoded.code, CODE);
  assert.equal(decoded.fingerprint, FP);
});

test("el payload del QR sobrevive al URL-encoding", () => {
  const payload = encodePairingPayload({ baseUrl: "https://pc-caja.local:48900", code: CODE, companyId: COMPANY });
  // El separador de la dirección queda escapado dentro del propio payload.
  assert.ok(payload.includes(encodeURIComponent("https://pc-caja.local:48900")));
  assert.equal(decodePairingPayload(decodeURIComponent(payload)).baseUrl, "https://pc-caja.local:48900");
  assert.equal(decodePairingPayload(payload.trim()).companyId, COMPANY);
});

test("parseManualHubAddress acepta las formas habituales", () => {
  assert.equal(parseManualHubAddress("192.168.1.10"), "http://192.168.1.10");
  assert.equal(parseManualHubAddress(" 192.168.1.10:48900 "), "http://192.168.1.10:48900");
  assert.equal(parseManualHubAddress("http://192.168.1.10:48900"), "http://192.168.1.10:48900");
  assert.equal(parseManualHubAddress("http://192.168.1.10:48900/"), "http://192.168.1.10:48900");
  assert.equal(parseManualHubAddress("https://hub.negocio.local/"), "https://hub.negocio.local");
  assert.equal(parseManualHubAddress("https://hub.negocio.local:443"), "https://hub.negocio.local");
  assert.equal(normalizeHubBaseUrl("192.168.1.10:48900"), "http://192.168.1.10:48900");
});

test("parseManualHubAddress rechaza credenciales, query, fragmento, esquema y puerto", () => {
  expectPairingError(() => parseManualHubAddress(""), "invalid_url");
  expectPairingError(() => parseManualHubAddress("   "), "invalid_url");
  expectPairingError(() => parseManualHubAddress("ftp://192.168.1.10"), "invalid_url");
  expectPairingError(() => parseManualHubAddress("file://c:/hub"), "invalid_url");
  expectPairingError(() => parseManualHubAddress("http://usuario:clave@192.168.1.10:48900"), "invalid_url");
  expectPairingError(() => parseManualHubAddress("192.168.1.10:48900?code=48219307"), "invalid_url");
  expectPairingError(() => parseManualHubAddress("192.168.1.10:48900#red"), "invalid_url");
  expectPairingError(() => parseManualHubAddress("192.168.1.10:70000"), "invalid_url");
  expectPairingError(() => parseManualHubAddress("192.168.1.10:0"), "invalid_url");
  expectPairingError(() => parseManualHubAddress("http://"), "invalid_url");
});

test("parseManualPairingInput separa el código del mismo campo", () => {
  assert.deepEqual(parseManualPairingInput("192.168.1.10:48900 48219307"), {
    baseUrl: "http://192.168.1.10:48900",
    code: CODE
  });
  assert.deepEqual(parseManualPairingInput("192.168.1.10 48219307"), {
    baseUrl: "http://192.168.1.10",
    code: CODE
  });
  assert.deepEqual(parseManualPairingInput("http://192.168.1.10:48900/ código: 48219307"), {
    baseUrl: "http://192.168.1.10:48900",
    code: CODE
  });
  assert.deepEqual(parseManualPairingInput("https://hub.negocio.local 48219307"), {
    baseUrl: "https://hub.negocio.local",
    code: CODE
  });
  // Sin código, el segundo valor queda vacío.
  assert.deepEqual(parseManualPairingInput("192.168.1.10:48900"), {
    baseUrl: "http://192.168.1.10:48900",
    code: ""
  });
  // Solo el código: no hay dirección que usar todavía.
  assert.deepEqual(parseManualPairingInput("48219307"), { baseUrl: "", code: CODE });
  expectPairingError(() => parseManualPairingInput("192.168.1.10:48900 123456789"), "invalid_url");
});

test("isWildcardHost distingue direcciones utilizables", () => {
  for (const host of ["", "0.0.0.0", "::", "[::]", "localhost", "127.0.0.1", "::1"]) {
    assert.equal(isWildcardHost(host), true, host);
  }
  for (const host of ["192.168.1.10", "hub.local", "10.0.0.5"]) {
    assert.equal(isWildcardHost(host), false, host);
  }
});

test("normalizeFingerprint normaliza mayúsculas y separadores", () => {
  assert.equal(normalizeFingerprint(FP_UPPER), FP);
  assert.equal(normalizeFingerprint(FP), FP);
  assert.equal(normalizeFingerprint(""), "");
  assert.equal(normalizeFingerprint("abc"), "");
  assert.equal(normalizeFingerprint(undefined), "");
});

test("hubStatusToPairingPayload construye el QR con un host real", () => {
  const built = hubStatusToPairingPayload({
    host: "192.168.1.10",
    port: 48900,
    pairingCode: CODE,
    companyId: COMPANY,
    tlsFingerprint: undefined
  });
  assert.equal(built.requiresHost, false);
  assert.equal(built.baseUrl, BASE_URL);
  const decoded = decodePairingPayload(built.payload);
  assert.equal(decoded.baseUrl, BASE_URL);
  assert.equal(decoded.code, CODE);
  assert.equal(decoded.companyId, COMPANY);
  assert.equal(decoded.fingerprint, "");
});

test("hubStatusToPairingPayload con huella usa https y la incluye", () => {
  const built = hubStatusToPairingPayload({
    host: "192.168.1.10",
    port: 48900,
    pairingCode: CODE,
    companyId: COMPANY,
    tlsFingerprint: FP_UPPER
  });
  assert.equal(built.baseUrl, "https://192.168.1.10:48900");
  const decoded = decodePairingPayload(built.payload);
  assert.equal(decoded.fingerprint, FP);
  assert.equal(decoded.baseUrl, "https://192.168.1.10:48900");
});

test("hubStatusToPairingPayload pide la IP cuando el host es wildcard", () => {
  for (const host of ["0.0.0.0", "::", "localhost"]) {
    const built = hubStatusToPairingPayload({
      host,
      port: 48900,
      pairingCode: CODE,
      companyId: COMPANY
    });
    assert.equal(built.requiresHost, true, host);
    assert.equal(built.baseUrl, "", host);
    assert.equal(built.payload, "", host);
  }
  // Sin código vigente tampoco hay QR que mostrar.
  const noCode = hubStatusToPairingPayload({
    host: "192.168.1.10",
    port: 48900,
    pairingCode: "",
    companyId: COMPANY
  });
  assert.equal(noCode.payload, "");
  assert.equal(noCode.requiresHost, true);
});

function acceptedFetch(bodies: Record<string, unknown>[]): typeof fetch {
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(
      JSON.stringify({ deviceToken: "t", hubId: "hub-1", deviceId: "dev-1", companyId: COMPANY }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;
}

test("joinHub envía el PIN solo si tiene entre 4 y 8 dígitos", async () => {
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl = acceptedFetch(bodies);
  await joinHub({ baseUrl: BASE_URL, code: CODE, companyId: COMPANY, deviceName: "Caja", pin: "1234", fetchImpl });
  await joinHub({ baseUrl: BASE_URL, code: CODE, companyId: COMPANY, deviceName: "Caja", pin: "123456789", fetchImpl });

  assert.equal(bodies[0].pin, "1234");
  assert.equal("pin" in bodies[1], false);
});

test("joinHub fija la huella TLS con https y tolera un puente sin el método", async () => {
  const pinned: Array<{ url: string; fp: string }> = [];
  const bridge = {
    status: async () => ({ ok: false, error: "" }),
    pinCertificate: async (url: string, fp: string) => {
      pinned.push({ url, fp });
    }
  };
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl = acceptedFetch(bodies);
  (globalThis as { window?: unknown }).window = { palmyraDesktopHub: bridge };
  try {
    await joinHub({
      baseUrl: "https://192.168.1.10:48900",
      code: CODE,
      companyId: COMPANY,
      deviceName: "Caja",
      tlsFingerprint: FP.toUpperCase(),
      fetchImpl
    });
    assert.deepEqual(pinned, [{ url: "https://192.168.1.10:48900", fp: FP }]);

    // Sin TLS no se fija nada.
    await joinHub({
      baseUrl: BASE_URL,
      code: CODE,
      companyId: COMPANY,
      deviceName: "Caja",
      tlsFingerprint: FP,
      fetchImpl
    });
    assert.equal(pinned.length, 1);

    // Un puente que no expone pinCertificate no rompe el emparejamiento.
    (globalThis as { window?: unknown }).window = { palmyraDesktopHub: { status: bridge.status } };
    await joinHub({
      baseUrl: "https://192.168.1.10:48900",
      code: CODE,
      companyId: COMPANY,
      deviceName: "Caja",
      tlsFingerprint: FP,
      fetchImpl
    });
    assert.equal(bodies.length, 3);
  } finally {
    delete (globalThis as { window?: unknown }).window;
  }
});
