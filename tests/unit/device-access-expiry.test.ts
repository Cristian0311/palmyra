import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  ACCESS_INVITE_DAY_OPTIONS,
  ACCESS_INVITE_DEFAULT_DAYS,
  ACCESS_INVITE_MAX_DAYS,
  describeAccessInviteExpiry,
  resolveAccessInviteExpiry,
} from "../../src/services/deviceAccess";

const source = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

/* ------------------------------------------------------------------ */
/* Caducidad del enlace: un único resolvedor para ambos caminos        */
/* ------------------------------------------------------------------ */

test("«Sin caducidad» se envía como 0 y nunca como 7 días", () => {
  for (const input of [0, -1, -30, "0", "-5"]) {
    const expiry = resolveAccessInviteExpiry(input as number);
    assert.equal(expiry.days, 0, `input ${input} debe quedar en 0`);
    assert.equal(expiry.perpetual, true);
    assert.equal(expiry.label, 'Sin caducidad');
    assert.match(expiry.note, /^Sin caducidad · un solo uso/);
  }
});

test("los días válidos conservan su etiqueta y el singular de un día", () => {
  assert.deepEqual(
    ACCESS_INVITE_DAY_OPTIONS.map(days => resolveAccessInviteExpiry(days).label),
    ['Válido 1 día', 'Válido 7 días', 'Válido 30 días', 'Válido 90 días', 'Sin caducidad']
  );
  const single = resolveAccessInviteExpiry(1);
  assert.equal(single.days, 1);
  assert.equal(single.perpetual, false);
  assert.equal(single.note, 'Válido 1 día · un solo uso · personal e intransferible');
});

test("valores sucios caen al valor por defecto o al tope del servidor", () => {
  for (const input of [undefined, null, '', 'abc', Number.NaN]) {
    assert.equal(resolveAccessInviteExpiry(input as never).days, ACCESS_INVITE_DEFAULT_DAYS);
  }
  assert.equal(resolveAccessInviteExpiry(365).days, ACCESS_INVITE_MAX_DAYS);
  assert.equal(resolveAccessInviteExpiry(7.4).days, 7);
  assert.equal(resolveAccessInviteExpiry(0.4).days, 1, 'un decimal positivo no debe volverse «sin caducidad»');
});

test("la fecha del enlace generado dice «no expira» cuando no caduca", () => {
  const fixed = Date.parse('2026-11-17T12:00:00Z');
  assert.equal(describeAccessInviteExpiry(0, fixed), 'Sin caducidad: el enlace no expira');
  assert.match(describeAccessInviteExpiry(7, fixed), /^Caduca el /);
});

test("la RPC recibe la caducidad normalizada y se devuelve al llamador", () => {
  const deviceAccess = source("src/services/deviceAccess.ts");
  assert.match(deviceAccess, /p_expires_in_days:\s*expiry\.days/);
  assert.match(deviceAccess, /return \{ token, link: buildDeviceAccessLink\(token\), days: expiry\.days \}/);
});

test("el editor y el menú de la fila comparten la caducidad elegida", () => {
  const team = source("src/pages/Team.tsx");
  // Ningún camino puede volver a llamar al servicio sin caducidad explícita.
  assert.match(team, /createDeviceAccessInvite\(employee\.id, expiry\.days\)/);
  assert.equal(
    (team.match(/createDeviceAccessInvite\(employee\.id, expiry\.days\)/g) || []).length,
    2,
    'editor y menú de la fila deben usar el mismo resolvedor'
  );
  assert.doesNotMatch(team, /createDeviceAccessInvite\(employee\.id\)/);
  // El diálogo del menú de la fila no puede rotular siempre 7 días.
  assert.doesNotMatch(team, /Válido 7 días, un solo uso/);
  assert.match(team, /resolveAccessInviteExpiry\(accessInvite\.days\)\.label/);
  // La opción del selector también sale del resolvedor.
  assert.match(team, /ACCESS_INVITE_DAY_OPTIONS\.map\(days =>/);
});
