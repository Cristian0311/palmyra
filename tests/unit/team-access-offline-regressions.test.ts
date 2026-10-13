import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

test("Team restores web access from the actual employee link or pending invitation", () => {
  const team = source("src/pages/Team.tsx");
  assert.match(team, /sendInvite:\s*Boolean\(employee\.user_id\s*\|\|\s*employee\.pending_invitation\)/);
  assert.doesNotMatch(team, /disabled=\{busy \|\| Boolean\(editing\?\.user_id\)\}/);
  assert.match(team, /showPosPassword \? "text" : "password"/);
  assert.match(team, /La contraseña actual no se puede recuperar porque se guarda como hash seguro/);
});

test("Team edits are persisted offline and replayed through an explicit queue handler", () => {
  const team = source("src/pages/Team.tsx");
  const types = source("src/services/offlineQueueTypes.ts");
  const queue = source("src/services/offline/processQueueItem.ts");
  assert.match(team, /enqueueOfflineItem\("employee_update"/);
  assert.match(types, /'employee_update'/);
  assert.match(queue, /case 'employee_update'/);
  assert.match(queue, /create_company_invitation/);
  assert.match(types, /'employee_status'/);
  assert.match(types, /'employee_delete'/);
  assert.match(types, /'invitation_revoke'/);
  assert.match(queue, /case 'employee_status'/);
  assert.match(queue, /case 'employee_delete'/);
  assert.match(queue, /case 'invitation_revoke'/);
});

test("POS shift-cancellation modal has only cancel and accept actions, with no password field", () => {
  const modal = source("src/components/pos/POSCancelShiftModal.tsx");
  const pos = source("src/pages/POS.tsx");
  assert.doesNotMatch(modal, /type="password"|Contraseña del Trabajador|setPassword/);
  assert.match(modal, /Aceptar cancelación/);
  assert.doesNotMatch(pos, /cancelShiftPassword/);
  assert.match(pos, /cancelSession\(sessionId, 'Cancelación de turno'\)/);
});
