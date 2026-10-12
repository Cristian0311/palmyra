import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

test("company exchange-rate upserts have the UPDATE SQL privilege required by ON CONFLICT", () => {
  const migration = read("supabase/migrations/20261012012500_fix_exchange_rate_upsert_privileges.sql");
  const mutations = read("src/services/supabaseSync/mutations.ts");
  assert.match(migration, /GRANT UPDATE ON TABLE public\.exchange_rates TO authenticated/i);
  assert.match(mutations, /\.from\('exchange_rates'\)\.upsert\([\s\S]*?onConflict:'id'/);
});

test("currency-rate queue retries preserve the actual Supabase error without recursively re-enqueueing", () => {
  const mutations = read("src/services/supabaseSync/mutations.ts");
  const processor = read("src/services/offline/processQueueItem.ts");
  const queue = read("src/services/offlineQueue.ts");
  assert.match(mutations, /if \(options\?\.queueOnFailure === false\) throw diagnostic/);
  assert.match(mutations, /setOfflineQueueItemLastError\('currency_rate', actionId, diagnostic\.message\)/);
  assert.match(processor, /pushCurrencyToSupabase\(data as any, \{ queueOnFailure: false \}\)/);
  assert.match(queue, /lastError: String\(message \|\| 'Error no especificado'\)/);
});

test("exchange-rate graph reloads durable server history after local cache is removed", () => {
  const page = read("src/pages/ExchangeRate.tsx");
  const migration = read("supabase/migrations/20261011170000_durable_exchange_rate_history.sql");
  const worker = read("supabase/functions/monitor-exchange-rates/index.ts");
  assert.match(page, /rpc\("get_exchange_rate_history"/);
  assert.match(page, /Historial permanente en Supabase/);
  assert.match(page, /El histórico principal se conserva en Supabase/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.exchange_rate_history/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.get_exchange_rate_history/);
  assert.match(worker, /from\("exchange_rate_history"\)/);
});
