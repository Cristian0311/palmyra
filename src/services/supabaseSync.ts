/**
 * Supabase synchronization facade.
 * Domain implementations are split by responsibility to keep the POS path small
 * and make offline-safe synchronization easier to reason about.
 */
export * from './supabaseSync/core';
export * from './supabaseSync/pull';
export * from './supabaseSync/mutations';
export * from './supabaseSync/rpc';
export * from './supabaseSync/diagnostics';
