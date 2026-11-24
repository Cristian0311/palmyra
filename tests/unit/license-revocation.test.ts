import test from "node:test";
import assert from "node:assert/strict";
import { leaseSigningInput, toBase64Url } from "../../src/services/license/contract";
import type { LeasePayloadV1, SignedLease } from "../../src/services/license/contract";
import { createDeviceKey } from "../../src/services/license/deviceKey";
import {
  createMemoryLicenseStore,
  saveDeviceKey,
  saveLease
} from "../../src/services/license/storage";
import { createLicenseRuntime } from "../../src/services/license/runtime";
import type { LicenseFetch } from "../../src/services/license/runtime";
import {
  LICENSE_REVOKED_MESSAGE,
  type LicenseRuntimeClient
} from "../../src/services/license/runtime";
import {
  checkLeaseRevocation,
  resetLeaseRevocationCache
} from "../../src/services/license/revocation";
import {
  assertLicenseWritable,
  isLicenseReadOnly,
  LicenseReadOnlyError,
  setLicenseReadOnly
} from "../../src/services/license/guard";

/**
 * Revocación de leases: modo `revoked` de solo lectura, caché por leaseId y
 * fallo abierto cuando la red no responde.
 */

const NOW = Date.parse("2026-11-23T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const REVOKE_BASE = "https://proyecto.test/functions/v1";
const iso = (ms: number): string => new Date(ms).toISOString();

const serverKeys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
  "sign",
  "verify"
])) as CryptoKeyPair;
const serverPublicJwk = await crypto.subtle.exportKey("jwk", serverKeys.publicKey);
const deviceKey = await createDeviceKey();

let leaseSeq = 0;

async function makeLease(overrides: Partial<LeasePayloadV1> = {}): Promise<SignedLease> {
  leaseSeq += 1;
  const payload: LeasePayloadV1 = {
    v: 1,
    leaseId: `lease-rev-${leaseSeq}`,
    companyId: COMPANY_ID,
    deviceId: "equipo-test",
    devicePubKeyFp: deviceKey.fingerprint,
    planCode: "growth",
    billingMonths: 1,
    limits: { warehouses: 3 },
    featureKeys: ["pos"],
    storageMode: "cloud",
    paidThrough: iso(NOW + 10 * DAY),
    issuedAt: iso(NOW - 2 * 60 * 60 * 1000),
    notBefore: iso(NOW - DAY),
    expiresAt: iso(NOW + 40 * DAY),
    offlineUntil: iso(NOW + 20 * DAY),
    graceDays: 5,
    maxOfflineDays: 35,
    serverTimeAnchor: iso(NOW - 2 * 60 * 60 * 1000),
    seq: leaseSeq,
    keyId: "test-key",
    ...overrides
  };
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    serverKeys.privateKey,
    new TextEncoder().encode(
      leaseSigningInput({ ...payload, signature: "", signatureAlg: "ES256" })
    )
  );
  return { ...payload, signature: toBase64Url(signature), signatureAlg: "ES256" };
}

interface FakeNetwork {
  fetchImpl: LicenseFetch;
  calls: string[];
}

