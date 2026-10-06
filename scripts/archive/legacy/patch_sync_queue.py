import re

with open('src/store/useStore.ts', 'r') as f:
    content = f.read()

# 1. Add isSyncing to AppState
content = content.replace("isOffline: boolean;", "isOffline: boolean;\n  isSyncing: boolean;")

# 2. Add isSyncing to store initialization
content = content.replace("isInitialized: false,", "isInitialized: false,\n  isSyncing: false,")

# 3. Replace processSyncQueue
old_process = """  processSyncQueue: async () => {
    const { syncQueue, isOffline, removeSyncTask } = get();
    if (isOffline || syncQueue.length === 0) return;
    
    // In Phase 3, we will add the actual Supabase pushes here.
    // For Phase 1, we just simulate processing or keep them if they fail.
    console.log(`[Sync Queue] Processing ${syncQueue.length} tasks...`);
    // Example: For now we'll just log them. We won't remove them until Phase 3 implements the actual push, 
    // or maybe we just leave them pending.
  },"""

new_process = """  processSyncQueue: async () => {
    const state = get();
    if (state.isOffline || state.syncQueue.length === 0 || state.isSyncing) return;
    
    set({ isSyncing: true });
    
    try {
      const queueSnapshot = [...get().syncQueue];
      console.log(`[Sync Queue] Processing ${queueSnapshot.length} tasks...`);
      
      for (const task of queueSnapshot) {
        if (!navigator.onLine) break; // Stop if connection lost
        
        try {
          let error = null;
          
          if (task.action === 'INSERT') {
            const { error: insertErr } = await supabase.from(task.table).insert(task.data);
            error = insertErr;
          } else if (task.action === 'UPDATE') {
            if (task.table === 'inventory_levels_upsert') {
              const { error: upsertErr } = await supabase.from('inventory_levels').upsert(
                task.data,
                { onConflict: 'product_id, branch_id, variant_label' }
              );
              error = upsertErr;
            } else {
              const { id, ...updateData } = task.data;
              const { error: updateErr } = await supabase.from(task.table).update(updateData).eq('id', id);
              error = updateErr;
            }
          }
          
          if (error) {
            console.error(`[Sync Queue] Failed to process task ${task.id} (${task.table}):`, error);
            set(s => ({
              syncQueue: s.syncQueue.map(t => t.id === task.id ? { ...t, retryCount: (t.retryCount || 0) + 1 } : t)
            }));
          } else {
            console.log(`[Sync Queue] Success task ${task.id} (${task.table})`);
            get().removeSyncTask(task.id);
          }
        } catch (err) {
          console.error(`[Sync Queue] Exception on task ${task.id}:`, err);
        }
      }
    } finally {
      set({ isSyncing: false });
    }
  },"""

content = content.replace(old_process, new_process)

with open('src/store/useStore.ts', 'w') as f:
    f.write(content)
