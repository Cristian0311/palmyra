import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

test("every OfflineActionType has an explicit offline replay handler", () => {
  const typesSource = source("src/services/offlineQueueTypes.ts");
  const queueSource = source("src/services/offline/processQueueItem.ts");
  const declaration = typesSource.match(/export type OfflineActionType =([\s\S]*?);/);
  assert.ok(declaration, "OfflineActionType declaration must exist");
  const types = [...declaration[1].matchAll(/'([^']+)'/g)].map(match => match[1]);
  const handlers = new Set([...queueSource.matchAll(/case '([^']+)'/g)].map(match => match[1]));
  assert.ok(types.length > 0, "offline queue action list must not be empty");
  assert.deepEqual(types.filter(type => !handlers.has(type)), []);
});

test("Realtime registers all Postgres callbacks before subscribing and filters tenant-owned tables", () => {
  const realtime = source("src/services/realtimeSync.ts");
  const registerPosition = realtime.lastIndexOf("channel.on('postgres_changes'");
  const subscribePosition = realtime.indexOf("channel.subscribe(");
  assert.ok(registerPosition >= 0, "Postgres change callbacks must be registered");
  assert.ok(subscribePosition > registerPosition, "all callbacks must be registered before subscribe()");
  assert.match(realtime, /table !== 'currencies'/, "shared currencies table must not receive a company_id filter");
  assert.match(realtime, /initRefCount/, "Realtime initialization should be reference-counted");
  assert.match(realtime, /subscriberGeneration/, "async channel setup should be cancellable by generation");
});

test("offline queue replay requires a real authenticated Supabase user", () => {
  const sync = source("src/services/offlineSync.ts");
  const authGuard = sync.indexOf("await supabase.auth.getUser()");
  const replayMutations = sync.indexOf("const hydratedQueue = getOfflineQueue()");
  assert.ok(authGuard >= 0, "replay auth guard must exist");
  assert.ok(replayMutations > authGuard, "offline queue must not replay under anonymous auth");
  assert.match(sync, /Las operaciones offline se conservarán/, "the auth guard must keep queued work for later retry");
});