function fakeNetwork(options: {
  revoked?: boolean;
  networkDown?: boolean;
  revokedAt?: string;
  reason?: string;
}): FakeNetwork {
  const calls: string[] = [];
  const fetchImpl: LicenseFetch = async (input) => {
    calls.push(input);
    if (input.includes("/revoke-lease")) {
      if (options.networkDown) throw new TypeError("network down");
      return new Response(
        JSON.stringify({
          revoked: options.revoked === true,
          revokedAt: options.revokedAt,
          reason: options.reason
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response(JSON.stringify({ keyId: "test-key", jwk: serverPublicJwk }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };
  return { fetchImpl, calls };
}

async function seededStore(lease: SignedLease) {
  const store = createMemoryLicenseStore();
  await saveDeviceKey(store, deviceKey);
  await saveLease(store, lease, COMPANY_ID);
  return store;
}

function makeRuntime(args: {
  store: Awaited<ReturnType<typeof seededStore>>;
  network: FakeNetwork;
  prefix: string;
  getClient?: () => LicenseRuntimeClient | null;
}) {
  return createLicenseRuntime({
    store: args.store,
    fetchImpl: args.network.fetchImpl,
    now: () => NOW,
    revokeBaseUrl: REVOKE_BASE,
    storageKeyPrefix: args.prefix,
    getClient: args.getClient
  });
}

test("lease revocado: modo revoked, solo lectura y mensaje del proveedor", async () => {
  setLicenseReadOnly(false);
  const lease = await makeLease();
  const network = fakeNetwork({
    revoked: true,
    revokedAt: iso(NOW - 60 * 60 * 1000),
    reason: "impago"
  });
  const runtime = makeRuntime({
    store: await seededStore(lease),
    network,
    prefix: "revoked"
  });

  const snapshot = await runtime.start({ companyId: COMPANY_ID });

  assert.equal(snapshot.mode, "revoked");
  assert.equal(snapshot.readOnly, true);
  assert.equal(snapshot.reason, "lease-revoked");
  assert.equal(snapshot.message, LICENSE_REVOKED_MESSAGE);
  assert.equal(snapshot.planCode, "growth");
  assert.equal(snapshot.leasePresent, true);
  assert.equal(isLicenseReadOnly(), true);
  assert.throws(() => assertLicenseWritable(), LicenseReadOnlyError);

  const revocationCall = network.calls.find((call) => call.includes("/revoke-lease"));
  assert.ok(revocationCall);
  assert.equal(
    revocationCall,
    `${REVOKE_BASE}/revoke-lease?leaseId=${encodeURIComponent(lease.leaseId)}`
  );

  setLicenseReadOnly(false);
});

test("la red caída no revoca y conserva el modo activo", async () => {
  setLicenseReadOnly(false);
  const lease = await makeLease();
  const network = fakeNetwork({ networkDown: true });
  const runtime = makeRuntime({
    store: await seededStore(lease),
    network,
    prefix: "offline"
  });

  const snapshot = await runtime.start({ companyId: COMPANY_ID });

  assert.equal(snapshot.mode, "active");
  assert.equal(snapshot.readOnly, false);
  assert.equal(snapshot.reason, "valid");
  assert.equal(isLicenseReadOnly(), false);
  assert.ok(network.calls.some((call) => call.includes("/revoke-lease")));
});

test("revocación: caché por leaseId con TTL y fallos sin caché", async () => {
  resetLeaseRevocationCache();
  const lease = await makeLease();
  let calls = 0;
  const fetchImpl: LicenseFetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ revoked: true, reason: "abuso" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  let clock = NOW;
  const first = await checkLeaseRevocation(lease, {
    fetchImpl,
    baseUrl: REVOKE_BASE,
    now: () => clock,
    ttlMs: 60_000
  });
  const second = await checkLeaseRevocation(lease, {
    fetchImpl,
    baseUrl: REVOKE_BASE,
    now: () => clock,
    ttlMs: 60_000
  });

  assert.deepEqual(first, { revoked: true, reason: "abuso" });
  assert.deepEqual(second, first);
  assert.equal(calls, 1);

  clock += 61_000;
  await checkLeaseRevocation(lease, {
    fetchImpl,
    baseUrl: REVOKE_BASE,
    now: () => clock,
    ttlMs: 60_000
  });
  assert.equal(calls, 2);

  // Sin base no hay red (falla abierto), sin mirar la caché previa.
  resetLeaseRevocationCache();
  const noBase = await checkLeaseRevocation(lease, {
    fetchImpl: async () => {
      throw new Error("no debería llamarse");
    },
    baseUrl: null,
    now: () => clock
  });
  assert.deepEqual(noBase, { revoked: false });
});

test("respuestas no concluyentes no revocan", async () => {
  resetLeaseRevocationCache();
  const lease = await makeLease();

  for (const body of [{ revoked: "true" }, { revoked: 1 }, {}, "sí"]) {
    const result = await checkLeaseRevocation(lease, {
      fetchImpl: async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }),
      baseUrl: REVOKE_BASE,
      now: () => NOW,
      ttlMs: 0
    });
    assert.deepEqual(result, { revoked: false });
  }

  const serverError = await checkLeaseRevocation(lease, {
    fetchImpl: async () =>
      new Response(JSON.stringify({ error: "boom" }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      }),
    baseUrl: REVOKE_BASE,
    now: () => NOW,
    ttlMs: 0
  });
  assert.deepEqual(serverError, { revoked: false });
});

test("una firma inválida no puede forzar solo lectura por revocación", async () => {
  setLicenseReadOnly(false);
  const original = await makeLease();
  const tampered: SignedLease = {
    ...original,
    signature: (original.signature[0] === "A" ? "B" : "A") + original.signature.slice(1)
  };
  const network = fakeNetwork({ revoked: true, reason: "impago" });
  const runtime = makeRuntime({
    store: await seededStore(tampered),
    network,
    prefix: "tampered"
  });

  const snapshot = await runtime.start({ companyId: COMPANY_ID });

  assert.equal(snapshot.mode, "invalid");
  assert.equal(snapshot.reason, "invalid-signature");
  assert.equal(snapshot.readOnly, false);
  assert.equal(isLicenseReadOnly(), false);
  // No se consultó la revocación de un lease no auténtico.
  assert.equal(network.calls.some((call) => call.includes("/revoke-lease")), false);
});
