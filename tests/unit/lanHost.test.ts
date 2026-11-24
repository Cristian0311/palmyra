import assert from "node:assert/strict";
import test from "node:test";
import { canUseLanPresence, isPrivateLanHost } from "../../src/services/lanHost";

test("La presencia LAN se permite en loopback y rangos privados", () => {
  for (const hostname of ["127.0.0.1", "localhost", "::1", "10.1.2.3", "192.168.0.25", "172.16.4.9", "172.31.255.254"]) {
    assert.equal(isPrivateLanHost(hostname), true, hostname);
  }
});

test("La presencia LAN se bloquea en Render y en rangos públicos", () => {
  for (const hostname of ["palmyracrm.onrender.com", "8.8.8.8", "172.32.0.1", "172.15.0.1", "example.com"]) {
    assert.equal(canUseLanPresence({ hostname, native: false, hubUrl: "" }), false, hostname);
  }
});

test("Android autónomo no envía latidos salvo que tenga un hub configurado", () => {
  assert.equal(canUseLanPresence({ hostname: "127.0.0.1", native: true, hubUrl: "" }), false);
  assert.equal(canUseLanPresence({ hostname: "127.0.0.1", native: true, hubUrl: "http://192.168.1.10:10000" }), true);
});

test("Un hub inválido no habilita la presencia LAN", () => {
  assert.equal(canUseLanPresence({ hostname: "palmyracrm.onrender.com", native: false, hubUrl: "ftp://192.168.1.10" }), false);
});
