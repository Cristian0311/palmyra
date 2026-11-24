import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

test("the transfer client dispatches in two phases instead of posting one-step moves", () => {
  const rpc = source("src/services/supabaseSync/rpc.ts");
  assert.match(rpc, /rpc\('palmyra_dispatch_transfer'/);
  assert.match(rpc, /export async function callReceiveTransferRPC/);
  assert.match(rpc, /rpc\('palmyra_receive_transfer'/);
  assert.match(rpc, /export async function callCancelTransferRPC/);
  assert.match(rpc, /rpc\('palmyra_cancel_transfer'/);
});

test("receiving and cancelling a shipment are queued when the app is offline", () => {
  const actions = source("src/store/actions/inventoryActions.ts");
  assert.match(actions, /enqueueOfflineItem\('transfer_receive'/);
  assert.match(actions, /enqueueOfflineItem\('transfer_cancel'/);
  assert.match(actions, /status: serverConfirmed \? 'in_transit' as const : 'pending' as const/);

  const queueTypes = source("src/services/offlineQueueTypes.ts");
  assert.match(queueTypes, /'transfer_receive'/);
  assert.match(queueTypes, /'transfer_cancel'/);

  const processor = source("src/services/offline/processQueueItem.ts");
  assert.match(processor, /case 'transfer_receive'/);
  assert.match(processor, /case 'transfer_cancel'/);
});

test("transfer history keeps the canonical in-transit status and batch grouping", () => {
  const pull = source("src/services/supabaseSync/pull.ts");
  // posted debe proyectarse a in_transit con la misma normalización del
  // almacén local y del camino sano (cloudSync): el mapeo ternario legado
  // convertía posted en 'completed' y rompía la recepción en dos fases.
  assert.match(pull, /status: normalizeTransferStatus\(t\.status\)/);
  assert.match(pull, /status\.not\.in\.\(cancelled\)/);
  assert.match(pull, /batchId:t\.batch_id\|\|undefined/);
});

test("the new migration adds the two-phase statuses, batch id and a unique transfer ledger", () => {
  const statuses = source("supabase/migrations/20261118120000_two_phase_transfer_status.sql");
  assert.match(statuses, /add value if not exists 'in_transit'/);
  assert.match(statuses, /add value if not exists 'received'/);
  assert.match(statuses, /add column if not exists batch_id uuid/);

  const rpcs = source("supabase/migrations/20261118120100_two_phase_transfer_rpcs_and_ledger_unique.sql");
  assert.match(rpcs, /create unique index if not exists stock_movements_transfer_reference_unique/);
  assert.match(rpcs, /where reference_type = 'transfer' and reference_id is not null/);
  assert.match(rpcs, /function public\.palmyra_dispatch_transfer/);
  assert.match(rpcs, /function public\.palmyra_receive_transfer/);
  assert.match(rpcs, /function public\.palmyra_cancel_transfer/);
  // The migration must refuse to deduplicate historical data silently.
  assert.match(rpcs, /raise exception 'stock_movements contiene movimientos de traslado duplicados/);
});
